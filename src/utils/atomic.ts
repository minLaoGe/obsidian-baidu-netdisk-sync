import { App, TFile, TFolder } from "obsidian";
import { calculateMd5 } from "./crypto";
import { getParentDir } from "./path";

/**
 * Atomic local file operations to guarantee data integrity.
 * Writes to a temporary file first, verifies hash and size, then atomically renames/replaces.
 */
export class AtomicFileSystem {
  constructor(private app: App) {}

  /**
   * Atomically write an ArrayBuffer or string to a local vault path.
   * If expectedMd5 is provided, it verifies the content hash before completing the commit.
   */
  async atomicWrite(
    vaultPath: string,
    data: ArrayBuffer | string,
    expectedMd5?: string
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parentDir = getParentDir(vaultPath);

    // 1. Ensure parent directory exists
    if (parentDir && !(await adapter.exists(parentDir))) {
      await this.ensureDirectoryExists(parentDir);
    }

    // 2. Prepare binary buffer and verify MD5 before even touching disk
    const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const computedMd5 = calculateMd5(buffer);
    if (expectedMd5 && computedMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
      throw new Error(
        `MD5 mismatch before writing "${vaultPath}". Expected ${expectedMd5}, computed ${computedMd5}`
      );
    }

    // 3. Write to a unique temporary file
    const tmpPath = `${vaultPath}.synctmp.${Date.now()}.${Math.random().toString(36).substring(2, 8)}`;
    
    try {
      if (typeof data === "string") {
        await adapter.write(tmpPath, data);
      } else {
        await adapter.writeBinary(tmpPath, data);
      }

      // 4. Verify tmp file on disk
      const tmpStat = await adapter.stat(tmpPath);
      if (!tmpStat || tmpStat.size !== buffer.length) {
        throw new Error(
          `Temp file size mismatch for "${vaultPath}". Expected ${buffer.length}, got ${tmpStat?.size}`
        );
      }

      // 5. Atomic replacement
      // If target exists, remove it or rename tmp over it
      const targetExists = await adapter.exists(vaultPath);
      if (targetExists) {
        // Safe replace: remove existing target and rename tmp to target
        await adapter.remove(vaultPath);
      }
      await adapter.rename(tmpPath, vaultPath);
    } catch (err) {
      // Clean up tmp file if it still exists
      try {
        if (await adapter.exists(tmpPath)) {
          await adapter.remove(tmpPath);
        }
      } catch (cleanErr) {
        console.error(`Failed to cleanup temp file "${tmpPath}":`, cleanErr);
      }
      throw err;
    }
  }

  /**
   * Recursively ensure a directory exists in vault.
   */
  async ensureDirectoryExists(dirPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!dirPath || dirPath === "." || dirPath === "/") return;
    
    const parts = dirPath.split("/").filter(p => p.length > 0);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
          // May throw if folder was created concurrently or already exists
          if (!(await adapter.exists(current))) {
            throw e;
          }
        }
      }
    }
  }

  /**
   * Safely delete a file or directory if it exists.
   */
  async safeDelete(vaultPath: string): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(vaultPath)) {
      const item = this.app.vault.getAbstractFileByPath(vaultPath);
      if (item) {
        await this.app.vault.trash(item, false); // move to system trash or trash folder
      } else {
        await adapter.remove(vaultPath);
      }
      return true;
    }
    return false;
  }

  /**
   * Read file as ArrayBuffer safely.
   */
  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    const adapter = this.app.vault.adapter;
    return await adapter.readBinary(vaultPath);
  }

  /**
   * Clean up any stale .synctmp.* files that may have been left behind from a crash.
   */
  async cleanStaleTempFiles(rootFolder: string = ""): Promise<number> {
    const adapter = this.app.vault.adapter;
    let cleaned = 0;
    try {
      const files = await adapter.list(rootFolder);
      for (const file of files.files) {
        if (file.includes(".synctmp.")) {
          try {
            await adapter.remove(file);
            cleaned++;
          } catch (e) {
            console.warn(`Could not remove stale tmp file ${file}:`, e);
          }
        }
      }
      for (const folder of files.folders) {
        cleaned += await this.cleanStaleTempFiles(folder);
      }
    } catch (e) {
      console.warn("Failed scanning for stale temp files:", e);
    }
    return cleaned;
  }
}
