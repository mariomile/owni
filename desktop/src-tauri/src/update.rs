//! Updates (docs/desktop.md, «Aggiornamenti»): at launch and every six hours the app asks the
//! latest GitHub release whether a newer version exists. A newer one is offered in a dialog;
//! accepted, it is downloaded, checked against the key in tauri.conf.json, installed, and the
//! app restarts. «Cerca aggiornamenti…» in the tray asks now and also says when there is none.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// One check at a time: the timer and the tray never show two dialogs.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Check now, then every six hours, quietly: only a newer version speaks.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        check(&app, false);
        std::thread::sleep(EVERY);
    });
}

/// Check off the main thread. `asked`: the person chose it, so «already up to date» and
/// errors get a dialog too.
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || check(&app, true));
}

fn check(app: &AppHandle, asked: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = tauri::async_runtime::block_on(offer(app, asked));
    BUSY.store(false, Ordering::SeqCst);
    if let Err(error) = result {
        eprintln!("owni: update: {error}");
        if asked {
            app.dialog()
                .message(format!(
                    "Non riesco a controllare gli aggiornamenti: {error}"
                ))
                .title("Aggiornamenti")
                .kind(MessageDialogKind::Warning)
                .blocking_show();
        }
    }
}

async fn offer(app: &AppHandle, asked: bool) -> Result<(), String> {
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(update) = found else {
        if asked {
            app.dialog()
                .message(format!(
                    "Hai Owni {}, la versione più recente.",
                    app.package_info().version
                ))
                .title("Owni è aggiornata")
                .blocking_show();
        }
        return Ok(());
    };
    let install = app
        .dialog()
        .message(format!(
            "È disponibile Owni {} (hai la {}). Lo scarico e lo installo, poi Owni si riapre. Le conversazioni restano dove sono.",
            update.version, update.current_version
        ))
        .title("Aggiornamento disponibile")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Installa e riavvia".into(),
            "Più tardi".into(),
        ))
        .blocking_show();
    if !install {
        return Ok(());
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // The server on this computer stops before the new version starts its own.
    if let Some(local) = app.try_state::<crate::Local>() {
        *local.phase.lock().unwrap() = crate::Phase::Off;
    }
    app.restart();
}
