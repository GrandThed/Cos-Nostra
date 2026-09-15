/** Every call into Rust, named and typed once. Nothing else in the UI touches `invoke`. */

import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  ArtKind,
  AudioDevice,
  Bootstrap,
  ClipAudio,
  CleanResult,
  CleanTarget,
  ClipMatch,
  ClipMatchRef,
  ClipProgress,
  ClipRow,
  EditSource,
  Encoders,
  ExportCodecs,
  Exported,
  ExportOptions,
  GameArtImage,
  LoginStarted,
  MatchClip,
  PublishGuild,
  SessionRow,
  Settings,
  SourceKind,
  Status,
  StorageStats,
  TimelineEvent,
} from "./types";

export const getStatus = () => invoke<Status>("get_status");
export const saveClip = () => invoke<string>("save_clip");
export const retryRecorder = () => invoke<void>("retry_recorder");

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const pickClipDir = () => invoke<string | null>("pick_clip_dir");
export const listMicrophones = () => invoke<AudioDevice[]>("list_microphones");
/** Executable names of the apps with an audio session right now. */
export const listAudioApps = () => invoke<string[]>("list_audio_apps");
export const clipAudio = (id: number) => invoke<ClipAudio>("clip_audio", { id });

export const listClips = () => invoke<ClipRow[]>("list_clips");
export const deleteClip = (id: number) => invoke<void>("delete_clip", { id });
export const setClipGame = (id: number, game: string | null) =>
  invoke<void>("set_clip_game", { id, game });
export const renameGame = (from: string | null, to: string | null) =>
  invoke<number>("rename_game", { from, to });
export const retryClip = (id: number) => invoke<void>("retry_clip", { id });
export const clipProgress = () => invoke<ClipProgress[]>("clip_progress");
export const openClipFolder = (id: number) => invoke<void>("open_clip_folder", { id });
export const getThumbnail = (id: number) => invoke<string | null>("get_thumbnail", { id });

/** `null` when the game has no picture yet: Rust looks it up in the background and says
 *  `game-art-changed` if one lands. */
export const getGameArt = (game: string, kind: ArtKind) =>
  invoke<GameArtImage | null>("get_game_art", { game, kind });
/** Opens a file picker; false when it was cancelled. */
export const chooseGameArt = (game: string) => invoke<boolean>("choose_game_art", { game });
/** Drops the picture the user chose and looks the game up again. */
export const resetGameArt = (game: string) => invoke<void>("reset_game_art", { game });

export const exportCodecs = () => invoke<ExportCodecs>("export_codecs");
/** Opens a save dialog, then exports there; null when the dialog was cancelled. Progress comes
 *  as `export-progress` events. */
export const exportClip = (id: number, options: ExportOptions) =>
  invoke<Exported | null>("export_clip", { id, options });
export const revealExport = (path: string) => invoke<void>("reveal_export", { path });

export const editSource = (id: number) => invoke<EditSource>("edit_source", { id });
/** One kept range, measured in the file `source` names (the match, or the clip's own). */
export const applyRange = (id: number, source: SourceKind, startMs: number, endMs: number) =>
  invoke<void>("apply_range", { id, source, startMs, endMs });

/** Rejects with `not_logged_in` or `bot_unavailable`, which the dialog words itself. */
export const listPublishGuilds = () => invoke<PublishGuild[]>("list_publish_guilds");
export const publishClip = (
  id: number,
  title: string | null,
  game: string | null,
  guildIds: string[],
  includeMic: boolean,
) => invoke<void>("publish_clip", { id, title, game, guildIds, includeMic });
/** Resolves with the server ids the backend actually queued. */
export const addClipPosts = (id: number, guildIds: string[]) =>
  invoke<string[]>("add_clip_posts", { id, guildIds });
export const unpublishClip = (id: number) => invoke<void>("unpublish_clip", { id });
export const refreshPosts = () => invoke<void>("refresh_posts");
export const openClipPost = (id: number, guildId: string) =>
  invoke<void>("open_clip_post", { id, guildId });

export const storageStats = () => invoke<StorageStats>("storage_stats");
export const cleanStorage = (target: CleanTarget) => invoke<CleanResult>("clean_storage", { target });
export const openClipDir = () => invoke<void>("open_clip_dir");

export const reprobeEncoders = () => invoke<Encoders>("reprobe_encoders");

export const startLogin = () => invoke<LoginStarted>("start_login");
export const cancelLogin = () => invoke<void>("cancel_login");
export const logout = () => invoke<void>("logout");
export const getAccount = () => invoke<Account | null>("get_account");

export const listSessions = () => invoke<SessionRow[]>("list_sessions");
export const matchEvents = (id: number) => invoke<TimelineEvent[]>("match_events", { id });
export const deleteSession = (id: number) => invoke<void>("delete_session", { id });
export const deleteMatch = (id: number) => invoke<void>("delete_match", { id });
/** Clamped to ten minutes either way. Leaves the match's `updated_at` alone, so its video does not reload. */
export function setMatchEventOffset(matchId: number, offsetMs: number): Promise<void> {
  return invoke<void>("set_match_event_offset", { matchId, offsetMs });
}
export const retrySession = (id: number) => invoke<void>("retry_session", { id });
/** Puts `startMs..endMs` of a match file in the clip queue and returns the new clip's id. */
export const clipFromMatch = (id: number, startMs: number, endMs: number) =>
  invoke<number>("clip_from_match", { id, startMs, endMs });
export const openMatchFolder = (id: number) => invoke<void>("open_match_folder", { id });
export const matchThumbnail = (id: number) => invoke<string | null>("match_thumbnail", { id });
export const clipsForMatch = (matchId: number) => invoke<MatchClip[]>("clips_for_match", { matchId });
export const matchForClip = (clipId: number) => invoke<ClipMatch | null>("match_for_clip", { clipId });
export const clipMatchIndex = () => invoke<ClipMatchRef[]>("clip_match_index");

export const getBootstrap = () => invoke<Bootstrap>("get_bootstrap");
export const finishFirstRun = () => invoke<void>("finish_first_run");

/** Tauri hands errors back as whatever the command returned, which is always a string here. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
