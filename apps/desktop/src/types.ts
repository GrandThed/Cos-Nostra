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
}

export type Quality = "small" | "balanced" | "high";
export type EncodeEngine = "cpu" | "gpu";

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
  backend_url: string;
  /** No `device_token`: `get_settings` blanks it, and `save_settings` puts the live one back.
   *  Whether a device is linked is `account` (or `get_account`), never the token itself. */
  account: Account | null;
  auto_upload: boolean;
  delete_source_after_encode: boolean;
  storage_limit_gb: number;
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
  free_space: number | null;
  disk_size: number | null;
}

export type CleanTarget = "sources" | "published" | "failed";

export interface CleanResult {
  clips: number;
  bytes: number;
}
