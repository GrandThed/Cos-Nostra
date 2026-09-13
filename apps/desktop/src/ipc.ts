/** Every call into Rust, named and typed once. Nothing else in the UI touches `invoke`. */

import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  Bootstrap,
  CleanResult,
  CleanTarget,
  ClipProgress,
  ClipRow,
  EditSource,
  Encoders,
  LoginStarted,
  Segment,
  Settings,
  Status,
  StorageStats,
} from "./types";

export const getStatus = () => invoke<Status>("get_status");
export const saveClip = () => invoke<string>("save_clip");
export const retryRecorder = () => invoke<void>("retry_recorder");

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const pickClipDir = () => invoke<string | null>("pick_clip_dir");

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

export const editSource = (id: number) => invoke<EditSource>("edit_source", { id });
/** An empty list keeps the whole recording, which is how an earlier cut is undone. */
export const applyCut = (id: number, segments: Segment[]) =>
  invoke<void>("apply_cut", { id, segments });

export const storageStats = () => invoke<StorageStats>("storage_stats");
export const cleanStorage = (target: CleanTarget) => invoke<CleanResult>("clean_storage", { target });
export const openClipDir = () => invoke<void>("open_clip_dir");

export const reprobeEncoders = () => invoke<Encoders>("reprobe_encoders");

export const startLogin = () => invoke<LoginStarted>("start_login");
export const cancelLogin = () => invoke<void>("cancel_login");
export const logout = () => invoke<void>("logout");
export const getAccount = () => invoke<Account | null>("get_account");

export const getBootstrap = () => invoke<Bootstrap>("get_bootstrap");
export const finishFirstRun = () => invoke<void>("finish_first_run");

/** Tauri hands errors back as whatever the command returned, which is always a string here. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
