//! macOS: mpv draws into an NSOpenGLView placed below the web view, through libmpv's render API.
//!
//! mpv ignores the `wid` option on macOS (it opens its own window instead), so we use the same
//! approach as native Mac players (IINA…). All OpenGL and AppKit work happens on the main thread.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSRect;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::mpv::Api;

const PARAM_INVALID: c_int = 0;
const PARAM_API_TYPE: c_int = 1;
const PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const PARAM_OPENGL_FBO: c_int = 3;
const PARAM_FLIP_Y: c_int = 4;
const UPDATE_FRAME: u64 = 1;

#[repr(C)]
pub struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct GlInitParams {
    get_proc_address: extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
struct GlFbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

static OPENGL: OnceLock<Option<libloading::Library>> = OnceLock::new();

extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let lib = OPENGL.get_or_init(|| unsafe {
        libloading::Library::new("/System/Library/Frameworks/OpenGL.framework/OpenGL").ok()
    });
    let Some(lib) = lib else { return std::ptr::null_mut() };
    unsafe {
        let n = CStr::from_ptr(name).to_bytes_with_nul();
        lib.get::<*mut c_void>(n).map(|s| *s).unwrap_or(std::ptr::null_mut())
    }
}

/// Schedules rendering of a frame on the main thread.
pub type Schedule = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

pub struct GlRenderer {
    api: Arc<Api>,
    ctx: *mut c_void,
    view: *mut AnyObject,
    glctx: *mut AnyObject,
    pending: AtomicBool,
    schedule: Schedule,
    last_size: std::sync::Mutex<(c_int, c_int)>,
}

unsafe impl Send for GlRenderer {}
unsafe impl Sync for GlRenderer {}

/// Called by mpv (from any thread) when a new frame is ready: we draw it on the main thread.
extern "C" fn on_update(data: *mut c_void) {
    let r = unsafe { &*(data as *const GlRenderer) };
    if r.pending.swap(true, Ordering::AcqRel) {
        return;
    }
    let addr = data as usize;
    (r.schedule)(Box::new(move || unsafe { (*(addr as *const GlRenderer)).render() }));
}

impl GlRenderer {
    /// Creates the OpenGL view below the web view and the mpv render context. Must be called on the main thread.
    ///
    /// `parent`: the window's content view; `webview`: the WKWebView (the video sits right below it).
    pub unsafe fn create(
        api: Arc<Api>,
        mpv: *mut c_void,
        parent: *mut AnyObject,
        webview: *mut AnyObject,
        schedule: Schedule,
    ) -> Result<*const GlRenderer, String> {
        let pf_cls = AnyClass::get(c"NSOpenGLPixelFormat").ok_or("NSOpenGLPixelFormat absent")?;
        let view_cls = AnyClass::get(c"NSOpenGLView").ok_or("NSOpenGLView absent")?;
        // OpenGL 3.2 Core profile, double buffered, accelerated, 24-bit color.
        let attrs: [u32; 9] = [99, 0x3200, 5, 73, 8, 24, 11, 8, 0];
        let pf: *mut AnyObject = msg_send![pf_cls, alloc];
        let pf: *mut AnyObject = msg_send![pf, initWithAttributes: attrs.as_ptr()];
        if pf.is_null() {
            return Err("format OpenGL refusé".into());
        }
        let bounds: NSRect = msg_send![parent, bounds];
        let view: *mut AnyObject = msg_send![view_cls, alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: bounds, pixelFormat: pf];
        if view.is_null() {
            return Err("vue OpenGL non créée".into());
        }
        let _: () = msg_send![view, setWantsBestResolutionOpenGLSurface: Bool::YES];
        // Follows the window size (flexible width and height).
        let _: () = msg_send![view, setAutoresizingMask: 18usize];
        // Below the web view (NSWindowBelow = -1).
        let _: () = msg_send![parent, addSubview: view, positioned: -1isize, relativeTo: webview];

        let glctx: *mut AnyObject = msg_send![view, openGLContext];
        if glctx.is_null() {
            return Err("contexte OpenGL absent".into());
        }
        let _: () = msg_send![glctx, makeCurrentContext];
        // No vsync wait: the main thread must not be blocked.
        let swap: c_int = 0;
        let _: () = msg_send![glctx, setValues: &swap as *const c_int, forParameter: 222isize];

        let mut init = GlInitParams { get_proc_address, get_proc_address_ctx: std::ptr::null_mut() };
        let mut params = [
            RenderParam { kind: PARAM_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
            RenderParam { kind: PARAM_OPENGL_INIT_PARAMS, data: &mut init as *mut _ as *mut c_void },
            RenderParam { kind: PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        let mut ctx: *mut c_void = std::ptr::null_mut();
        let r = (api.render_context_create)(&mut ctx, mpv, params.as_mut_ptr() as *mut c_void);
        if r < 0 {
            return Err(format!("contexte de rendu mpv : {}", api.err(r)));
        }
        let renderer = Box::new(GlRenderer {
            api,
            ctx,
            view,
            glctx,
            pending: AtomicBool::new(false),
            schedule,
            last_size: std::sync::Mutex::new((0, 0)),
        });
        let set_cb = renderer.api.render_context_set_update_callback;
        let ptr = Box::into_raw(renderer);
        set_cb(ctx, on_update, ptr as *mut c_void);
        Ok(ptr)
    }

    unsafe fn render(&self) {
        self.pending.store(false, Ordering::Release);
        let flags = (self.api.render_context_update)(self.ctx);
        let bounds: NSRect = msg_send![self.view, bounds];
        let px: NSRect = msg_send![self.view, convertRectToBacking: bounds];
        let (w, h) = (px.size.width.round() as c_int, px.size.height.round() as c_int);
        if w <= 0 || h <= 0 {
            return;
        }
        let _: () = msg_send![self.glctx, makeCurrentContext];
        {
            let mut last = self.last_size.lock().unwrap();
            if *last != (w, h) {
                *last = (w, h);
                let _: () = msg_send![self.glctx, update];
            } else if flags & UPDATE_FRAME == 0 {
                return;
            }
        }
        let mut fbo = GlFbo { fbo: 0, w, h, internal_format: 0 };
        let mut flip: c_int = 1;
        let mut params = [
            RenderParam { kind: PARAM_OPENGL_FBO, data: &mut fbo as *mut _ as *mut c_void },
            RenderParam { kind: PARAM_FLIP_Y, data: &mut flip as *mut _ as *mut c_void },
            RenderParam { kind: PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        (self.api.render_context_render)(self.ctx, params.as_mut_ptr() as *mut c_void);
        let _: () = msg_send![self.glctx, flushBuffer];
        (self.api.render_context_report_swap)(self.ctx);
    }
}
