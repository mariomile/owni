//! Owni on the desktop (docs/desktop.md): one window on the person's Owni server, an icon in
//! the tray or menu bar, and a shortcut that brings it up from anywhere. The console is the
//! server's own; the app adds only what a browser tab cannot do. The Mac app also carries a
//! server of its own (local.rs), used until the person connects another one.

mod local;
mod server;
mod settings;
mod update;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";

/// The server the main window shows, once the person connected one.
#[derive(Default)]
struct Current(Mutex<Option<Url>>);

/// Owni on this computer: what the app carries, and how far it got starting it.
struct Local {
    bundle: Option<local::Bundle>,
    phase: Mutex<Phase>,
}

enum Phase {
    Off,
    Starting,
    Ready(local::Running),
    Failed(String),
}

/// What the main window shows: the bundled page that asks for the server, or a page of the server.
enum Page {
    Connect,
    Server(Url),
}

#[tauri::command]
async fn connect(app: AppHandle, input: String) -> Result<(), String> {
    let server = server::parse(&input)?;
    let origin = server.origin.clone();
    tauri::async_runtime::spawn_blocking(move || server::check(&origin))
        .await
        .map_err(|e| e.to_string())??;
    settings::save(
        &settings_file(&app)?,
        &settings::Settings {
            server: Some(server.origin.to_string()),
        },
    )?;
    *app.state::<Current>().0.lock().unwrap() = Some(server.origin.clone());
    // Another server now: the one on this computer is not needed.
    *app.state::<Local>().phase.lock().unwrap() = Phase::Off;
    open_main(&app, Page::Server(server.start)).map_err(|e| e.to_string())
}

/// Back to Owni on this computer, from the connect page.
#[tauri::command]
fn use_local(app: AppHandle) -> Result<(), String> {
    settings::save(&settings_file(&app)?, &settings::Settings { server: None })?;
    let ready = match &*app.state::<Local>().phase.lock().unwrap() {
        Phase::Ready(running) => Some(running.origin.clone()),
        _ => None,
    };
    match ready {
        Some(origin) => {
            *app.state::<Current>().0.lock().unwrap() = Some(origin.clone());
            open_main(&app, Page::Server(origin)).map_err(|e| e.to_string())
        }
        None => {
            start_local(&app);
            Ok(())
        }
    }
}

/// What the connect page shows: the connected server, whether this computer can run Owni,
/// and how starting it went.
#[tauri::command]
fn state(app: AppHandle) -> serde_json::Value {
    let local = app.state::<Local>();
    let phase = local.phase.lock().unwrap();
    let remote = matches!(*phase, Phase::Off)
        .then(|| app.state::<Current>().0.lock().unwrap().clone())
        .flatten();
    serde_json::json!({
        "current": remote.map(|u| u.to_string()),
        "local": local.bundle.is_some(),
        "starting": matches!(*phase, Phase::Starting),
        "error": match &*phase { Phase::Failed(message) => Some(message.clone()), _ => None },
    })
}

/// Start the server the app carries, then sign in to it. The connect page says it is starting,
/// or why it did not.
fn start_local(app: &AppHandle) {
    let local = app.state::<Local>();
    let Some(bundle) = local.bundle.as_ref() else {
        return;
    };
    {
        let mut phase = local.phase.lock().unwrap();
        if matches!(*phase, Phase::Starting) {
            return;
        }
        // A server already running is stopped first: a single one owns the data folder.
        *phase = Phase::Starting;
    }
    *app.state::<Current>().0.lock().unwrap() = None;
    let _ = open_main(app, Page::Connect);
    let paths = (|| -> tauri::Result<_> {
        let path = app.path();
        Ok((
            path.app_data_dir()?.join("data"),
            path.app_log_dir()?.join("server.log"),
            path.app_config_dir()?.join("owner-token"),
        ))
    })();
    let ((data, log, keep), bundle) = match paths {
        Ok(paths) => (paths, bundle.clone()),
        Err(error) => {
            *local.phase.lock().unwrap() = Phase::Failed(error.to_string());
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let started = local::start(&bundle, &data, &log);
        let local = app.state::<Local>();
        let mut phase = local.phase.lock().unwrap();
        // The person connected another server meanwhile: this one is not needed.
        if !matches!(*phase, Phase::Starting) {
            return;
        }
        match started {
            Ok(running) => {
                let page = local::login(&data, &keep, &running.origin);
                *app.state::<Current>().0.lock().unwrap() = Some(running.origin.clone());
                *phase = Phase::Ready(running);
                drop(phase);
                let _ = open_main(&app, Page::Server(page));
            }
            Err(message) => {
                *phase = Phase::Failed(message);
                drop(phase);
                let _ = open_main(&app, Page::Connect);
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        // First: a second launch only brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == summon() {
                        // From another app: hide only when Owni is already in front.
                        match main_window(app) {
                            Some(w) if w.is_focused().unwrap_or(false) => {
                                let _ = w.hide();
                            }
                            _ => show(app),
                        }
                    }
                })
                .build(),
        )
        .manage(Current::default())
        .invoke_handler(tauri::generate_handler![connect, state, use_local])
        .setup(|app| {
            let handle = app.handle().clone();
            let bundle = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
                .zip(handle.path().resource_dir().ok())
                .and_then(|(exe_dir, resources)| local::Bundle::find(&exe_dir, &resources));
            handle.manage(Local {
                bundle,
                phase: Mutex::new(Phase::Off),
            });
            // Checked again: a hand-edited file must not open a page the form would refuse.
            let saved = settings::load(&settings_file(&handle)?)
                .server
                .and_then(|s| server::parse(&s).ok())
                .map(|s| s.origin);
            let carried = handle.state::<Local>().bundle.is_some();
            *handle.state::<Current>().0.lock().unwrap() = saved.clone();
            match saved {
                Some(origin) => open_main(&handle, Page::Server(origin))?,
                // No server of the person's yet: the one the app carries, when it has one.
                None if carried => start_local(&handle),
                None => open_main(&handle, Page::Connect)?,
            }
            tray(&handle)?;
            update::watch(&handle);
            // Another app may hold the shortcut: Owni still works from the tray.
            if let Err(error) = handle.global_shortcut().register(summon()) {
                eprintln!("owni: shortcut not registered: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides: Owni stays in the tray, ready for the shortcut. Esci quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("owni: the app could not start")
        .run(|app, event| {
            // The Mac's Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show(app);
            }
            // Esci stops the server on this computer too.
            if let tauri::RunEvent::Exit = event {
                if let Some(local) = app.try_state::<Local>() {
                    *local.phase.lock().unwrap() = Phase::Off;
                }
            }
        });
}

/// Ctrl+Shift+Space (⌘⇧Space on a Mac): Owni from any app.
fn summon() -> Shortcut {
    let command = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(command | Modifiers::SHIFT), Code::Space)
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings::file(
        &app.path().app_config_dir().map_err(|e| e.to_string())?,
    ))
}

/// Show a page in the main window, creating the window the first time. The window's
/// navigation rule reads the current server, so one window serves both kinds of page.
fn open_main(app: &AppHandle, page: Page) -> tauri::Result<()> {
    let url = match page {
        Page::Connect => server::bundled_page(),
        Page::Server(start) => start,
    };
    if let Some(window) = main_window(app) {
        window.navigate(url)?;
        show(app);
        return Ok(());
    }
    let guard = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("Owni")
        .inner_size(1180.0, 800.0)
        .min_inner_size(380.0, 520.0)
        .visible(false)
        // Pages of the server stay in the window; any other link opens in the browser.
        .on_navigation(move |target| allowed(&guard, target))
        // A link that asks for a new window (target=_blank, window.open): a server page opens in a
        // window of the app, which shares the session; anything else in the browser.
        .on_new_window({
            let app = app.clone();
            move |target, _| {
                if allowed(&app, &target) {
                    let _ = open_viewer(&app, target);
                }
                NewWindowResponse::Deny
            }
        })
        // A file from the server (Scarica in File) goes to Downloads, as in a browser.
        .on_download({
            let app = app.clone();
            move |_, event| {
                if let DownloadEvent::Requested { destination, .. } = event {
                    if let Ok(dir) = app.path().download_dir() {
                        let name = destination
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("download")
                            .to_string();
                        *destination = unused(&dir, &name);
                    }
                }
                true
            }
        })
        .build()?;
    // Shown once built: no white flash before the page.
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// A server page that asked for its own window (a picture, a document): a plain window of the
/// app, under the same navigation rule.
fn open_viewer(app: &AppHandle, page: Url) -> tauri::Result<()> {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let label = format!("view-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let guard = app.clone();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(page))
        .title("Owni")
        .inner_size(960.0, 720.0)
        .on_navigation(move |target| allowed(&guard, target))
        .build()?;
    Ok(())
}

/// `name` in `dir`, or `name (2)`, `name (3)`…: a download never replaces a file.
fn unused(dir: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (1..)
        .map(|n| {
            dir.join(if n == 1 {
                format!("{stem}{ext}")
            } else {
                format!("{stem} ({n}){ext}")
            })
        })
        .find(|p| !p.exists())
        .expect("owni: an unused name")
}

fn allowed(app: &AppHandle, target: &Url) -> bool {
    let server = app.state::<Current>().0.lock().unwrap().clone();
    match server::navigation(server.as_ref(), target) {
        server::Navigation::Stay => true,
        server::Navigation::Browser => {
            let _ = app.opener().open_url(target.as_str(), None::<&str>);
            false
        }
        server::Navigation::Refuse => false,
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The tray icon: clicking it takes the focus from the window, so being visible alone decides.
fn toggle(app: &AppHandle) {
    match main_window(app) {
        Some(window) if window.is_visible().unwrap_or(false) => {
            let _ = window.hide();
        }
        _ => show(app),
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Apri Owni", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Nuova chat", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "server", "Cambia server…", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "update", "Cerca aggiornamenti…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &chat,
            &PredefinedMenuItem::separator(app)?,
            &change,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("owni")
        .tooltip("Owni")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("owni: the bundle has an icon"),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "chat" => {
                let origin = app.state::<Current>().0.lock().unwrap().clone();
                match origin.and_then(|o| o.join("/#/chat").ok()) {
                    Some(chat) => {
                        let _ = open_main(app, Page::Server(chat));
                    }
                    None => show(app),
                }
            }
            "server" => {
                let _ = open_main(app, Page::Connect);
            }
            "update" => update::check_now(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::unused;

    #[test]
    fn a_download_never_replaces_a_file() {
        let dir = std::env::temp_dir().join(format!("owni-unused-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unused(&dir, "nota.pdf"), dir.join("nota.pdf"));
        std::fs::write(dir.join("nota.pdf"), "").unwrap();
        std::fs::write(dir.join("nota (2).pdf"), "").unwrap();
        assert_eq!(unused(&dir, "nota.pdf"), dir.join("nota (3).pdf"));
        assert_eq!(unused(&dir, "LEGGIMI"), dir.join("LEGGIMI"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
