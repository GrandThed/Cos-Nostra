//! Exporting a clip to a file of the player's choosing, outside the publish path: the footage as
//! recorded, a file that fits a size (a Discord attachment limit), or a codec, resolution, frame
//! rate and quality picked by hand.
//!
//! Everything here decides *what* to ask ffmpeg for; `ffmpeg::export` runs it. The rate-control
//! numbers follow `ffmpeg::av1_args` and `h264_args`: constant quality on each encoder's own
//! scale (AMF's AV1 quantizer is 0-255, everything else 0-51), and for a size target a bitrate
//! with a ceiling, checked against the file it produced and tried once more when it overshot.

use std::path::Path;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::ffmpeg::{self, Binaries, Encoders, Export, ExportVideo, Segment, SOFTWARE_AV1, SOFTWARE_H264};
use crate::settings::EncodeEngine;

/// What kind of file an export is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The recorded video stream copied as it is. Fast and lossless, but it can only start on a
    /// keyframe, so it may begin a moment before the clip does.
    Original,
    /// Whatever quality fits under `Options::target_mb`.
    Size,
    /// `codec`, `height`, `fps` and `level` as picked.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

/// Quality presets for a custom export, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Low,
    Medium,
    High,
    Ultra,
}

/// What the export dialog asks for. Part of the UI contract (`types.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct Options {
    pub mode: Mode,
    pub codec: Codec,
    /// Output height for a custom export; `None` keeps the recording's.
    pub height: Option<u32>,
    /// Frame rate for a custom export; `None` keeps the recording's.
    pub fps: Option<u32>,
    pub level: Level,
    /// Size target in megabytes (MiB, as Discord counts them) for `Mode::Size`.
    pub target_mb: Option<f64>,
    pub include_mic: bool,
}

/// Heights a custom export may be scaled to.
pub const HEIGHTS: [u32; 5] = [2160, 1440, 1080, 720, 480];
/// Frame rates a custom export may be written at.
pub const RATES: [u32; 2] = [60, 30];
/// Smallest and largest size target.
pub const MIN_TARGET_MB: f64 = 1.0;
pub const MAX_TARGET_MB: f64 = 4096.0;

impl Options {
    pub fn validate(&self) -> Result<()> {
        if let Some(h) = self.height {
            if !HEIGHTS.contains(&h) {
                bail!("{h} is not an export height");
            }
        }
        if let Some(f) = self.fps {
            if !RATES.contains(&f) {
                bail!("{f} is not an export frame rate");
            }
        }
        if self.mode == Mode::Size {
            match self.target_mb {
                Some(mb) if (MIN_TARGET_MB..=MAX_TARGET_MB).contains(&mb) => {}
                _ => bail!("a size target has to be between {MIN_TARGET_MB} and {MAX_TARGET_MB} MB"),
            }
        }
        Ok(())
    }
}

/// The encoder an export of `codec` uses. The engine setting decides between the probed
/// hardware encoder and software, as for publishing; H.265 is hardware only, since the shipped
/// ffmpeg has no x265.
pub fn encoder_for(codec: Codec, probed: &Encoders, engine: EncodeEngine, hevc: Option<&str>) -> Result<String> {
    let chosen = ffmpeg::encoders_for(probed, engine);
    Ok(match codec {
        Codec::H264 => chosen.h264,
        Codec::Av1 => chosen.av1,
        Codec::Hevc => match hevc {
            Some(e) => e.to_string(),
            None => bail!("this PC has no hardware H.265 encoder"),
        },
    })
}

/// Constant-quality settings for a custom export on `encoder`.
pub fn quality_args(encoder: &str, level: Level) -> Vec<String> {
    let pick = |values: [u32; 4]| {
        match level {
            Level::Low => values[0],
            Level::Medium => values[1],
            Level::High => values[2],
            Level::Ultra => values[3],
        }
        .to_string()
    };
    let args: Vec<String> = match encoder {
        SOFTWARE_H264 => {
            let preset = if level == Level::Ultra { "slow" } else { "medium" };
            vec!["-preset".into(), preset.into(), "-crf".into(), pick([28, 23, 19, 16])]
        }
        SOFTWARE_AV1 => vec![
            "-preset".into(),
            "6".into(),
            "-crf".into(),
            pick([46, 40, 34, 28]),
            "-svtav1-params".into(),
            "tune=0".into(),
        ],
        "av1_amf" => {
            let qp = pick([180, 140, 110, 90]);
            vec!["-quality".into(), "quality".into(), "-rc".into(), "cqp".into(), "-qp_i".into(), qp.clone(), "-qp_p".into(), qp]
        }
        "h264_amf" | "hevc_amf" => {
            let qp = pick([30, 25, 21, 18]);
            vec!["-quality".into(), "quality".into(), "-rc".into(), "cqp".into(), "-qp_i".into(), qp.clone(), "-qp_p".into(), qp]
        }
        "av1_nvenc" => vec!["-preset".into(), "p5".into(), "-rc".into(), "vbr".into(), "-cq".into(), pick([40, 34, 28, 23]), "-b:v".into(), "0".into()],
        "h264_nvenc" | "hevc_nvenc" => {
            vec!["-preset".into(), "p5".into(), "-rc".into(), "vbr".into(), "-cq".into(), pick([30, 25, 21, 18]), "-b:v".into(), "0".into()]
        }
        "av1_qsv" => vec!["-global_quality".into(), pick([40, 34, 28, 23])],
        _ => vec!["-global_quality".into(), pick([30, 25, 21, 18])],
    };
    args
}

/// Average-bitrate settings for a size target on `encoder`, with a ceiling a quarter above the
/// average so a hard stretch cannot blow the budget.
pub fn bitrate_args(encoder: &str, video_kbps: u32) -> Vec<String> {
    let rate = format!("{video_kbps}k");
    let peak = format!("{}k", video_kbps + video_kbps / 4);
    let buffer = format!("{}k", video_kbps * 2);
    match encoder {
        SOFTWARE_H264 => vec!["-preset".into(), "medium".into(), "-b:v".into(), rate, "-maxrate".into(), peak, "-bufsize".into(), buffer],
        SOFTWARE_AV1 => vec!["-preset".into(), "6".into(), "-b:v".into(), rate, "-svtav1-params".into(), "tune=0".into()],
        e if e.ends_with("_amf") => {
            vec!["-quality".into(), "quality".into(), "-rc".into(), "vbr_peak".into(), "-b:v".into(), rate, "-maxrate".into(), peak]
        }
        e if e.ends_with("_nvenc") => vec![
            "-preset".into(),
            "p5".into(),
            "-rc".into(),
            "vbr".into(),
            "-b:v".into(),
            rate,
            "-maxrate".into(),
            peak,
            "-bufsize".into(),
            buffer,
        ],
        _ => vec!["-b:v".into(), rate, "-maxrate".into(), peak, "-bufsize".into(), buffer],
    }
}

/// How a size target is spent: bitrates, and the height and frame rate that bitrate can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SizePlan {
    pub video_kbps: u32,
    pub audio_kbps: u32,
    /// `None` keeps the source's height.
    pub height: Option<u32>,
    /// `None` keeps the source's rate.
    pub fps: Option<u32>,
}

/// Bits per pixel per frame below which a codec's picture visibly falls apart. Measured by eye,
/// not by VMAF: H.264 at 1080p60 holds up to about 6 Mbps, which is 0.05.
fn least_bits_per_pixel(codec: Codec) -> f64 {
    match codec {
        Codec::H264 => 0.05,
        Codec::Hevc => 0.035,
        Codec::Av1 => 0.03,
    }
}

/// Spends `target_mb` on `duration_ms` of footage: a few percent go to the container, the
/// audio gets what the budget can afford, and the picture is made smaller until the bitrate
/// left can draw it: down to 720p first, then to 30 fps, then smaller still. A 720p30 clip
/// reads better in a Discord embed than a blurry 540p60 one.
pub fn plan_size(target_mb: f64, duration_ms: i64, source_height: u32, source_fps: f64, codec: Codec) -> Result<SizePlan> {
    let seconds = (duration_ms as f64 / 1000.0).max(0.5);
    // MiB, as Discord counts, less 6 % for the container and for encoders that run over.
    let total_kbps = target_mb * 1024.0 * 1024.0 * 8.0 * 0.94 / seconds / 1000.0;
    let audio_kbps: u32 = if total_kbps < 600.0 {
        64
    } else if total_kbps < 1500.0 {
        96
    } else {
        128
    };
    let video = total_kbps - f64::from(audio_kbps);
    if video < 150.0 {
        bail!("{:.0} s does not fit in {target_mb} MB; shorten the clip or pick a bigger size", seconds);
    }
    let video_kbps = video.min(100_000.0) as u32;

    let least = least_bits_per_pixel(codec);
    let bpp = |height: u32, fps: f64| video * 1000.0 / (f64::from(height) * f64::from(height) * 16.0 / 9.0 * fps);
    let source_fps = if source_fps > 0.0 { source_fps } else { 60.0 };
    let mut height = source_height.max(1);
    let mut fps = source_fps;
    let mut scaled = false;
    let mut shrink = |steps: &[u32], height: &mut u32, fps: f64| {
        for &step in steps {
            if bpp(*height, fps) >= least {
                break;
            }
            if step < *height {
                *height = step;
                scaled = true;
            }
        }
    };
    shrink(&[1080, 720], &mut height, fps);
    let mut reframed = false;
    if bpp(height, fps) < least && fps > 31.0 {
        fps = 30.0;
        reframed = true;
    }
    shrink(&[540, 480, 360], &mut height, fps);
    Ok(SizePlan {
        video_kbps,
        audio_kbps,
        height: scaled.then_some(height),
        fps: reframed.then_some(30),
    })
}

/// The range of `src` an export writes: the clip's cut on its own recording (the outer span of a
/// cut from before the one-range editor), everything otherwise.
pub fn range_of(cut: Option<&[Segment]>, original: bool) -> Option<Segment> {
    let cut = cut.filter(|c| original && !c.is_empty())?;
    Some(Segment { start_ms: cut[0].start_ms, end_ms: cut[cut.len() - 1].end_ms })
}

/// What an export wrote.
#[derive(Debug, Clone, Serialize)]
pub struct Exported {
    pub path: String,
    pub size: u64,
    pub duration_ms: i64,
}

/// Everything `run` needs besides the options.
pub struct Source<'a> {
    pub path: &'a Path,
    pub info: &'a ffmpeg::MediaInfo,
    pub range: Option<Segment>,
    pub encoders: &'a Encoders,
    pub engine: EncodeEngine,
    pub hevc: Option<&'a str>,
}

/// Runs an export of `source` into `dst`. `on_progress` gets 0.0..=1.0, across both passes when
/// a size target needs a second one.
pub fn run(bins: &Binaries, source: &Source<'_>, options: &Options, dst: &Path, on_progress: &dyn Fn(f32)) -> Result<Exported> {
    options.validate()?;
    let info = source.info;
    let audio = info.audio_stream(options.include_mic);
    let mut range = source.range;
    let length = |r: Option<Segment>| r.map_or(info.duration_ms, |r| r.end_ms - r.start_ms);

    match options.mode {
        Mode::Original => {
            if let Some(r) = range {
                let from = ffmpeg::keyframe_at_or_before(bins, source.path, r.start_ms)?;
                range = Some(Segment { start_ms: from, end_ms: r.end_ms });
            }
            let job = Export { src: source.path, dst, range, audio, audio_kbps: 192, video: ExportVideo::Copy };
            ffmpeg::export(bins, &job, Some(&ffmpeg::Progress { duration_ms: length(range), on: on_progress }))?;
        }
        Mode::Custom => {
            let encoder = encoder_for(options.codec, source.encoders, source.engine, source.hevc)?;
            // Never scaled up: a 720p recording exported "at 1080p" stays 720p.
            let height = options.height.filter(|h| *h < info.height);
            let fps = options.fps.filter(|f| f64::from(*f) < info.fps - 0.5);
            let args = quality_args(&encoder, options.level);
            let job = Export {
                src: source.path,
                dst,
                range,
                audio,
                audio_kbps: 160,
                video: ExportVideo::Encode { encoder, args, height, fps, source_fps: info.fps },
            };
            ffmpeg::export(bins, &job, Some(&ffmpeg::Progress { duration_ms: length(range), on: on_progress }))?;
        }
        Mode::Size => {
            let target_mb = options.target_mb.unwrap_or(10.0);
            let target_bytes = (target_mb * 1024.0 * 1024.0) as u64;
            let encoder = encoder_for(options.codec, source.encoders, source.engine, source.hevc)?;
            let plan = plan_size(target_mb, length(range), info.height, info.fps, options.codec)?;
            let first_half = |p: f32| on_progress(p * 0.5);
            let second_half = |p: f32| on_progress(0.5 + p * 0.5);
            let mut video_kbps = plan.video_kbps;
            for attempt in 0..2 {
                let job = Export {
                    src: source.path,
                    dst,
                    range,
                    audio,
                    audio_kbps: plan.audio_kbps,
                    video: ExportVideo::Encode {
                        encoder: encoder.clone(),
                        args: bitrate_args(&encoder, video_kbps),
                        height: plan.height,
                        fps: plan.fps,
                        source_fps: info.fps,
                    },
                };
                let on: &dyn Fn(f32) = if attempt == 0 { &first_half } else { &second_half };
                ffmpeg::export(bins, &job, Some(&ffmpeg::Progress { duration_ms: length(range), on }))?;
                let size = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
                if size <= target_bytes {
                    break;
                }
                if attempt == 1 {
                    let _ = std::fs::remove_file(dst);
                    bail!("the encoder could not get this clip under {target_mb} MB; pick a bigger size");
                }
                // Over by a margin the encoder chose: aim lower by that much again.
                let scale = target_bytes as f64 / size as f64 * 0.95;
                log::info!("export was {size} bytes for a {target_bytes} byte target; again at {:.0} %", scale * 100.0);
                video_kbps = ((f64::from(video_kbps) * scale) as u32).max(100);
            }
        }
    }
    on_progress(1.0);
    let size = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
    let duration_ms = ffmpeg::probe(bins, dst).map(|i| i.duration_ms).unwrap_or_else(|_| length(range));
    Ok(Exported { path: dst.display().to_string(), size, duration_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_target_scales_the_picture_before_it_starves_it() {
        // 30 s in 10 MB: about 2.5 Mbps of video, too little for 1080p60 H.264.
        let plan = plan_size(10.0, 30_000, 1080, 60.0, Codec::H264).unwrap();
        assert!((2_300..2_600).contains(&plan.video_kbps), "{plan:?}");
        assert_eq!(plan.audio_kbps, 128);
        assert_eq!(plan.height, Some(720));
        assert_eq!(plan.fps, Some(30), "720p before 30 fps, 30 fps before 540p");

        // The same budget goes further in AV1: it keeps 60 fps.
        let av1 = plan_size(10.0, 30_000, 1080, 60.0, Codec::Av1).unwrap();
        assert_eq!((av1.height, av1.fps), (Some(720), None), "{av1:?}");

        // Plenty of room: nothing changes.
        let roomy = plan_size(500.0, 30_000, 1080, 60.0, Codec::H264).unwrap();
        assert_eq!((roomy.height, roomy.fps), (None, None));

        // Two minutes in 10 MB is a small picture at a low rate, with thin audio.
        let tight = plan_size(10.0, 120_000, 1080, 60.0, Codec::H264).unwrap();
        assert!(tight.height.unwrap() <= 480, "{tight:?}");
        assert_eq!(tight.fps, Some(30));
        assert_eq!(tight.audio_kbps, 96);

        // An hour does not fit at all.
        assert!(plan_size(10.0, 3_600_000, 1080, 60.0, Codec::H264).is_err());
    }

    #[test]
    fn options_are_checked() {
        let base = Options {
            mode: Mode::Custom,
            codec: Codec::H264,
            height: Some(720),
            fps: Some(30),
            level: Level::High,
            target_mb: None,
            include_mic: true,
        };
        base.validate().unwrap();
        assert!(Options { height: Some(700), ..base.clone() }.validate().is_err());
        assert!(Options { fps: Some(24), ..base.clone() }.validate().is_err());
        assert!(Options { mode: Mode::Size, ..base.clone() }.validate().is_err(), "a size needs a target");
        Options { mode: Mode::Size, target_mb: Some(10.0), ..base.clone() }.validate().unwrap();
        assert!(Options { mode: Mode::Size, target_mb: Some(0.2), ..base }.validate().is_err());
    }

    #[test]
    fn encoders_and_rate_control_follow_the_engine() {
        let probed = Encoders { av1: "av1_amf".into(), h264: "h264_amf".into() };
        assert_eq!(encoder_for(Codec::H264, &probed, EncodeEngine::Cpu, None).unwrap(), SOFTWARE_H264);
        assert_eq!(encoder_for(Codec::Av1, &probed, EncodeEngine::Gpu, None).unwrap(), "av1_amf");
        assert!(encoder_for(Codec::Hevc, &probed, EncodeEngine::Cpu, None).is_err());
        assert_eq!(encoder_for(Codec::Hevc, &probed, EncodeEngine::Cpu, Some("hevc_amf")).unwrap(), "hevc_amf");

        // AMF's AV1 quantizer is 0-255; its H.264 and H.265 ones are 0-51.
        assert!(quality_args("av1_amf", Level::High).contains(&"110".to_string()));
        assert!(quality_args("hevc_amf", Level::High).contains(&"21".to_string()));
        assert!(quality_args(SOFTWARE_H264, Level::Ultra).contains(&"slow".to_string()));
        assert_eq!(bitrate_args(SOFTWARE_H264, 2000)[3], "2000k");
        assert!(bitrate_args("h264_nvenc", 2000).contains(&"2500k".to_string()));
    }

    #[test]
    fn the_range_is_the_cut_on_the_recording_only() {
        let cut = [Segment { start_ms: 1_000, end_ms: 4_000 }, Segment { start_ms: 6_000, end_ms: 9_000 }];
        assert_eq!(range_of(Some(&cut), true), Some(Segment { start_ms: 1_000, end_ms: 9_000 }));
        assert_eq!(range_of(Some(&cut), false), None, "an encoded copy already is the cut");
        assert_eq!(range_of(None, true), None);
    }

    /// Every mode against real ffmpeg on a three-track recording: the file plays, carries one
    /// audio track, and a size target is met.
    #[test]
    fn exports_every_mode() {
        let bins = ffmpeg::locate().expect("ffmpeg must be reachable for these tests");
        let dir = std::env::temp_dir().join(format!("cos-nostra-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("recording.mp4");
        let status = std::process::Command::new(&bins.ffmpeg)
            .args(["-hide_banner", "-nostdin", "-y", "-v", "error"])
            .args(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
            .args(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000"])
            .args(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000"])
            .args(["-t", "6", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "96k"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());
        let info = ffmpeg::probe(&bins, &src).unwrap();
        let encoders = Encoders { av1: SOFTWARE_AV1.into(), h264: SOFTWARE_H264.into() };
        let range = Some(Segment { start_ms: 1_500, end_ms: 4_500 });
        let source = Source { path: &src, info: &info, range, encoders: &encoders, engine: EncodeEngine::Cpu, hevc: None };
        let options = |mode, target_mb| Options {
            mode,
            codec: Codec::H264,
            height: Some(480),
            fps: Some(30),
            level: Level::Low,
            target_mb,
            include_mic: false,
        };

        let original = dir.join("original.mp4");
        let done = run(&bins, &source, &options(Mode::Original, None), &original, &|_| {}).unwrap();
        let out = ffmpeg::probe(&bins, &original).unwrap();
        assert_eq!((out.height, out.audio_tracks), (720, 1));
        // It starts on the keyframe at 1 s, so it runs half a second long.
        assert!((done.duration_ms - 3_500).abs() <= 150, "{done:?}");

        let custom = dir.join("custom.mp4");
        let done = run(&bins, &source, &options(Mode::Custom, None), &custom, &|_| {}).unwrap();
        let out = ffmpeg::probe(&bins, &custom).unwrap();
        assert_eq!((out.height, out.audio_tracks), (480, 1));
        assert!((out.fps - 30.0).abs() < 0.1, "{out:?}");
        assert!((done.duration_ms - 3_000).abs() <= 150, "{done:?}");

        let small = dir.join("small.mp4");
        let seen = std::cell::Cell::new(0.0f32);
        let done = run(&bins, &source, &options(Mode::Size, Some(1.0)), &small, &|p| seen.set(p)).unwrap();
        assert!(done.size <= 1024 * 1024, "{done:?}");
        assert_eq!(seen.get(), 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
