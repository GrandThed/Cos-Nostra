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
    /// Proves to the backend that whoever polls the code is the device that asked for it.
    /// It is a bearer for `GET /auth/device/:code` only. It never reaches settings.json and
    /// never reaches the webview: the code alone is short and guessable, so without this
    /// whoever polls first would walk away with the device token.
    pub poll_secret: String,
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

/// Who was in this account's Discord voice channel just now. The backend answers with an
/// empty list rather than an error when it cannot reach the bot, so an empty `participants`
/// is an answer, not a failure.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSnapshot {
    pub participants: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClipUpload {
    /// Omitted rather than sent as null: the backend takes either now, but an older one
    /// rejects a null on an optional field and fails the whole upload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    /// RFC 3339.
    pub recorded_at: String,
    /// The three sizes are what the backend signs each upload URL for, so they have to be
    /// the real byte length of the file that is about to be PUT, not what the encode
    /// recorded earlier. A wrong number fails the signature check at the bucket.
    pub size_av1: i64,
    pub size_h264: i64,
    pub size_thumb: i64,
    /// Discord ids who were in voice with the owner when the clip was taken, for the bot to
    /// mention. Omitted rather than sent as `[]` or null when there is nobody to report, for
    /// consistency with `game` and `title` above; being a new field, an older backend ignores
    /// it either way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_discord_ids: Option<Vec<String>>,
    /// The Discord servers the owner picked in the publish dialog. Always sent, and always an
    /// array: to the backend an absent or null `guildIds` means "every configured server", the
    /// behaviour of builds from before the dialog, while `[]` means the web page only. A clip
    /// this build publishes must never fall into the first meaning by accident.
    pub guild_ids: Vec<String>,
}

/// Body of `POST /clips/:id/replace`: the new files for a clip the site already has. The
/// record keeps its id, page URL and Discord post; only the objects and the length change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceClipUpload {
    pub duration_ms: i64,
    pub size_av1: i64,
    pub size_h264: i64,
    pub size_thumb: i64,
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

/// A server the caller can publish to: configured on the backend, with the bot confirming the
/// caller is a member. `slug` names the guild's site, which the desktop has no use for yet.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishGuild {
    pub guild_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub slug: Option<String>,
}

/// One live Discord post of one of the caller's clips (`GET /me/posts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPost {
    pub clip_id: String,
    pub guild_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[allow(dead_code)]
    pub channel_id: String,
    #[allow(dead_code)]
    pub message_id: String,
    pub message_url: String,
    pub posted_at: String,
}

/// `POST /clips/:id/posts` answers with the guilds it actually queued, after dropping ones that
/// are not configured or already carry a live post of the clip.
#[derive(Debug, Clone, Deserialize)]
pub struct QueuedPosts {
    pub queued: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

/// Callback for upload progress: the total bytes handed to the socket so far. Shared rather
/// than borrowed because reqwest requires the request body to own everything it reads from.
pub type OnBytes = std::sync::Arc<dyn Fn(u64) + Send + Sync>;

/// A file that reports how much of itself has been read.
struct Counting {
    inner: File,
    sent: u64,
    on_bytes: OnBytes,
}

impl std::io::Read for Counting {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.sent += n as u64;
            (self.on_bytes)(self.sent);
        }
        Ok(n)
    }
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
    ///
    /// Carries the poll secret as its bearer, never the device token: this is the call that
    /// earns the device token, so at this point there is none. A wrong or missing secret is
    /// a 401, which the caller treats as fatal rather than transient.
    pub fn poll_device_login(&self, code: &str, poll_secret: &str) -> Result<Option<DevicePoll>> {
        let what = format!("GET /auth/device/{code}");
        let req = self
            .client
            .get(self.url(&format!("/auth/device/{code}")))
            .bearer_auth(poll_secret);
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

    /// Asks who is in the owner's Discord voice channel right now. Called the instant a clip
    /// is saved, since by the time it has encoded and uploaded the channel may have emptied.
    /// Bodyless: the backend knows the account from the device token.
    pub fn voice_snapshot(&self) -> Result<VoiceSnapshot> {
        let req = self.auth(self.client.post(self.url("/discord/voice-snapshot")))?;
        Self::send_json(req, "POST /discord/voice-snapshot")
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

    /// Asks for fresh upload URLs for a clip that is already on the site, so an edited clip
    /// replaces its own video rather than becoming a second clip. Followed by the same three
    /// PUTs and `complete_clip` as a first upload.
    pub fn replace_clip(&self, id: &str, clip: &ReplaceClipUpload) -> Result<CreatedClip> {
        let what = format!("POST /clips/{id}/replace");
        let req = self.auth(self.client.post(self.url(&format!("/clips/{id}/replace"))).json(clip))?;
        Self::send_json(req, &what)
    }

    /// Streams a file to a presigned URL. No auth header: the signature is in the URL.
    ///
    /// `on_bytes` is called with the running total as the body is read, on whatever thread
    /// reqwest reads it from, so the clip card can count the megabytes up.
    pub fn put_file(
        &self,
        url: &str,
        path: &Path,
        content_type: &str,
        on_bytes: Option<OnBytes>,
    ) -> Result<()> {
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let len = file
            .metadata()
            .with_context(|| format!("sizing {}", path.display()))?
            .len();
        // A counting reader has to declare its length or reqwest falls back to chunked
        // transfer encoding, which a presigned S3 PUT rejects.
        let body = match on_bytes {
            Some(on_bytes) => {
                reqwest::blocking::Body::sized(Counting { inner: file, sent: 0, on_bytes }, len)
            }
            None => reqwest::blocking::Body::from(file),
        };
        let req = self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .timeout(PUT_TIMEOUT)
            .body(body);
        Self::send(req, &format!("PUT {}", path.display())).map(drop)
    }

    /// Removes a clip's video from the bucket. The backend keeps the row, because the Discord
    /// post and its reactions point at it, so the link survives and the video does not.
    pub fn delete_clip(&self, id: &str) -> Result<()> {
        let what = format!("DELETE /clips/{id}");
        let req = self.auth(self.client.delete(self.url(&format!("/clips/{id}"))))?;
        Self::send(req, &what).map(drop)
    }

    pub fn complete_clip(&self, id: &str) -> Result<CompletedClip> {
        let what = format!("POST /clips/{id}/complete");
        let req = self.auth(self.client.post(self.url(&format!("/clips/{id}/complete"))))?;
        Self::send_json(req, &what)
    }

    /// The servers the publish dialog offers. A 503 (`bot_unavailable`) means the backend could
    /// not ask the bot who the caller is in, and is left for the caller to explain.
    pub fn publish_guilds(&self) -> Result<Vec<PublishGuild>> {
        let req = self.auth(self.client.get(self.url("/discord/guilds")))?;
        Self::send_json::<Items<PublishGuild>>(req, "GET /discord/guilds").map(|b| b.items)
    }

    /// Asks the bot to post an already published clip in more servers. Answers once queued;
    /// the posts themselves land a few seconds later.
    pub fn add_clip_posts(&self, id: &str, guild_ids: &[String]) -> Result<QueuedPosts> {
        let what = format!("POST /clips/{id}/posts");
        let req = self.auth(
            self.client
                .post(self.url(&format!("/clips/{id}/posts")))
                .json(&serde_json::json!({ "guildIds": guild_ids })),
        )?;
        Self::send_json(req, &what)
    }

    /// Every live post of every one of the caller's clips.
    pub fn my_posts(&self) -> Result<Vec<MyPost>> {
        let req = self.auth(self.client.get(self.url("/me/posts")))?;
        Self::send_json::<Items<MyPost>>(req, "GET /me/posts").map(|b| b.items)
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
                ("200 OK", s(r#"{"code":"ABCD","verifyUrl":"https://x/verify?code=ABCD","pollSecret":"s3cr3t","expiresIn":600}"#)),
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
        assert_eq!(start.poll_secret, "s3cr3t");
        assert!(matches!(
            api.poll_device_login("ABCD", &start.poll_secret).unwrap(),
            Some(DevicePoll::Pending)
        ));
        let token = match api.poll_device_login("ABCD", &start.poll_secret).unwrap() {
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
                size_thumb: 100,
                participant_discord_ids: Some(vec!["123".into(), "456".into()]),
                guild_ids: Vec::new(),
            })
            .unwrap();
        assert_eq!(created.id, "clip1");
        assert!(created.uploads.av1.starts_with(&base));
        // The AV1 upload is watched, which swaps the plain file body for the counting one;
        // the content-length assertions below are what prove that stayed a sized request.
        let counted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&counted);
        let on_bytes: OnBytes = Arc::new(move |sent| sink.lock().unwrap().push(sent));
        api.put_file(&created.uploads.av1, &av1, "video/mp4", Some(on_bytes)).unwrap();
        api.put_file(&created.uploads.h264, &h264, "video/mp4", None).unwrap();
        api.put_file(&created.uploads.thumb, &thumb, "image/jpeg", None).unwrap();
        let counted = counted.lock().unwrap().clone();
        assert_eq!(counted.last(), Some(&3000), "the whole file was counted: {counted:?}");
        assert!(counted.windows(2).all(|w| w[0] < w[1]), "counts must rise: {counted:?}");

        let err = api.complete_clip("clip1").unwrap_err();
        let http = http_error(&err).expect("http error in chain");
        assert_eq!(http.status, 409);
        assert_eq!(http.error, "upload_incomplete");
        assert!(format!("{err:#}").contains("HTTP 409: upload_incomplete"));

        let done = api.complete_clip("clip1").unwrap();
        assert_eq!(done.urls.page, "https://x/c/clip1");

        let err = api.me().unwrap_err();
        assert_eq!(status_of(&err), Some(401));
        assert!(api.poll_device_login("ZZZZ", "s3cr3t").unwrap().is_none(), "404 is None");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 12);
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/auth/device"));
        let start_body: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(start_body["deviceName"], "PC");
        assert!(seen[0].header("user-agent").unwrap().starts_with("cos-nostra-desktop/"));
        assert_eq!(seen[0].header("authorization"), None);
        assert_eq!(seen[1].path, "/auth/device/ABCD");
        // Both polls prove who asked for the code with the poll secret.
        assert_eq!(seen[1].header("authorization"), Some("Bearer s3cr3t"));
        assert_eq!(seen[2].path, "/auth/device/ABCD");
        assert_eq!(seen[2].header("authorization"), Some("Bearer s3cr3t"));
        assert_eq!(seen[3].path, "/auth/me");
        assert_eq!(seen[3].header("authorization"), Some("Bearer tok"));
        assert_eq!((seen[4].method.as_str(), seen[4].path.as_str()), ("POST", "/clips"));
        let clip_body: serde_json::Value = serde_json::from_slice(&seen[4].body).unwrap();
        assert_eq!(clip_body["durationMs"], 30_000);
        assert_eq!(clip_body["sizeAv1"], 3000);
        assert_eq!(clip_body["sizeThumb"], 100);
        assert_eq!(clip_body["recordedAt"], "2026-09-10T10:00:00Z");
        assert_eq!(clip_body["participantDiscordIds"][1], "456");
        assert!(clip_body.get("title").is_none(), "an optional None is left out entirely");
        // No server ticked is still an explicit list: absent would mean "post everywhere".
        assert_eq!(clip_body["guildIds"], serde_json::json!([]));

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
        // That last poll ran on a client that *has* a device token. The poll route still
        // sends the poll secret, which is the whole point: it must not spend the token.
        assert_eq!(seen[11].header("authorization"), Some("Bearer s3cr3t"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_reuses_the_clip_id() {
        let (base, seen) = stub(|base| {
            vec![
                ("200 OK", format!(
                    r#"{{"id":"clip1","uploads":{{"av1":"{base}/s3/av1?sig=9","h264":"{base}/s3/h264?sig=9","thumb":"{base}/s3/thumb?sig=9"}},"expiresIn":900}}"#
                )),
                ("404 Not Found", r#"{"error":"not_found"}"#.to_string()),
            ]
        });
        let api = Api::new(&base, Some("tok".into())).unwrap();
        let body = ReplaceClipUpload {
            duration_ms: 12_000,
            size_av1: 10,
            size_h264: 20,
            size_thumb: 3,
        };
        let replaced = api.replace_clip("clip1", &body).unwrap();
        assert_eq!(replaced.id, "clip1");
        assert!(replaced.uploads.h264.ends_with("/s3/h264?sig=9"));
        // A clip the site has since deleted is a 404 the caller can fall back from.
        let err = api.replace_clip("clip1", &body).unwrap_err();
        assert_eq!(status_of(&err), Some(404));

        let seen = seen.lock().unwrap();
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/clips/clip1/replace"));
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
        let sent: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(sent["durationMs"], 12_000);
        assert_eq!(sent["sizeThumb"], 3);
    }

    /// The backend answers 401 when the poll secret is missing or wrong. That must not look
    /// like "still pending" (the loop would spin for ten minutes) nor like "expired" (`None`).
    #[test]
    fn a_poll_with_the_wrong_secret_is_a_401() {
        let (base, seen) = stub(|_| {
            vec![("401 Unauthorized", r#"{"error":"bad_poll_secret"}"#.to_string())]
        });
        let api = Api::new(&base, Some("device-token".into())).unwrap();
        let err = api.poll_device_login("ABCD", "wrong").unwrap_err();
        assert_eq!(status_of(&err), Some(401));

        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/auth/device/ABCD");
        assert_eq!(seen[0].header("authorization"), Some("Bearer wrong"));
    }

    /// The snapshot is a bodyless authenticated POST. A backend too old to have the route, or
    /// one that is down, must surface as an `Err` here: swallowing it is the caller's job, and
    /// an empty list has to keep meaning "asked, nobody there".
    #[test]
    fn voice_snapshot_reads_the_ids_and_surfaces_failures() {
        let (base, seen) = stub(|_| {
            let s = |x: &str| x.to_string();
            vec![
                ("200 OK", s(r#"{"participants":["123","456"]}"#)),
                ("200 OK", s(r#"{"participants":[]}"#)),
                ("404 Not Found", s(r#"{"error":"not_found"}"#)),
            ]
        });
        let api = Api::new(&base, Some("tok".into())).unwrap();
        assert_eq!(api.voice_snapshot().unwrap().participants, vec!["123", "456"]);
        assert!(api.voice_snapshot().unwrap().participants.is_empty());
        let err = api.voice_snapshot().unwrap_err();
        assert_eq!(status_of(&err), Some(404));

        // Without a token there is nothing to ask with, and no request is made.
        let anonymous = Api::new(&base, None).unwrap();
        assert!(anonymous.voice_snapshot().is_err());

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "the anonymous call never reached the wire");
        assert_eq!(
            (seen[0].method.as_str(), seen[0].path.as_str()),
            ("POST", "/discord/voice-snapshot")
        );
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
        assert!(seen[0].body.is_empty(), "no request body");
    }

    /// The three publish routes, read in the contract's shapes: nullable name and icon, a 503
    /// that callers can tell apart, and the post list keyed by the backend's clip id.
    #[test]
    fn publish_routes_read_the_contract_shapes() {
        let (base, seen) = stub(|_| {
            let s = |x: &str| x.to_string();
            vec![
                ("200 OK", s(r#"{"items":[{"guildId":"111","name":"Cos Nostra","iconUrl":"https://cdn.discordapp.com/icons/111/abc.png?size=96","slug":"cn"},{"guildId":"222","name":null,"iconUrl":null,"slug":null}]}"#)),
                ("503 Service Unavailable", s(r#"{"error":"bot_unavailable"}"#)),
                ("202 Accepted", s(r#"{"queued":["222"]}"#)),
                ("200 OK", s(r#"{"items":[{"clipId":"c1","guildId":"111","name":"Cos Nostra","iconUrl":null,"channelId":"5","messageId":"6","messageUrl":"https://discord.com/channels/111/5/6","postedAt":"2026-09-13T20:00:00.000Z"}]}"#)),
            ]
        });
        let api = Api::new(&base, Some("tok".into())).unwrap();

        let guilds = api.publish_guilds().unwrap();
        assert_eq!(guilds.len(), 2);
        assert_eq!(guilds[0].guild_id, "111");
        assert_eq!(guilds[0].icon_url.as_deref(), Some("https://cdn.discordapp.com/icons/111/abc.png?size=96"));
        assert_eq!((guilds[1].name.as_deref(), guilds[1].icon_url.as_deref()), (None, None));

        let err = api.publish_guilds().unwrap_err();
        let http = http_error(&err).unwrap();
        assert_eq!((http.status, http.error.as_str()), (503, "bot_unavailable"));

        let queued = api.add_clip_posts("c1", &["111".into(), "222".into()]).unwrap();
        assert_eq!(queued.queued, vec!["222"]);

        let posts = api.my_posts().unwrap();
        assert_eq!(posts[0].clip_id, "c1");
        assert_eq!(posts[0].message_url, "https://discord.com/channels/111/5/6");

        let seen = seen.lock().unwrap();
        assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("GET", "/discord/guilds"));
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
        assert_eq!((seen[2].method.as_str(), seen[2].path.as_str()), ("POST", "/clips/c1/posts"));
        let body: serde_json::Value = serde_json::from_slice(&seen[2].body).unwrap();
        assert_eq!(body, serde_json::json!({ "guildIds": ["111", "222"] }));
        assert_eq!((seen[3].method.as_str(), seen[3].path.as_str()), ("GET", "/me/posts"));
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
