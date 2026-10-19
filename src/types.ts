/**
 * Types and interfaces for Obsidian Baidu Netdisk Sync Plugin
 */

export interface PluginSettings {
  // Baidu Netdisk Authentication
  appKey: string;
  secretKey: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // Unix timestamp in ms
  username: string;

  // Remote Sync Configuration
  remoteBasePath: string; // e.g. "/apps/obsidian-vault"
  
  // Sync Behaviors
  autoSync: boolean;
  mobileManualSync: boolean; // Mobile: only explicit sync actions may contact the remote.
  incrementalSync: boolean;
  syncPaused: boolean;
  uploadConcurrency: number; // 1–5 different files; per-file upload phases remain ordered
  downloadConcurrency?: number; // 1–5 different files; per-file download phases remain ordered
  syncIntervalMinutes: number;
  syncIntervalSeconds?: number;
  syncOnStartup: boolean;
  syncOnModifyDebounceSeconds: number; // Debounce delay before syncing modified files
  
  // Conflict Strategy
  conflictStrategy: ConflictStrategy;
  
  // Ignored patterns (glob / path prefixes)
  ignoredPatterns: string[];

  // End-to-End Encryption (E2EE, inspired by owl234)
  enableE2EE: boolean;
  e2eePassword?: string;

  // Granular Obsidian config sync
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncThemes: boolean;
}

export type ConflictStrategy = "git_merge" | "create_conflict_file" | "keep_newer" | "keep_local" | "keep_remote";

export interface RemoteFileInfo {
  fsId: string;
  path: string;
  serverFilename: string;
  size: number;
  md5?: string;
  serverMtime: number; // in milliseconds
  isdir: number; // 1 for dir, 0 for file
}

/**
 * Base snapshot metadata entry for 3-way conflict detection & ordering
 */
export interface SyncMetadataEntry {
  path: string;            // relative vault path e.g. "Notes/Daily.md"
  localMtime: number;      // local file mtime in ms
  localSize?: number;      // local file size in bytes for zero-IO fast-path
  localMd5: string;        // local content md5 hex
  remoteFsId: string;      // remote Baidu Netdisk fs_id
  remoteMtime: number;     // remote server mtime in ms
  remoteMd5: string;       // remote content md5
  lastSyncTime: number;    // timestamp ms when last synced
  revision?: number;       // monotonically increasing sequence number
}

export interface PendingConflict {
  path: string;
  remotePath: string;
  copies: string[];
  remote: { exists: boolean; md5?: string; fsId?: string; mtime?: number };
  createdAt: number;
}

export interface SyncStateData {
  version: number;
  lastFullSyncTimestamp: number;
  conflicts?: Record<string, PendingConflict>;
  files: Record<string, SyncMetadataEntry>;
}

export type SyncActionType = 
  | "upload"               // local is newer / new local file
  | "download"             // remote is newer / new remote file
  | "conflict"             // both changed independently
  | "delete_remote"        // local was deleted
  | "delete_local"         // remote was deleted
  | "noop";                // in-sync

export interface SyncTask {
  path: string;
  action: SyncActionType;
  localFile?: {
    path: string;
    mtime: number;
    size: number;
  };
  remoteFile?: RemoteFileInfo;
  base?: SyncMetadataEntry;
  timestamp: number;       // timestamp when task was generated
}

export interface SyncResult {
  total: number;
  skipped: number;
  uploaded: number;
  downloaded: number;
  conflicted: number;
  deleted: number;
  errors: Array<{ path: string; error: string }>;
}

export interface SyncLogEntry {
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  detail?: string;
}
