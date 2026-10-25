//! The Owni server the app shows: what the person typed, checked and reduced to an origin.

use std::time::Duration;
use url::Url;

/// A server address the app may open: its origin, and the page to start on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    /// Scheme, host and port: the only pages the main window shows.
    pub origin: Url,
    /// The origin, or the personal login link (`/login#…`) when that is what was pasted.
    pub start: Url,
}

/// Read what the person typed: an address (`owni.example.it`, `https://…`) or their login link.
/// Plain http only to this computer: a session cookie must not cross the network in clear.
pub fn parse(input: &str) -> Result<Server, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Scrivi l'indirizzo del tuo Owni".into());
    }
    let with_scheme = if text.contains("://") {
        text.to_string()
    } else if is_loopback_host(typed_host(text)) {
        format!("http://{text}")
    } else {
        format!("https://{text}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| "Questo non sembra un indirizzo".to_string())?;
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(host) => {}
        "http" => {
            return Err(
                "Serve un indirizzo https: in http la sessione viaggerebbe in chiaro".into(),
            )
        }
        _ => return Err("L'indirizzo deve iniziare con https://".into()),
    }
    if host.is_empty() || !url.username().is_empty() || url.password().is_some() {
        return Err("Questo non sembra un indirizzo".into());
    }
    let origin = Url::parse(&url.origin().ascii_serialization()).map_err(|e| e.to_string())?;
    // Only the login link keeps its path: any other page starts from the console's home.
    let start = if url.path() == "/login" && url.fragment().is_some_and(|f| !f.is_empty()) {
        url.clone()
    } else {
        origin.clone()
    };
    Ok(Server { origin, start })
}

/// What the main window does with a page it is asked to open.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The bundled connect page, or a page of the connected server.
    Stay,
    /// Anything else on the web: the person's browser opens it.
    Browser,
    /// Not a web page (file://, a custom scheme): nowhere.
    Refuse,
}

pub fn navigation(server: Option<&Url>, target: &Url) -> Navigation {
    if is_bundled(target) || server.is_some_and(|origin| same_origin(origin, target)) {
        Navigation::Stay
    } else if matches!(target.scheme(), "http" | "https" | "mailto") {
        Navigation::Browser
    } else {
        Navigation::Refuse
    }
}

/// The connect page shipped inside the app. Windows serves the app's files from
/// http://tauri.localhost, the other systems from tauri://localhost.
pub fn bundled_page() -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    Url::parse(base).expect("owni: a fixed address")
}

fn is_bundled(target: &Url) -> bool {
    let page = bundled_page();
    target.scheme() == page.scheme() && target.host_str() == page.host_str()
}

/// The page belongs to the server: same scheme, host and port.
pub fn same_origin(origin: &Url, page: &Url) -> bool {
    origin.origin() == page.origin()
}

/// Owni answers at /healthz: the address is right and the server is up.
pub fn check(origin: &Url) -> Result<(), String> {
    let health = origin.join("/healthz").map_err(|e| e.to_string())?;
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent.get(health.as_str()).call().map_err(|_| {
        format!(
            "{} non risponde: controlla l'indirizzo e la rete",
            origin.host_str().unwrap_or("")
        )
    })?;
    let ok = response.status() == 200
        && response
            .body_mut()
            .read_to_string()
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .is_some_and(|v| v["ok"] == true);
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{} risponde, ma non è un server Owni",
            origin.host_str().unwrap_or("")
        ))
    }
}

/// The host part of an address typed without a scheme: `[::1]` keeps its brackets.
fn typed_host(text: &str) -> &str {
    match text.find(']') {
        Some(end) if text.starts_with('[') => &text[..=end],
        _ => text.split(['/', ':']).next().unwrap_or(""),
    }
}

fn is_loopback_host(host: &str) -> bool {
    // Url writes an IPv6 host in brackets.
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_name_is_https_and_a_local_one_is_http() {
        assert_eq!(
            parse("owni.example.it").unwrap().origin.as_str(),
            "https://owni.example.it/"
        );
        assert_eq!(
            parse(" localhost:8080 ").unwrap().origin.as_str(),
            "http://localhost:8080/"
        );
        assert_eq!(
            parse("http://127.0.0.1:8080/#/chat")
                .unwrap()
                .start
                .as_str(),
            "http://127.0.0.1:8080/"
        );
    }

    #[test]
    fn the_login_link_is_kept_to_sign_in() {
        let server = parse("https://owni.example.it/login#abc123").unwrap();
        assert_eq!(server.origin.as_str(), "https://owni.example.it/");
        assert_eq!(
            server.start.as_str(),
            "https://owni.example.it/login#abc123"
        );
        assert_eq!(
            parse("https://owni.example.it/login#").unwrap().start,
            server.origin
        );
    }

    #[test]
    fn refuses_clear_text_to_another_computer_and_other_schemes() {
        assert!(parse("http://owni.example.it").is_err());
        assert!(parse("http://owni.localhost").is_err());
        assert_eq!(
            parse("[::1]:8080").unwrap().origin.as_str(),
            "http://[::1]:8080/"
        );
        assert!(parse("file:///etc/passwd").is_err());
        assert!(parse("javascript:alert(1)").is_err());
        assert!(parse("https://user:pw@owni.example.it").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn the_server_stays_in_the_window_and_the_rest_of_the_web_goes_to_the_browser() {
        let origin = parse("owni.example.it").unwrap().origin;
        let at = |u: &str| navigation(Some(&origin), &Url::parse(u).unwrap());
        assert_eq!(at("https://owni.example.it/#/chat"), Navigation::Stay);
        let (bundled, other) = if cfg!(windows) {
            (
                "http://tauri.localhost/index.html",
                "tauri://localhost/index.html",
            )
        } else {
            (
                "tauri://localhost/index.html",
                "http://tauri.localhost/index.html",
            )
        };
        assert_eq!(at(bundled), Navigation::Stay);
        assert_ne!(at(other), Navigation::Stay);
        assert_eq!(at("https://docs.example.com/x.pdf"), Navigation::Browser);
        assert_eq!(at("mailto:ciao@example.it"), Navigation::Browser);
        assert_eq!(at("file:///etc/passwd"), Navigation::Refuse);
        assert_eq!(at("tauri://evil/index.html"), Navigation::Refuse);
        assert_eq!(
            navigation(None, &Url::parse("https://owni.example.it/").unwrap()),
            Navigation::Browser
        );
    }

    #[test]
    fn only_the_server_origin_is_the_server() {
        let origin = parse("owni.example.it").unwrap().origin;
        assert!(same_origin(
            &origin,
            &Url::parse("https://owni.example.it/#/impostazioni").unwrap()
        ));
        assert!(!same_origin(
            &origin,
            &Url::parse("https://owni.example.it.evil.com/").unwrap()
        ));
        assert!(!same_origin(
            &origin,
            &Url::parse("http://owni.example.it/").unwrap()
        ));
        assert!(!same_origin(
            &origin,
            &Url::parse("https://owni.example.it:8443/").unwrap()
        ));
    }
}
