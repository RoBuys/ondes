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
    /// Number of the reconnection attempt in progress, while waiting to resume after a network error.
    retry: Option<u32>,
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
        keep_awake::acquire();
        let result = download_with_retries(&app2, &id, &url, &path, &cancel).await;
        keep_awake::release();
        let (status, error) = match result {
            Ok(_) => ("done", None),
            Err(_) if cancel.load(Ordering::Relaxed) => ("paused", None),
            Err(e) => ("error", Some(e.msg)),
        };
        log_line(&app2, &format!("téléchargement {id} : fin ({status})"));
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
                retry: None,
            },
        );
        app2.state::<Downloads>().0.lock().unwrap().remove(&id);
    });
    Ok(path_str)
}

/// A failed download attempt; `retry` tells whether it is worth trying again (network glitch, server busy).
struct DlError {
    msg: String,
    retry: bool,
}

impl DlError {
    fn retry(msg: String) -> Self {
        DlError { msg, retry: true }
    }
    fn fatal(msg: String) -> Self {
        DlError { msg, retry: false }
    }
}

/// Consecutive attempts without receiving any new data before giving up.
const MAX_ATTEMPTS_WITHOUT_PROGRESS: u32 = 8;

/// Downloads with automatic resumption: after a network error, waits (2 s, 4 s… up to 60 s) and resumes
/// from the partial file with a Range request. Gives up only after several attempts that brought no data.
async fn download_with_retries(
    app: &AppHandle,
    id: &str,
    url: &str,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<(), DlError> {
    let part = part_path(path);
    let size = || std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut failures = 0u32;
    loop {
        let before = size();
        log_line(
            app,
            &format!(
                "téléchargement {id} : essai depuis l'octet {before} ({})",
                proxy::redact(url)
            ),
        );
        let err = match run_download(app, id, url, path, cancel).await {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        if cancel.load(Ordering::Relaxed) {
            return Err(err);
        }
        // Progress made during this attempt: the next failures are counted afresh.
        if size() > before {
            failures = 0;
        }
        failures += 1;
        log_line(
            app,
            &format!(
                "téléchargement {id} : erreur ({}) — {}",
                err.msg,
                if err.retry { "nouvel essai" } else { "abandon" }
            ),
        );
        if !err.retry || failures > MAX_ATTEMPTS_WITHOUT_PROGRESS {
            return Err(err);
        }
        let _ = app.emit(
            "download-progress",
            Progress {
                id: id.to_string(),
                status: "downloading",
                received: size(),
                total: None,
                path: path.to_string_lossy().into_owned(),
                error: Some(err.msg.clone()),
                retry: Some(failures),
            },
        );
        // Wait before retrying, while staying responsive to "pause".
        let wait = Duration::from_secs((1u64 << failures.min(6)).min(60));
        let until = Instant::now() + wait;
        while Instant::now() < until {
            if cancel.load(Ordering::Relaxed) {
                return Err(DlError::fatal("annulé".into()));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// One download attempt, resuming from the partial file when the server supports byte ranges.
async fn run_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<(), DlError> {
    let part = part_path(path);
    let offset = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .user_agent(concat!("Mozilla/5.0 Ondes/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| DlError::fatal(e.to_string()))?;
    let mut req = client.get(url);
    if offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| DlError::retry(format!("Connexion impossible : {}", e.without_url())))?;
    let status = resp.status();
    if !status.is_success() {
        // 404/401/410: the file is gone or access is denied for good. Other errors (5xx, 429, and the 403/458
        // some providers return while the connection limit is reached) are worth retrying.
        let fatal = matches!(status.as_u16(), 401 | 404 | 410);
        let msg = format!("Le serveur a répondu {status}");
        return Err(if fatal {
            DlError::fatal(msg)
        } else {
            DlError::retry(msg)
        });
    }
    // 206: the server resumes where we stopped; otherwise we start over.
    let resume = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    if offset > 0 && !resume {
        log_line(app, &format!("téléchargement {id} : reprise refusée par le serveur ({status}), on repart de zéro"));
    }
    let mut received = if resume { offset } else { 0 };
    let total = resp.content_length().map(|l| l + received);
    log_line(
        app,
        &format!(
            "téléchargement {id} : réponse {status}, {received} octets déjà reçus, total {}",
            total.map(|t| t.to_string()).unwrap_or("?".into())
        ),
    );

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resume)
        .truncate(!resume)
        .open(&part)
        .await
        .map_err(|e| DlError::fatal(format!("Écriture impossible : {e}")))?;

    let path_str = path.to_string_lossy().into_owned();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.flush().await.ok();
            return Err(DlError::fatal("annulé".into()));
        }
        let chunk = tokio::time::timeout(Duration::from_secs(60), resp.chunk())
            .await
            .map_err(|_| DlError::retry("Le serveur ne répond plus".to_string()))?
            .map_err(|e| DlError::retry(format!("Transfert interrompu : {}", e.without_url())))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .await
            .map_err(|e| DlError::fatal(format!("Écriture impossible : {e}")))?;
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
                    retry: None,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| DlError::fatal(e.to_string()))?;
    drop(file);
    if let Some(t) = total {
        if received < t {
            return Err(DlError::retry("Téléchargement incomplet".into()));
        }
    }
    tokio::fs::rename(&part, path)
        .await
        .map_err(|e| DlError::fatal(e.to_string()))?;
    Ok(())
}

/// Keeps the Mac from idle-sleeping (and the app from App Nap) while at least one download runs.
mod keep_awake {
    use std::sync::Mutex;

    struct Activity {
        count: usize,
        #[cfg(target_os = "macos")]
        token: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    }
    // The activity token is only touched under the mutex.
    unsafe impl Send for Activity {}

    static ACTIVITY: Mutex<Activity> = Mutex::new(Activity {
        count: 0,
        #[cfg(target_os = "macos")]
        token: None,
    });

    pub fn acquire() {
        let mut a = ACTIVITY.lock().unwrap();
        a.count += 1;
        #[cfg(target_os = "macos")]
        if a.count == 1 {
            use objc2::msg_send;
            use objc2::rc::Retained;
            use objc2::runtime::{AnyClass, AnyObject};
            unsafe {
                if let Some(cls) = AnyClass::get(c"NSProcessInfo") {
                    let pi: *mut AnyObject = msg_send![cls, processInfo];
                    let reason = objc2_foundation::NSString::from_str("Ondes download in progress");
                    // NSActivityUserInitiated: includes NSActivityIdleSystemSleepDisabled.
                    let token: Option<Retained<AnyObject>> =
                        msg_send![pi, beginActivityWithOptions: 0x00FF_FFFFu64, reason: &*reason];
                    a.token = token;
                }
            }
        }
    }

    pub fn release() {
        let mut a = ACTIVITY.lock().unwrap();
        a.count = a.count.saturating_sub(1);
        #[cfg(target_os = "macos")]
        if a.count == 0 {
            if let Some(token) = a.token.take() {
                use objc2::msg_send;
                use objc2::runtime::{AnyClass, AnyObject};
                unsafe {
                    if let Some(cls) = AnyClass::get(c"NSProcessInfo") {
                        let pi: *mut AnyObject = msg_send![cls, processInfo];
                        let _: () = msg_send![pi, endActivity: &*token];
                    }
                }
            }
        }
    }
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
    log_line(&app, &line);
}

/// Writes a line to the diagnostic log; the log is reset once it exceeds 2 MB.
fn log_line(app: &AppHandle, line: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("ondes.log");
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
