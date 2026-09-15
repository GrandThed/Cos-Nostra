/** The shapes the Rust side serialises. Keep in step with `settings.rs`, `queue.rs`,
 *  `storage.rs` and the `Status`, `Bootstrap` and `ClipProgress` types in `lib.rs`. */

export interface HookedGame {
  title: string;
  class: string;
  executable: string;
}

export interface CaptureConflict {
  executable: string;
  title: string;
}

export interface Encoders {
  av1: string;
  h264: string;
}

export interface Account {
  discord_id: string;
  username: string;
  avatar: string | null;
}

export interface Status {
  recording: boolean;
  encoder: string | null;
  hotkey: string;
  clip_dir: string;
  buffer_seconds: number;
  error: string | null;
  hotkey_error: string | null;
  /** Empty when markers are off. */
  marker_hotkey: string;
  marker_hotkey_error: string | null;
  hooked_game: HookedGame | null;
  conflict: CaptureConflict | null;
  encoders: Encoders | null;
  ffmpeg_error: string | null;
  account: Account | null;
  /** The game session being recorded right now, if one is. */
  session: LiveSession | null;
}

export type Quality = "small" | "balanced" | "high";
export type EncodeEngine = "cpu" | "gpu";
export type Language = "en" | "es";
/** Which sound besides the microphone is recorded. `settings::AudioSource`. */
export type AudioSource = "system" | "game" | "game_and_apps";

export interface Settings {
  hotkey: string;
  /** Puts a marker on the session being recorded. Empty turns it off. */
  marker_hotkey: string;
  buffer_seconds: number;
  buffer_max_mb: number;
  video_bitrate_kbps: number;
  fps: number;
  /** Height the recording is scaled down to; 0 records at the screen's own. */
  record_height: number;
  audio_source: AudioSource;
  /** Executable names recorded next to the game with `game_and_apps`. */
  audio_apps: string[];
  mic_enabled: boolean;
  /** WASAPI endpoint id, or "default". */
  mic_device: string;
  /** Percent, 0–200. */
  mic_volume: number;
  mic_noise_suppression: boolean;
  clip_dir: string;
  start_with_windows: boolean;
  notify_on_save: boolean;
  sound_on_save: boolean;
  encoders: Encoders | null;
  encode_while_gaming: boolean;
  quality: Quality;
  encode_engine: EncodeEngine;
  language: Language;
  backend_url: string;
  /** Region shard for Valorant's public match-details API (`pd.<shard>.a.pvp.net`), e.g. "na",
   *  "eu", "ap", "kr". Not discoverable from the local Riot Client API, so it is a setting. */
  valorant_shard: string;
  /** No `device_token`: `get_settings` blanks it, and `save_settings` puts the live one back.
   *  Whether a device is linked is `account` (or `get_account`), never the token itself. */
  account: Account | null;
  /** The servers the publish dialog had ticked last time; its default next time. */
  last_publish_guilds: string[];
  delete_source_after_encode: boolean;
  storage_limit_gb: number;
  /** Same idea as `storage_limit_gb`, but for `<clip folder>\Matches`: 0 for no limit. */
  session_storage_limit_gb: number;
  record_sessions: boolean;
  /** Record every other game in the background, keeping `other_games_hours` of footage. */
  record_other_games: boolean;
  other_games_hours: number;
  open_after_session: boolean;
  first_run_done: boolean;
  tray_hint_shown: boolean;
}

export interface LoginStarted {
  code: string;
  verify_url: string;
}

export type ClipStatus = "saved" | "encoding" | "encoded" | "uploading" | "done" | "failed";
export type Stage = "encode" | "upload";

/** One kept range of a recording, in milliseconds. Matches `ffmpeg::Segment`. */
export interface Segment {
  start_ms: number;
  end_ms: number;
}

export type SourceKind = "match" | "clip";

/** What the editor loads for a clip. Matches `edit::EditSource`. */
export interface EditSource {
  kind: SourceKind;
  /** The match file, or the clip's own recording (or encoded copy). */
  path: string;
  match_id: number | null;
  duration_ms: number;
  fps: number;
  width: number;
  height: number;
  has_audio: boolean;
  /** The clip's current range, in `path` milliseconds. */
  range: Segment;
  /** Where the footage the clip already has sits in `path`; null when it has none here. */
  clip_span: Segment | null;
  /** True when the clip's own file is the untouched recording. */
  original: boolean;
  /** The stored cut has several parts, which Apply turns into one range. */
  multi_part: boolean;
}

/** One live Discord post of a clip. Matches `queue::ClipPost`. */
export interface ClipPost {
  guild_id: string;
  name: string | null;
  icon_url: string | null;
  message_url: string;
  posted_at: string;
}

/** A server the publish dialog offers. */
export interface PublishGuild {
  guild_id: string;
  name: string | null;
  icon_url: string | null;
}

/** A clip drawn on a match timeline, in match-file milliseconds. `placement::MatchClip`. */
export interface MatchClip {
  clip_id: number;
  start_ms: number;
  end_ms: number;
  status: ClipStatus;
  published: boolean;
}

/** The match a clip was taken in. `placement::ClipMatch`. */
export interface ClipMatch {
  match_id: number;
  session_id: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  path: string;
}

export interface ClipMatchRef {
  clip_id: number;
  match_id: number;
  session_id: number;
}

export interface ClipRow {
  id: number;
  source_path: string;
  game: string | null;
  title: string | null;
  recorded_at: string;
  duration_ms: number;
  width: number;
  height: number;
  size_source: number;
  size_av1: number | null;
  size_h264: number | null;
  av1_path: string | null;
  h264_path: string | null;
  thumb_path: string | null;
  status: ClipStatus;
  error: string | null;
  attempts: number;
  stage: Stage;
  remote_id: string | null;
  page_url: string | null;
  fps: number | null;
  /** Kept parts of the original recording, from the editor. `null` is the whole recording. */
  cut: Segment[] | null;
  /** When the row last changed; the thumbnail cache is keyed on it. */
  updated_at: string;
  /** The user pressed Publish. Without it the clip is local, whatever its status. */
  publish: boolean;
  publish_guilds: string[] | null;
  publish_title: string | null;
  /** UTC time of the recording's first frame, which places the clip on its match. */
  captured_at: string | null;
  /** Live Discord posts, as the backend last reported them. */
  posts: ClipPost[];
  /** Whether the published copies keep the microphone, when the recording has it on its own track. */
  include_mic: boolean;
}

/** How a clip is exported. `export::Mode`, `Codec`, `Level` and `Options`. */
export type ExportMode = "original" | "size" | "custom";
export type ExportCodec = "h264" | "hevc" | "av1";
export type ExportLevel = "low" | "medium" | "high" | "ultra";

export interface ExportOptions {
  mode: ExportMode;
  codec: ExportCodec;
  /** One of 2160, 1440, 1080, 720, 480; null keeps the recording's. */
  height: number | null;
  /** 60 or 30; null keeps the recording's. */
  fps: number | null;
  level: ExportLevel;
  /** MiB, for `size`. */
  target_mb: number | null;
  include_mic: boolean;
}

/** What an export wrote. `export::Exported`. */
export interface Exported {
  path: string;
  size: number;
  duration_ms: number;
}

/** The codecs this PC can export. `lib.rs` `ExportCodecs`. */
export interface ExportCodecs {
  h264: boolean;
  hevc: boolean;
  av1: boolean;
}

/** A microphone Settings can pick. `win::AudioDevice`. */
export interface AudioDevice {
  id: string;
  name: string;
}

/** What a clip's recording has for sound. `lib.rs` `ClipAudio`. */
export interface ClipAudio {
  tracks: number;
  /** The microphone is on a track of its own, so it can be left out. */
  mic_track: boolean;
}

/** Which picture of a game: a square-ish icon for lists, or box art for the game header. Rust
 *  falls back to the other when only one exists. `game_art::ArtKind`. */
export type ArtKind = "icon" | "cover";

/** A game's picture. `game_art::GameArtImage`. */
export interface GameArtImage {
  /** A `data:` URL. */
  url: string;
  /** The user chose it, so no lookup ever replaces it. */
  custom: boolean;
}

/** Live percentage of the encode or upload running right now. */
export interface ClipProgress {
  id: number;
  stage: "encode" | "upload" | "idle";
  percent: number;
}

/** How far the one-time OBS runtime download has got. */
export type Bootstrap =
  | { phase: "downloading"; progress: number; message: string }
  | { phase: "extracting"; progress: number; message: string }
  | { phase: "restarting" }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/** Clips and the bytes they hold on this PC. */
export interface Bucket {
  clips: number;
  bytes: number;
}

export interface GameUsage {
  game: string | null;
  clips: number;
  bytes: number;
}

export interface Kinds {
  sources: number;
  av1: number;
  h264: number;
  thumbs: number;
  other: number;
  other_files: number;
}

export interface StorageStats {
  clip_dir: string;
  clips: number;
  total: number;
  kinds: Kinds;
  games: GameUsage[];
  published: Bucket;
  local_only: Bucket;
  reclaim_sources: Bucket;
  reclaim_published: Bucket;
  reclaim_failed: Bucket;
  /** Session recordings and cut match files under `<clip folder>\Matches`. Never encoded to
   *  AV1/H264 and never uploaded, so it is its own bucket rather than part of the split above. */
  matches: Bucket;
  free_space: number | null;
  disk_size: number | null;
}

export type CleanTarget = "sources" | "published" | "failed";

export interface CleanResult {
  clips: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Sessions and matches. Keep in step with `sessions.rs`, `timeline.rs` and `session_watch.rs`.

/** `other` is any other game, recorded in the background in parts. */
export type SessionGame = "valorant" | "league" | "counter_strike" | "teamfight_tactics" | "other";

/** The session the watch is recording right now. */
export interface LiveSession {
  id: number;
  game: SessionGame;
  game_name: string;
  /** False between League games, while only the client runs. */
  recording: boolean;
  match_id: number | null;
}

export type SessionStatus = "recording" | "processing" | "ready" | "failed";
export type MatchStatus = "live" | "pending" | "ready" | "missing" | "failed";
export type Outcome = "win" | "loss" | "draw";

export interface MatchRow {
  id: number;
  session_id: number;
  started_at: string;
  ended_at: string | null;
  /** False for the stand-in that keeps a session's footage when nothing detected a match. */
  detected: boolean;
  map: string | null;
  mode: string | null;
  result: Outcome | null;
  ally_score: number | null;
  enemy_score: number | null;
  path: string | null;
  thumb_path: string | null;
  /** Wall-clock time of the file's first frame; an event at `at` is `at - file_start_at` in. */
  file_start_at: string | null;
  duration_ms: number | null;
  size: number | null;
  status: MatchStatus;
  error: string | null;
  updated_at: string;
  /** Added to every event's time on this match, for timelines that were recorded out of step with the video. */
  event_offset_ms: number;
}

export interface SessionRow {
  id: number;
  game: SessionGame;
  game_name: string;
  started_at: string;
  ended_at: string | null;
  status: SessionStatus;
  provider_reached: boolean;
  error: string | null;
  matches: MatchRow[];
}

export type EndReason = "finished" | "lost" | "session_ended" | "superseded";

/** One mark on a match's timeline. The `kind` tag and fields are `timeline::Event`. */
export type TimelineEvent = { id: number; match_id: number | null; at: string } & (
  | { kind: "match_start"; map: string | null; mode: string | null }
  | { kind: "round_end"; round: number; ally: number; enemy: number; won: boolean | null }
  | {
      kind: "match_end";
      ally: number | null;
      enemy: number | null;
      result: Outcome | null;
      reason: EndReason;
    }
  | { kind: "kill"; victim: string | null; weapon: string | null; headshot: boolean }
  | { kind: "death"; killer: string | null; weapon: string | null }
  | { kind: "assist"; victim: string | null }
  | { kind: "multikill"; count: number }
  /** `ours`: the player's team got it (true), the other team did (false), or unknown. */
  | { kind: "objective"; name: string; ours: boolean | null }
  /** The player pressed the marker hotkey here. */
  | { kind: "marker" }
);
