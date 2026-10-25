//! Owni on this computer (docs/desktop.md, «Owni sul Mac»): the app starts the server it
//! carries (Node next to the app's executable, the compiled server in its resources), waits for
//! it, and signs the owner in. Nothing leaves the computer but the calls to the model.

use std::fs;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

/// The port tried first: the same at every start, so the console's saved preferences stay.
const PORT: u16 = 47821;
/// The first start creates the data folder: a slow disk may need a while.
const WAIT: Duration = Duration::from_secs(90);

/// What the app carries to run Owni by itself. Absent in a build without it (`pnpm dev`).
#[derive(Clone)]
pub struct Bundle {
    node: PathBuf,
    server: PathBuf,
    computer: Option<PathBuf>,
}

impl Bundle {
    pub fn find(exe_dir: &Path, resources: &Path) -> Option<Bundle> {
        let node = exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let server = resources.join("server");
        let helper = exe_dir.join("owni-computer-use");
        let computer = (cfg!(target_os = "macos") && helper.is_file()).then_some(helper);
        (node.is_file() && server.join(ENTRY).is_file()).then_some(Bundle {
            node,
            server,
            computer,
        })
    }
}

/// desktop/server-entry.mjs, next to the compiled server (dist/).
const ENTRY: &str = "server-entry.mjs";

/// The server while it runs; dropping it stops the server.
pub struct Running {
    child: Child,
    pub origin: Url,
}

impl Drop for Running {
    fn drop(&mut self) {
        stop(&mut self.child);
    }
}

/// Start the server on this computer and wait until it answers. The model is the test one at
/// the first start: the console's «Primi passi» asks for the real one and its key.
pub fn start(bundle: &Bundle, data: &Path, log: &Path) -> Result<Running, String> {
    fs::create_dir_all(data).map_err(|e| e.to_string())?;
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out = fs::File::create(log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let port = free_port();
    let child = command(bundle, data, port)
        // Kept open while the app runs: its end tells the server to stop (server-entry.mjs).
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("Owni non parte su questo computer: {e}"))?;
    let origin = Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    let mut running = Running { child, origin };
    let since = Instant::now();
    loop {
        if crate::server::check(&running.origin).is_ok() {
            return Ok(running);
        }
        if let Ok(Some(_)) = running.child.try_wait() {
            return Err(format!(
                "Owni si è fermata appena partita: i dettagli sono in {}",
                log.display()
            ));
        }
        if since.elapsed() > WAIT {
            return Err(format!(
                "Owni non risponde ancora: i dettagli sono in {}",
                log.display()
            ));
        }
        thread::sleep(Duration::from_millis(300));
    }
}

/// No inherited server/desktop routing can turn the native helper into a remote control API.
fn command(bundle: &Bundle, data: &Path, port: u16) -> Command {
    let mut command = Command::new(&bundle.node);
    command
        .arg(ENTRY)
        .current_dir(&bundle.server)
        .env("NODE_ENV", "production")
        .env("OWNI_DATA_DIR", data)
        .env("OWNI_WEB_HOST", "127.0.0.1")
        .env("OWNI_WEB_PORT", port.to_string())
        .env("OWNI_MODEL_PROVIDER", "faux")
        // Only the bundled, loopback server may use this computer's subscriptions and screen.
        .env("OWNI_LOCAL_PROVIDERS", "1")
        .env_remove("OWNI_LOCAL_DESKTOP_HELPER")
        .env_remove("OWNI_DESKTOP")
        .env_remove("OWNI_DESKTOP_NETWORK")
        .env_remove("OWNI_DESKTOP_URL")
        .env_remove("OWNI_DESKTOP_TOKEN")
        .env_remove("OWNI_CELL_SECRET")
        .env_remove("OWNI_PUBLIC_URL");
    if let Some(helper) = &bundle.computer {
        command
            .env("OWNI_DESKTOP", "local")
            .env("OWNI_LOCAL_DESKTOP_HELPER", helper);
    }
    command
}

/// The page that signs the owner in. The server writes the owner's link once, at its first
/// start, and asks for that file to be deleted: the app keeps the token in its own folder
/// instead, readable only by this user, and opens the link at every start.
pub fn login(data: &Path, keep: &Path, origin: &Url) -> Url {
    let fresh = data.join("owner-login-link.txt");
    if let Some(token) = fs::read_to_string(&fresh)
        .ok()
        .as_deref()
        .and_then(token_of)
    {
        if save_private(keep, token).is_ok() {
            let _ = fs::remove_file(&fresh);
        }
    }
    fs::read_to_string(keep)
        .ok()
        .as_deref()
        .map(str::trim)
        .filter(|t| valid(t))
        .and_then(|t| origin.join(&format!("/login#{t}")).ok())
        .unwrap_or_else(|| origin.clone())
}

fn token_of(link: &str) -> Option<&str> {
    link.trim()
        .split_once("/login#")
        .map(|(_, token)| token)
        .filter(|t| valid(t))
}

fn valid(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn save_private(path: &Path, token: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    use std::io::Write;
    options
        .open(path)
        .and_then(|mut f| f.write_all(token.as_bytes()))
        .map_err(|e| e.to_string())
}

/// PORT when it is free, otherwise any free one: another program may hold it.
fn free_port() -> u16 {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, PORT)).is_ok() {
        return PORT;
    }
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(PORT)
}

/// Asked to stop first, so the server closes its files; stopped for good after a few seconds.
fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        let since = Instant::now();
        while since.elapsed() < Duration::from_secs(5) {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("owni-local-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_first_link_is_kept_by_the_app_and_opened_at_every_start() {
        let base = dir("login");
        let (data, keep) = (base.join("data"), base.join("config/owner-token"));
        fs::create_dir_all(&data).unwrap();
        let origin = Url::parse("http://127.0.0.1:47821/").unwrap();
        assert_eq!(login(&data, &keep, &origin), origin);
        fs::write(
            data.join("owner-login-link.txt"),
            "http://127.0.0.1:47821/login#abc-DEF_123\n",
        )
        .unwrap();
        let other = Url::parse("http://127.0.0.1:50000/").unwrap();
        assert_eq!(
            login(&data, &keep, &other).as_str(),
            "http://127.0.0.1:50000/login#abc-DEF_123"
        );
        assert!(!data.join("owner-login-link.txt").exists());
        assert_eq!(
            login(&data, &keep, &origin).as_str(),
            "http://127.0.0.1:47821/login#abc-DEF_123"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&keep).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_strange_token_is_not_put_in_the_address() {
        assert_eq!(token_of("http://x/login#a b"), None);
        assert_eq!(token_of("http://x/login#"), None);
        assert_eq!(token_of("http://x/"), None);
        assert_eq!(token_of("http://x/login#ok1"), Some("ok1"));
    }

    #[test]
    fn a_bundle_needs_both_node_and_the_server() {
        let base = dir("bundle");
        assert!(Bundle::find(&base, &base).is_none());
        let node = base.join(if cfg!(windows) { "node.exe" } else { "node" });
        fs::write(&node, "").unwrap();
        assert!(Bundle::find(&base, &base).is_none());
        fs::create_dir_all(base.join("server")).unwrap();
        fs::write(base.join("server").join(ENTRY), "").unwrap();
        let bundle = Bundle::find(&base, &base).unwrap();
        assert!(bundle.computer.is_none());
        fs::write(base.join("owni-computer-use"), "").unwrap();
        let bundle = Bundle::find(&base, &base).unwrap();
        assert_eq!(bundle.computer.is_some(), cfg!(target_os = "macos"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn only_the_carried_server_receives_the_local_helper_and_loopback_mode() {
        use std::ffi::OsStr;
        let helper = PathBuf::from("/Applications/Owni.app/Contents/MacOS/owni-computer-use");
        let bundle = Bundle {
            node: PathBuf::from("/node"),
            server: PathBuf::from("/server"),
            computer: Some(helper.clone()),
        };
        let process = command(&bundle, Path::new("/data"), 47821);
        let env: std::collections::HashMap<_, _> = process.get_envs().collect();
        assert_eq!(
            env[OsStr::new("OWNI_WEB_HOST")],
            Some(OsStr::new("127.0.0.1"))
        );
        assert_eq!(
            env[OsStr::new("OWNI_LOCAL_PROVIDERS")],
            Some(OsStr::new("1"))
        );
        assert_eq!(env[OsStr::new("OWNI_DESKTOP")], Some(OsStr::new("local")));
        assert_eq!(
            env[OsStr::new("OWNI_LOCAL_DESKTOP_HELPER")],
            Some(helper.as_os_str())
        );
        assert_eq!(env[OsStr::new("OWNI_PUBLIC_URL")], None);
        assert_eq!(env[OsStr::new("OWNI_CELL_SECRET")], None);
        assert_eq!(env[OsStr::new("OWNI_DESKTOP_URL")], None);
        let without = Bundle {
            computer: None,
            ..bundle
        };
        let process = command(&without, Path::new("/data"), 47821);
        let env: std::collections::HashMap<_, _> = process.get_envs().collect();
        assert_eq!(env[OsStr::new("OWNI_DESKTOP")], None);
        assert_eq!(env[OsStr::new("OWNI_LOCAL_DESKTOP_HELPER")], None);
    }
}
