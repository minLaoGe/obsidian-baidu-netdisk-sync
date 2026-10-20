import { App } from "obsidian";
import { AtomicFileSystem } from "../utils/atomic";
import { calculateMd5 } from "../utils/crypto";

/** Local hints learned only from successful uploads or downloaded bytes.
 * Conflicting observations poison a key rather than guessing content. */
export class HashCache {
  private entries: Record<string, string | null> = {};
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(private app: App, private scope: string) {
    this.path = `${app.vault.configDir || ".obsidian"}/plugins/baidu-sync/hash-cache-${scope}.json`;
  }
  private key(hash: string | undefined, size: number | undefined): string | undefined {
    if (!hash || !/^[a-z0-9]{32}$/i.test(hash) || !Number.isSafeInteger(size) || size! < 0) return;
    return `${hash.toLowerCase()}:${size}`;
  }
  private async load() {
    if (this.loaded) return;
    try {
      const e = JSON.parse(await this.app.vault.adapter.read(this.path));
      if (e.version === 1 && e.scope === this.scope && e.entries && typeof e.entries === "object" && !Array.isArray(e.entries) &&
          e.checksum === calculateMd5(new TextEncoder().encode(JSON.stringify(e.entries)))) {
        this.entries = Object.fromEntries(Object.entries(e.entries).filter(([k,v]) => /^[a-z0-9]{32}:\d+$/.test(k) && (v === null || typeof v === "string" && /^[a-f0-9]{32}$/.test(v)))) as Record<string, string | null>;
      }
    } catch { /* Missing/corrupt cache always falls back to downloading. */ }
    this.loaded = true;
  }
  async matches(hash: string | undefined, size: number | undefined, plaintext: string): Promise<boolean> {
    await this.queue;
    await this.load();
    const key = this.key(hash,size);
    return !!key && this.entries[key] === plaintext.toLowerCase();
  }
  async remember(hash: string | undefined, size: number | undefined, plaintext: string): Promise<void> {
    const key = this.key(hash,size);
    if (!key || !/^[a-f0-9]{32}$/i.test(plaintext)) return;
    const task = this.queue.catch(() => undefined).then(async () => {
      await this.load();
      const value = plaintext.toLowerCase();
      if (this.entries[key] === value || this.entries[key] === null) return;
      this.entries[key] = this.entries[key] === undefined ? value : null;
      const entries = this.entries;
      const checksum = calculateMd5(new TextEncoder().encode(JSON.stringify(entries)));
      await new AtomicFileSystem(this.app).atomicWrite(this.path, JSON.stringify({version:1,scope:this.scope,checksum,entries}));
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
