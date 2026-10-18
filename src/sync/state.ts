import { App } from "obsidian";
import { SyncMetadataEntry, SyncStateData } from "../types";

const DEFAULT_STATE_FILE_PATH = ".obsidian/plugins/baidu-sync/sync-state.json";

/**
 * Manages the persistent synchronization state database with atomic write semantics.
 */
export class SyncStateStore {
  private data: SyncStateData = {
    version: 1,
    lastFullSyncTimestamp: 0,
    files: {},
  };
  private isLoaded: boolean = false;
  private isDirty: boolean = false;
  private saveLock: Promise<void> = Promise.resolve();
  private stateFilePath: string;

  constructor(private app: App, stateFilePath: string = DEFAULT_STATE_FILE_PATH) {
    this.stateFilePath = stateFilePath;
  }

  /**
   * Load existing state from disk. If missing or corrupted, initializes safely.
   */
  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.stateFilePath)) {
        const content = await adapter.read(this.stateFilePath);
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.files === "object") {
          this.data = {
            version: parsed.version || 1,
            lastFullSyncTimestamp: parsed.lastFullSyncTimestamp || 0,
            files: parsed.files || {},
          };
        }
      }
    } catch (err) {
      console.warn("Failed to parse existing sync-state.json, initializing new state:", err);
      this.data = {
        version: 1,
        lastFullSyncTimestamp: 0,
        files: {},
      };
    }
    this.isLoaded = true;
    this.isDirty = false;
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
    const nextRevision = (existing ? existing.revision : 0) + 1;
    
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

    // Chain saves to avoid concurrent writing collisions
    this.saveLock = this.saveLock.then(async () => {
      const adapter = this.app.vault.adapter;
      const jsonContent = JSON.stringify(this.data, null, 2);
      
      // Ensure plugin folder exists
      const lastSlash = this.stateFilePath.lastIndexOf("/");
      const pluginDir = lastSlash > 0 ? this.stateFilePath.substring(0, lastSlash) : ".obsidian/plugins/baidu-sync";
      if (!(await adapter.exists(pluginDir))) {
        await adapter.mkdir(pluginDir);
      }

      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}`;
      try {
        await adapter.write(tmpPath, jsonContent);
        
        // Verify tmp file by re-parsing
        const verifyContent = await adapter.read(tmpPath);
        JSON.parse(verifyContent);

        // Atomic replace
        if (await adapter.exists(this.stateFilePath)) {
          await adapter.remove(this.stateFilePath);
        }
        await adapter.rename(tmpPath, this.stateFilePath);
        this.isDirty = false;
      } catch (err) {
        try {
          if (await adapter.exists(tmpPath)) {
            await adapter.remove(tmpPath);
          }
        } catch (_) {}
        console.error("Failed to atomically save sync-state.json:", err);
        throw err;
      }
    });

    return this.saveLock;
  }
}
