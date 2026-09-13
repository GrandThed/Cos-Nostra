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
  hooked_game: HookedGame | null;
  conflict: CaptureConflict | null;
  encoders: Encoders | null;
  ffmpeg_error: string | null;
  account: Account | null;
  auto_upload: boolean;
  /** The game session being recorded right now, if one is. */
  session: LiveSession | null;
}

export type Quality = "small" | "balanced" | "high";
export type EncodeEngine = "cpu" | "gpu";
export type Language = "en" | "es";

export interface Settings {
  hotkey: string;
  buffer_seconds: number;
  buffer_max_mb: number;
  video_bitrate_kbps: number;
  fps: number;
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
  auto_upload: boolean;
  delete_source_after_encode: boolean;
  storage_limit_gb: number;
  /** Same idea as `storage_limit_gb`, but for `<clip folder>\Matches`: 0 for no limit. */
  session_storage_limit_gb: number;
  record_sessions: boolean;
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

/** What the editor loads for a clip. Matches `EditSource` in `lib.rs`. */
export interface EditSource {
  path: string;
  duration_ms: number;
  fps: number;
  width: number;
  height: number;
  has_audio: boolean;
  /** The cut already on the clip, when it was measured against this file. */
  cut: Segment[] | null;
  /** True when the file is the untouched recording, so a cut can be changed again later. */
  original: boolean;
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

export type SessionGame = "valorant" | "league" | "counter_strike" | "teamfight_tactics";

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
);
