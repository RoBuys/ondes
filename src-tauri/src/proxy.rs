//! Relais HTTP local (127.0.0.1) utilisé sur macOS.
//!
//! WKWebView applique le CORS et bloque le contenu http depuis l'app : les serveurs IPTV, qui n'envoient
//! pas d'en-têtes CORS, y seraient inaccessibles. L'interface passe donc par ce relais, qui récupère
//! la ressource côté Rust. Les manifestes HLS sont réécrits pour que leurs segments passent aussi par ici.
//! Un jeton aléatoire empêche d'autres pages web de la machine de s'en servir.

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Serialize)]
pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
}

struct Inner {
    client: reqwest::Client,
    port: u16,
    token: String,
}

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Démarre le relais et renvoie son port et son jeton.
pub fn start() -> Result<ProxyInfo, String> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token()?;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Ondes/0.1")
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let state = Arc::new(Inner { client, port, token: token.clone() });
    let app = Router::new().route("/proxy", any(handle)).with_state(state);

    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => {
                let _ = axum::serve(listener, app).await;
            }
            Err(e) => eprintln!("relais Ondes : {e}"),
        }
    });
    Ok(ProxyInfo { port, token })
}

fn cors(h: &mut HeaderMap) {
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-length, content-range, accept-ranges, content-type"),
    );
}

fn plain(status: StatusCode, msg: &str) -> Response {
    let mut r = (status, msg.to_string()).into_response();
    cors(r.headers_mut());
    r
}

async fn handle(
    State(st): State<Arc<Inner>>,
    method: Method,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if method == Method::OPTIONS {
        return plain(StatusCode::NO_CONTENT, "");
    }
    if q.get("t").map(String::as_str) != Some(st.token.as_str()) {
        return plain(StatusCode::FORBIDDEN, "jeton invalide");
    }
    let Some(url) = q.get("url").filter(|u| u.starts_with("http://") || u.starts_with("https://")) else {
        return plain(StatusCode::BAD_REQUEST, "url invalide");
    };

    let mut req = st.client.get(url);
    if let Some(range) = headers.get(header::RANGE) {
        req = req.header(header::RANGE, range.clone());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &e.to_string()),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let final_url = resp.url().clone();
    let content_type = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let looks_hls = content_type.to_ascii_lowercase().contains("mpegurl") || final_url.path().to_ascii_lowercase().ends_with(".m3u8");

    if looks_hls && status.is_success() {
        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => return plain(StatusCode::BAD_GATEWAY, &e.to_string()),
        };
        let body = if text.contains("#EXT-X-") { rewrite_hls(&text, &final_url, st.port, &st.token) } else { text };
        let mut r = (status, body).into_response();
        r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/vnd.apple.mpegurl"));
        cors(r.headers_mut());
        return r;
    }

    let mut out = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::LAST_MODIFIED,
        header::ETAG,
    ] {
        if let Some(v) = resp.headers().get(&name) {
            if let Ok(v) = HeaderValue::from_bytes(v.as_bytes()) {
                out.insert(name, v);
            }
        }
    }
    cors(&mut out);
    let mut r = Response::new(Body::from_stream(resp.bytes_stream()));
    *r.status_mut() = status;
    *r.headers_mut() = out;
    r
}

fn rewrite_hls(text: &str, base: &reqwest::Url, port: u16, token: &str) -> String {
    let prox = |u: &str| -> String {
        let abs = base.join(u).map(|x| x.to_string()).unwrap_or_else(|_| u.to_string());
        format!("http://127.0.0.1:{port}/proxy?t={token}&url={}", urlencode(&abs))
    };
    text.lines()
        .map(|line| {
            let l = line.trim();
            if l.is_empty() {
                line.to_string()
            } else if l.starts_with('#') {
                rewrite_uri_attrs(line, &prox)
            } else {
                prox(l)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Réécrit les attributs URI="…" (clés de chiffrement, pistes audio, sous-titres…).
fn rewrite_uri_attrs(line: &str, prox: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find("URI=\"") {
        out.push_str(&rest[..i + 5]);
        rest = &rest[i + 5..];
        match rest.find('"') {
            Some(j) => {
                out.push_str(&prox(&rest[..j]));
                rest = &rest[j..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaie_un_flux_hls() {
        let info = start().expect("démarrage du relais");
        tauri::async_runtime::block_on(async move {
            let base = format!("http://127.0.0.1:{}/proxy", info.port);
            let c = reqwest::Client::new();

            // Sans jeton : refusé.
            let r = c.get(format!("{base}?url=https://example.com")).send().await.unwrap();
            assert_eq!(r.status().as_u16(), 403);

            // Manifeste HLS : réécrit vers le relais, avec CORS.
            let src = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
            let r = c.get(format!("{base}?t={}&url={}", info.token, urlencode(src))).send().await.unwrap();
            assert!(r.status().is_success());
            assert_eq!(r.headers()["access-control-allow-origin"], "*");
            let master = r.text().await.unwrap();
            let variant = master.lines().find(|l| l.starts_with("http://127.0.0.1")).expect("variante réécrite").to_string();

            let media = c.get(&variant).send().await.unwrap().text().await.unwrap();
            let seg = media.lines().find(|l| l.starts_with("http://127.0.0.1")).expect("segment réécrit").to_string();

            // Segment avec Range : 206 et octets transmis.
            let r = c.get(&seg).header("range", "bytes=0-1023").send().await.unwrap();
            assert_eq!(r.status().as_u16(), 206);
            assert!(r.headers().contains_key("content-range"));
            assert_eq!(r.bytes().await.unwrap().len(), 1024);
            println!("OK : manifeste, variante, segment {seg}");
        });
    }
}
