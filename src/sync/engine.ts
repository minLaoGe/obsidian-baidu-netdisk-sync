import { App, Notice, TAbstractFile, TFile } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { decryptData, encryptData, isEncrypted } from "../crypto/e2ee";
import { ConflictDecision, determineSyncAction, FileStateInspection, generateConflictPath } from "./conflict";
import { DebounceManager, FifoQueue, Mutex, runBounded } from "./queue";
import { SyncStateStore } from "./state";
import { PendingConflict, ConflictStrategy, PluginSettings, RemoteFileInfo, SyncLogEntry, SyncResult } from "../types";
import { AtomicFileSystem } from "../utils/atomic";
import { calculateMd5 } from "../utils/crypto";
import { normalizeVaultPath, toLocalPath, toRemotePath } from "../utils/path";

export class SyncEngine {
  private atomicFs: AtomicFileSystem;
  private stateStore: SyncStateStore;
  private client: BaiduClient;
  private syncMutex: Mutex = new Mutex();
  private taskQueue: FifoQueue = new FifoQueue();
  private debounceManager: DebounceManager = new DebounceManager();
  private isSyncing: boolean = false;
  private logs: SyncLogEntry[] = [];
  private onStatusChange?: (statusText: string, isBusy: boolean) => void;

  constructor(
    private app: App,
    private getSettings: () => PluginSettings,
    client: BaiduClient,
    onStatusChange?: (statusText: string, isBusy: boolean) => void
  ) {
    this.client = client;
    this.atomicFs = new AtomicFileSystem(app);
    this.stateStore = new SyncStateStore(app);
    this.onStatusChange = onStatusChange;
  }

  public updateClient(client: BaiduClient) {
    this.client = client;
  }

  public async initialize(): Promise<void> {
    const { restored, cleaned } = await this.atomicFs.recoverCrashAndCleanStale();
    await this.stateStore.load();
    if (restored > 0) {
      this.log("warn", `已自动执行崩溃恢复：成功从灾难备份还原了 ${restored} 个笔记文件！`);
      new Notice(`[BaiduSync] 崩溃恢复：已自动还原 ${restored} 个笔记文件！`);
    }
    if (cleaned > 0) {
      this.log("info", `已清理 ${cleaned} 个历史无用临时/备份文件。`);
    }
  }

  private setStatus(text: string, isBusy: boolean) {
    if (this.onStatusChange) {
      this.onStatusChange(text, isBusy);
    }
  }

  public log(level: "info" | "success" | "warn" | "error", message: string, detail?: string) {
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      detail,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) {
      this.logs.pop();
    }
    if (level === "error") {
      console.error(`[BaiduSync] ${message}`, detail || "");
    } else {
      console.log(`[BaiduSync] [${level.toUpperCase()}] ${message}`);
    }
  }

  public getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  /**
   * Check if a path should be ignored from syncing
   */
  private shouldIgnore(vaultPath: string): boolean {
    const norm = normalizeVaultPath(vaultPath);
    if (!norm) return true;
    if (/\.conflict-\d{8}-\d{6}(?:-[a-z0-9]+)?(?:\.|$)/.test(norm)) return true;
    
    // Ignore internal temporary and system folders
    if (norm.startsWith(".trash/") || norm.startsWith(".git/")) return true;
    const ownDir = `${this.app.vault.configDir || ".obsidian"}/plugins/baidu-sync`;
    if (norm === ownDir || norm.startsWith(ownDir + "/")) return true;

    if (this.getPendingConflicts().some(c => c.path === norm || c.copies.includes(norm))) return true;
    const settings = this.getSettings();

    // Check obsidian config sync rules
    if (norm.startsWith(".obsidian/")) {
      if (!settings.syncObsidianConfig) return true;
      if (norm.includes("workspace") || norm.includes("cache/")) return true;
      if (norm.startsWith(".obsidian/plugins/") && !settings.syncPlugins) return true;
      if (norm.startsWith(".obsidian/themes/") && !settings.syncThemes) return true;
    }

    // Custom user ignored patterns
    for (const pattern of settings.ignoredPatterns || []) {
      const p = pattern.trim();
      if (!p) continue;
      if (norm === p || norm.startsWith(p + "/") || norm.endsWith(p)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Register local vault file modification with debounce for ordering
   */
  public handleLocalFileModified(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (this.shouldIgnore(file.path)) return;

    const debounceSeconds = this.getSettings().syncOnModifyDebounceSeconds || 3;
    this.debounceManager.debounce(file.path, debounceSeconds * 1000, () => {
      this.taskQueue.enqueue(async () => {
        await this.syncSingleFile(file.path, true);
      });
    });
  }

  /**
   * Register local vault file deletion with debounce
   */
  public handleLocalFileDeleted(file: TAbstractFile): void {
    if (this.shouldIgnore(file.path)) return;

    this.debounceManager.debounce(file.path, 1000, () => {
      this.taskQueue.enqueue(async () => {
        await this.syncSingleFile(file.path, true);
      });
    });
  }

  /**
   * Sync a single file safely within sync lock
   */
  public async syncSingleFile(vaultPath: string, localChangeOnly: boolean = false): Promise<void> {
    if (this.shouldIgnore(vaultPath)) return;

    return this.syncMutex.acquire(async () => {
      try {
        const settings = this.getSettings();
        if (!settings.accessToken) return;

        const remotePath = toRemotePath(settings.remoteBasePath, vaultPath);
        const base = this.stateStore.get(vaultPath);

        const localInspection = await this.inspectLocalFile(vaultPath);
        // Event-driven jobs only need to push local changes. Full sync still
        // checks remote edits; identical-content saves need no network request.
        if (localChangeOnly && base && localInspection.exists && localInspection.md5 === base.localMd5) {
          return;
        }
        const remoteInspection = await this.inspectRemoteFile(remotePath);

        const decision = determineSyncAction(localInspection, remoteInspection, base);

        if (decision.action === "noop") return;
        await this.executeAction(vaultPath, remotePath, decision, localInspection, remoteInspection, base);
        await this.stateStore.save();
      } catch (err: any) {
        this.log("error", `单文件同步错误 "${vaultPath}"`, err.message || String(err));
      }
    });
  }

  /**
   * Run full bidirectional synchronization
   */
  public async runFullSync(): Promise<SyncResult> {
    return this.syncMutex.acquire(async () => {
      const result: SyncResult = {
        total: 0,
        skipped: 0,
        uploaded: 0,
        downloaded: 0,
        conflicted: 0,
        deleted: 0,
        errors: [],
      };

      const settings = this.getSettings();
      if (!settings.accessToken) {
        new Notice("百度网盘同步：请先在设置中填写并授权 Access Token！");
        return result;
      }

      const startedAt = Date.now();
      this.isSyncing = true;
      this.setStatus("正在同步...", true);
      this.log("info", "开始执行全量双向同步比对...");

      try {
        // 1. Gather all local files
        this.setStatus("扫描本地文件...", true);
        const localFiles = this.app.vault.getFiles().filter((f) => !this.shouldIgnore(f.path));
        const localMap: Map<string, TFile> = new Map();
        for (const file of localFiles) {
          localMap.set(normalizeVaultPath(file.path), file);
        }

        // 2. Gather all remote files
        this.setStatus("获取网盘文件列表...", true);
        const remoteList = await this.client.listFiles(settings.remoteBasePath, true);
        const remoteMap: Map<string, RemoteFileInfo> = new Map();
        for (const rItem of remoteList) {
          if (rItem.isdir === 1) continue;
          const relPath = toLocalPath(settings.remoteBasePath, rItem.path);
          if (relPath && !this.shouldIgnore(relPath)) {
            remoteMap.set(normalizeVaultPath(relPath), rItem);
          }
        }

        // 3. Collect union of all tracked paths (Local + Remote + Base)
        const baseEntries = this.stateStore.getAll();
        const allPaths = new Set<string>([
          ...localMap.keys(),
          ...remoteMap.keys(),
          ...Object.keys(baseEntries),
        ]);

        result.total = allPaths.size;

        // Plan from one baseline while holding the existing vault-wide mutex.
        // Only independent uploads may overlap. Downloads/deletions/conflicts run
        // after all uploads settle, preserving the existing atomic-write lock.
        const uploads: Array<() => Promise<void>> = [];
        const serial: Array<() => Promise<void>> = [];
        let completed = 0;
        for (const path of allPaths) {
          this.setStatus(`检查文件 (${uploads.length + serial.length + completed + 1}/${allPaths.size})`, true);
          try {
            if (this.shouldIgnore(path)) { completed++; result.skipped++; continue; }
            const remotePath = toRemotePath(settings.remoteBasePath, path);
            const base = baseEntries[path];
            const localFile = localMap.get(path);
            let localInspection = await this.inspectLocalFile(path, localFile);
            const remoteItem = remoteMap.get(path);
            const remoteInspection: FileStateInspection = remoteItem
              ? { exists: true, mtime: remoteItem.serverMtime, md5: remoteItem.md5,
                  size: remoteItem.size, fsId: remoteItem.fsId }
              : { exists: false };
            let decision = determineSyncAction(localInspection, remoteInspection, base);
            if (decision.action === "noop") { completed++; result.skipped++; continue; }
            const work = async () => {
              const itemStarted = Date.now();
              const wasUpload = decision.action === "upload";
              try {
                // Local content may change while the plan is being scanned or
                // waiting for a worker. Recheck before any overwrite/deletion.
                localInspection = await this.inspectLocalFile(path);
                decision = determineSyncAction(localInspection, remoteInspection, base);
                if (wasUpload && decision.action !== "upload") {
                  this.log("warn", `文件在排队期间发生变化，留待下次同步: ${path}`);
                  return;
                }
                if (decision.action !== "noop") {
                  await this.executeAction(path, remotePath, decision, localInspection, remoteInspection, base);

                  if (decision.action === "upload") {
                    result.uploaded++;
                    this.log("success", `上传成功: ${path}`);
                  } else if (decision.action === "download") {
                    result.downloaded++;
                    this.log("success", `下载成功: ${path}`);
                  } else if (decision.action === "conflict") {
                    result.conflicted++;
                    this.log("warn", `冲突待人工处理: ${path}`);
                  } else if (decision.action === "delete_local" || decision.action === "delete_remote") {
                    result.deleted++;
                    this.log("info", `删除同步完成: ${path}`);
                  }
                }
              } catch (itemErr: any) {
                this.log("error", `同步失败: ${path}`, itemErr.message || String(itemErr));
                result.errors.push({ path, error: itemErr.message || String(itemErr) });
                return;
              } finally {
                completed++;
                this.setStatus(`同步进度 (${completed}/${allPaths.size})`, true);
              }
              // Checkpoint only completed commits. Save stays serialized and
              // atomic; a checkpoint failure stops new work and drains workers.
              await this.stateStore.save();
              if (decision.action === "upload") {
                this.log("info", `上传耗时: ${path} ${(Date.now() - itemStarted) / 1000}s`);
              }
            };
            (decision.action === "upload" ? uploads : serial).push(work);
          } catch (itemErr: any) {
            completed++;
            this.log("error", `同步失败: ${path}`, itemErr.message || String(itemErr));
            result.errors.push({ path, error: itemErr.message || String(itemErr) });
          }
        }
        const concurrency = Math.max(1, Math.min(3, Math.floor(settings.uploadConcurrency || 3)));
        this.log("info", `上传计划: ${uploads.length} 个文件，并发 ${concurrency}`);
        if (uploads.length || serial.length) await this.client.createDirectory(settings.remoteBasePath);
        await runBounded(uploads, concurrency, work => work());
        for (const work of serial) await work();

        // 5. Update state and commit
        if (result.uploaded || result.downloaded || result.conflicted || result.deleted) {
          this.stateStore.setLastFullSyncTimestamp(Date.now());
          await this.stateStore.save();
        }

        this.setStatus(this.getPendingConflicts().length ? "部分文件待人工解决冲突" : "已同步", false);
        const summary = `同步完成: 跳过${result.skipped} ↑${result.uploaded} ↓${result.downloaded} ⚠${result.conflicted} ✕${result.deleted}${
          result.errors.length ? ` (失败: ${result.errors.length})` : ""
        }`;
        new Notice(summary);
        this.log("info", `${summary}；总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      } catch (err: any) {
        this.log("error", "全量同步过程异常退出", err.message || String(err));
        new Notice(`百度网盘同步错误: ${err.message || String(err)}`);
        this.setStatus("同步出错", false);
      } finally {
        this.isSyncing = false;
      }

      return result;
    });
  }

  /**
   * Execute decided sync action with atomicity, E2EE, and conflict resolution
   */
  private async executeAction(
    localPath: string,
    remotePath: string,
    decision: ConflictDecision,
    local: FileStateInspection,
    remote: FileStateInspection,
    base?: any
  ): Promise<void> {
    const settings = this.getSettings();

    switch (decision.action) {
      case "noop":
        return;

      case "upload": {
        let buffer = await this.atomicFs.readBinary(localPath);
        const localRawMd5 = calculateMd5(buffer);

        // End-to-End Encryption (E2EE)
        if (settings.enableE2EE) {
          if (!settings.e2eePassword || settings.e2eePassword.trim().length === 0) {
            throw new Error(`已启用端到端加密但未设置密码，已中止上传: ${localPath}`);
          }
          buffer = await encryptData(buffer, settings.e2eePassword);
        }

        const uploadResult = await this.client.uploadFile(remotePath, buffer);

        this.stateStore.set(localPath, {
          path: localPath,
          localMtime: local.mtime || Date.now(),
          localMd5: localRawMd5,
          remoteFsId: uploadResult.fsId,
          remoteMtime: Date.now(),
          remoteMd5: uploadResult.md5 || localRawMd5,
          lastSyncTime: Date.now(),
        });
        break;
      }

      case "download": {
        if (!remote.fsId) {
          throw new Error(`缺少 fs_id 无法下载: ${remotePath}`);
        }

        let data = await this.client.downloadFile(remote.fsId);

        // End-to-End Decryption
        if (isEncrypted(data) || settings.enableE2EE) {
          if (!settings.e2eePassword) {
            throw new Error(`文件 "${localPath}" 处于加密状态，但本地未配置解密密码！`);
          }
          data = await decryptData(data, settings.e2eePassword);
        }

        const decryptedMd5 = calculateMd5(data);

        // Atomic safe write
        await this.atomicFs.atomicWrite(localPath, data, decryptedMd5);

        const newStat = await this.app.vault.adapter.stat(localPath);
        this.stateStore.set(localPath, {
          path: localPath,
          localMtime: newStat ? newStat.mtime : Date.now(),
          localMd5: decryptedMd5,
          remoteFsId: remote.fsId,
          remoteMtime: remote.mtime || Date.now(),
          remoteMd5: remote.md5 || decryptedMd5,
          lastSyncTime: Date.now(),
        });
        break;
      }

      case "conflict": {
        await this.resolveConflict(localPath, remotePath, decision, local, remote, base);
        break;
      }

      case "delete_remote": {
        await this.client.deleteFile(remotePath);
        this.stateStore.delete(localPath);
        break;
      }

      case "delete_local": {
        await this.atomicFs.safeDelete(localPath);
        this.stateStore.delete(localPath);
        break;
      }
    }
  }

  public getPendingConflicts(): PendingConflict[] { return this.stateStore.getConflicts?.() || []; }

  /** Keep the original and the remote snapshot; never advance the baseline or
   * make a remote mutation until the user explicitly confirms resolution. */
  private async resolveConflict(localPath: string, remotePath: string,
    decision: ConflictDecision, local: FileStateInspection, remote: FileStateInspection,
    base?: any): Promise<void> {
    const existing = this.getPendingConflicts().find(c => c.path === localPath);
    if (existing && existing.remote.md5 === remote.md5 && existing.remote.fsId === remote.fsId && existing.remote.exists === remote.exists &&
        (!remote.exists || (existing.copies.length && await this.app.vault.adapter.exists(existing.copies[existing.copies.length - 1])))) return;
    let data: ArrayBuffer | undefined;
    let copyPath: string | undefined;
    if (remote.exists) {
      if (!remote.fsId) throw new Error("冲突缺少远端文件标识");
      data = await this.client.downloadFile(remote.fsId);
      const settings = this.getSettings();
      if (isEncrypted(data) || settings.enableE2EE) {
        if (!settings.e2eePassword) throw new Error("无法解密远端冲突副本");
        data = await decryptData(data, settings.e2eePassword);
      }
      copyPath = generateConflictPath(localPath);
      while (await this.app.vault.adapter.exists(copyPath)) copyPath = generateConflictPath(localPath);
    }
    const record: PendingConflict = { path: localPath, remotePath,
      copies: [...(existing?.copies || []), ...(copyPath ? [copyPath] : [])],
      remote: { exists: remote.exists, md5: remote.md5, fsId: remote.fsId, mtime: remote.mtime },
      createdAt: existing?.createdAt || Date.now() };
    // Persist the exclusion before creating a copy: create/modify events cannot
    // accidentally upload either side while this conflict is unresolved.
    this.stateStore.setConflict(record);
    await this.stateStore.save();
    if (copyPath && data) await this.atomicFs.atomicWrite(copyPath, data, calculateMd5(data));
    this.log("warn", `待人工解决冲突: ${localPath}${copyPath ? `；远端副本: ${copyPath}` : "；远端已删除"}`);
    new Notice(`百度同步发现冲突：${localPath}。已暂停此文件同步，请打开“待处理冲突”人工合并并确认。`, 15000);
  }

  public async refreshPendingConflict(path: string): Promise<void> {
    return this.syncMutex.acquire(async () => {
      const record = this.getPendingConflicts().find(c => c.path === path);
      if (!record) return;
      await this.resolveConflict(path, record.remotePath, {action:"conflict",reason:"User refreshed snapshot",isConflict:true},
        await this.inspectLocalFile(path), await this.inspectRemoteFile(record.remotePath));
    });
  }

  public async confirmConflictResolved(path: string): Promise<void> {
    return this.syncMutex.acquire(async () => {
      const record = this.getPendingConflicts().find(c => c.path === path);
      if (!record) return;
      const remote = await this.inspectRemoteFile(record.remotePath);
      if (remote.exists !== record.remote.exists || remote.md5 !== record.remote.md5 ||
          remote.fsId !== record.remote.fsId) {
        await this.resolveConflict(path, record.remotePath, {action:"conflict",reason:"Remote changed again",isConflict:true},
          await this.inspectLocalFile(path), remote);
        throw new Error("远端又发生了变化，已更新冲突记录，请重新检查双方版本。");
      }
      const local = await this.inspectLocalFile(path);
      if (local.exists) {
        await this.executeAction(path, record.remotePath, {action:"upload",reason:"User confirmed merge",isConflict:false},local,remote);
      } else if (remote.exists) {
        await this.client.deleteFile(record.remotePath);
        this.stateStore.delete(path);
      } else this.stateStore.delete(path);
      this.stateStore.clearConflict(path);
      try { await this.stateStore.save(); }
      catch (error) { this.stateStore.setConflict(record); throw error; }
      // Snapshot copies remain excluded even after resolution; never upload
      // archived remote versions as new notes.
      this.setStatus("冲突已处理", false);
      new Notice(`冲突已由人工确认并同步：${path}`);
    });
  }

  private async inspectLocalFile(vaultPath: string, cachedFile?: TFile): Promise<FileStateInspection> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(vaultPath);
    if (!exists) {
      return { exists: false };
    }

    const stat = await adapter.stat(vaultPath);
    const buffer = await adapter.readBinary(vaultPath);
    const md5 = calculateMd5(buffer);

    return {
      exists: true,
      mtime: stat ? stat.mtime : cachedFile ? cachedFile.stat.mtime : Date.now(),
      size: stat ? stat.size : buffer.byteLength,
      md5: md5,
    };
  }

  /**
   * Inspect remote file state.
   * Note: If network error occurs, we DO NOT swallow it and return exists: false.
   * We let it throw to abort single file sync safely, preventing accidental deletion of local files!
   */
  private async inspectRemoteFile(remotePath: string): Promise<FileStateInspection> {
    const parentDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    // listFiles will return [] if parentDir doesn't exist (errno -9), or throw on network/auth error
    const list = await this.client.listFiles(parentDir, false);
    const matched = list.find((item) => item.path === remotePath);

    if (matched && matched.isdir === 0) {
      return {
        exists: true,
        mtime: matched.serverMtime,
        size: matched.size,
        md5: matched.md5,
        fsId: matched.fsId,
      };
    }
    return { exists: false };
  }
}
