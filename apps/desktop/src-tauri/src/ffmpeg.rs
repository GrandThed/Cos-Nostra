//! ffmpeg invocations: encoder probing, media probing, AV1 and H.264 encodes, thumbnails.
//! Everything runs as a child process at below-normal priority with no console window, and
//! every encode writes to `<dst>.part` first so a crash never leaves a half file that looks
//! finished.
//!
//! The binary is a Tauri sidecar (`bundle.externalBin`), copied next to the app exe as
//! `ffmpeg.exe`. Releases ship the minimal build from `scripts/build-ffmpeg.sh`, which enables
//! only what this module uses; a new encoder, filter or format here has to be added there too.
//! There is no ffprobe: it would be a second copy of every library, so `probe` reads ffmpeg's
//! own description of its input and `keyframe_at_or_before` its `framecrc` packet list.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::settings::Quality;

/// The resolved ffmpeg executable.
#[derive(Debug, Clone)]
pub struct Binaries {
    pub ffmpeg: PathBuf,
}

/// ffmpeg encoder names chosen by the startup probe, e.g. `av1_amf` / `h264_amf`, or the
/// software fallbacks `libsvtav1` / `libx264`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Encoders {
    pub av1: String,
    pub h264: String,
}

/// What `probe` reports about a source file.
#[derive(Debug, Clone, Serialize)]
pub struct MediaInfo {
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub size: u64,
    /// The multi-part cut builds a filter graph per stream, so it has to know whether there
    /// is an audio stream to trim at all.
    pub has_audio: bool,
    /// How many audio streams the file has. A recording made with the microphone on has three
    /// (`capture::TRACK_MIX` and the two after it); everything else has one or none.
    pub audio_tracks: usize,
}

impl MediaInfo {
    /// True when the file keeps the microphone on a track of its own, so an encode can leave it
    /// out.
    pub fn has_mic_track(&self) -> bool {
        self.audio_tracks > crate::capture::TRACK_MIC
    }

    /// The audio stream an encode of this file uses: the mix, or the mix without the
    /// microphone when `include_mic` is off and the file has that track. `None` for a silent
    /// file.
    pub fn audio_stream(&self, include_mic: bool) -> Option<usize> {
        if self.audio_tracks == 0 {
            None
        } else if !include_mic && self.has_mic_track() {
            Some(crate::capture::TRACK_NO_MIC)
        } else {
            Some(crate::capture::TRACK_MIX)
        }
    }
}

/// One kept range of the source, in milliseconds. Serialised as-is into the clip database
/// and across the Tauri bridge, so the field names are part of the UI contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Which parts of the source to keep, in order. Empty keeps everything, which is what every
/// clip starts as; one segment is a trim; more than one is a cut with the middles removed
/// and the rest joined back together.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cut {
    pub segments: Vec<Segment>,
}

/// Shortest kept part the editor may ask for. Below this a part is a few frames that the
/// encoder's keyframe placement cannot represent sensibly.
pub const MIN_SEGMENT_MS: i64 = 100;

/// How close to the ends a single segment may be and still count as "the whole clip". The
/// editor measures the duration from the browser's decoder, `probe` from the container,
/// and the two disagree by a frame or two.
const WHOLE_TOLERANCE_MS: i64 = 60;

impl Cut {
    pub fn whole() -> Cut {
        Cut::default()
    }

    pub fn is_whole(&self) -> bool {
        self.segments.is_empty()
    }

    /// Checks and tidies segments against the source they apply to: clamped to the clip,
    /// sorted, each at least `MIN_SEGMENT_MS` long, none overlapping (touching ones merge).
    /// A cut that keeps the whole clip comes back as `whole`, so "no cut" has one spelling.
    pub fn normalize(segments: &[Segment], duration_ms: i64) -> Result<Cut> {
        // No parts at all is how the editor spells "the whole recording".
        if segments.is_empty() {
            return Ok(Cut::whole());
        }
        let mut segs: Vec<Segment> = segments
            .iter()
            .map(|s| Segment {
                start_ms: s.start_ms.max(0),
                end_ms: s.end_ms.min(duration_ms),
            })
            .collect();
        segs.sort_by_key(|s| (s.start_ms, s.end_ms));
        let mut out: Vec<Segment> = Vec::with_capacity(segs.len());
        for s in segs {
            if s.end_ms - s.start_ms < MIN_SEGMENT_MS {
                bail!(
                    "a kept part must be at least {MIN_SEGMENT_MS} ms long, got {} ms at {} ms",
                    s.end_ms - s.start_ms,
                    s.start_ms
                );
            }
            if let Some(last) = out.last_mut() {
                if s.start_ms < last.end_ms {
                    bail!("kept parts overlap at {} ms", s.start_ms);
                }
                if s.start_ms == last.end_ms {
                    last.end_ms = s.end_ms;
                    continue;
                }
            }
            out.push(s);
        }
        if out.is_empty() {
            bail!("a cut has to keep at least one part");
        }
        let whole = out.len() == 1
            && out[0].start_ms <= WHOLE_TOLERANCE_MS
            && out[0].end_ms >= duration_ms - WHOLE_TOLERANCE_MS;
        Ok(if whole { Cut::whole() } else { Cut { segments: out } })
    }

    /// How much of a `duration_ms` source survives this cut.
    pub fn kept_ms(&self, duration_ms: i64) -> i64 {
        if self.is_whole() {
            duration_ms
        } else {
            self.segments.iter().map(|s| s.end_ms - s.start_ms).sum()
        }
    }

    /// The source time that is `fraction` of the way through the kept footage, which is where
    /// the thumbnail is taken so it shows a frame that is actually in the clip.
    pub fn source_time_at(&self, fraction: f64, duration_ms: i64) -> i64 {
        let fraction = fraction.clamp(0.0, 1.0);
        if self.is_whole() {
            return (duration_ms as f64 * fraction) as i64;
        }
        let mut left = (self.kept_ms(duration_ms) as f64 * fraction) as i64;
        for s in &self.segments {
            let len = s.end_ms - s.start_ms;
            if left < len {
                return s.start_ms + left;
            }
            left -= len;
        }
        self.segments.last().map(|s| s.end_ms).unwrap_or(0)
    }
}

/// Where an encode reports its progress. `on` is called with 0.0..=1.0 on the calling thread,
/// roughly twice a second, and `duration_ms` is what that fraction is measured against.
pub struct Progress<'a> {
    pub duration_ms: i64,
    pub on: &'a dyn Fn(f32),
}

/// One encode: which file, where it goes, which parts of it, and who is watching.
struct Job<'a> {
    src: &'a Path,
    dst: &'a Path,
    cut: &'a Cut,
    /// Which audio stream of `src` to keep, `None` for none; see `MediaInfo::audio_stream`.
    audio: Option<usize>,
    progress: Option<&'a Progress<'a>>,
}

pub const SOFTWARE_AV1: &str = "libsvtav1";
pub const SOFTWARE_H264: &str = "libx264";

/// BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW. A game in the foreground keeps its frame
/// rate and no console flashes up while encoding.
const CREATION_FLAGS: u32 = 0x4000 | 0x0800_0000;

/// Keyframe interval in frames (two seconds at 60 fps) so seeking and trimming stay cheap.
const GOP: &str = "120";

/// Finds the sidecar `ffmpeg.exe` next to the running exe, falling back to whatever is on
/// PATH. Errors if neither can be found.
pub fn locate() -> Result<Binaries> {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let bins = Binaries {
            ffmpeg: dir.join("ffmpeg.exe"),
        };
        if bins.ffmpeg.is_file() && works(&bins.ffmpeg) {
            log::info!("using sidecar ffmpeg in {}", dir.display());
            // Builds before the minimal ffmpeg also shipped a ~160 MB ffprobe.exe, which an
            // update installs over but never removes.
            let stale = dir.join("ffprobe.exe");
            if stale.is_file() {
                match fs::remove_file(&stale) {
                    Ok(()) => log::info!("removed the unused {}", stale.display()),
                    Err(e) => log::warn!("could not remove the unused {}: {e}", stale.display()),
                }
            }
            return Ok(bins);
        }
    }

    let bins = Binaries {
        ffmpeg: PathBuf::from("ffmpeg"),
    };
    if works(&bins.ffmpeg) {
        log::info!("using ffmpeg from PATH");
        return Ok(bins);
    }
    bail!("ffmpeg.exe was found neither next to the app nor on PATH")
}

/// True when `exe -version` can be spawned and exits 0; this is the `where.exe` check that
/// also survives a broken or non-executable file.
fn works(exe: &Path) -> bool {
    command(exe)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A child process with the priority and window flags every ffmpeg call uses.
fn command(exe: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(exe);
    cmd.creation_flags(CREATION_FLAGS);
    cmd.stdin(Stdio::null());
    cmd
}

/// Common ffmpeg prefix: quiet, no prompts, overwrite.
fn ffmpeg_command(bins: &Binaries) -> Command {
    let mut cmd = command(&bins.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y"]);
    cmd
}

/// Half the logical cores, at least one, for software encoders and decoders.
fn threads() -> String {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 2).max(1).to_string()
}

/// Runs an encode while feeding `-progress` output to the caller.
///
/// ffmpeg writes key=value lines to stdout with `-progress pipe:1`, of which only the elapsed
/// output time interests us. stderr is drained on its own thread: with both pipes open, a full
/// one would block the child forever.
fn run_progress(mut cmd: Command, what: &str, progress: &Progress<'_>) -> Result<()> {
    use std::io::{BufRead, BufReader, Read};

    cmd.args(["-progress", "pipe:1", "-nostats"]);
    log::debug!("{what}: {cmd:?}");
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("{what}: failed to spawn {:?}", cmd.get_program()))?;

    let mut errors = child.stderr.take().expect("stderr is piped");
    let drain = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = errors.read_to_string(&mut text);
        text
    });

    let total = progress.duration_ms.max(1) as f64;
    for line in BufReader::new(child.stdout.take().expect("stdout is piped")).lines() {
        let Ok(line) = line else { break };
        // `out_time_us` is microseconds. `out_time_ms` is a misnomer for the same unit, kept
        // as a fallback for builds that do not print the newer key.
        let Some(micros) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        else {
            continue;
        };
        if let Ok(micros) = micros.trim().parse::<i64>() {
            (progress.on)((micros as f64 / 1000.0 / total).clamp(0.0, 1.0) as f32);
        }
    }

    let status = child.wait().with_context(|| format!("{what}: waiting for ffmpeg"))?;
    let stderr = drain.join().unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("{}", stderr_tail(&stderr)))
            .with_context(|| format!("{what}: ffmpeg exited with {status}"));
    }
    (progress.on)(1.0);
    Ok(())
}

/// Runs the command, returning its output or an error carrying the tail of stderr.
fn run(mut cmd: Command, what: &str) -> Result<Output> {
    log::debug!("{what}: {cmd:?}");
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("{what}: failed to spawn {:?}", cmd.get_program()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("{}", stderr_tail(&stderr)))
            .with_context(|| format!("{what}: ffmpeg exited with {}", output.status));
    }
    Ok(output)
}

/// The last lines of a failed run's stderr, which is where ffmpeg says what went wrong.
fn stderr_tail(stderr: &str) -> String {
    let tail: Vec<&str> = stderr.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
    tail.join("\n")
}

/// Runs a two second test encode with each hardware AV1 encoder (nvenc, amf, qsv in that
/// order) and each hardware H.264 encoder, keeping the first that exits 0. Falls back to
/// `libsvtav1` and `libx264`. Slow (several seconds); cache the result in settings.
pub fn probe_encoders(bins: &Binaries) -> Encoders {
    let av1 = first_working(bins, &["av1_nvenc", "av1_amf", "av1_qsv"]).unwrap_or(SOFTWARE_AV1);
    let h264 = first_working(bins, &["h264_nvenc", "h264_amf", "h264_qsv"]).unwrap_or(SOFTWARE_H264);
    log::info!("encoders: av1={av1} h264={h264}");
    Encoders {
        av1: av1.into(),
        h264: h264.into(),
    }
}

/// The encoders to actually use, given what the probe found and which engine the user picked.
///
/// `Gpu` uses the probed hardware encoders; `Cpu` ignores them and encodes in software, which
/// on the measured machine is both smaller and better (see `av1_args`). The replay buffer is
/// unaffected - it has to keep up with a game in real time and is always hardware.
pub fn encoders_for(probed: &Encoders, engine: crate::settings::EncodeEngine) -> Encoders {
    match engine {
        crate::settings::EncodeEngine::Gpu => probed.clone(),
        crate::settings::EncodeEngine::Cpu => Encoders {
            av1: SOFTWARE_AV1.into(),
            h264: SOFTWARE_H264.into(),
        },
    }
}

fn first_working<'a>(bins: &Binaries, candidates: &[&'a str]) -> Option<&'a str> {
    candidates.iter().copied().find(|encoder| {
        let started = Instant::now();
        let mut cmd = ffmpeg_command(bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-t", "2"])
            .args(["-c:v", encoder, "-f", "null", "-"]);
        match run(cmd, &format!("probe {encoder}")) {
            Ok(_) => {
                log::info!("encoder {encoder}: ok ({} ms)", started.elapsed().as_millis());
                true
            }
            Err(e) => {
                log::info!("encoder {encoder}: unavailable ({e:#})");
                false
            }
        }
    })
}

/// ffmpeg's description of an input file: the `Input #0` block it prints to stderr.
#[derive(Debug, Default, PartialEq)]
struct InputDump {
    duration_ms: Option<i64>,
    /// The container's start time in seconds, what ffprobe calls `format.start_time`.
    start: f64,
    streams: Vec<DumpStream>,
}

#[derive(Debug, Default, PartialEq)]
struct DumpStream {
    /// `Video`, `Audio`, `Data`, ...
    kind: String,
    /// Only the tests assert on codec names; the app trusts the encoder it asked for.
    #[cfg_attr(not(test), allow(dead_code))]
    codec: String,
    width: u32,
    height: u32,
    /// The stream's `r_frame_rate`, which ffmpeg prints as `tbr` rounded to two decimals.
    fps: f64,
}

/// Reads the block ffmpeg prints about its input before doing anything else with it:
///
/// ```text
/// Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
///   Duration: 00:00:06.00, start: 0.000000, bitrate: 4339 kb/s
///   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 4227 kb/s, 60 fps, 60 tbr, 15360 tbn (default)
///   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 96 kb/s (default)
/// ```
///
/// That is text for people, not an interface, but it is `av_dump_format`'s and has kept this
/// shape for well over a decade; the tests pin it against the ffmpeg they run. `Duration` has
/// centisecond precision, finer than any tolerance the callers use. `None` when there is no
/// such block, which is how ffmpeg says it could not open the file at all.
fn parse_input_dump(stderr: &str) -> Option<InputDump> {
    let mut lines = stderr.lines().skip_while(|l| !l.starts_with("Input #0"));
    lines.next()?;
    let mut dump = InputDump::default();
    // The block ends at the first line that is not indented: "Stream mapping:", "Output #0",
    // or the complaint that no output was given.
    for line in lines.take_while(|l| l.starts_with(' ')).map(str::trim_start) {
        if let Some(rest) = line.strip_prefix("Duration: ") {
            let mut fields = rest.split(", ");
            dump.duration_ms = fields.next().and_then(parse_clock);
            if let Some(start) = fields.find_map(|f| f.strip_prefix("start: ")) {
                dump.start = start.trim().parse().unwrap_or(0.0);
            }
        } else if let Some(rest) = line.strip_prefix("Stream #0:") {
            // `0[0x1](und): Video: h264 ...`. The id holds colons, but never a colon and a space.
            let Some((kind, desc)) = rest.split_once(": ").and_then(|(_, rest)| rest.split_once(": ")) else {
                continue;
            };
            dump.streams.push(parse_stream(kind, desc));
        }
    }
    Some(dump)
}

/// One stream line after its kind: the codec first, then comma-separated facts in no fixed
/// order, recognised by their shape (`1280x720 ...`, `60 tbr`).
fn parse_stream(kind: &str, desc: &str) -> DumpStream {
    let parts = split_top_level(desc);
    let mut stream = DumpStream {
        kind: kind.to_string(),
        codec: parts[0].split_whitespace().next().unwrap_or_default().to_string(),
        ..DumpStream::default()
    };
    for part in &parts[1..] {
        let first = part.split_whitespace().next().unwrap_or_default();
        if let Some((w, h)) = first.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.parse(), h.parse()) {
                (stream.width, stream.height) = (w, h);
            }
        }
        // `fps` is the average rate and comes first; `tbr` is `r_frame_rate` and wins.
        if let Some(rate) = part.strip_suffix(" tbr") {
            stream.fps = parse_rate(rate);
        } else if let Some(rate) = part.strip_suffix(" fps") {
            if stream.fps == 0.0 {
                stream.fps = parse_rate(rate);
            }
        }
    }
    stream
}

/// Splits on the commas that are not inside `(...)` or `[...]`, so `yuv420p(tv, bt709)` stays
/// one part.
fn split_top_level(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    for (i, b) in s.bytes().enumerate() {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(s[start..].trim());
    parts
}

/// A rate as ffmpeg prints it: `60`, `59.94`, or `1k` for 1000.
fn parse_rate(s: &str) -> f64 {
    let s = s.trim();
    match s.strip_suffix('k') {
        Some(thousands) => thousands.parse::<f64>().map(|v| v * 1000.0).unwrap_or(0.0),
        None => s.parse().unwrap_or(0.0),
    }
}

/// `00:01:02.50` -> 62500. `N/A` (a container that does not know its length) -> `None`.
fn parse_clock(s: &str) -> Option<i64> {
    let mut parts = s.trim().splitn(3, ':');
    let hours: i64 = parts.next()?.parse().ok()?;
    let minutes: i64 = parts.next()?.parse().ok()?;
    let secs: f64 = parts.next()?.parse().ok()?;
    Some(((hours * 3600 + minutes * 60) * 1000) + (secs * 1000.0).round() as i64)
}

/// Opens `src` with no output, which makes ffmpeg describe the input and stop. It exits
/// non-zero for want of an output, so success is the description being there.
fn inspect(bins: &Binaries, src: &Path) -> Result<InputDump> {
    let mut cmd = ffmpeg_command(bins);
    cmd.arg("-i").arg(src);
    log::debug!("probe: {cmd:?}");
    let output = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("probe {}: failed to spawn {:?}", src.display(), cmd.get_program()))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_input_dump(&stderr)
        .ok_or_else(|| anyhow!("{}", stderr_tail(&stderr)))
        .with_context(|| format!("probe {}: ffmpeg could not read it", src.display()))
}

/// Duration, dimensions, frame rate and size of a video file.
pub fn probe(bins: &Binaries, src: &Path) -> Result<MediaInfo> {
    let dump = inspect(bins, src)?;
    let video = dump
        .streams
        .iter()
        .find(|s| s.kind == "Video")
        .with_context(|| format!("probe {}: no video stream", src.display()))?;
    let duration_ms = dump
        .duration_ms
        .with_context(|| format!("probe {}: no duration", src.display()))?;
    Ok(MediaInfo {
        duration_ms,
        width: video.width,
        height: video.height,
        fps: video.fps,
        size: fs::metadata(src).map(|m| m.len()).unwrap_or(0),
        has_audio: dump.streams.iter().any(|s| s.kind == "Audio"),
        audio_tracks: dump.streams.iter().filter(|s| s.kind == "Audio").count(),
    })
}

fn seconds(ms: i64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

/// Input options for a cut: seek before `-i` so footage outside the kept range is never
/// decoded. `-ss` on the input is frame accurate (ffmpeg decodes from the previous keyframe
/// and drops what comes before the point), and resets timestamps so the seek point is zero.
///
/// One segment is just `-ss`/`-to`. Several seek to the first start and stop at the last
/// end, then a filter graph trims each kept part out of that span and concatenates them, so
/// the middles disappear in the same pass that encodes. The trim times are relative to the
/// seek point because that is where the decoded timestamps now start.
///
/// The streams are always mapped by hand: a recording with the microphone on has three audio
/// tracks, and ffmpeg's own pick would be whichever it likes best rather than the one asked for.
fn input_args(cmd: &mut Command, src: &Path, cut: &Cut, audio: Option<usize>) {
    match cut.segments.as_slice() {
        [] => {
            cmd.arg("-i").arg(src);
            map_streams(cmd, audio);
        }
        [one] => {
            cmd.args(["-ss", &seconds(one.start_ms), "-to", &seconds(one.end_ms)]);
            cmd.arg("-i").arg(src);
            map_streams(cmd, audio);
        }
        many => {
            let base = many[0].start_ms;
            let end = many[many.len() - 1].end_ms;
            cmd.args(["-ss", &seconds(base), "-to", &seconds(end)]);
            cmd.arg("-i").arg(src);
            cmd.args(["-filter_complex", &concat_graph(many, base, audio)]);
            cmd.args(["-map", "[v]"]);
            if audio.is_some() {
                cmd.args(["-map", "[a]"]);
            }
        }
    }
}

fn map_streams(cmd: &mut Command, audio: Option<usize>) {
    cmd.args(["-map", "0:v:0"]);
    if let Some(track) = audio {
        cmd.args(["-map", &format!("0:a:{track}")]);
    }
}

/// `trim`/`atrim` each part out of the decoded span, restart its timestamps, and `concat`
/// them in order. Without an audio stream the graph only carries video: naming `[0:a]` on a
/// silent file is a hard error, not an empty stream.
fn concat_graph(segments: &[Segment], base_ms: i64, audio: Option<usize>) -> String {
    let mut graph = String::new();
    let mut inputs = String::new();
    for (i, s) in segments.iter().enumerate() {
        let (a, b) = (seconds(s.start_ms - base_ms), seconds(s.end_ms - base_ms));
        graph.push_str(&format!("[0:v:0]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];"));
        inputs.push_str(&format!("[v{i}]"));
        if let Some(track) = audio {
            graph.push_str(&format!("[0:a:{track}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}];"));
            inputs.push_str(&format!("[a{i}]"));
        }
    }
    graph.push_str(&format!(
        "{inputs}concat=n={}:v=1:a={}[v]",
        segments.len(),
        u8::from(audio.is_some())
    ));
    if audio.is_some() {
        graph.push_str("[a]");
    }
    graph
}

/// Video encoder settings, measured with `scripts/bench-encoders.mjs`.
///
/// Every software preset here is **capped CRF**: a constant-quality target plus a ceiling the
/// encoder may not exceed. That is not the same as a bitrate target, and the difference is the
/// point. On an ordinary clip the ceiling is never reached, so the file comes out as small as
/// the content allows (a desktop capture lands around 3 MB for 26 s). On high-motion gameplay
/// the ceiling engages and trims the clip instead of letting it balloon to 50 MB. Sizes stay
/// in a band the user can predict without paying for it on every clip.
///
/// Two measured facts drive the numbers, both from a 28 s 1080p60 high-motion capture:
///
/// - **`libsvtav1` is far ahead of `av1_amf`.** At matched size (30.6 MB against 30.8 MB) it
///   scored 93.43 VMAF where AMD's hardware AV1 interpolates to about 89.3 and `h264_amf`
///   managed 88.54. AMD's AV1 is barely better than AMD's own H.264, so hardware AV1 is the
///   fast option, not the good one.
/// - **The ceiling is a safety net, not a size dial.** Clamping is a far worse way to reach a
///   size than simply asking for less quality: at a 5 Mbps cap, crf 34 scored 85.21 at 17.0 MB,
///   while plain crf 46 with no cap at all scored **90.94 at 20.3 MB**. So each level picks its
///   CRF for the quality it wants and sets `-maxrate` high enough that ordinary clips never
///   touch it; only a pathological clip gets clamped.
///
/// Preset 6 is the chosen speed: about 40 s for a 28 s clip. Preset 4 was measured and is
/// worth roughly 2 VMAF *when the ceiling binds* (85.21 against 83.13 at a 5 Mbps cap) and
/// within 0.1 VMAF of preset 6 when it does not. Since the ceilings above are set not to bind,
/// preset 4 would double the encode time to buy almost nothing.
///
/// AMF's quantizer scale is 0-255, not the 0-51 that H.264-style encoders use: `-qp_i 28`
/// there asks for near-lossless, which is how AV1 once came out twice the size of the H.264
/// copy. NVENC's `-cq` and QSV's `-global_quality` really are 0-51. **Neither NVENC nor QSV
/// has ever been measured** - this is an AMD machine - so their rows carry numbers inferred
/// from their own scales and stay behind `probe_encoders`.
fn av1_args(encoder: &str, quality: Quality) -> Vec<&'static str> {
    // (crf, ceiling, buffer) for libsvtav1; the hardware rows carry their own quantizers.
    match encoder {
        "av1_amf" => match quality {
            // Hardware AMF has no usable capped mode: `-rc qvbr` measured *below* the plain
            // cqp curve (86.82 at 31 MB against cqp 128's 88.22 at 27 MB), so this is
            // constant quantizer and genuinely uncapped. Choosing the GPU means giving up the
            // size ceiling, which is why the CPU is the default.
            Quality::Small => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "128", "-qp_p", "128"],
            Quality::Balanced => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "110", "-qp_p", "110"],
            Quality::High => vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "95", "-qp_p", "95"],
        },
        "av1_nvenc" => match quality {
            Quality::Small => vec!["-cq", "38", "-preset", "p5", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-cq", "32", "-preset", "p5", "-maxrate", "10M", "-bufsize", "20M"],
            Quality::High => vec!["-cq", "28", "-preset", "p5", "-maxrate", "16M", "-bufsize", "32M"],
        },
        "av1_qsv" => match quality {
            Quality::Small => vec!["-global_quality", "38", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-global_quality", "32", "-maxrate", "10M", "-bufsize", "20M"],
            Quality::High => vec!["-global_quality", "28", "-maxrate", "16M", "-bufsize", "32M"],
        },
        // libsvtav1. `-maxrate` is what turns CRF into capped CRF; SVT reports it as
        // "BRC mode: capped CRF". Do not reach for `-svtav1-params mbr=`, which expects kbps
        // and silently clamps a bytes-per-second value to 100 Mbps, leaving the cap off.
        _ => match quality {
            Quality::Small => vec![
                "-preset", "6", "-crf", "46", "-svtav1-params", "tune=0",
                "-maxrate", "8M", "-bufsize", "16M",
            ],
            Quality::Balanced => vec![
                "-preset", "6", "-crf", "40", "-svtav1-params", "tune=0",
                "-maxrate", "12M", "-bufsize", "24M",
            ],
            Quality::High => vec![
                "-preset", "6", "-crf", "34", "-svtav1-params", "tune=0",
                "-maxrate", "20M", "-bufsize", "40M",
            ],
        },
    }
}

/// The H.264 copy is **not** a fallback that nobody watches. `og:video` on the player page
/// points at it, so Discord's inline player streams H.264 to every viewer in the server and
/// never touches the AV1 file - confirmed from a live embed object, which carries
/// `video.url = .../clips/<id>/h264` behind a discordapp.net proxy. It is the hot copy and it
/// gets a real quality target here, not the starved 8 Mbps bitrate cap it used to carry, which
/// wasted bits on easy clips (7.7 MB where AV1 needed 3.1 MB for a better score) and starved
/// on hard ones (88.54 VMAF).
fn h264_args(encoder: &str, quality: Quality) -> Vec<&'static str> {
    match encoder {
        "h264_amf" => match quality {
            Quality::Small => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "4M", "-maxrate", "6M"],
            Quality::Balanced => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "8M", "-maxrate", "12M"],
            Quality::High => vec!["-quality", "quality", "-rc", "vbr_peak", "-b:v", "14M", "-maxrate", "20M"],
        },
        "h264_nvenc" => match quality {
            Quality::Small => vec!["-preset", "p5", "-rc", "vbr", "-cq", "28", "-b:v", "0", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-maxrate", "20M", "-bufsize", "40M"],
        },
        "h264_qsv" => match quality {
            Quality::Small => vec!["-global_quality", "28", "-maxrate", "6M", "-bufsize", "12M"],
            Quality::Balanced => vec!["-global_quality", "23", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-global_quality", "19", "-maxrate", "20M", "-bufsize", "40M"],
        },
        // libx264, capped CRF like the AV1 software path. `medium` rather than `veryfast`:
        // encoding runs after the game exits and the extra seconds buy real quality.
        _ => match quality {
            Quality::Small => vec!["-preset", "medium", "-crf", "26", "-maxrate", "8M", "-bufsize", "16M"],
            Quality::Balanced => vec!["-preset", "medium", "-crf", "22", "-maxrate", "12M", "-bufsize", "24M"],
            Quality::High => vec!["-preset", "medium", "-crf", "19", "-maxrate", "20M", "-bufsize", "40M"],
        },
    }
}

fn is_software(encoder: &str) -> bool {
    !(encoder.ends_with("_amf") || encoder.ends_with("_nvenc") || encoder.ends_with("_qsv"))
}

/// Encodes `src` to `dst` through `<dst>.part`, renaming only on success.
fn encode(
    bins: &Binaries,
    encoder: &str,
    video_args: &[&str],
    audio_args: &[&str],
    job: Job<'_>,
) -> Result<()> {
    let Job { src, dst, cut, audio, progress } = job;
    let part = part_path(dst);
    let _ = fs::remove_file(&part);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error"]);
    if is_software(encoder) {
        cmd.args(["-threads", &threads()]);
    }
    input_args(&mut cmd, src, cut, audio);
    cmd.args(["-c:v", encoder]).args(video_args).args(["-g", GOP]);
    cmd.args(audio_args);
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&part);

    let started = Instant::now();
    let what = format!("encode {encoder} {}", src.display());
    let result = match progress {
        Some(p) => run_progress(cmd, &what, p),
        None => run(cmd, &what).map(drop),
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, dst).with_context(|| format!("rename {} to {}", part.display(), dst.display()))?;
    log::info!(
        "encoded {} with {encoder} in {:.1} s",
        dst.display(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn part_path(dst: &Path) -> PathBuf {
    let mut name = dst.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// AV1 in MP4 with Opus audio, at the user's chosen quality. Keyframe every two seconds.
/// `audio` is the audio stream of `src` to keep, `None` for a silent file
/// (`MediaInfo::audio_stream`).
pub fn encode_av1(
    bins: &Binaries,
    encoder: &str,
    quality: Quality,
    src: &Path,
    dst: &Path,
    cut: &Cut,
    audio: Option<usize>,
    progress: Option<&Progress<'_>>,
) -> Result<()> {
    encode(
        bins,
        encoder,
        &av1_args(encoder, quality),
        &["-c:a", "libopus", "-b:a", "128k"],
        Job { src, dst, cut, audio, progress },
    )
}

/// H.264 in MP4 with AAC audio: the copy Discord's inline player actually streams, and the
/// one old devices fall back to. See `h264_args` for why it is not the afterthought its name
/// suggests.
pub fn encode_h264(
    bins: &Binaries,
    encoder: &str,
    quality: Quality,
    src: &Path,
    dst: &Path,
    cut: &Cut,
    audio: Option<usize>,
    progress: Option<&Progress<'_>>,
) -> Result<()> {
    encode(
        bins,
        encoder,
        &h264_args(encoder, quality),
        &["-c:a", "aac", "-b:a", "160k"],
        Job { src, dst, cut, audio, progress },
    )
}

/// Single JPEG frame at `at_ms`, 640 pixels wide.
pub fn thumbnail(bins: &Binaries, src: &Path, dst: &Path, at_ms: i64) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error", "-ss", &seconds(at_ms.max(0))])
        .arg("-i")
        .arg(src)
        .args(["-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-f", "image2"])
        .arg(dst);
    run(cmd, &format!("thumbnail {}", src.display()))?;
    Ok(())
}

/// Presentation times, in seconds, of the keyframes in a `framecrc` listing of stream 0:
///
/// ```text
/// #tb 0: 1/15360
/// 0,      14848,      15360,      256,    26425, 0xc1af470d
/// 0,      15104,      16128,      256,     1180, 0x2b3e6c1a, F=0x0
/// ```
///
/// The columns are stream, dts, pts, duration, size and checksum. `F=` is only printed for a
/// packet whose flags are anything but exactly "keyframe", so a keyframe is a line without it,
/// or with bit 0 set in it.
fn keyframe_times(listing: &str) -> Vec<f64> {
    let mut time_base = None;
    let mut times = Vec::new();
    for line in listing.lines() {
        if let Some(tb) = line.strip_prefix("#tb 0: ") {
            time_base = tb.split_once('/').and_then(|(num, den)| {
                let (num, den) = (num.trim().parse::<f64>().ok()?, den.trim().parse::<f64>().ok()?);
                (den != 0.0).then_some((num, den))
            });
            continue;
        }
        let Some((num, den)) = time_base else { continue };
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if line.starts_with('#') || fields.len() < 6 || fields[0] != "0" {
            continue;
        }
        let key = match fields[6..].iter().find_map(|f| f.strip_prefix("F=0x")) {
            None => true,
            Some(hex) => u32::from_str_radix(hex, 16).is_ok_and(|flags| flags & 1 == 1),
        };
        if let (true, Ok(pts)) = (key, fields[2].parse::<i64>()) {
            // Multiply before dividing: `pts * (1 / den)` lands a hair off whole seconds.
            times.push(pts as f64 * num / den);
        }
    }
    times
}

/// How far back from a cut point to look for its keyframe. Far past any GOP a recorder uses.
const KEYFRAME_LOOKBACK_MS: i64 = 30_000;

/// The time of the last video keyframe at or before `at_ms`, measured from the start of the
/// file the way `-ss` measures it. A stream copy can only begin on a keyframe, so this is
/// where a copy that wants `at_ms` really starts. Reads packets without decoding them, and only
/// around the point, so it costs the same on a three hour recording as on a clip.
pub fn keyframe_at_or_before(bins: &Binaries, src: &Path, at_ms: i64) -> Result<i64> {
    if at_ms <= 0 {
        return Ok(0);
    }
    let from = (at_ms - KEYFRAME_LOOKBACK_MS).max(0);
    // Stream-copy the window into `framecrc`, which lists every packet with its flags and
    // never decodes a frame. `-copyts` keeps the demuxer's own timestamps, so subtracting the
    // container start time (from the input description on stderr) measures from the start of
    // the file the way `-ss` does.
    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-nostats", "-copyts", "-ss", &seconds(from), "-t", &seconds(at_ms + 500 - from)])
        .arg("-i")
        .arg(src)
        .args(["-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"]);
    let output = run(cmd, &format!("keyframes of {}", src.display()))?;
    let start = parse_input_dump(&String::from_utf8_lossy(&output.stderr)).map_or(0.0, |d| d.start);
    let best = keyframe_times(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .map(|t| ((t - start) * 1000.0).round() as i64)
        .filter(|&ms| ms <= at_ms)
        .max();
    match best {
        Some(ms) => Ok(ms.clamp(0, at_ms)),
        None => {
            log::warn!(
                "no keyframe found before {at_ms} ms in {}; cutting there anyway",
                src.display()
            );
            Ok(at_ms)
        }
    }
}

/// Copies `from_ms..to_ms` of `src` into `dst` without re-encoding, video and any audio.
/// `from_ms` should come from `keyframe_at_or_before`: starting exactly on a keyframe is what
/// makes the new file's first frame `from_ms` of the old one.
pub fn copy_range(bins: &Binaries, src: &Path, from_ms: i64, to_ms: i64, dst: &Path) -> Result<()> {
    if to_ms <= from_ms {
        bail!("copy {}: empty range {from_ms}..{to_ms}", src.display());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let part = part_path(dst);
    let mut cmd = ffmpeg_command(bins);
    // Seeking a millisecond past the keyframe still lands on it, and never on the one before
    // when the point's timestamp rounds down.
    cmd.args(["-v", "error", "-ss", &seconds(from_ms + 1)])
        .arg("-i")
        .arg(src)
        .args(["-t", &seconds(to_ms - from_ms)])
        .args(["-map", "0:v:0", "-map", "0:a?", "-c", "copy"])
        .args(["-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&part);
    let started = Instant::now();
    run(cmd, &format!("copy {}", src.display()))?;
    fs::rename(&part, dst).with_context(|| format!("rename {} -> {}", part.display(), dst.display()))?;
    log::info!(
        "copied {:.1}s of {} in {:.1}s",
        (to_ms - from_ms) as f64 / 1000.0,
        src.display(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// What an export writes for its picture.
#[derive(Debug, Clone)]
pub enum ExportVideo {
    /// The recorded stream as it is. The range must start on a keyframe
    /// (`keyframe_at_or_before`), since a copy cannot start anywhere else.
    Copy,
    Encode {
        encoder: String,
        /// Rate control, from `export::quality_args` or `export::bitrate_args`.
        args: Vec<String>,
        /// Scale to this height, keeping the shape; `None` keeps the source's.
        height: Option<u32>,
        /// Frames per second; `None` keeps the source's.
        fps: Option<u32>,
        /// The source's rate, for the keyframe interval.
        source_fps: f64,
    },
}

/// One export of a clip into a file the user picked.
#[derive(Debug, Clone)]
pub struct Export<'a> {
    pub src: &'a Path,
    pub dst: &'a Path,
    /// The part of `src` to write; `None` is all of it.
    pub range: Option<Segment>,
    /// Which audio stream to carry, `None` for none (`MediaInfo::audio_stream`).
    pub audio: Option<usize>,
    pub audio_kbps: u32,
    pub video: ExportVideo,
}

/// Writes an export through `<dst>.part`, like every encode, as an MP4 with AAC audio that
/// plays anywhere: H.264 and H.265 are tagged the way Apple players want, and the index goes
/// at the front so a browser or Discord can start playing before it has the whole file.
pub fn export(bins: &Binaries, job: &Export<'_>, progress: Option<&Progress<'_>>) -> Result<()> {
    let part = part_path(job.dst);
    let _ = fs::remove_file(&part);
    if let Some(parent) = job.dst.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error"]);
    match (&job.video, job.range) {
        (ExportVideo::Copy, Some(range)) => {
            // As in `copy_range`: a millisecond past the keyframe still lands on it.
            cmd.args(["-ss", &seconds(range.start_ms + 1)]).arg("-i").arg(job.src);
            cmd.args(["-t", &seconds(range.end_ms - range.start_ms)]);
        }
        (ExportVideo::Encode { encoder, .. }, Some(range)) => {
            if is_software(encoder) {
                cmd.args(["-threads", &threads()]);
            }
            cmd.args(["-ss", &seconds(range.start_ms), "-to", &seconds(range.end_ms)]).arg("-i").arg(job.src);
        }
        (video, None) => {
            if let ExportVideo::Encode { encoder, .. } = video {
                if is_software(encoder) {
                    cmd.args(["-threads", &threads()]);
                }
            }
            cmd.arg("-i").arg(job.src);
        }
    }
    map_streams(&mut cmd, job.audio);
    match &job.video {
        ExportVideo::Copy => {
            cmd.args(["-c:v", "copy", "-avoid_negative_ts", "make_zero"]);
        }
        ExportVideo::Encode { encoder, args, height, fps, source_fps } => {
            cmd.args(["-c:v", encoder]).args(args);
            if let Some(h) = height {
                // Even width, as every 4:2:0 encoder needs.
                cmd.args(["-vf", &format!("scale=-2:{h}:flags=lanczos")]);
            }
            if let Some(f) = fps {
                cmd.args(["-r", &f.to_string()]);
            }
            let rate = fps.map(f64::from).unwrap_or(*source_fps).max(1.0);
            cmd.args(["-g", &((rate * 2.0).round() as u32).to_string()]);
            if is_software(encoder) {
                cmd.args(["-pix_fmt", "yuv420p"]);
            }
            if encoder.starts_with("hevc") {
                cmd.args(["-tag:v", "hvc1"]);
            }
        }
    }
    if job.audio.is_some() {
        cmd.args(["-c:a", "aac", "-b:a", &format!("{}k", job.audio_kbps)]);
    }
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&part);

    let started = Instant::now();
    let what = format!("export {}", job.src.display());
    let result = match progress {
        Some(p) => run_progress(cmd, &what, p),
        None => run(cmd, &what).map(drop),
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, job.dst).with_context(|| format!("rename {} to {}", part.display(), job.dst.display()))?;
    log::info!("exported {} in {:.1} s", job.dst.display(), started.elapsed().as_secs_f64());
    Ok(())
}

/// The first hardware H.265 encoder that works on this machine, if any. There is no software
/// fallback: x265 is not in the shipped ffmpeg.
pub fn probe_hevc(bins: &Binaries) -> Option<String> {
    first_working(bins, &["hevc_nvenc", "hevc_amf", "hevc_qsv"]).map(str::to_string)
}

/// Joins files that share codecs and settings end to end, without re-encoding.
pub fn concat_copy(bins: &Binaries, parts: &[PathBuf], dst: &Path) -> Result<()> {
    let list = {
        let mut name = dst.as_os_str().to_os_string();
        name.push(".concat.txt");
        PathBuf::from(name)
    };
    let body: String = parts
        .iter()
        .map(|p| format!("file '{}'\n", p.display().to_string().replace('\'', r"'\''")))
        .collect();
    fs::write(&list, body).with_context(|| format!("write {}", list.display()))?;
    let part = part_path(dst);
    let mut cmd = ffmpeg_command(bins);
    cmd.args(["-v", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&part);
    let result = run(cmd, &format!("concat into {}", dst.display()));
    let _ = fs::remove_file(&list);
    result?;
    fs::rename(&part, dst).with_context(|| format!("rename {} -> {}", part.display(), dst.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bins() -> Binaries {
        locate().expect("ffmpeg must be reachable for these tests")
    }

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cos-nostra-ffmpeg-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 3 s 1280x720 60 fps test pattern with a sine tone, encoded with libx264 so any build
    /// can decode it.
    fn sample(bins: &Binaries, dir: &Path) -> PathBuf {
        let src = dir.join("sample.mp4");
        let mut cmd = ffmpeg_command(bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "96k"])
            .arg(&src);
        run(cmd, "sample").unwrap();
        src
    }

    fn codecs(bins: &Binaries, path: &Path) -> (String, String) {
        let dump = inspect(bins, path).unwrap();
        let by_kind = |kind: &str| {
            dump.streams
                .iter()
                .find(|s| s.kind == kind)
                .map(|s| s.codec.clone())
                .unwrap_or_default()
        };
        (by_kind("Video"), by_kind("Audio"))
    }

    #[test]
    fn parses_input_descriptions() {
        // Real ffmpeg 9 output: a fragmented recording (per-stream start, colour info with
        // commas inside parentheses) and an NTSC-rate AV1 clip decoded through libdav1d.
        // Built from lines: a `\` continuation in a string literal would eat the indentation
        // that tells the block apart from what follows it.
        let recording = [
            "[mov,mp4,m4a,3gp,3g2,mj2 @ 000001] a warning before the block",
            r"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\Clips\Matches\session.mp4':",
            "  Metadata:",
            "    major_brand     : iso5",
            "  Duration: 01:02:03.45, start: -0.023220, bitrate: 4310 kb/s",
            "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4227 kb/s, 60 fps, 60 tbr, 15360 tbn, start 0.033333 (default)",
            "    Metadata:",
            "      handler_name    : VideoHandler",
            "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 160 kb/s (default)",
            "At least one output file must be specified",
        ]
        .join("\n");
        let dump = parse_input_dump(&recording).unwrap();
        assert_eq!(dump.duration_ms, Some(3_723_450));
        assert!((dump.start + 0.02322).abs() < 1e-9);
        assert_eq!(
            dump.streams,
            vec![
                DumpStream { kind: "Video".into(), codec: "h264".into(), width: 1920, height: 1080, fps: 60.0 },
                DumpStream { kind: "Audio".into(), codec: "aac".into(), width: 0, height: 0, fps: 0.0 },
            ]
        );

        let clip = [
            "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'av1.mp4':",
            "  Duration: 00:00:03.00, start: 0.000000, bitrate: 1878 kb/s",
            "  Stream #0:0[0x1](und): Video: av1 (libdav1d) (Main) (av01 / 0x31307661), yuv420p(tv, progressive), 640x360 [SAR 1:1 DAR 16:9], 1788 kb/s, 59.94 fps, 59.94 tbr, 60k tbn (default)",
            "  Stream #0:1[0x2](und): Audio: opus (Opus / 0x7375704F), 48000 Hz, mono, fltp, 77 kb/s (default)",
            "Stream mapping:",
            "  Stream #0:0 -> #0:0 (copy)",
        ]
        .join("\n");
        let dump = parse_input_dump(&clip).unwrap();
        assert_eq!(dump.duration_ms, Some(3_000));
        assert_eq!(dump.start, 0.0);
        assert_eq!(dump.streams.len(), 2, "the stream mapping is not part of the input");
        assert_eq!((dump.streams[0].codec.as_str(), dump.streams[0].width, dump.streams[0].fps), ("av1", 640, 59.94));
        assert_eq!(dump.streams[1].codec, "opus");

        // A file ffmpeg cannot open has no description; one without a length has no duration.
        assert_eq!(parse_input_dump("broken.mp4: Invalid data found when processing input\n"), None);
        let unknown = parse_input_dump("Input #0, mov, from 'x':\n  Duration: N/A, bitrate: N/A\n").unwrap();
        assert_eq!((unknown.duration_ms, unknown.start), (None, 0.0));
        assert_eq!(parse_rate("1k"), 1000.0);
    }

    #[test]
    fn parses_framecrc_keyframes() {
        let listing = "\
#format: frame checksums\n\
#tb 0: 1/15360\n\
#media_type 0: video\n\
#dimensions 0: 1280x720\n\
0,      14848,      15360,      256,    26425, 0xc1af470d\n\
0,      15104,      16128,      256,     1180, 0x2b3e6c1a, F=0x0\n\
0,      15360,      15616,      256,     1180, 0x2b3e6c1a, F=0x4\n\
0,      30208,      30720,      256,    27688, 0xd91ec37b, S=1,       24, 0x0bd50212\n\
0,      45568,      46080,      256,    28364, 0x11c4a1a9, F=0x5\n";
        assert_eq!(keyframe_times(listing), vec![1.0, 2.0, 3.0]);
        assert!(keyframe_times("0,      14848,      15360,      256,    26425, 0xc1af470d\n").is_empty(), "no time base, no times");
    }

    #[test]
    fn formats_times_and_parts() {
        assert_eq!(seconds(500), "0.500");
        assert_eq!(seconds(2500), "2.500");
        assert_eq!(part_path(Path::new("C:/x/clip.mp4")), PathBuf::from("C:/x/clip.mp4.part"));
    }

    fn seg(start_ms: i64, end_ms: i64) -> Segment {
        Segment { start_ms, end_ms }
    }

    #[test]
    fn cuts_normalize() {
        // The whole clip, however it is spelled, is "no cut".
        assert!(Cut::normalize(&[], 30_000).unwrap().is_whole());
        assert!(Cut::normalize(&[seg(0, 30_000)], 30_000).unwrap().is_whole());
        assert!(Cut::normalize(&[seg(20, 29_980)], 30_000).unwrap().is_whole());
        assert!(Cut::normalize(&[seg(-5, 99_999)], 30_000).unwrap().is_whole());

        // Sorted, clamped, touching parts merged.
        let cut = Cut::normalize(&[seg(20_000, 40_000), seg(1_000, 5_000), seg(5_000, 8_000)], 30_000).unwrap();
        assert_eq!(cut.segments, vec![seg(1_000, 8_000), seg(20_000, 30_000)]);
        assert_eq!(cut.kept_ms(30_000), 17_000);

        // Rejections: too short, overlapping, nothing kept.
        assert!(Cut::normalize(&[seg(1_000, 1_050)], 30_000).is_err());
        assert!(Cut::normalize(&[seg(1_000, 5_000), seg(4_000, 9_000)], 30_000).is_err());
        assert!(Cut::normalize(&[seg(31_000, 32_000)], 30_000).is_err());

        // A thumbnail at a quarter of the kept footage lands inside a kept part.
        let cut = Cut { segments: vec![seg(10_000, 12_000), seg(20_000, 26_000)] };
        assert_eq!(cut.kept_ms(30_000), 8_000);
        assert_eq!(cut.source_time_at(0.0, 30_000), 10_000);
        // A quarter of the 8 s kept is exactly the end of the first part, so it is the start of the next.
        assert_eq!(cut.source_time_at(0.25, 30_000), 20_000);
        assert_eq!(cut.source_time_at(0.5, 30_000), 22_000);
        assert_eq!(cut.source_time_at(1.0, 30_000), 26_000);
        assert_eq!(Cut::whole().source_time_at(0.25, 30_000), 7_500);

        // The graph names one chain per part and only touches audio when there is some.
        let graph = concat_graph(&cut.segments, 10_000, Some(0));
        assert_eq!(
            graph,
            "[0:v:0]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0];\
             [0:a:0]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0];\
             [0:v:0]trim=start=10.000:end=16.000,setpts=PTS-STARTPTS[v1];\
             [0:a:0]atrim=start=10.000:end=16.000,asetpts=PTS-STARTPTS[a1];\
             [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
        );
        let silent = concat_graph(&cut.segments, 10_000, None);
        assert!(!silent.contains("[0:a"));
        assert!(silent.ends_with("[v0][v1]concat=n=2:v=1:a=0[v]"));
        // The voiceless track of a recording made with the microphone on.
        assert!(concat_graph(&cut.segments, 10_000, Some(1)).contains("[0:a:1]atrim"));
    }

    #[test]
    fn picks_the_audio_track() {
        let info = |audio_tracks| MediaInfo {
            duration_ms: 1,
            width: 1,
            height: 1,
            fps: 60.0,
            size: 1,
            has_audio: audio_tracks > 0,
            audio_tracks,
        };
        assert_eq!(info(0).audio_stream(true), None);
        assert_eq!(info(0).audio_stream(false), None);
        // A recording from before the microphone, or one made with it off: only the mix.
        assert_eq!(info(1).audio_stream(false), Some(0));
        assert!(!info(1).has_mic_track());
        // Mix, mix without the microphone, microphone.
        assert!(info(3).has_mic_track());
        assert_eq!(info(3).audio_stream(true), Some(0));
        assert_eq!(info(3).audio_stream(false), Some(1));
    }

    /// A recording made with the microphone on: three audio tracks, the mix first. Leaving the
    /// microphone out encodes the second; a stream copy keeps all three.
    #[test]
    fn leaves_the_microphone_out_of_an_encode() {
        let bins = bins();
        let dir = std::env::temp_dir().join(format!("cos-nostra-mic-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("three-tracks.mp4");
        let mut cmd = ffmpeg_command(&bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000"])
            .args(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000"])
            .args(["-t", "3", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30"])
            .args(["-c:a", "aac", "-b:a", "64k"])
            .arg(&src);
        run(cmd, "three-track sample").unwrap();
        let info = probe(&bins, &src).unwrap();
        assert_eq!(info.audio_tracks, 3);

        let out = dir.join("no-mic.mp4");
        let cut = Cut { segments: vec![seg(500, 2500)] };
        encode_h264(&bins, SOFTWARE_H264, Quality::Small, &src, &out, &cut, info.audio_stream(false), None).unwrap();
        let encoded = probe(&bins, &out).unwrap();
        assert_eq!(encoded.audio_tracks, 1, "an encode carries one track");

        let copy = dir.join("copy.mp4");
        copy_range(&bins, &src, 0, 2_000, &copy).unwrap();
        assert_eq!(probe(&bins, &copy).unwrap().audio_tracks, 3, "a copy keeps every track");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn end_to_end() {
        let _ = env_logger::builder().is_test(true).try_init();
        let bins = bins();
        println!("binaries: {bins:?}");
        let dir = tmp_dir();
        let src = sample(&bins, &dir);

        let info = probe(&bins, &src).unwrap();
        println!("probe: {info:?}");
        assert!((info.duration_ms - 3000).abs() <= 100, "duration {}", info.duration_ms);
        assert_eq!((info.width, info.height), (1280, 720));
        assert!((info.fps - 60.0).abs() < 0.01);
        assert!(info.size > 0);

        let started = Instant::now();
        let encoders = probe_encoders(&bins);
        println!("probe_encoders: {encoders:?} in {:.1} s", started.elapsed().as_secs_f64());

        assert!(info.has_audio, "the sample carries a sine tone");
        let trim = Cut {
            segments: vec![seg(500, 2500)],
        };

        let av1 = dir.join("out_av1.mp4");
        let started = Instant::now();
        encode_av1(&bins, &encoders.av1, Quality::Balanced, &src, &av1, &trim, Some(0), None).unwrap();
        let av1_info = probe(&bins, &av1).unwrap();
        println!(
            "av1 ({}): {:.1} s, {} bytes, {:?}",
            encoders.av1,
            started.elapsed().as_secs_f64(),
            av1_info.size,
            av1_info
        );
        assert!(!part_path(&av1).exists());
        assert_eq!(codecs(&bins, &av1), ("av1".to_string(), "opus".to_string()));
        assert!((av1_info.duration_ms - 2000).abs() <= 100, "av1 duration {}", av1_info.duration_ms);
        assert_eq!((av1_info.width, av1_info.height), (1280, 720));

        let h264 = dir.join("out_h264.mp4");
        let started = Instant::now();
        // Same encode, watched: the clip cards show this fraction as "Encoding · N%".
        let seen = std::cell::RefCell::new(Vec::new());
        let watch = Progress {
            duration_ms: 2000,
            on: &|p| seen.borrow_mut().push(p),
        };
        encode_h264(&bins, &encoders.h264, Quality::Balanced, &src, &h264, &trim, Some(0), Some(&watch)).unwrap();
        let seen = seen.into_inner();
        assert!(seen.len() > 1, "ffmpeg reported no progress: {seen:?}");
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress went backwards: {seen:?}");
        assert!(seen.iter().all(|p| (0.0..=1.0).contains(p)), "out of range: {seen:?}");
        assert_eq!(seen.last(), Some(&1.0), "progress did not finish: {seen:?}");
        let h264_info = probe(&bins, &h264).unwrap();
        println!(
            "h264 ({}): {:.1} s, {} bytes, {:?}",
            encoders.h264,
            started.elapsed().as_secs_f64(),
            h264_info.size,
            h264_info
        );
        assert!(!part_path(&h264).exists());
        assert_eq!(codecs(&bins, &h264), ("h264".to_string(), "aac".to_string()));
        assert!((h264_info.duration_ms - 2000).abs() <= 100, "h264 duration {}", h264_info.duration_ms);

        let thumb = dir.join("thumb.jpg");
        thumbnail(&bins, &src, &thumb, 750).unwrap();
        let thumb_len = fs::metadata(&thumb).unwrap().len();
        println!("thumbnail: {thumb_len} bytes");
        assert!(thumb_len > 1024);

        // A cut with two middles removed: three parts of the 3 s sample, 2 s kept, joined by
        // the filter graph. Progress is measured against the kept length and still reaches 1.
        let cut = Cut {
            segments: vec![seg(0, 800), seg(1_200, 1_800), seg(2_400, 3_000)],
        };
        let joined = dir.join("out_cut.mp4");
        let seen = std::cell::RefCell::new(Vec::new());
        let watch = Progress {
            duration_ms: cut.kept_ms(info.duration_ms),
            on: &|p| seen.borrow_mut().push(p),
        };
        let started = Instant::now();
        encode_h264(&bins, &encoders.h264, Quality::Balanced, &src, &joined, &cut, Some(0), Some(&watch)).unwrap();
        let joined_info = probe(&bins, &joined).unwrap();
        println!(
            "cut ({}): {:.1} s, {} bytes, {:?}",
            encoders.h264,
            started.elapsed().as_secs_f64(),
            joined_info.size,
            joined_info
        );
        assert_eq!(codecs(&bins, &joined), ("h264".to_string(), "aac".to_string()));
        assert!((joined_info.duration_ms - 2000).abs() <= 100, "cut duration {}", joined_info.duration_ms);
        assert!(joined_info.has_audio, "the joined clip keeps its audio");
        let seen = seen.into_inner();
        assert_eq!(seen.last(), Some(&1.0), "cut progress did not finish: {seen:?}");

        // The same cut on a silent source builds a video-only graph rather than failing on
        // a missing audio stream.
        let silent_src = dir.join("silent.mp4");
        let mut cmd = ffmpeg_command(&bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "3"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
            .arg(&silent_src);
        run(cmd, "silent sample").unwrap();
        let silent_info = probe(&bins, &silent_src).unwrap();
        assert!(!silent_info.has_audio);
        let silent_out = dir.join("out_silent_cut.mp4");
        encode_h264(&bins, &encoders.h264, Quality::Balanced, &silent_src, &silent_out, &cut, None, None).unwrap();
        let silent_out_info = probe(&bins, &silent_out).unwrap();
        assert!((silent_out_info.duration_ms - 2000).abs() <= 100, "silent cut duration {}", silent_out_info.duration_ms);
        assert!(!silent_out_info.has_audio);

        // A bad encoder name fails cleanly and leaves no .part behind, watched or not: a
        // failure has to carry ffmpeg's stderr even though nothing was read from stdout.
        let bad = dir.join("bad.mp4");
        let reached = std::cell::Cell::new(0.0f32);
        let watch = Progress {
            duration_ms: 2000,
            on: &|p| reached.set(p),
        };
        let err = encode_av1(
            &bins,
            "no_such_encoder",
            Quality::Balanced,
            &src,
            &bad,
            &Cut::whole(),
            Some(0),
            Some(&watch),
        )
        .unwrap_err();
        println!("expected failure: {err:#}");
        assert!(!bad.exists() && !part_path(&bad).exists());
        assert!(reached.get() < 1.0, "a failed encode must not report itself finished");
        assert!(
            format!("{err:#}").contains("no_such_encoder"),
            "the failure lost ffmpeg's stderr: {err:#}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A match is cut out of a session recording by stream copy, starting on a keyframe.
    #[test]
    fn copies_ranges_on_keyframes_and_joins_them() {
        let bins = bins();
        let dir = std::env::temp_dir().join(format!("cos-nostra-copy-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Six seconds with a keyframe every second, like a recorder with a short GOP.
        let src = dir.join("session.mp4");
        let mut cmd = ffmpeg_command(&bins);
        cmd.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-keyint_min", "60"])
            .args(["-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k"])
            .arg(&src);
        run(cmd, "sample").unwrap();

        assert_eq!(keyframe_at_or_before(&bins, &src, 0).unwrap(), 0);
        assert_eq!(keyframe_at_or_before(&bins, &src, 2_500).unwrap(), 2_000);
        assert_eq!(keyframe_at_or_before(&bins, &src, 3_000).unwrap(), 3_000);
        assert_eq!(keyframe_at_or_before(&bins, &src, 999).unwrap(), 0);

        let first = dir.join("first.mp4");
        copy_range(&bins, &src, 2_000, 4_500, &first).unwrap();
        let info = probe(&bins, &first).unwrap();
        assert!((info.duration_ms - 2_500).abs() <= 100, "copy duration {}", info.duration_ms);
        assert!(info.has_audio);
        assert!(!part_path(&first).exists());

        let second = dir.join("second.mp4");
        copy_range(&bins, &src, 5_000, 6_000, &second).unwrap();
        let joined = dir.join("joined.mp4");
        concat_copy(&bins, &[first.clone(), second.clone()], &joined).unwrap();
        let info = probe(&bins, &joined).unwrap();
        assert!((info.duration_ms - 3_500).abs() <= 150, "joined duration {}", info.duration_ms);
        assert!(!dir.join("joined.mp4.concat.txt").exists());

        assert!(copy_range(&bins, &src, 3_000, 3_000, &dir.join("empty.mp4")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
