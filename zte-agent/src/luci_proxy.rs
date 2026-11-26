//! Expose the router's existing, independently authenticated LuCI UI on the console origin.
use crate::httpd::{api, guard, tls::Secure, Ctx, Peer};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;

const UPSTREAM: &str = "http://127.0.0.1:8081";
const MAX_POST: usize = 32 * 1024 * 1024;
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static UPLOADS: Semaphore = Semaphore::const_new(2);

pub fn router() -> Router<Ctx> {
    Router::new()
        .route("/cgi-bin/luci", any(forward))
        .route("/cgi-bin/luci/", any(forward))
        .route("/cgi-bin/luci/{*path}", any(forward))
        .route("/cgi-bin/{helper}", any(forward))
        .route("/luci-static/{*path}", any(forward))
        .route("/ubus", any(forward))
        .route("/ubus/", any(forward))
}

fn luci_path(path: &str) -> bool {
    path == "/cgi-bin/luci"
        || path.starts_with("/cgi-bin/luci/")
        || path.starts_with("/luci-static/")
        || matches!(path, "/ubus" | "/ubus/" | "/cgi-bin/cgi-backup" | "/cgi-bin/cgi-download" | "/cgi-bin/cgi-exec" | "/cgi-bin/cgi-upload")
}

fn allowed_cookie(name: &str) -> bool {
    matches!(name, "sysauth_http" | "sysauth_https")
}

fn local_redirect(value: &str) -> Option<HeaderValue> {
    let target = value.strip_prefix(UPSTREAM).unwrap_or(value);
    let path = target.split(['?', '#']).next()?;
    if path == "/" {
        return Some(HeaderValue::from_static("/cgi-bin/luci/"));
    }
    if !luci_path(path) {
        return None;
    }
    HeaderValue::from_str(target).ok()
}

async fn forward(State(ctx): State<Ctx>, req: Request) -> Response {
    let path = req.uri().path();
    if !luci_path(path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let secure = req.extensions().get::<Secure>().is_some();
    let loopback = req.extensions().get::<Peer>()
        .is_some_and(|peer| peer.0.ip().to_canonical().is_loopback());
    let h = req.headers();
    if !api::header(h, "host").is_some_and(|host| ctx.hosts.allows_via(host, loopback, secure, &|| ctx.ts.get())) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let method = req.method().clone();
    if !matches!(method, Method::GET | Method::HEAD | Method::POST)
        || (method == Method::POST && path.starts_with("/luci-static/"))
    {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if guard::api_mutation_refused(
        if method == Method::POST { crate::server::Method::Post } else { crate::server::Method::Get },
        &guard::ReqHeaders {
            host: api::header(h, "host"),
            origin: api::header(h, "origin"),
            referer: api::header(h, "referer"),
            sec_fetch_site: api::header(h, "sec-fetch-site"),
        },
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let target = format!("{}{}", UPSTREAM, req.uri().path_and_query().unwrap().as_str());
    let Ok(target) = reqwest::Url::parse(&target) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !luci_path(target.path()) || target.path() != path {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut cookies = Vec::new();
    for header in h.get_all(header::COOKIE) {
        if let Ok(header) = header.to_str() {
            cookies.extend(header.split(';').map(str::trim).filter(|pair| {
                pair.split_once('=').is_some_and(|(name, _)| allowed_cookie(name))
            }));
        }
    }
    let client = CLIENT.get_or_init(|| reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(65))
        .build().expect("fixed LuCI HTTP client"));
    let mut outgoing = client.request(method.clone(), target);
    for key in [header::ACCEPT, header::ACCEPT_LANGUAGE, header::CONTENT_TYPE] {
        if let Some(value) = h.get(&key) {
            outgoing = outgoing.header(key, value);
        }
    }
    if !cookies.is_empty() {
        outgoing = outgoing.header(header::COOKIE, cookies.join("; "));
    }

    let _upload;
    if method == Method::POST {
        _upload = match UPLOADS.try_acquire() {
            Ok(permit) => permit,
            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        };
        let body = match tokio::time::timeout(Duration::from_secs(25), to_bytes(req.into_body(), MAX_POST)).await {
            Ok(Ok(body)) => body,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
        outgoing = outgoing.body(body);
    }
    let Ok(incoming) = outgoing.send().await else {
        return (StatusCode::BAD_GATEWAY, "LuCI is unavailable").into_response();
    };
    let mut reply = Response::builder().status(incoming.status());
    let h = incoming.headers();
    for name in [
        header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_DISPOSITION,
        header::CONTENT_ENCODING, header::WWW_AUTHENTICATE,
        header::HeaderName::from_static("x-luci-login-required"),
    ] {
        if let Some(value) = h.get(&name) {
            reply = reply.header(name, value);
        }
    }
    if let Some(value) = h.get(header::LOCATION) {
        let Some(target) = value.to_str().ok().and_then(local_redirect) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        reply = reply.header(header::LOCATION, target);
    }
    for value in h.get_all(header::SET_COOKIE) {
        if let Ok(cookie) = value.to_str() {
            if cookie.split_once('=').is_some_and(|(name, _)| allowed_cookie(name)) {
                let value = if secure { format!("{cookie}; Secure") } else { cookie.to_owned() };
                reply = reply.header(header::SET_COOKIE, value);
            }
        }
    }
    let stream = futures_util::stream::try_unfold(incoming, |mut response| async move {
        response.chunk().await.map(|chunk| chunk.map(|chunk| (chunk, response)))
    });
    reply.header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_FRAME_OPTIONS, "SAMEORIGIN")
        .header("content-security-policy", "frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
        .header("x-content-type-options", "nosniff")
        .body(if method == Method::HEAD { Body::empty() } else { Body::from_stream(stream) })
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}
