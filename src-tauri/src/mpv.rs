//! mpv playback engine.
//!
//! libmpv is loaded at runtime (dlopen): if it is missing, the app still works with the web player.
//! The video is drawn by mpv directly into the app window (`wid` option), below the web page made
//! transparent; the UI positions the picture under the player area with the `video-margin-ratio-*` margins.

use libloading::Library;
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

type Handle = *mut c_void;

const FORMAT_STRING: c_int = 1;
const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;

const EVENT_SHUTDOWN: c_int = 1;
const EVENT_LOG_MESSAGE: c_int = 2;
const EVENT_START_FILE: c_int = 6;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
struct MpvEventLogMessage {
    prefix: *const c_char,
    level: *const c_char,
    text: *const c_char,
}

/// libmpv functions used by Ondes.
pub struct Api {
    _lib: Library,
    path: PathBuf,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    terminate_destroy: unsafe extern "C" fn(Handle),
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    get_property_string: unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char,
    command: unsafe extern "C" fn(Handle, *mut *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut MpvEvent,
    free: unsafe extern "C" fn(*mut c_void),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    request_log_messages: unsafe extern "C" fn(Handle, *const c_char) -> c_int,
    // Render API (macOS)
    #[allow(dead_code)]
    pub render_context_create: unsafe extern "C" fn(*mut *mut c_void, Handle, *mut c_void) -> c_int,
    #[allow(dead_code)]
    pub render_context_set_update_callback: unsafe extern "C" fn(*mut c_void, extern "C" fn(*mut c_void), *mut c_void),
    #[allow(dead_code)]
    pub render_context_update: unsafe extern "C" fn(*mut c_void) -> u64,
    #[allow(dead_code)]
    pub render_context_render: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    #[allow(dead_code)]
    pub render_context_report_swap: unsafe extern "C" fn(*mut c_void),
}

impl Api {
    fn load(path: &PathBuf) -> Result<Api, String> {
        unsafe {
            let lib = Library::new(path).map_err(|e| format!("{} : {e}", path.display()))?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes()).map_err(|e| format!("{} : {e}", $name))?
                };
            }
            Ok(Api {
                create: sym!("mpv_create"),
                initialize: sym!("mpv_initialize"),
                terminate_destroy: sym!("mpv_terminate_destroy"),
                set_option_string: sym!("mpv_set_option_string"),
                set_property_string: sym!("mpv_set_property_string"),
                get_property_string: sym!("mpv_get_property_string"),
                command: sym!("mpv_command"),
                observe_property: sym!("mpv_observe_property"),
                wait_event: sym!("mpv_wait_event"),
                free: sym!("mpv_free"),
                error_string: sym!("mpv_error_string"),
                request_log_messages: sym!("mpv_request_log_messages"),
                render_context_create: sym!("mpv_render_context_create"),
                render_context_set_update_callback: sym!("mpv_render_context_set_update_callback"),
                render_context_update: sym!("mpv_render_context_update"),
                render_context_render: sym!("mpv_render_context_render"),
                render_context_report_swap: sym!("mpv_render_context_report_swap"),
                _lib: lib,
                path: path.clone(),
            })
        }
    }

    pub fn err(&self, code: c_int) -> String {
        unsafe { CStr::from_ptr((self.error_string)(code)).to_string_lossy().into_owned() }
    }
}

/// mpv instance (the libmpv API can be used from several threads).
pub struct Mpv {
    api: Arc<Api>,
    h: Handle,
}

unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    fn set_option(&self, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        let r = unsafe { (self.api.set_option_string)(self.h, n.as_ptr(), v.as_ptr()) };
        if r < 0 { Err(format!("{name}={value} : {}", self.api.err(r))) } else { Ok(()) }
    }

    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        let r = unsafe { (self.api.set_property_string)(self.h, n.as_ptr(), v.as_ptr()) };
        if r < 0 { Err(format!("{name} : {}", self.api.err(r))) } else { Ok(()) }
    }

    pub fn get(&self, name: &str) -> Option<String> {
        let n = cstr(name).ok()?;
        unsafe {
            let p = (self.api.get_property_string)(self.h, n.as_ptr());
            if p.is_null() {
                return None;
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            (self.api.free)(p as *mut c_void);
            Some(s)
        }
    }

    pub fn command(&self, args: &[String]) -> Result<(), String> {
        let owned: Vec<CString> = args.iter().map(|a| cstr(a)).collect::<Result<_, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let r = unsafe { (self.api.command)(self.h, ptrs.as_mut_ptr()) };
        if r < 0 { Err(format!("{} : {}", args.first().map(String::as_str).unwrap_or(""), self.api.err(r))) } else { Ok(()) }
    }

    fn observe(&self, id: u64, name: &str, format: c_int) {
        if let Ok(n) = cstr(name) {
            unsafe { (self.api.observe_property)(self.h, id, n.as_ptr(), format) };
        }
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.api.terminate_destroy)(self.h) };
    }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "caractère nul".to_string())
}

/// Properties sent to the UI whenever they change.
const OBSERVED: &[(&str, c_int)] = &[
    ("time-pos", FORMAT_DOUBLE),
    ("duration", FORMAT_DOUBLE),
    ("pause", FORMAT_FLAG),
    ("paused-for-cache", FORMAT_FLAG),
    ("core-idle", FORMAT_FLAG),
    ("eof-reached", FORMAT_FLAG),
    ("seekable", FORMAT_FLAG),
    ("volume", FORMAT_DOUBLE),
    ("mute", FORMAT_FLAG),
    ("aid", FORMAT_STRING),
    ("sid", FORMAT_STRING),
    ("track-list/count", FORMAT_INT64),
    ("video-params/w", FORMAT_INT64),
    ("video-params/h", FORMAT_INT64),
    ("demuxer-cache-time", FORMAT_DOUBLE),
];

#[derive(Default)]
pub struct MpvState {
    inner: Mutex<Option<Arc<Mpv>>>,
    /// OpenGL renderer (macOS), kept for the whole lifetime of the app.
    #[allow(dead_code)]
    renderer: Mutex<Option<usize>>,
    /// Locations tried unsuccessfully before the library that was loaded (diagnostics).
    skipped: Mutex<Vec<String>>,
    api: Mutex<Option<Arc<Api>>>,
}

/// Possible libmpv locations: the app's resource folder, next to the executable, then system installs.
fn candidates<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["libmpv-2.dll", "mpv-2.dll"]
    } else if cfg!(target_os = "macos") {
        &["libmpv.2.dylib", "libmpv.dylib"]
    } else {
        &["libmpv.so.2", "libmpv.so"]
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ONDES_LIBMPV") {
        dirs.push(PathBuf::from(p));
    }
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("lib"));
        dirs.push(r);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.to_path_buf());
            dirs.push(d.join("../Frameworks"));
            dirs.push(d.join("lib"));
        }
    }
    // Development: libraries prepared in src-tauri/lib/<platform>.
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib").join(std::env::consts::OS));
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/lib"));
        dirs.push(PathBuf::from("/usr/local/lib"));
    }
    let mut out = Vec::new();
    for d in dirs {
        if d.is_file() {
            out.push(d);
            continue;
        }
        for n in names {
            let p = d.join(n);
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

fn load_api<R: Runtime>(app: &AppHandle<R>, state: &MpvState) -> Result<Arc<Api>, String> {
    if let Some(a) = state.api.lock().unwrap().clone() {
        return Ok(a);
    }
    let mut errors = Vec::new();
    for p in candidates(app) {
        match Api::load(&p) {
            Ok(api) => {
                *state.skipped.lock().unwrap() = errors.clone();
                let api = Arc::new(api);
                *state.api.lock().unwrap() = Some(api.clone());
                return Ok(api);
            }
            Err(e) => errors.push(e),
        }
    }
    Err(if errors.is_empty() { "libmpv introuvable".into() } else { errors.join(" ; ") })
}

/// Native window handle passed to mpv (`wid`): NSView on macOS, HWND on Windows.
fn window_id<R: Runtime>(window: &WebviewWindow<R>) -> Result<i64, String> {
    #[cfg(target_os = "macos")]
    {
        return window.ns_view().map(|p| p as i64).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        return window.hwnd().map(|h| h.0 as i64).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = window;
        Err("plateforme non prise en charge".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitInfo {
    version: String,
    path: String,
    skipped: Vec<String>,
    hwdec: Option<String>,
}

fn start<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, state: &MpvState) -> Result<Arc<Mpv>, String> {
    if let Some(m) = state.inner.lock().unwrap().clone() {
        return Ok(m);
    }
    let api = load_api(app, state)?;
    let h = unsafe { (api.create)() };
    if h.is_null() {
        return Err("mpv_create a échoué".into());
    }
    let mpv = Mpv { api: api.clone(), h };
    let wid = window_id(window)?;

    // Base options: no user config, no mpv key bindings or UI (the app provides its own).
    let opts: &[(&str, &str)] = &[
        ("config", "no"),
        ("load-scripts", "no"),
        ("ytdl", "no"),
        ("osc", "no"),
        ("osd-level", "0"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("input-cursor", "no"),
        ("cursor-autohide", "no"),
        ("idle", "yes"),
        ("force-window", "yes"),
        ("keep-open", "no"),
        ("hwdec", "auto-safe"),
        ("background-color", "#0d0f14"),
        ("cache", "yes"),
        ("demuxer-max-bytes", "150MiB"),
        ("demuxer-readahead-secs", "20"),
        ("network-timeout", "20"),
        ("user-agent", "Mozilla/5.0 Ondes/0.3"),
        ("stream-lavf-o", "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5"),
        ("alang", "fre,fra,fr,french,eng,en"),
        ("slang", "fre,fra,fr"),
        ("sid", "no"),
        ("sub-auto", "no"),
        ("audio-display", "no"),
        ("terminal", "no"),
    ];
    for (k, v) in opts {
        mpv.set_option(k, v)?;
    }
    // mpv built-in scripts (stats, console, menus…): not needed here. Some do not exist
    // in every version, hence the ignored errors.
    for k in [
        "load-stats-overlay",
        "load-console",
        "load-auto-profiles",
        "load-select",
        "load-commands",
        "load-positioning",
        "load-context-menu",
        "load-osd-console",
    ] {
        let _ = mpv.set_option(k, "no");
    }
    // macOS: render API into an app view; elsewhere, mpv draws into the window (wid).
    if cfg!(target_os = "macos") {
        mpv.set_option("vo", "libmpv")?;
        let _ = wid;
    } else {
        mpv.set_option("vo", "gpu-next,gpu,")?;
        mpv.set_option("wid", &wid.to_string())?;
    }
    // Automatic deinterlacing of broadcast TV streams (1080i); "auto" only exists in recent versions.
    if mpv.set_option("deinterlace", "auto").is_err() {
        let _ = mpv.set_option("deinterlace", "no");
    }
    let r = unsafe { (api.initialize)(h) };
    if r < 0 {
        return Err(format!("initialisation de mpv : {}", api.err(r)));
    }
    let level = cstr("warn").unwrap();
    unsafe { (api.request_log_messages)(h, level.as_ptr()) };
    for (i, (name, fmt)) in OBSERVED.iter().enumerate() {
        mpv.observe(i as u64 + 1, name, *fmt);
    }

    // macOS: the window stays opaque; the web view stops painting its background and an OpenGL view placed
    // below it receives mpv's picture. Created on the main thread (AppKit and OpenGL).
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<usize, String>>();
        let parent = window.ns_view().map_err(|e| e.to_string())? as usize;
        let api2 = api.clone();
        let mpv_h = h as usize;
        let app2 = app.clone();
        window
            .with_webview(move |w| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk = w.inner() as *mut AnyObject;
                let no = objc2_foundation::NSNumber::new_bool(false);
                let key = objc2_foundation::NSString::from_str("drawsBackground");
                let _: () = msg_send![&*wk, setValue: &*no, forKey: &*key];
                let schedule: crate::mac_render::Schedule = Box::new(move |f| {
                    let _ = app2.run_on_main_thread(f);
                });
                let r = crate::mac_render::GlRenderer::create(api2, mpv_h as Handle, parent as *mut AnyObject, wk, schedule)
                    .map(|p| p as usize);
                let _ = tx.send(r);
            })
            .map_err(|e| e.to_string())?;
        let renderer = rx.recv().map_err(|e| e.to_string())??;
        *state.renderer.lock().unwrap() = Some(renderer);
    }

    let mpv = Arc::new(mpv);
    *state.inner.lock().unwrap() = Some(mpv.clone());
    spawn_events(app.clone(), mpv.clone());
    Ok(mpv)
}

/// Event thread: observed properties, playback start/end, error messages.
fn spawn_events<R: Runtime>(app: AppHandle<R>, mpv: Arc<Mpv>) {
    let api = mpv.api.clone();
    let h = mpv.h as usize;
    // The thread does not keep the instance alive: mpv_terminate_destroy (Drop) wakes it up with SHUTDOWN.
    drop(mpv);
    std::thread::spawn(move || loop {
        let ev = unsafe { &*(api.wait_event)(h as Handle, -1.0) };
        match ev.event_id {
            EVENT_SHUTDOWN => break,
            EVENT_PROPERTY_CHANGE => {
                let p = unsafe { &*(ev.data as *const MpvEventProperty) };
                let name = unsafe { CStr::from_ptr(p.name).to_string_lossy().into_owned() };
                let value = unsafe {
                    if p.data.is_null() {
                        Value::Null
                    } else {
                        match p.format {
                            FORMAT_DOUBLE => json!(*(p.data as *const f64)),
                            FORMAT_FLAG => json!(*(p.data as *const c_int) != 0),
                            FORMAT_INT64 => json!(*(p.data as *const i64)),
                            FORMAT_STRING => json!(CStr::from_ptr(*(p.data as *const *const c_char)).to_string_lossy()),
                            _ => Value::Null,
                        }
                    }
                };
                let _ = app.emit("mpv-prop", json!({ "name": name, "value": value }));
            }
            EVENT_START_FILE => {
                let _ = app.emit("mpv-event", json!({ "event": "start-file" }));
            }
            EVENT_FILE_LOADED => {
                let _ = app.emit("mpv-event", json!({ "event": "file-loaded" }));
            }
            EVENT_PLAYBACK_RESTART => {
                let _ = app.emit("mpv-event", json!({ "event": "playback-restart" }));
            }
            EVENT_END_FILE => {
                let e = unsafe { &*(ev.data as *const MpvEventEndFile) };
                // reason: 0 normal end, 2 stopped, 3 quit, 4 error, 5 replaced by another file.
                let reason = match e.reason {
                    0 => "eof",
                    2 => "stop",
                    3 => "quit",
                    4 => "error",
                    5 => "redirect",
                    _ => "other",
                };
                let error = if e.error < 0 { Some(api.err(e.error)) } else { None };
                let _ = app.emit("mpv-event", json!({ "event": "end-file", "reason": reason, "error": error }));
            }
            EVENT_LOG_MESSAGE => {
                let m = unsafe { &*(ev.data as *const MpvEventLogMessage) };
                let text = unsafe {
                    format!(
                        "[{}] {}: {}",
                        CStr::from_ptr(m.level).to_string_lossy(),
                        CStr::from_ptr(m.prefix).to_string_lossy(),
                        CStr::from_ptr(m.text).to_string_lossy().trim_end()
                    )
                };
                let _ = app.emit("mpv-log", text);
            }
            _ => {}
        }
    });
}

/// Async command: it runs off the main thread, which mpv needs during its initialization
/// on macOS (a synchronous command would freeze the app).
#[tauri::command]
pub async fn mpv_init<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, state: State<'_, MpvState>) -> Result<InitInfo, String> {
    let mpv = start(&app, &window, &state)?;
    Ok(InitInfo {
        version: mpv.get("mpv-version").unwrap_or_default(),
        path: mpv.api.path.display().to_string(),
        skipped: state.skipped.lock().unwrap().clone(),
        hwdec: mpv.get("hwdec"),
    })
}

fn current(state: &MpvState) -> Result<Arc<Mpv>, String> {
    state.inner.lock().unwrap().clone().ok_or_else(|| "mpv n'est pas démarré".into())
}

#[tauri::command]
pub async fn mpv_command(state: State<'_, MpvState>, args: Vec<String>) -> Result<(), String> {
    current(&state)?.command(&args)
}

#[tauri::command]
pub async fn mpv_set(state: State<'_, MpvState>, name: String, value: String) -> Result<(), String> {
    current(&state)?.set(&name, &value)
}

#[tauri::command]
pub async fn mpv_get(state: State<'_, MpvState>, name: String) -> Result<Option<String>, String> {
    Ok(current(&state)?.get(&name))
}

/// Positions the picture in the window: margins as a fraction of the window size (0 to 1).
#[tauri::command]
pub async fn mpv_margins(state: State<'_, MpvState>, left: f64, right: f64, top: f64, bottom: f64) -> Result<(), String> {
    let mpv = current(&state)?;
    let clamp = |v: f64| v.clamp(0.0, 0.99);
    mpv.set("video-margin-ratio-left", &format!("{:.5}", clamp(left)))?;
    mpv.set("video-margin-ratio-right", &format!("{:.5}", clamp(right)))?;
    mpv.set("video-margin-ratio-top", &format!("{:.5}", clamp(top)))?;
    mpv.set("video-margin-ratio-bottom", &format!("{:.5}", clamp(bottom)))
}

/// Audio and subtitle tracks of the current file.
#[tauri::command]
pub async fn mpv_tracks(state: State<'_, MpvState>) -> Result<Value, String> {
    let mpv = current(&state)?;
    let n: usize = mpv.get("track-list/count").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut out = Vec::new();
    for i in 0..n {
        let g = |k: &str| mpv.get(&format!("track-list/{i}/{k}"));
        out.push(json!({
            "id": g("id").and_then(|s| s.parse::<i64>().ok()),
            "type": g("type"),
            "lang": g("lang"),
            "title": g("title"),
            "codec": g("codec"),
            "selected": g("selected").as_deref() == Some("yes"),
            "channels": g("demux-channel-count"),
        }));
    }
    Ok(Value::Array(out))
}

/// Diagnostics (macOS): window view order, to check that the video is below the web page.
#[tauri::command]
pub async fn mpv_debug_views<R: Runtime>(window: WebviewWindow<R>) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(debug_views_main(&w));
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn debug_views_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, ClassType};
        let view = window.ns_view().map_err(|e| e.to_string())? as *mut AnyObject;
        let _ = objc2_foundation::NSObject::class();
        let mut out = Vec::new();
        unsafe fn describe(v: *mut AnyObject, depth: usize, out: &mut Vec<String>) {
            if v.is_null() || depth > 1 {
                return;
            }
            let cls: *const objc2::runtime::AnyClass = msg_send![&*v, class];
            let layer: *mut AnyObject = msg_send![&*v, layer];
            let mut lay = String::new();
            if !layer.is_null() {
                let lc: *const objc2::runtime::AnyClass = msg_send![&*layer, class];
                lay.push_str(&format!(" [layer {}", (*lc).name().to_string_lossy()));
                let subl: Option<Retained<objc2_foundation::NSArray<AnyObject>>> = msg_send![&*layer, sublayers];
                if let Some(subl) = subl {
                    let names: Vec<String> = subl
                        .iter()
                        .map(|l| {
                            let c: *const objc2::runtime::AnyClass = msg_send![&*l, class];
                            (*c).name().to_string_lossy().into_owned()
                        })
                        .collect();
                    lay.push_str(&format!(" > {}", names.join(", ")));
                }
                lay.push(']');
            }
            out.push(format!("{}{}{}", "  ".repeat(depth), (*cls).name().to_string_lossy(), lay));
            let subs: Option<Retained<objc2_foundation::NSArray<AnyObject>>> = msg_send![&*v, subviews];
            if let Some(subs) = subs {
                for s in subs.iter() {
                    describe(Retained::as_ptr(&s) as *mut AnyObject, depth + 1, out);
                }
            }
        }
        unsafe { describe(view, 0, &mut out) };
        return Ok(out);
    }
    #[allow(unreachable_code)]
    {
        let _ = window;
        Ok(Vec::new())
    }
}
