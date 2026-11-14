#[cfg(target_os = "macos")]
mod mac_render;
mod mpv;
mod proxy;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Downloads in progress: id → cancellation flag.
#[derive(Default)]
struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    status: &'static str, // "downloading" | "done" | "error" | "paused"
    received: u64,
    total: Option<u64>,
    path: String,
    error: Option<String>,
}

/// Removes characters that are not allowed in Windows file names.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = trimmed.trim_end_matches(['.', ' ']).to_string();
    let mut out: String = trimmed.chars().take(180).collect();
    if out.is_empty() {
        out = "video".into();
    }
    out
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("Ondes");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Impossible de créer {} : {e}", dir.display()))?;
    Ok(dir)
}

fn part_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".part");
    PathBuf::from(p)
}

#[tauri::command]
fn downloads_dir(app: AppHandle) -> Result<String, String> {
    download_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Starts (or resumes) a download. Returns the final file path.
#[tauri::command]
fn download_start(
    app: AppHandle,
    state: State<'_, Downloads>,
    id: String,
    url: String,
    file_name: String,
) -> Result<String, String> {
    let path = download_dir(&app)?.join(sanitize(&file_name));
    let path_str = path.to_string_lossy().into_owned();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(path_str);
        }
        map.insert(id.clone(), cancel.clone());
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_download(&app2, &id, &url, &path, &cancel).await;
        let (status, error) = match result {
            Ok(_) => ("done", None),
            Err(_) if cancel.load(Ordering::Relaxed) => ("paused", None),
            Err(e) => ("error", Some(e)),
        };
        let received = std::fs::metadata(if status == "done" {
            path.clone()
        } else {
            part_path(&path)
        })
        .map(|m| m.len())
        .unwrap_or(0);
        let _ = app2.emit(
            "download-progress",
            Progress {
                id: id.clone(),
                status,
                received,
                total: if status == "done" {
                    Some(received)
                } else {
                    None
                },
                path: path.to_string_lossy().into_owned(),
                error,
            },
        );
        app2.state::<Downloads>().0.lock().unwrap().remove(&id);
    });
    Ok(path_str)
}

async fn run_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let part = part_path(path);
    let offset = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Ondes/0.4.0")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Le serveur a répondu {status}"));
    }
    // 206: the server resumes where we stopped; otherwise we start over.
    let resume = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut received = if resume { offset } else { 0 };
    let total = resp.content_length().map(|l| l + received);

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resume)
        .truncate(!resume)
        .open(&part)
        .await
        .map_err(|e| format!("Écriture impossible : {e}"))?;

    let path_str = path.to_string_lossy().into_owned();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.flush().await.ok();
            return Err("annulé".into());
        }
        let chunk = tokio::time::timeout(Duration::from_secs(60), resp.chunk())
            .await
            .map_err(|_| "Le serveur ne répond plus".to_string())?
            .map_err(|e| format!("Transfert interrompu : {e}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Écriture impossible : {e}"))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(500) {
            last_emit = Instant::now();
            let _ = app.emit(
                "download-progress",
                Progress {
                    id: id.to_string(),
                    status: "downloading",
                    received,
                    total,
                    path: path_str.clone(),
                    error: None,
                },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if let Some(t) = total {
        if received < t {
            return Err("Téléchargement incomplet".into());
        }
    }
    tokio::fs::rename(&part, path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn download_cancel(state: State<'_, Downloads>, id: String) {
    if let Some(flag) = state.0.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Deletes the file (and its partial file). Restricted to the Ondes download folder.
#[tauri::command]
fn download_delete(app: AppHandle, path: String) -> Result<(), String> {
    let dir = download_dir(&app)?;
    let p = PathBuf::from(&path);
    if !p.starts_with(&dir) {
        return Err("Chemin hors du dossier Ondes".into());
    }
    for f in [p.clone(), part_path(&p)] {
        if f.exists() {
            std::fs::remove_file(&f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Opens the file manager on the file (or on the Ondes folder).
#[tauri::command]
fn reveal(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(p) if Path::new(&p).exists() => PathBuf::from(p),
        _ => download_dir(&app)?,
    };
    #[cfg(target_os = "windows")]
    {
        let arg = if target.is_file() {
            format!("/select,{}", target.display())
        } else {
            target.display().to_string()
        };
        std::process::Command::new("explorer")
            .arg(arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = if target.is_file() {
            target.parent().map(Path::to_path_buf).unwrap_or(target)
        } else {
            target
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Appends a line to the diagnostic log (app log folder, ondes.log).
#[tauri::command]
fn diag_log(app: AppHandle, line: String) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("ondes.log");
    // The log is reset once it exceeds 2 MB.
    if std::fs::metadata(&path)
        .map(|m| m.len() > 2_000_000)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{secs} {line}");
    }
}

/// Self-test (development builds only): list of streams to play, from the ONDES_SELFTEST variable.
#[tauri::command]
fn selftest_spec() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("ONDES_SELFTEST").ok()
    } else {
        None
    }
}

/// Local relay (macOS): port and token, or nothing on Windows where WebView2 does not enforce CORS.
struct ProxyState(Option<proxy::ProxyInfo>);

#[tauri::command]
fn proxy_info(state: State<'_, ProxyState>) -> Option<proxy::ProxyInfo> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Downloads::default())
        .manage(mpv::MpvState::default())
        .setup(|app| {
            let info = if cfg!(target_os = "windows") {
                None
            } else {
                let log = app.path().app_log_dir().ok().map(|d| {
                    let _ = std::fs::create_dir_all(&d);
                    d.join("ondes.log")
                });
                match proxy::start(log) {
                    Ok(i) => Some(i),
                    Err(e) => {
                        eprintln!("relais Ondes indisponible : {e}");
                        None
                    }
                }
            };
            app.manage(ProxyState(info));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            downloads_dir,
            download_start,
            download_cancel,
            download_delete,
            file_exists,
            reveal,
            proxy_info,
            diag_log,
            selftest_spec,
            mpv::mpv_init,
            mpv::mpv_command,
            mpv::mpv_set,
            mpv::mpv_get,
            mpv::mpv_margins,
            mpv::mpv_tracks,
            mpv::mpv_debug_views,
            mpv::mpv_stats
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'Ondes");
}
