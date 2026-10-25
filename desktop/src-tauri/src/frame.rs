//! The main window's frame on a Mac (docs/desktop.md, «Finestra e scorciatoie»): no title bar, and the
//! three window buttons sit inside the sidebar's top corner, as in the Mac's own apps. The page
//! is told with `data-desktop="mac"` so the console makes room for them, and with
//! `data-fullscreen` when macOS hides them in full screen. The bands the console marks with
//! `data-tauri-drag-region` move the window; a double click on them zooms it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};
use url::Url;

/// Where the close button sits: level with the sidebar's first row.
#[cfg(target_os = "macos")]
const BUTTONS: tauri::LogicalPosition<f64> = tauri::LogicalPosition::new(18.0, 20.0);

/// Before the page's own scripts, so its first paint already leaves the room.
#[cfg(target_os = "macos")]
const MARK: &str = r#"(function () {
  var mark = function () { document.documentElement.dataset.desktop = "mac"; };
  if (document.documentElement) mark(); else document.addEventListener("DOMContentLoaded", mark);
})();"#;

/// The frame, on a Mac; elsewhere the system's own title bar stays.
pub fn apply<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(BUTTONS)
        .initialization_script(MARK);
    builder
}

/// Full screen as the page last heard it.
static FULL: AtomicBool = AtomicBool::new(false);

/// Tell a page just loaded whether the window is in full screen: the buttons are gone there, and
/// so is the room for them.
pub fn sync<R: Runtime>(window: &WebviewWindow<R>) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let full = window.is_fullscreen().unwrap_or(false);
    FULL.store(full, Ordering::Relaxed);
    let _ = window.eval(format!(
        "document.documentElement.toggleAttribute(\"data-fullscreen\", {full})"
    ));
}

/// The window was resized: the page hears only when full screen changed.
pub fn resized<R: Runtime>(window: &WebviewWindow<R>) {
    let full = window.is_fullscreen().unwrap_or(false);
    if cfg!(target_os = "macos") && FULL.load(Ordering::Relaxed) != full {
        sync(window);
    }
}

/// Pages of the Owni server get the two commands a drag region sends, and nothing else
/// (capabilities/default.json gives remote pages no access at all). Once per server.
pub fn grant(app: &AppHandle, page: &Url) {
    static GRANTED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    if !cfg!(target_os = "macos") {
        return;
    }
    let origin = page.origin().ascii_serialization();
    let mut granted = GRANTED.lock().unwrap();
    if granted.contains(&origin) {
        return;
    }
    let capability = CapabilityBuilder::new(format!("move-window-{}", granted.len()))
        .remote(format!("{origin}/*"))
        .window(crate::MAIN)
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize");
    match app.add_capability(capability) {
        Ok(()) => granted.push(origin),
        Err(error) => eprintln!("owni: window drag not granted to {origin}: {error}"),
    }
}
