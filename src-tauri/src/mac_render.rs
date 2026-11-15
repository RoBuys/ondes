//! macOS: mpv draws into an NSOpenGLView placed below the web view, through libmpv's render API.
//!
//! mpv ignores the `wid` option on macOS (it opens its own window instead), so we use the same
//! approach as native Mac players (IINA…). The view is created on the main thread, but frames are
//! rendered on a dedicated thread: rendering a 1080p frame takes several milliseconds (texture upload of
//! software-decoded frames), which at 50 fps kept the main thread busy and made the whole UI sluggish.
//! The OpenGL context is protected by the CGL lock, shared with the main thread (resizing).

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSRect;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use crate::mpv::Api;

const PARAM_INVALID: c_int = 0;
const PARAM_API_TYPE: c_int = 1;
const PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const PARAM_OPENGL_FBO: c_int = 3;
const PARAM_FLIP_Y: c_int = 4;
/// By default mpv_render_context_render() sleeps until the frame's display time; we let mpv pace
/// frames through its update callback instead, so the render thread never sleeps inside mpv.
const PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;
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

type CglFn = unsafe extern "C" fn(*mut c_void) -> c_int;

/// OpenGL framework and the CGL functions used to share the context between threads.
struct Gl {
    lib: libloading::Library,
    lock: CglFn,
    unlock: CglFn,
    set_current: CglFn,
    flush: CglFn,
}

static OPENGL: OnceLock<Option<Gl>> = OnceLock::new();

fn gl() -> Option<&'static Gl> {
    OPENGL
        .get_or_init(|| unsafe {
            let lib =
                libloading::Library::new("/System/Library/Frameworks/OpenGL.framework/OpenGL")
                    .ok()?;
            let f = |n: &[u8]| lib.get::<CglFn>(n).ok().map(|s| *s);
            Some(Gl {
                lock: f(b"CGLLockContext\0")?,
                unlock: f(b"CGLUnlockContext\0")?,
                set_current: f(b"CGLSetCurrentContext\0")?,
                flush: f(b"CGLFlushDrawable\0")?,
                lib,
            })
        })
        .as_ref()
}

extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let Some(gl) = gl() else {
        return std::ptr::null_mut();
    };
    unsafe {
        let n = CStr::from_ptr(name).to_bytes_with_nul();
        gl.lib
            .get::<*mut c_void>(n)
            .map(|s| *s)
            .unwrap_or(std::ptr::null_mut())
    }
}

pub struct GlRenderer {
    api: Arc<Api>,
    ctx: *mut c_void,
    view: *mut AnyObject,
    glctx: *mut AnyObject,
    /// CGLContextObj behind `glctx`.
    cgl: *mut c_void,
    /// Set by mpv's update callback, consumed by the render thread.
    pending: Mutex<bool>,
    wake: Condvar,
    /// Drawable size in pixels, updated on the main thread.
    size: Mutex<(c_int, c_int)>,
    size_changed: AtomicBool,
}

unsafe impl Send for GlRenderer {}
unsafe impl Sync for GlRenderer {}

/// Called by mpv (from any thread) when a new frame is ready: wakes the render thread.
extern "C" fn on_update(data: *mut c_void) {
    let r = unsafe { &*(data as *const GlRenderer) };
    *r.pending.lock().unwrap() = true;
    r.wake.notify_one();
}

impl GlRenderer {
    /// Creates the OpenGL view below the web view, the mpv render context and the render thread.
    /// Must be called on the main thread.
    ///
    /// `parent`: the window's content view; `webview`: the WKWebView (the video sits right below it).
    pub unsafe fn create(
        api: Arc<Api>,
        mpv: *mut c_void,
        parent: *mut AnyObject,
        webview: *mut AnyObject,
    ) -> Result<*const GlRenderer, String> {
        let gl = gl().ok_or("OpenGL indisponible")?;
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
        let cgl: *mut c_void = msg_send![glctx, CGLContextObj];
        // No vsync wait in flushes: mpv already paces frames.
        let swap: c_int = 0;
        let _: () = msg_send![glctx, setValues: &swap as *const c_int, forParameter: 222isize];

        // The render context is created with the GL context current, then the context is released so
        // that the render thread can take it.
        (gl.lock)(cgl);
        (gl.set_current)(cgl);
        let mut init = GlInitParams {
            get_proc_address,
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut params = [
            RenderParam {
                kind: PARAM_API_TYPE,
                data: c"opengl".as_ptr() as *mut c_void,
            },
            RenderParam {
                kind: PARAM_OPENGL_INIT_PARAMS,
                data: &mut init as *mut _ as *mut c_void,
            },
            RenderParam {
                kind: PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let mut ctx: *mut c_void = std::ptr::null_mut();
        let r = (api.render_context_create)(&mut ctx, mpv, params.as_mut_ptr() as *mut c_void);
        (gl.set_current)(std::ptr::null_mut());
        (gl.unlock)(cgl);
        if r < 0 {
            return Err(format!("contexte de rendu mpv : {}", api.err(r)));
        }

        let renderer = Box::new(GlRenderer {
            api,
            ctx,
            view,
            glctx,
            cgl,
            pending: Mutex::new(false),
            wake: Condvar::new(),
            size: Mutex::new((0, 0)),
            size_changed: AtomicBool::new(false),
        });
        let set_cb = renderer.api.render_context_set_update_callback;
        let ptr = Box::into_raw(renderer);
        (*ptr).resize();
        set_cb(ctx, on_update, ptr as *mut c_void);

        let addr = ptr as usize;
        std::thread::Builder::new()
            .name("ondes-render".into())
            .spawn(move || unsafe { (*(addr as *const GlRenderer)).run() })
            .map_err(|e| e.to_string())?;
        Ok(ptr)
    }

    /// Main thread: reads the view's size in pixels and updates the GL drawable (after a resize or a
    /// change of screen). The CGL lock keeps the render thread from drawing meanwhile.
    /// Main thread: the view's size in points.
    pub unsafe fn view_size(&self) -> (f64, f64) {
        let bounds: NSRect = msg_send![self.view, bounds];
        (bounds.size.width, bounds.size.height)
    }

    pub unsafe fn resize(&self) {
        let Some(gl) = gl() else { return };
        let bounds: NSRect = msg_send![self.view, bounds];
        let px: NSRect = msg_send![self.view, convertRectToBacking: bounds];
        let s = (
            px.size.width.round() as c_int,
            px.size.height.round() as c_int,
        );
        let mut size = self.size.lock().unwrap();
        if *size == s {
            return;
        }
        (gl.lock)(self.cgl);
        let _: () = msg_send![self.glctx, update];
        (gl.unlock)(self.cgl);
        *size = s;
        drop(size);
        self.size_changed.store(true, Ordering::Release);
        on_update(self as *const _ as *mut c_void);
    }

    /// Render thread: waits for mpv's signal, then draws the frame.
    unsafe fn run(&self) {
        loop {
            {
                let mut p = self.pending.lock().unwrap();
                while !*p {
                    p = self.wake.wait(p).unwrap();
                }
                *p = false;
            }
            let t0 = std::time::Instant::now();
            if self.render() {
                let us = t0.elapsed().as_micros() as u64;
                use std::sync::atomic::Ordering::Relaxed;
                crate::mpv::RENDER_FRAMES.fetch_add(1, Relaxed);
                crate::mpv::RENDER_MICROS.fetch_add(us, Relaxed);
                crate::mpv::RENDER_MAX_MICROS.fetch_max(us, Relaxed);
            }
        }
    }

    /// Draws the current frame if mpv has one (or if the size changed). Returns true if it drew.
    unsafe fn render(&self) -> bool {
        let Some(gl) = gl() else { return false };
        let (w, h) = *self.size.lock().unwrap();
        if w <= 0 || h <= 0 {
            return false;
        }
        (gl.lock)(self.cgl);
        (gl.set_current)(self.cgl);
        let flags = (self.api.render_context_update)(self.ctx);
        let resized = self.size_changed.swap(false, Ordering::AcqRel);
        let drew = flags & UPDATE_FRAME != 0 || resized;
        if drew {
            let mut fbo = GlFbo {
                fbo: 0,
                w,
                h,
                internal_format: 0,
            };
            let mut flip: c_int = 1;
            let mut no_block: c_int = 0;
            let mut params = [
                RenderParam {
                    kind: PARAM_OPENGL_FBO,
                    data: &mut fbo as *mut _ as *mut c_void,
                },
                RenderParam {
                    kind: PARAM_FLIP_Y,
                    data: &mut flip as *mut _ as *mut c_void,
                },
                RenderParam {
                    kind: PARAM_BLOCK_FOR_TARGET_TIME,
                    data: &mut no_block as *mut _ as *mut c_void,
                },
                RenderParam {
                    kind: PARAM_INVALID,
                    data: std::ptr::null_mut(),
                },
            ];
            (self.api.render_context_render)(self.ctx, params.as_mut_ptr() as *mut c_void);
            (gl.flush)(self.cgl);
        }
        (gl.set_current)(std::ptr::null_mut());
        (gl.unlock)(self.cgl);
        if drew {
            (self.api.render_context_report_swap)(self.ctx);
        }
        drew
    }
}
