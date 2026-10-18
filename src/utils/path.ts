/**
 * Utility functions for file path manipulation across local and Baidu Netdisk.
 */

/**
 * Normalize a vault path: replace backslashes, remove leading/trailing slashes.
 * e.g., "\\folder\\note.md" -> "folder/note.md"
 */
export function normalizeVaultPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

/**
 * Join paths with forward slash, removing redundant slashes.
 */
export function joinPaths(...parts: string[]): string {
  const filtered = parts
    .map(p => p.replace(/\\/g, "/"))
    .filter(p => p && p.trim().length > 0);
  
  const joined = filtered.join("/");
  return joined.replace(/\/+/g, "/");
}

/**
 * Convert local vault path to remote Baidu Netdisk absolute path.
 * e.g., remoteBase: "/apps/obsidian", local: "notes/work.md" -> "/apps/obsidian/notes/work.md"
 */
export function toRemotePath(remoteBase: string, localVaultPath: string): string {
  const normBase = "/" + normalizeVaultPath(remoteBase);
  const normPath = normalizeVaultPath(localVaultPath);
  if (!normPath) return normBase;
  return normBase + "/" + normPath;
}

/**
 * Convert remote Baidu Netdisk absolute path to local vault relative path.
 * e.g., remoteBase: "/apps/obsidian", remote: "/apps/obsidian/notes/work.md" -> "notes/work.md"
 */
export function toLocalPath(remoteBase: string, remoteAbsolutePath: string): string {
  const normBase = "/" + normalizeVaultPath(remoteBase);
  const normRemote = "/" + normalizeVaultPath(remoteAbsolutePath);
  
  if (normRemote === normBase) return "";
  if (normRemote.startsWith(normBase + "/")) {
    return normRemote.slice(normBase.length + 1);
  }
  return normalizeVaultPath(remoteAbsolutePath);
}

/**
 * Get directory part of a path.
 */
export function getParentDir(p: string): string {
  const norm = normalizeVaultPath(p);
  const lastSlash = norm.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return norm.substring(0, lastSlash);
}

/**
 * Get base filename without directory.
 */
export function getFileName(p: string): string {
  const norm = normalizeVaultPath(p);
  const lastSlash = norm.lastIndexOf("/");
  if (lastSlash === -1) return norm;
  return norm.substring(lastSlash + 1);
}
