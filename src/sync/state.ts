import { App } from "obsidian";
import { AtomicFileSystem } from "../utils/atomic";
import { PendingConflict, SyncMetadataEntry, SyncStateData } from "../types";

/**
 * Manages the persistent synchronization state database with atomic write semantics.
 */
export class SyncStateStore {
  private data: SyncStateData = {
    version: 1,
    lastFullSyncTimestamp: 0,
    files: {},
  };
  private isDirty: boolean = false;
  private saveLock: Promise<void> = Promise.resolve();
  private stateFilePath: string;

  constructor(private app: App, stateFilePath: string = `${app.vault.configDir || ".obsidian"}/plugins/baidu-sync/sync-state.json`) {
    this.stateFilePath = stateFilePath;
  }

  /**
   * Load existing state; a corrupt baseline blocks sync instead of being discarded.
   */
  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.stateFilePath)) {
        const content = await adapter.read(this.stateFilePath);
        const parsed = JSON.parse(content);
        if (parsed && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)) {
          this.data = {
            version: parsed.version || 1,
            lastFullSyncTimestamp: parsed.lastFullSyncTimestamp || 0,
            files: parsed.files || {},
            conflicts: parsed.conflicts || {},
          };
        } else {
          throw new Error("Invalid sync state");
        }
      }
    } catch (err) {
      throw new Error(`同步基线加载失败，已停止同步以保护现有文件: ${String(err)}`);
    }
    this.isDirty = false;
  }

  getConflicts(): PendingConflict[] { return Object.values(this.data.conflicts || {}); }
  setConflict(record: PendingConflict): void {
    (this.data.conflicts ||= {})[record.path] = record;
    this.isDirty = true;
  }
  clearConflict(path: string): void {
    if (this.data.conflicts?.[path]) { delete this.data.conflicts[path]; this.isDirty = true; }
  }

  /**
   * Get metadata entry for a file
   */
  get(path: string): SyncMetadataEntry | undefined {
    return this.data.files[path];
  }

  /**
   * Set or update metadata entry with monotonically increasing revision
   */
  set(
    path: string,
    entry: Omit<SyncMetadataEntry, "revision"> & { revision?: number }
  ): void {
    const existing = this.data.files[path];
    const nextRevision = (existing?.revision ?? 0) + 1;
    
    this.data.files[path] = {
      ...entry,
      revision: entry.revision ?? nextRevision,
    };
    this.isDirty = true;
  }

  /**
   * Remove entry for a deleted file
   */
  delete(path: string): void {
    if (this.data.files[path]) {
      delete this.data.files[path];
      this.isDirty = true;
    }
  }

  /**
   * Get all tracked file entries
   */
  getAll(): Record<string, SyncMetadataEntry> {
    return { ...this.data.files };
  }

  /**
   * Update full sync timestamp
   */
  setLastFullSyncTimestamp(ts: number): void {
    this.data.lastFullSyncTimestamp = ts;
    this.isDirty = true;
  }

  getLastFullSyncTimestamp(): number {
    return this.data.lastFullSyncTimestamp;
  }

  /**
   * Atomically persist state to disk (tmp file -> write -> verify JSON -> rename)
   */
  async save(): Promise<void> {
    if (!this.isDirty) return;

    // A failed save must not poison the queue or discard newer in-memory changes.
    const task = this.saveLock.catch(() => undefined).then(async () => {
      const json = JSON.stringify(this.data, null, 2);
      await new AtomicFileSystem(this.app).atomicWrite(this.stateFilePath, json);
      this.isDirty = JSON.stringify(this.data, null, 2) !== json;
    });
    this.saveLock = task;
    return task;
  }
}
