import { ConflictStrategy, SyncActionType, SyncMetadataEntry } from "../types";
import { getFileName, getParentDir, joinPaths } from "../utils/path";

export interface FileStateInspection {
  exists: boolean;
  mtime?: number;
  md5?: string;
  size?: number;
  fsId?: string;
}

export interface ConflictDecision {
  action: SyncActionType;
  reason: string;
  isConflict: boolean;
  conflictSubtype?: "both_modified" | "remote_deleted_local_modified" | "local_deleted_remote_modified";
}

/**
 * Perform 3-way delta detection between Local, Remote, and Base snapshot
 */
export function determineSyncAction(
  local: FileStateInspection,
  remote: FileStateInspection,
  base?: SyncMetadataEntry
): ConflictDecision {
  // Scenario 1: File is in Base snapshot
  if (base) {
    const localChanged = !local.exists || local.md5 !== base.localMd5;
    const remoteChanged = !remote.exists || remote.md5 !== base.remoteMd5;

    // 1.1 Neither changed
    if (!localChanged && !remoteChanged) {
      return { action: "noop", reason: "Unchanged on both sides", isConflict: false };
    }

    // 1.2 Both deleted
    if (!local.exists && !remote.exists) {
      return { action: "noop", reason: "Deleted on both sides", isConflict: false };
    }

    // 1.3 Local deleted, remote unchanged -> delete remote
    if (!local.exists && !remoteChanged) {
      return { action: "delete_remote", reason: "Deleted locally, clean up remote", isConflict: false };
    }

    // 1.4 Remote deleted, local unchanged -> delete local
    if (!remote.exists && !localChanged) {
      return { action: "delete_local", reason: "Deleted remotely, clean up local", isConflict: false };
    }

    // 1.5 Local changed, remote unchanged
    if (localChanged && !remoteChanged && local.exists) {
      return { action: "upload", reason: "Modified locally, upload to remote", isConflict: false };
    }

    // 1.6 Remote changed, local unchanged
    if (remoteChanged && !localChanged && remote.exists) {
      return { action: "download", reason: "Modified remotely, download to local", isConflict: false };
    }

    // 1.7 Both changed / deleted symmetrically
    if (local.exists && remote.exists) {
      if (local.md5 === remote.md5) {
        // Content converged to the same state
        return { action: "noop", reason: "Both modified to identical content", isConflict: false };
      }
      // True conflict: both modified with different contents
      return {
        action: "conflict",
        conflictSubtype: "both_modified",
        reason: "Both sides modified independently with differing hashes",
        isConflict: true,
      };
    }

    // 1.8 One deleted while the other modified -> Conflict
    if (local.exists && !remote.exists) {
      return {
        action: "conflict",
        conflictSubtype: "remote_deleted_local_modified",
        reason: "远端已删除但本地有新修改，存在修改与删除冲突",
        isConflict: true,
      };
    }

    if (!local.exists && remote.exists) {
      return {
        action: "conflict",
        conflictSubtype: "local_deleted_remote_modified",
        reason: "本地已删除但远端有新修改，存在修改与删除冲突",
        isConflict: true,
      };
    }

    return {
      action: "conflict",
      conflictSubtype: "both_modified",
      reason: "One side deleted while the other side was modified",
      isConflict: true,
    };
  }

  // Scenario 2: First-time sync (No base snapshot)
  if (local.exists && !remote.exists) {
    return { action: "upload", reason: "New local file", isConflict: false };
  }

  if (!local.exists && remote.exists) {
    return { action: "download", reason: "New remote file", isConflict: false };
  }

  if (local.exists && remote.exists) {
    if (local.md5 === remote.md5) {
      return { action: "noop", reason: "Files exist on both sides with identical hash", isConflict: false };
    }
    // Both exist on first sync but differ -> Conflict
    return {
      action: "conflict",
      reason: "File exists on both sides with differing contents on first sync",
      isConflict: true,
    };
  }

  return { action: "noop", reason: "Neither file exists", isConflict: false };
}

/**
 * Generate conflict resolution filename:
 * e.g. "Notes/Daily.md" -> "Notes/Daily.conflict-20261019-000523.md"
 */
export function generateConflictPath(originalPath: string): string {
  const dir = getParentDir(originalPath);
  const filename = getFileName(originalPath);
  const now = new Date();
  
  const pad = (n: number) => n.toString().padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const lastDot = filename.lastIndexOf(".");
  let conflictName: string;
  if (lastDot > 0) {
    const base = filename.substring(0, lastDot);
    const ext = filename.substring(lastDot);
    conflictName = `${base}.conflict-${timestamp}${ext}`;
  } else {
    conflictName = `${filename}.conflict-${timestamp}`;
  }

  return dir ? joinPaths(dir, conflictName) : conflictName;
}
