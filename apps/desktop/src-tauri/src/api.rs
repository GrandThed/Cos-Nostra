//! Blocking client for the Cos Nostra backend: device login, clip records and the presigned
//! uploads. Every call returns `anyhow::Result`; HTTP failures carry an `HttpError` in the
//! chain so callers can react to specific status codes (401 dead token, 409 incomplete upload).

use std::fs::File;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};

use crate::settings::Account;

const USER_AGENT: &str = concat!("cos-nostra-desktop/", env!("CARGO_PKG_VERSION"));
const JSON_TIMEOUT: Duration = Duration::from_secs(30);
const PUT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A non-2xx response. `error` is the body's `error` field when the body was JSON, else the
/// raw body (truncated).
#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub error: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.error.is_empty() {
            write!(f, "HTTP {}", self.status)
        } else {
            write!(f, "HTTP {}: {}", self.status, self.error)
        }
    }
}

impl std::error::Error for HttpError {}

/// The `HttpError` inside an `anyhow` chain, if the failure was an HTTP status.
pub fn http_error(e: &anyhow::Error) -> Option<&HttpError> {
    e.downcast_ref::<HttpError>()
}

pub fn status_of(e: &anyhow::Error) -> Option<u16> {
    http_error(e).map(|h| h.status)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub code: String,
    pub verify_url: String,
}

/// Unknown fields (`id`, `expiresIn`, ...) are ignored by serde.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub discord_id: String,
    pub username: String,
    #[serde(default)]
    pub avatar: Option<String>,
}

impl From<User> for Account {
    fn from(u: User) -> Self {
        Account {
            discord_id: u.discord_id,
            username: u.username,
            avatar: u.avatar,
        }
    }
}

#[derive(Debug, Clone)]
pub enum DevicePoll {
    Pending,
    Ready { token: String, user: User },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePollBody {
    status: String,
    token: Option<String>,
    user: Option<User>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Me {
    pub user: User,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClipUpload {
    pub game: Option<String>,
    pub title: Option<String>,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    /// RFC 3339.
    pub recorded_at: String,
    pub size_av1: i64,
    pub size_h264: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadUrls {
    pub av1: String,
    pub h264: String,
    pub thumb: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedClip {
    pub id: String,
    pub uploads: UploadUrls,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClipUrls {
    pub page: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompletedClip {
    pub id: String,
    pub urls: ClipUrls,
}

pub struct Api {
    base_url: String,
    token: Option<String>,
    client: Client,
}

impl Api {
    pub fn new(base_url: &str, token: Option<String>) -> Result<Api> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(JSON_TIMEOUT)
            .build()
            .context("building HTTP client")?;
        Ok(Api {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            client,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn auth(&self, req: RequestBuilder) -> Result<RequestBuilder> {
        let token = self.token.as_deref().context("not logged in")?;
        Ok(req.bearer_auth(token))
    }

    /// Sends the request and turns a non-2xx status into an `HttpError`.
    fn send(req: RequestBuilder, what: &str) -> Result<Response> {
        let resp = req.send().with_context(|| format!("{what}: request failed"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().unwrap_or_default();
        let error = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| body.chars().take(200).collect());
        Err(HttpError {
            status: status.as_u16(),
            error,
        })
        .with_context(|| what.to_string())
    }

    fn send_json<T: serde::de::DeserializeOwned>(req: RequestBuilder, what: &str) -> Result<T> {
        Self::send(req, what)?
            .json()
            .with_context(|| format!("{what}: bad JSON in response"))
    }

    pub fn start_device_login(&self, device_name: &str) -> Result<DeviceStart> {
        let req = self
            .client
            .post(self.url("/auth/device"))
            .json(&serde_json::json!({ "deviceName": device_name }));
        Self::send_json(req, "POST /auth/device")
    }

    /// One poll. `Ok(None)` when the backend no longer knows the code (404: expired or used).
    pub fn poll_device_login(&self, code: &str) -> Result<Option<DevicePoll>> {
        let what = format!("GET /auth/device/{code}");
        let req = self.client.get(self.url(&format!("/auth/device/{code}")));
        let body: DevicePollBody = match Self::send_json(req, &what) {
            Ok(b) => b,
            Err(e) if status_of(&e) == Some(404) => return Ok(None),
            Err(e) => return Err(e),
        };
        match body.status.as_str() {
            "pending" => Ok(Some(DevicePoll::Pending)),
            "ready" => Ok(Some(DevicePoll::Ready {
                token: body.token.context("ready response without token")?,
                user: body.user.context("ready response without user")?,
            })),
            other => anyhow::bail!("{what}: unexpected status {other:?}"),
        }
    }

    pub fn me(&self) -> Result<Me> {
        let req = self.auth(self.client.get(self.url("/auth/me")))?;
        Self::send_json(req, "GET /auth/me")
    }

    /// Revokes this device's token on the backend.
    pub fn delete_device(&self) -> Result<()> {
        let req = self.auth(self.client.delete(self.url("/auth/device")))?;
        Self::send(req, "DELETE /auth/device").map(drop)
    }

    pub fn create_clip(&self, clip: &NewClipUpload) -> Result<CreatedClip> {
        let req = self.auth(self.client.post(self.url("/clips")).json(clip))?;
        Self::send_json(req, "POST /clips")
    }

    /// Streams a file to a presigned URL. No auth header: the signature is in the URL.
    pub fn put_file(&self, url: &str, path: &Path, content_type: &str) -> Result<()> {
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let req = self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .timeout(PUT_TIMEOUT)
            .body(file);
        Self::send(req, &format!("PUT {}", path.display())).map(drop)
    }

    pub fn complete_clip(&self, id: &str) -> Result<CompletedClip> {
        let what = format!("POST /clips/{id}/complete");
        let req = self.auth(self.client.post(self.url(&format!("/clips/{id}/complete"))))?;
        Self::send_json(req, &what)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    /// One request as the stub saw it.
    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<Seen> {
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let mut parts = line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let mut headers = Vec::new();
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).ok()?;
            let h = h.trim_end().to_string();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                headers.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        let len: usize = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).ok()?;
        Some(Seen {
            method,
            path,
            headers,
            body,
        })
    }

    fn respond(stream: &mut TcpStream, status: &str, body: &str) {
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.flush();
    }

    /// Serves scripted responses on a background thread and records every request. The script
    /// is built from the bound address so bodies can point back at the stub.
    fn stub(
        script: impl FnOnce(&str) -> Vec<(&'static str, String)>,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let script = script(&base);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_thread = Arc::clone(&seen);
        std::thread::spawn(move || {
            for (status, body) in script {
                let (mut stream, _) = listener.accept().unwrap();
                if let Some(req) = read_request(&mut stream) {
                    seen_thread.lock().unwrap().push(req);
                }
                respond(&mut stream, status, &body);
            }
        });
        (base, seen)
    }

    #[test]
    fn full_upload_sequence() {
        let dir = std::env::temp_dir().join(format!("cos-nostra-api-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let av1 = dir.join("a.av1.mp4");
        let h264 = dir.join("a.h264.mp4");
        let thumb = dir.join("a.jpg");
        std::fs::write(&av1, vec![1u8; 3000]).unwrap();
        std::fs::write(&h264, vec![2u8; 2000]).unwrap();
        std::fs::write(&thumb, vec![3u8; 100]).unwrap();

        // The presigned URLs point back at the stub; the script order is the call order.
        let (base, seen) = stub(|base| {
            let s = |x: &str| x.to_string();
            vec![
                ("200 OK", s(r#"{"code":"ABCD","verifyUrl":"https://x/verify?code=ABCD","expiresIn":600}"#)),
                ("200 OK", s(r#"{"status":"pending"}"#)),
                ("200 OK", s(r#"{"status":"ready","token":"tok","user":{"id":"u1","discordId":"123","username":"benja","avatar":null}}"#)),
                ("200 OK", s(r#"{"user":{"id":"u1","discordId":"123","username":"benja"},"device":{"id":"d1"}}"#)),
                ("200 OK", format!(
                    r#"{{"id":"clip1","uploads":{{"av1":"{base}/s3/av1?sig=1","h264":"{base}/s3/h264?sig=2","thumb":"{base}/s3/thumb?sig=3"}},"expiresIn":900}}"#
                )),
                ("200 OK", s("")),
                ("200 OK", s("")),
                ("200 OK", s("")),
                ("409 Conflict", s(r#"{"error":"upload_incomplete"}"#)),
                ("200 OK", s(r#"{"id":"clip1","urls":{"page":"https://x/c/clip1"}}"#)),
                ("401 Unauthorized", s(r#"{"error":"bad_token"}"#)),
                ("404 Not Found", s(r#"{"error":"not_found"}"#)),
            ]
        });

        let api = Api::new(&base, None).unwrap();
        let start = api.start_device_login("PC").unwrap();
        assert_eq!(start.code, "ABCD");
        assert_eq!(start.verify_url, "https://x/verify?code=ABCD");
        assert!(matches!(api.poll_device_login("ABCD").unwrap(), Some(DevicePoll::Pending)));
        let token = match api.poll_device_login("ABCD").unwrap() {
            Some(DevicePoll::Ready { token, user }) => {
                assert_eq!(user.username, "benja");
                assert_eq!(user.discord_id, "123");
                token
            }
            other => panic!("expected ready, got {other:?}"),
        };
        assert_eq!(token, "tok");

        let api = Api::new(&base, Some(token)).unwrap();
        assert_eq!(api.me().unwrap().user.username, "benja");

        let created = api
            .create_clip(&NewClipUpload {
                game: Some("Game".into()),
                title: None,
                duration_ms: 30_000,
                width: 1920,
                height: 1080,
                recorded_at: "2026-09-10T10:00:00Z".into(),
                size_av1: 3000,
                size_h264: 2000,
            })
            .unwrap();
        assert_eq!(created.id, "clip1");
        assert!(created.uploads.av1.starts_with(&base));
        api.put_file(&created.uploads.av1, &av1, "video/mp4").unwrap();
        api.put_file(&created.uploads.h264, &h264, "video/mp4").unwrap();
        api.put_file(&created.uploads.thumb, &thumb, "image/jpeg").unwrap();

        let err = api.complete_clip("clip1").unwrap_err();
        let http = http_error(&err).expect("http error in chain");
        assert_eq!(http.status, 409);
        assert_eq!(http.error, "upload_incomplete");
        assert!(format!("{err:#}").contains("HTTP 409: upload_incomplete"));

        let done = api.complete_clip("clip1").unwrap();
        assert_eq!(done.urls.page, "https://x/c/clip1");

        let err = api.me().unwrap_err();
        assert_eq!(status_of(&err), Some(401));
        assert!(api.poll_device_login("ZZZZ").unwrap().is_none(), "404 is None");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 12);
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/auth/device"));
        let start_body: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(start_body["deviceName"], "PC");
        assert!(seen[0].header("user-agent").unwrap().starts_with("cos-nostra-desktop/"));
        assert_eq!(seen[0].header("authorization"), None);
        assert_eq!(seen[1].path, "/auth/device/ABCD");
        assert_eq!(seen[3].path, "/auth/me");
        assert_eq!(seen[3].header("authorization"), Some("Bearer tok"));
        assert_eq!((seen[4].method.as_str(), seen[4].path.as_str()), ("POST", "/clips"));
        let clip_body: serde_json::Value = serde_json::from_slice(&seen[4].body).unwrap();
        assert_eq!(clip_body["durationMs"], 30_000);
        assert_eq!(clip_body["sizeAv1"], 3000);
        assert_eq!(clip_body["recordedAt"], "2026-09-10T10:00:00Z");

        for (i, (path, len, ct)) in [
            ("/s3/av1?sig=1", 3000usize, "video/mp4"),
            ("/s3/h264?sig=2", 2000, "video/mp4"),
            ("/s3/thumb?sig=3", 100, "image/jpeg"),
        ]
        .into_iter()
        .enumerate()
        {
            let put = &seen[5 + i];
            assert_eq!(put.method, "PUT");
            assert_eq!(put.path, path);
            assert_eq!(put.body.len(), len, "PUT body length for {path}");
            assert_eq!(put.header("content-type"), Some(ct));
            assert_eq!(put.header("content-length"), Some(len.to_string().as_str()));
            assert_eq!(put.header("authorization"), None, "presigned PUTs carry no bearer");
        }
        assert_eq!(seen[8].path, "/clips/clip1/complete");
        assert_eq!(seen[8].header("authorization"), Some("Bearer tok"));
        assert_eq!(seen[11].path, "/auth/device/ZZZZ");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_body_without_json() {
        let (base, _seen) = stub(|_| vec![("502 Bad Gateway", "<html>upstream down</html>".to_string())]);
        let api = Api::new(&base, None).unwrap();
        let err = api.start_device_login("PC").unwrap_err();
        let http = http_error(&err).unwrap();
        assert_eq!(http.status, 502);
        assert_eq!(http.error, "<html>upstream down</html>");
    }
}
