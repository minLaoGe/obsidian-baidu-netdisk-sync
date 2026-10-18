import { App, TFile } from "obsidian";
import { calculateMd5 } from "./crypto";
import { getParentDir } from "./path";

/**
 * Two-phase transaction filesystem for Obsidian notes with automatic crash rollback & recovery.
 * Completely cross-platform (iOS, Android, Desktop) without Node.js Buffer / crypto dependencies.
 */
export class AtomicFileSystem {
  constructor(private app: App) {}

  /**
   * Atomically write an ArrayBuffer, Uint8Array or string to a local vault path.
   * Employs Two-Phase Swap with Backup (.syncbak) & Rollback:
   * 1. Write and verify temporary file (.synctmp)
   * 2. Move existing target file to backup (.syncbak)
   * 3. Rename temporary file to target file
   * 4. On failure, automatically restore .syncbak
   * 5. On success, clean up .syncbak
   */
  async atomicWrite(
    vaultPath: string,
    data: ArrayBuffer | Uint8Array | string,
    expectedMd5?: string
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parentDir = getParentDir(vaultPath);

    // 1. Ensure parent directory exists
    if (parentDir && !(await adapter.exists(parentDir))) {
      await this.ensureDirectoryExists(parentDir);
    }

    // 2. Prepare binary bytes cross-platform
    const bytes: Uint8Array =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);

    // 3. Compute and verify hash before touching disk
    const computedMd5 = calculateMd5(bytes);
    if (expectedMd5 && computedMd5.toLowerCase() !== expectedMd5.toLowerCase()) {
      throw new Error(
        `MD5 校验失败，已拒绝写入 "${vaultPath}"。预期: ${expectedMd5}, 计算值: ${computedMd5}`
      );
    }

    // 4. Write to a unique temporary file
    const tmpPath = `${vaultPath}.synctmp.${Date.now()}.${Math.random().toString(36).substring(2, 8)}`;
    const bakPath = `${vaultPath}.syncbak`;

    try {
      if (typeof data === "string") {
        await adapter.write(tmpPath, data);
      } else {
        const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await adapter.writeBinary(tmpPath, arrayBuf);
      }

      // Verify temp file on disk
      const tmpStat = await adapter.stat(tmpPath);
      if (!tmpStat || tmpStat.size !== bytes.length) {
        throw new Error(
          `临时文件大小校验失败 "${vaultPath}". 预期: ${bytes.length}, 实际: ${tmpStat?.size}`
        );
      }

      // 5. Two-Phase Swap
      const targetExists = await adapter.exists(vaultPath);
      if (targetExists) {
        // Move old version to backup before overwriting
        if (await adapter.exists(bakPath)) {
          await adapter.remove(bakPath);
        }
        await adapter.rename(vaultPath, bakPath);
      }

      try {
        // Commit new version
        await adapter.rename(tmpPath, vaultPath);

        // Success! Safe to clean up the backup
        if (targetExists && (await adapter.exists(bakPath))) {
          await adapter.remove(bakPath);
        }
      } catch (commitErr) {
        // Rollback: if target does not exist but backup exists, restore old version
        try {
          if (targetExists && !(await adapter.exists(vaultPath)) && (await adapter.exists(bakPath))) {
            await adapter.rename(bakPath, vaultPath);
            console.warn(`[BaiduSync] 写入失败，已成功从备份回滚恢复原文件: ${vaultPath}`);
          }
        } catch (rollbackErr) {
          console.error(`[BaiduSync] 回滚备份失败: ${vaultPath}`, rollbackErr);
        }
        throw commitErr;
      }
    } catch (err) {
      // Clean up orphaned temp file if still present
      try {
        if (await adapter.exists(tmpPath)) {
          await adapter.remove(tmpPath);
        }
      } catch (_) {}
      throw err;
    }
  }

  /**
   * Recursively ensure a directory exists in vault.
   */
  async ensureDirectoryExists(dirPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!dirPath || dirPath === "." || dirPath === "/") return;

    const parts = dirPath.split("/").filter((p) => p.length > 0);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
          if (!(await adapter.exists(current))) {
            throw e;
          }
        }
      }
    }
  }

  /**
   * Safely delete a file or directory if it exists (using trash).
   */
  async safeDelete(vaultPath: string): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(vaultPath)) {
      const item = this.app.vault.getAbstractFileByPath(vaultPath);
      if (item) {
        await this.app.vault.trash(item, false);
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
   * Startup Crash Recovery & Cleanup:
   * 1. If a .syncbak exists and the original file is missing, automatically RESTORE it!
   * 2. If original file exists, remove stale .syncbak and .synctmp
   */
  async recoverCrashAndCleanStale(rootFolder: string = ""): Promise<{ restored: number; cleaned: number }> {
    const adapter = this.app.vault.adapter;
    let restored = 0;
    let cleaned = 0;

    try {
      const list = await adapter.list(rootFolder);

      for (const file of list.files) {
        // Crash recovery for .syncbak
        if (file.endsWith(".syncbak")) {
          const originalPath = file.slice(0, -".syncbak".length);
          const origExists = await adapter.exists(originalPath);

          if (!origExists) {
            try {
              await adapter.rename(file, originalPath);
              restored++;
              console.log(`[BaiduSync] 崩溃恢复：已从灾难备份成功还原 "${originalPath}"`);
            } catch (rErr) {
              console.error(`[BaiduSync] 还原备份失败 "${file}":`, rErr);
            }
          } else {
            // Original exists, safe to delete stale backup
            try {
              await adapter.remove(file);
              cleaned++;
            } catch (_) {}
          }
        } else if (file.includes(".synctmp.")) {
          try {
            await adapter.remove(file);
            cleaned++;
          } catch (_) {}
        }
      }

      for (const folder of list.folders) {
        const sub = await this.recoverCrashAndCleanStale(folder);
        restored += sub.restored;
        cleaned += sub.cleaned;
      }
    } catch (e) {
      console.warn("[BaiduSync] 崩溃扫描检查失败:", e);
    }

    return { restored, cleaned };
  }
}
