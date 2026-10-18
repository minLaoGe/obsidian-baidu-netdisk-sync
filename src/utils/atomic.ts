import { App, FileSystemAdapter, Platform } from "obsidian";
import { calculateMd5 } from "./crypto";
import { getParentDir } from "./path";

interface Journal {
  version: 1;
  target: string;
  oldHash: string | null;
  newHash: string;
}

/** Recoverable single-file replacement. DataAdapter has no fsync/atomic-overwrite
 * contract: this provides verified backups and restart recovery, not power-loss
 * durability or an atomic transaction across the vault and remote service. */
export class AtomicFileSystem {
  private static locks = new WeakMap<App, Promise<unknown>>();
  readonly transactionDir: string;

  constructor(private app: App) {
    this.transactionDir = `${app.vault.configDir || ".obsidian"}/plugins/baidu-sync/transactions`;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = AtomicFileSystem.locks.get(this.app) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    AtomicFileSystem.locks.set(this.app, next.catch(() => undefined));
    return next;
  }

  private validateTarget(path: string): void {
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") ||
        path.split("/").some(p => !p || p === "." || p === "..") ||
        path === this.transactionDir || path.startsWith(this.transactionDir + "/")) {
      throw new Error(`Unsafe transaction target: ${path}`);
    }
  }

  private async hash(path: string): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    return await adapter.exists(path) ? calculateMd5(await adapter.readBinary(path)) : null;
  }

  private async verify(path: string, hash: string): Promise<void> {
    if (await this.hash(path) !== hash) throw new Error(`File verification failed: ${path}`);
  }

  /** Desktop-only native API; never resolved on mobile. rename replaces an
   * existing file in one filesystem operation instead of delete + rename. */
  private nativeIO(): { fs: typeof import("fs/promises"); base: string } | null {
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return null;
    return { fs: require("fs/promises"), base: adapter.getBasePath() };
  }

  private async flush(path: string): Promise<void> {
    const native = this.nativeIO();
    if (!native) return;
    const handle = await native.fs.open(`${native.base}/${path}`, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async cleanup(record: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const stem = record.slice(0, -5);
    // Journal is removed last. A failed cleanup remains recoverable and idempotent.
    for (const path of [stem + ".new", stem + ".old", record]) {
      if (await adapter.exists(path)) await adapter.remove(path);
    }
  }

  private async recoverOne(record: string): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const j: Journal = JSON.parse(await adapter.read(record));
    if (j.version !== 1 || typeof j.target !== "string" ||
        !/^[a-f0-9]{32}$/.test(j.newHash) ||
        !(j.oldHash === null || /^[a-f0-9]{32}$/.test(j.oldHash))) {
      throw new Error(`Invalid transaction journal; manual recovery required: ${record}`);
    }
    this.validateTarget(j.target);
    const current = await this.hash(j.target);
    if (current === j.newHash || (j.oldHash !== null && current === j.oldHash)) {
      await this.cleanup(record);
      return false;
    }
    if (current !== null) {
      // An external edit or corrupt target must never cause silent backup deletion.
      throw new Error(`Target changed during transaction; preserved recovery files: ${j.target}`);
    }
    const stem = record.slice(0, -5);
    const source = j.oldHash === null ? stem + ".new" : stem + ".old";
    const expected = j.oldHash === null ? j.newHash : j.oldHash;
    await this.verify(source, expected);
    await this.ensureDirectoryExists(getParentDir(j.target));
    // Copy rather than move: retain the verified recovery source if this write fails.
    await adapter.writeBinary(j.target, await adapter.readBinary(source));
    await this.verify(j.target, expected);
    await this.cleanup(record);
    return true;
  }

  private async recover(): Promise<{ restored: number; cleaned: number }> {
    const adapter = this.app.vault.adapter;
    let restored = 0, cleaned = 0;
    if (!(await adapter.exists(this.transactionDir))) return { restored, cleaned };
    const list = await adapter.list(this.transactionDir);
    for (const record of list.files.filter(p => /\/[a-f0-9-]+\.json$/.test(p))) {
      if (await this.recoverOne(record)) restored++;
      cleaned++;
    }
    // Unjournalled payloads are deliberately retained. Never scan user filenames.
    return { restored, cleaned };
  }

  async recoverCrashAndCleanStale(): Promise<{ restored: number; cleaned: number }> {
    return this.exclusive(() => this.recover());
  }

  async atomicWrite(path: string, data: ArrayBuffer | Uint8Array | string, expectedMd5?: string): Promise<void> {
    return this.exclusive(async () => {
      this.validateTarget(path);
      await this.recover(); // unresolved transactions block subsequent writes
      const adapter = this.app.vault.adapter;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) :
        new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
      const newHash = calculateMd5(bytes);
      if (expectedMd5 && expectedMd5.toLowerCase() !== newHash) throw new Error(`MD5 mismatch: ${path}`);
      await this.ensureDirectoryExists(getParentDir(path));
      await this.ensureDirectoryExists(this.transactionDir);
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
      const stem = `${this.transactionDir}/${id}`;
      const record = stem + ".json";
      await adapter.writeBinary(stem + ".new", bytes.buffer as ArrayBuffer);
      await this.verify(stem + ".new", newHash);
      const oldHash = await this.hash(path);
      if (oldHash !== null) {
        await adapter.writeBinary(stem + ".old", await adapter.readBinary(path));
        await this.verify(stem + ".old", oldHash);
      }
      const journal: Journal = { version: 1, target: path, oldHash, newHash };
      const json = JSON.stringify(journal);
      await adapter.write(record, json);
      if (await adapter.read(record) !== json) throw new Error(`Journal verification failed: ${record}`);
      // Request data durability where desktop filesystem APIs are available.
      await this.flush(stem + ".new");
      if (oldHash !== null) await this.flush(stem + ".old");
      await this.flush(record);
      // Recheck immediately before replacing; this is not a lock against external editors.
      if (await this.hash(path) !== oldHash) throw new Error(`File changed before commit: ${path}`);
      try {
        const native = this.nativeIO();
        if (native) {
          // No remove fallback on desktop: if atomic replacement is unsupported,
          // fail with the original intact and retain/recover the transaction.
          await native.fs.rename(`${native.base}/${stem}.new`, `${native.base}/${path}`);
        } else {
          // Mobile adapter has no portable atomic-overwrite primitive.
          if (oldHash !== null) await adapter.remove(path);
          await adapter.rename(stem + ".new", path);
        }
        await this.verify(path, newHash);
      } catch (error) {
        // Best effort rollback; on failure leave the journal and backup for restart.
        try { await this.recoverOne(record); } catch { /* preserve all recovery evidence */ }
        throw error;
      }
      // A cleanup failure must not report a successfully committed file as unwritten.
      try { await this.cleanup(record); } catch (error) {
        console.warn("[BaiduSync] Committed; transaction cleanup deferred", error);
      }
    });
  }

  async ensureDirectoryExists(dir: string): Promise<void> {
    if (!dir) return;
    const adapter = this.app.vault.adapter;
    let current = "";
    for (const part of dir.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        try { await adapter.mkdir(current); }
        catch (error) { if (!(await adapter.exists(current))) throw error; }
      }
    }
  }

  async safeDelete(path: string): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) await this.app.vault.trash(file, false);
    else await adapter.trashLocal(path);
    return true;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(path);
  }
}
