import { App } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { calculateMd5 } from "../utils/crypto";
import { boundedInventoryRead } from "../utils/read-timeout";

export const JOURNAL_ENTRIES = 64;
export const JOURNAL_BYTES = 256 * 1024;
export const JOURNAL_NAME = /^device-([a-f0-9]{32})\.json$/;
interface Entry {
  sequence: number;
  id: string;
  phase: "begin" | "done";
  paths: string[];
  // Large batches invalidate the whole inventory rather than exceeding the cap.
  fullScan?: true;
}
export interface Journal { version: 2; writer: string; entries: Entry[]; }
export type Journals = Record<string, { fingerprint: string; journal: Journal }>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const randomId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");

export function validateJournal(value: any, name: string, validPath: (path: unknown) => boolean): Journal {
  const match = JOURNAL_NAME.exec(name);
  if (!match || value?.version !== 2 || value.writer !== match[1] ||
      !Array.isArray(value.entries) || !value.entries.length || value.entries.length > JOURNAL_ENTRIES ||
      encode(value).byteLength > JOURNAL_BYTES) throw new Error("设备变更日志格式或容量无效");
  const ids = new Set<string>();
  for (let i = 0; i < value.entries.length; i++) {
    const e = value.entries[i];
    if (!e || !Number.isSafeInteger(e.sequence) || e.sequence < 1 ||
        (i > 0 && e.sequence !== value.entries[i - 1].sequence + 1) ||
        typeof e.id !== "string" || !/^[a-f0-9]{32}$/.test(e.id) || ids.has(e.id) ||
        (e.phase !== "done" && !(e.phase === "begin" && i === value.entries.length - 1)) ||
        !Array.isArray(e.paths) || !e.paths.every(validPath) ||
        !(e.fullScan === true ? e.paths.length === 0 : e.fullScan === undefined && e.paths.length > 0)) {
      throw new Error("设备变更日志不连续或包含无效路径");
    }
    ids.add(e.id);
  }
  return value;
}

/** No wall-clock watermark: prove continuity from the last observed sequence.
 * Missing windows and altered prefixes require an actual complete inventory. */
export function journalChanges(previous: Journals, current: Journals): { paths: Set<string>; audit: boolean } {
  const paths = new Set<string>();
  let audit = Object.keys(previous).some(name => !Object.hasOwn(current, name));
  const include = (entry: Entry) => {
    if (entry.fullScan) audit = true;
    for (const path of entry.paths) paths.add(path);
  };
  for (const [name, item] of Object.entries(current)) {
    const before = previous[name]?.journal;
    const entries = item.journal.entries;
    const last = before?.entries[before.entries.length - 1];
    if (!last) {
      if (entries[0].sequence !== 1) audit = true;
      for (const e of entries) include(e);
    } else {
      if (entries[0].sequence > last.sequence + 1 || entries[entries.length - 1].sequence < last.sequence) audit = true;
      for (const old of before!.entries) {
        const retained = entries.find(e => e.sequence === old.sequence);
        if (retained && (retained.id !== old.id || JSON.stringify(retained.paths) !== JSON.stringify(old.paths) ||
            retained.fullScan !== old.fullScan || (old.phase === "done" && retained.phase !== "done"))) audit = true;
      }
      // A begin captured before a scan must be checked even if it has just
      // completed and fallen off a short (byte-limited) window.
      if (last.phase === "begin") include(last);
      for (const e of entries) if (e.sequence > last.sequence || e.phase === "begin" ||
          (e.sequence === last.sequence && last.phase === "begin")) include(e);
    }
  }
  return { paths, audit };
}

type WriterState = { journal?: Journal; loaded: boolean; tail: Promise<unknown> };
type Registry = WeakMap<object, Map<string, WriterState>>;

/** One bounded, single-writer document per vault/device/scope. Identity lives in
 * Obsidian's device-local storage, never in a copied/synced .obsidian folder.
 * Clear the reusable identity BEFORE publishing. A crash or ambiguous upload
 * abandons this document, so a delayed request cannot overwrite a newer one.
 * Abandoned documents are retained and pending paths remain inspectable. */
export class RollingJournal {
  constructor(private app: App, private client: BaiduClient, private directory: string,
    private scope: string, private validPath: (path: unknown) => boolean, private log: (message: string) => void) {}

  mutate<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    const key = Symbol.for("baidu-sync.rolling-writers.v2");
    const host = globalThis as unknown as { [key: symbol]: Registry };
    const registry = host[key] ||= new WeakMap();
    let states = registry.get(this.app);
    if (!states) { states = new Map(); registry.set(this.app, states); }
    const storageKey = "baidu-sync-journal-" + calculateMd5(encode([this.directory, this.scope]).buffer);
    let state = states.get(storageKey);
    if (!state) { state = { loaded: false, tail: Promise.resolve() }; states.set(storageKey, state); }
    const writer = state;
    const run = writer.tail.catch(() => undefined).then(() => this.write(writer, storageKey, paths, operation));
    writer.tail = run.catch(() => undefined);
    return run;
  }

  private async write<T>(state: WriterState, key: string, paths: string[], operation: () => Promise<T>): Promise<T> {
    // Required on supported Obsidian versions; never fall back to a synced file
    // for identity, which would make copied vaults overwrite each other's log.
    if (typeof this.app.loadLocalStorage !== "function" || typeof this.app.saveLocalStorage !== "function") {
      throw new Error("当前 Obsidian 不支持设备独立索引存储，请升级 Obsidian 后同步");
    }
    if (!state.loaded) {
      const stored = this.app.loadLocalStorage(key);
      let candidate: Journal | undefined;
      try {
        if (stored) {
          const journal = validateJournal(stored, `device-${stored.writer}.json`, this.validPath);
          if (journal.entries.every(e => e.phase === "done")) candidate = journal;
        }
      } catch { this.log("本机日志游标无效，将使用新的设备日志并保留旧记录"); }
      if (candidate) {
        // A restored device backup can roll back localStorage. Never let its
        // stale prefix overwrite newer cloud history. Verify once per loaded
        // writer; steady-state mutations do not add any read requests.
        const path = `${this.directory}/device-${candidate.writer}.json`;
        const remote = (await this.client.listFiles(this.directory, false)).find(f => f.path === path && f.isdir === 0);
        if (remote && remote.size > 0 && remote.size <= JOURNAL_BYTES) {
          const bytes = await boundedInventoryRead(this.client.downloadFile(remote.fsId, remote.size));
          if (bytes.byteLength === remote.size && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === JSON.stringify(candidate)) {
            state.journal = candidate;
          }
        }
        if (!state.journal) this.log("本机日志与云端不一致，保留原日志并使用新标识，避免覆盖较新的变更");
      }
      state.loaded = true;
    }
    const previous = state.journal;
    const sequence = previous ? previous.entries[previous.entries.length - 1].sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("设备日志序号超出范围，已停止写入");
    let entry: Entry = { sequence, id: randomId(), phase: "begin", paths: [...new Set(paths)] };
    let journal: Journal = { version: 2, writer: previous?.writer || randomId(), entries: [...(previous?.entries || []), entry] };
    // Leave enough room for the envelope; very large batches use an explicit
    // audit marker, not truncated paths or an unbounded number of fragments.
    if (encode({ ...journal, entries: [entry] }).byteLength > JOURNAL_BYTES) {
      entry = { sequence, id: entry.id, phase: "begin", paths: [], fullScan: true };
      journal.entries[journal.entries.length - 1] = entry;
    }
    while (journal.entries.length > JOURNAL_ENTRIES || encode(journal).byteLength > JOURNAL_BYTES) journal.entries.shift();
    const path = `${this.directory}/device-${journal.writer}.json`;
    this.app.saveLocalStorage(key, null);
    state.journal = undefined;
    // If begin publication fails, no user-file operation may run. Do not reuse
    // this name after any uncertain upload, including a failure of done.
    await this.client.uploadFile(path, encode(journal).buffer);
    try {
      return await operation();
    } finally {
      journal = { ...journal, entries: journal.entries.map(e => e === entry ? { ...e, phase: "done" as const } : e) };
      try {
        await this.client.uploadFile(path, encode(journal).buffer);
        this.app.saveLocalStorage(key, journal);
        state.journal = journal;
      } catch {
        this.log("设备日志提交未确认：保留旧日志，下次使用新日志；未完成路径将持续复查");
      }
    }
  }
}
