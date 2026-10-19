import { RemoteIndex, INDEX_DIR } from "./remote-index";
import { hasConflictMarkers, mergeText } from "./merge";
import { App, Notice, Platform, TAbstractFile, TFile } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { decryptData, encryptData, isEncrypted } from "../crypto/e2ee";
import { ConflictDecision, determineSyncAction, FileStateInspection, generateConflictPath, sameFileVersion } from "./conflict";
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
  private interactiveConflictRequests=0;
  private batchJournalActive=false;
  private disposed=false;
  public dispose(): void {
    this.disposed=true;
    this.debounceManager.clearAll();
  }
  private automaticSyncBlocked(): boolean {
    return this.disposed || this.getSettings().syncPaused || !!(Platform.isMobile && this.getSettings().mobileManualSync);
  }
  private lastConflictNoticeAt=0;
  private notifyConflict():void {
    if(this.isSyncing || this.interactiveConflictRequests>0) return;
    const now=Date.now();
    if(now-this.lastConflictNoticeAt<10000) return;
    this.lastConflictNoticeAt=now;
    new Notice("百度同步发现待处理冲突，请点击状态栏查看并解决。其他文件继续同步。",10000);
  }
  private taskQueue: FifoQueue = new FifoQueue();
  private debounceManager: DebounceManager = new DebounceManager();
  private isSyncing: boolean = false;
  private logs: SyncLogEntry[] = [];
  private progressStatus = '就绪';
  private progressResult: SyncResult | null = null;
  private progressStartedAt = 0;
  private progressFinishedAt = 0;
  private currentFiles = new Set<string>();
  public getProgress() {
    const match = /\((\d+)\/(\d+)\)/.exec(this.progressStatus);
    const result = this.progressResult;
    return { status: this.progressStatus, busy: this.isSyncing, startedAt: this.progressStartedAt, finishedAt: this.progressFinishedAt,
      done: match ? Number(match[1]) : 0, total: match ? Number(match[2]) : 0,
      uploaded: result?.uploaded ?? 0, downloaded: result?.downloaded ?? 0, skipped: result?.skipped ?? 0,
      conflicted: result?.conflicted ?? 0, errors: result?.errors.length ?? 0, files: [...this.currentFiles] };
  }
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
    this.progressStatus = text;
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
    if(norm===INDEX_DIR || norm.startsWith(INDEX_DIR+"/")) return true;
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
    if (this.automaticSyncBlocked()) return;
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
    if (this.automaticSyncBlocked()) return;
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
        if (this.disposed || !settings.accessToken || settings.syncPaused || (localChangeOnly && this.automaticSyncBlocked())) return;

        const remotePath = toRemotePath(settings.remoteBasePath, vaultPath);
        const base = this.stateStore.get(vaultPath);

        const localInspection = await this.inspectLocalFile(vaultPath);
        // Event-driven jobs only need to push local changes. Full sync still
        // checks remote edits; identical-content saves need no network request.
        if (localChangeOnly && base && localInspection.exists && localInspection.md5 === base.localMd5) {
          return;
        }
        const remoteInspection = await this.inspectRemoteFile(remotePath);

        const decision = determineSyncAction(localInspection, remoteInspection, base, !!(settings.incrementalSync && localChangeOnly));

        if (decision.action === "noop") {
          if (this.rememberIdenticalVersion(vaultPath,localInspection,remoteInspection,base)) await this.stateStore.save();
          return;
        }
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
  public async runFullSync(forceFull=false): Promise<SyncResult> {
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

      this.progressResult = result; this.progressStartedAt = Date.now(); this.progressFinishedAt = 0; this.currentFiles.clear();
      const settings = this.getSettings();
      if (this.disposed || settings.syncPaused) { this.setStatus("已暂停",false); return result; }
      if (!settings.accessToken) {
        new Notice("百度网盘同步：请先在设置中填写并授权 Access Token！");
        return result;
      }

      const startedAt = Date.now();
      this.isSyncing = true;
      this.setStatus("正在同步...", true);
      this.log("info", "开始检查同步变更...");

      try {
        // 1. Gather all local files
        this.setStatus("扫描本地文件...", true);
        const localFiles = this.app.vault.getFiles().filter((f) => !this.shouldIgnore(f.path));
        const localMap: Map<string, TFile> = new Map();
        for (const file of localFiles) {
          localMap.set(normalizeVaultPath(file.path), file);
        }

        // 2. Gather all remote files
        this.setStatus(settings.incrementalSync ? "检查远端变更记录..." : "完整校验网盘目录...", true);
        const indexed=settings.incrementalSync ? await this.remoteIndex().inventory(forceFull) : undefined;
        const remoteList=indexed ? indexed.files : await this.client.listFiles(settings.remoteBasePath,true,()=>this.interactiveConflictRequests>0);
        if(indexed) this.log("info",indexed.incremental ? `增量检查：远端 ${indexed.changed} 个变更路径` : "完整目录校验完成，后续使用增量索引");
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
        const mutationPaths:string[]=[];
        let completed = 0;
        let completedWork=0;
        let acceptedIdentical = false;
        for (const path of allPaths) {
          if(this.interactiveConflictRequests) break;
          this.setStatus(`检查本地变更 (${uploads.length + serial.length + completed + 1}/${allPaths.size})`, true);
          try {
            if (this.shouldIgnore(path)) { completed++; result.skipped++; continue; }
            const remotePath = toRemotePath(settings.remoteBasePath, path);
            const base = baseEntries[path];
            const localFile = localMap.get(path);
            let localInspection = await this.inspectLocalFile(path, localFile);
            const remoteItem = remoteMap.get(path);
            let remoteInspection: FileStateInspection = remoteItem
              ? { exists: true, mtime: remoteItem.serverMtime, md5: remoteItem.md5,
                  size: remoteItem.size, fsId: remoteItem.fsId }
              : { exists: false };
            let decision = determineSyncAction(localInspection, remoteInspection, base, indexed?.incremental === true);
            if (decision.action === "noop") {
              acceptedIdentical = this.rememberIdenticalVersion(path,localInspection,remoteInspection,base) || acceptedIdentical;
              completed++; result.skipped++; continue;
            }
            const work = async () => {
              if (this.getSettings().syncPaused || this.interactiveConflictRequests) return;
              const itemStarted = Date.now();
              this.currentFiles.add(path); this.setStatus(`同步变更 (${completedWork}/${uploads.length+serial.length})`, true);
              const wasUpload = decision.action === "upload";
              try {
                // Local content may change while the plan is being scanned or
                // waiting for a worker. Recheck before any overwrite/deletion.
                localInspection = await this.inspectLocalFile(path);
                if(indexed?.incremental) {
                  const actual=await this.inspectRemoteFile(remotePath);
                  if(actual.exists!==remoteInspection.exists || actual.md5!==remoteInspection.md5 || actual.fsId!==remoteInspection.fsId) {
                    // An unjournaled/late edit was observed. Never keep using the stale cache next round.
                    await this.remoteIndex().invalidate();
                  }
                  remoteInspection=actual;
                }
                decision = determineSyncAction(localInspection, remoteInspection, base, indexed?.incremental === true);
                if (wasUpload && decision.action !== "upload") {
                  this.log("warn", `文件在排队期间发生变化，留待下次同步: ${path}`);
                  return;
                }
                if (decision.action !== "noop") {
                  await this.executeAction(path, remotePath, decision, localInspection, remoteInspection, base);

                  if ((decision.action as string) === "noop") { result.skipped++; }
                  else if (decision.action === "upload") {
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
                completedWork++; this.currentFiles.delete(path);
                this.setStatus(`同步变更 (${completedWork}/${uploads.length+serial.length})`, true);
              }
              // Checkpoint only completed commits. Save stays serialized and
              // atomic; a checkpoint failure stops new work and drains workers.
              await this.stateStore.save();
              if (decision.action === "upload") {
                this.log("info", `上传耗时: ${path} ${(Date.now() - itemStarted) / 1000}s`);
              }
            };
            (decision.action === "upload" ? uploads : serial).push(work);
            if(decision.action==="upload" || decision.action==="delete_remote") mutationPaths.push(path);
          } catch (itemErr: any) {
            completed++;
            this.log("error", `同步失败: ${path}`, itemErr.message || String(itemErr));
            result.errors.push({ path, error: itemErr.message || String(itemErr) });
          }
        }
        if (acceptedIdentical) await this.stateStore.save();
        const concurrency = Math.max(1, Math.min(3, Math.floor(settings.uploadConcurrency || 3)));
        this.log("info", `上传计划: ${uploads.length} 个文件，并发 ${concurrency}`);
        if (uploads.length) await this.client.createDirectory(settings.remoteBasePath);
        const executePlan=async()=>{
          await runBounded(uploads, concurrency, work => work());
          for (const work of serial) await work();
        };
        if(settings.incrementalSync && mutationPaths.length) {
          await this.remoteIndex().mutateMany(mutationPaths,async()=>{
            this.batchJournalActive=true;
            try {await executePlan();} finally {this.batchJournalActive=false;}
          });
        } else await executePlan();

        // 5. Update state and commit
        if (result.uploaded || result.downloaded || result.conflicted || result.deleted) {
          this.stateStore.setLastFullSyncTimestamp(Date.now());
          await this.stateStore.save();
        }

        this.setStatus(this.getSettings().syncPaused ? "已暂停" : result.errors.length ? `同步结束，${result.errors.length} 个文件失败` : this.getPendingConflicts().length ? "部分文件待人工解决冲突" : "已同步", false);
        const summary = `${this.interactiveConflictRequests ? "同步已让出执行机会给冲突处理，剩余文件下次继续" : "同步完成"}: 跳过${result.skipped} ↑${result.uploaded} ↓${result.downloaded} ⚠${result.conflicted} ✕${result.deleted}${
          result.errors.length ? ` (失败: ${result.errors.length})` : ""
        }`;
        new Notice(summary+(result.conflicted ? "；冲突请点击状态栏处理" : ""));
        this.log("info", `${summary}；总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      } catch (err: any) {
        if(err.message==="SYNC_YIELD_FOR_CONFLICT") {
          this.log("info","全量扫描已安全让出执行机会给冲突处理；未使用不完整目录执行同步");
          this.setStatus("正在处理所选冲突",true);
          return result;
        }
        this.log("error", "全量同步过程异常退出", err.message || String(err));
        new Notice(`百度网盘同步错误: ${err.message || String(err)}`);
        this.setStatus("同步出错", false);
      } finally {
        this.isSyncing = false; this.progressFinishedAt = Date.now(); this.currentFiles.clear();
        this.setStatus(this.progressStatus, false);
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

        const uploadResult = await this.remoteMutation(localPath,()=>this.client.uploadFile(remotePath, buffer));

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
        await this.remoteMutation(localPath,()=>this.client.deleteFile(remotePath));
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

  private remoteIndex():RemoteIndex {
    const settings=this.getSettings();
    const scope=calculateMd5(new TextEncoder().encode(JSON.stringify([settings.remoteBasePath,settings.appKey,settings.username])).buffer);
    return new RemoteIndex(this.app,this.client,settings.remoteBasePath,scope,m=>this.log("info",m),()=>this.interactiveConflictRequests>0,text=>this.setStatus(text,true));
  }
  private async remoteMutation<T>(path:string,operation:()=>Promise<T>):Promise<T> {
    return this.getSettings().incrementalSync && !this.batchJournalActive ? this.remoteIndex().mutate(path,operation) : operation();
  }

  private rememberIdenticalVersion(path: string, local: FileStateInspection,
    remote: FileStateInspection, base?: any): boolean {
    if (!sameFileVersion(local,remote) || !remote.fsId) return false;
    if (base?.localMd5 === local.md5 && base?.remoteMd5 === remote.md5 &&
        base?.remoteFsId === remote.fsId) return false;
    this.stateStore.set(path,{path,localMtime:local.mtime!,localMd5:local.md5!,
      remoteFsId:remote.fsId,remoteMtime:remote.mtime!,remoteMd5:remote.md5!,lastSyncTime:Date.now()});
    return true;
  }

  public getPendingConflicts(): PendingConflict[] { return this.stateStore.getConflicts?.() || []; }

  /** Keep the original and the remote snapshot; never advance the baseline or
   * make a remote mutation until the user explicitly confirms resolution. */
  private async resolveConflict(localPath: string, remotePath: string,
    decision: ConflictDecision, local: FileStateInspection, remote: FileStateInspection,
    base?: any): Promise<void> {
    const existing = this.getPendingConflicts().find(c => c.path === localPath);
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
      // Server-reported hashes may differ from plaintext hashes. Verify the
      // downloaded/decrypted bytes against a fresh local read before deduping.
      const current = await this.inspectLocalFile(localPath);
      const plaintextMd5 = calculateMd5(data);
      if (sameFileVersion(current,{...remote,md5:plaintextMd5})) {
        this.stateStore.set(localPath,{path:localPath,localMtime:current.mtime!,localMd5:current.md5!,
          remoteFsId:remote.fsId,remoteMtime:remote.mtime!,remoteMd5:remote.md5 || plaintextMd5,lastSyncTime:Date.now()});
        if (existing) this.stateStore.clearConflict(localPath);
        try { await this.stateStore.save(); }
        catch (error) { if (existing) this.stateStore.setConflict(existing); throw error; }
        for (const copy of existing?.copies || []) {
          if (await this.app.vault.adapter.exists(copy)) {
            const bytes = await this.atomicFs.readBinary(copy);
            if (calculateMd5(bytes) === plaintextMd5) {
              try { await this.atomicFs.safeDelete(copy); }
              catch { this.log("warn",`已去除冲突标记；重复副本保留待手动清理: ${copy}`); }
            }
          }
        }
        decision.action="noop";decision.isConflict=false;
        this.setStatus("相同版本已合并",false);
        this.log("info",`内容及修改时间相同，保留原文件: ${localPath}`);
        return;
      }
      const strategy = this.getSettings().conflictStrategy || "create_conflict_file";
      const isText = /\.(md|markdown|txt|json|csv|yaml|yml|xml|html|css|js|ts|log)$/i.test(localPath);
      if (strategy === "git_merge" && isText && local.exists) {
        let localText: string | null = null;
        let remoteText: string | null = null;
        try {
          const localBytes = await this.atomicFs.readBinary(localPath);
          localText = new TextDecoder("utf-8", { fatal: true }).decode(localBytes);
          remoteText = new TextDecoder("utf-8", { fatal: true }).decode(data);
          if (localText.includes("\0") || remoteText.includes("\0")) {
            localText = null;
            remoteText = null;
          }
        } catch {
          localText = null;
          remoteText = null;
        }

        if (localText !== null && remoteText !== null) {
          if (!hasConflictMarkers(localText)) {
            const result = mergeText(localText, remoteText);
            const mergedBytes = new TextEncoder().encode(result.merged);
            await this.atomicFs.atomicWrite(localPath, mergedBytes, calculateMd5(mergedBytes));
          }
          const record: PendingConflict = {
            path: localPath,
            remotePath,
            copies: existing?.copies || [],
            remote: { exists: remote.exists, md5: remote.md5, fsId: remote.fsId, mtime: remote.mtime },
            createdAt: existing?.createdAt || Date.now(),
          };
          this.stateStore.setConflict(record);
          await this.stateStore.save();
          this.log("warn", `已按 Git 格式在单文件内合并冲突标记: ${localPath}`);
          this.notifyConflict();
          return;
        }
      }
      if (existing && existing.remote.md5 === remote.md5 && existing.remote.fsId === remote.fsId &&
          existing.remote.exists === remote.exists && existing.copies.length &&
          await this.app.vault.adapter.exists(existing.copies[existing.copies.length-1])) return;
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
    this.notifyConflict();
  }

  public async readConflictMerge(path: string) {
    const record=this.getPendingConflicts().find(c=>c.path===path);
    if (!record) throw new Error("冲突记录已变化，请重新打开");
    if (!/\.(md|markdown|txt|json|csv|yaml|yml|xml|html|css|js|ts|log)$/i.test(path)) throw new Error("二进制文件不支持文本合并，请选择保留版本");
    const read=async(p:string):Promise<string|null>=> {
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const bytes=await this.atomicFs.readBinary(p);
      if(bytes.byteLength>2*1024*1024) throw new Error("文件超过 2 MB，请在编辑器中手动处理");
      const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
      if(text.includes("\0")) throw new Error("二进制内容不支持文本合并");
      return text;
    };
    const local=await read(path);
    const copy=record.copies[record.copies.length-1];
    let remote: string | null = null;
    if (record.remote.exists) {
      if (copy && (await this.app.vault.adapter.exists(copy))) {
        remote = await read(copy);
      } else if (record.remote.fsId) {
        let raw = await this.client.downloadFile(record.remote.fsId);
        if (isEncrypted(raw) || this.getSettings().enableE2EE) {
          const pwd = this.getSettings().e2eePassword;
          if (pwd) {
            raw = await decryptData(raw, pwd);
          }
        }
        remote = new TextDecoder("utf-8").decode(raw);
      }
    }
    if (record.remote.exists && remote === null) throw new Error("远端副本缺失，请先更新远端副本");
    return {local,remote,signature:JSON.stringify(record)};
  }

  public async saveConflictMerge(path:string, expected:{local:string|null;remote:string|null;signature:string}, text:string):Promise<void> {
    return this.syncMutex.acquire(async()=>{
      if(hasConflictMarkers(text)) throw new Error("请先处理所有冲突标记，再保存合并结果");
      const current=await this.readConflictMerge(path);
      if(JSON.stringify(current)!==JSON.stringify(expected)) throw new Error("文件或冲突版本已变化，请重新打开比较，避免覆盖新修改");
      const data=new TextEncoder().encode(text).buffer;
      await this.atomicFs.atomicWrite(path,data,calculateMd5(data));
      try { await this.commitConflictResolution(path); }
      catch(e:any) { throw new Error(`合并内容已保存，但提交未完成，冲突仍保留：${e.message || String(e)}`); }
    });
  }

  public async trashConflictFile(conflictPath: string, target: string): Promise<void> {
    return this.syncMutex.acquire(async()=>{
      const record=this.getPendingConflicts().find(c=>c.path===conflictPath);
      if (!record || (target!==record.path && !record.copies.includes(target))) {
        throw new Error("只能删除当前冲突登记的原文件或副本");
      }
      if (!(await this.app.vault.adapter.exists(target))) throw new Error("文件不存在或已经移入回收站");
      await this.atomicFs.safeDelete(target);
      this.log("info",`冲突文件已移入本地回收站（未修改网盘）: ${target}`);
      new Notice("已移入本地回收站，网盘文件未改动。");
    });
  }

  public async refreshPendingConflict(path: string): Promise<void> {
    return this.syncMutex.acquire(async () => {
      const record = this.getPendingConflicts().find(c => c.path === path);
      if (!record) return;
      await this.resolveConflict(path, record.remotePath, {action:"conflict",reason:"User refreshed snapshot",isConflict:true},
        await this.inspectLocalFile(path), await this.inspectRemoteFile(record.remotePath));
    });
  }

  public async acceptConflictVersions(paths:string[], side:"local"|"remote", progress?:(done:number,total:number,path:string)=>void) {
    this.interactiveConflictRequests++;
    const selected=[...new Set(paths)];
    try {
    const resolved:string[]=[], failed:{path:string;message:string}[]=[];
    progress?.(0,selected.length,"");
    for(const path of selected) {
      try {
        await this.syncMutex.acquire(async()=>{
          if(this.getSettings().syncPaused) throw new Error("同步已暂停");
          const record=this.getPendingConflicts().find(c=>c.path===path);
          if(!record) throw new Error("冲突记录已变化，请刷新列表");
          if(side==="local") {await this.commitConflictResolution(path);return;}
          const remote=await this.inspectRemoteFile(record.remotePath);
          if (remote.exists !== record.remote.exists || (remote.exists && record.remote.exists && remote.md5 !== record.remote.md5)) {
            await this.resolveConflict(path,record.remotePath,{action:"conflict",reason:"Remote changed again",isConflict:true},await this.inspectLocalFile(path),remote);
            throw new Error("远端版本已变化，请检查更新后的冲突再选择");
          }
          const local=await this.inspectLocalFile(path);
          // Preserve the replaced local version before accepting remote bytes/deletion.
          if(local.exists) {
            const bytes=await this.atomicFs.readBinary(path);
            let backup=generateConflictPath(path);
            while(await this.app.vault.adapter.exists(backup)) backup=generateConflictPath(path);
            const updated={...record,copies:[...record.copies,backup]};
            this.stateStore.setConflict(updated);
            await this.stateStore.save();
            await this.atomicFs.atomicWrite(backup,bytes,calculateMd5(bytes));
          }
          if(remote.exists) await this.executeAction(path,record.remotePath,{action:"download",reason:"User accepted remote",isConflict:false},local,remote);
          else {if(local.exists) await this.atomicFs.safeDelete(path);this.stateStore.delete(path);}
          const pending=this.getPendingConflicts().find(c=>c.path===path)!;
          this.stateStore.clearConflict(path);
          try {await this.stateStore.save();} catch(e) {this.stateStore.setConflict(pending);throw e;}
          this.setStatus("冲突已处理",false);
        });
        resolved.push(path);
      } catch(e:any) {failed.push({path,message:e.message || String(e)});}
      progress?.(resolved.length+failed.length,selected.length,path);
    }
    return {resolved,failed};
    } finally {this.interactiveConflictRequests--;}
  }

  public async confirmConflictResolved(path: string): Promise<void> {
    return this.syncMutex.acquire(()=>this.commitConflictResolution(path));
  }

  private async commitConflictResolution(path:string):Promise<void> {
      if (this.getSettings().syncPaused) throw new Error("同步已暂停，请先在设置中解除暂停");
      const record = this.getPendingConflicts().find(c => c.path === path);
      if (!record) return;
      const remote = await this.inspectRemoteFile(record.remotePath);
      if (remote.exists !== record.remote.exists || (remote.exists && record.remote.exists && remote.md5 !== record.remote.md5)) {
        await this.resolveConflict(path, record.remotePath, {action:"conflict",reason:"Remote changed again",isConflict:true},
          await this.inspectLocalFile(path), remote);
        throw new Error("远端又发生了变化，已更新冲突记录，请重新检查双方版本。");
      }
      const local = await this.inspectLocalFile(path);
      if (local.exists) {
        if (/\.(md|markdown|txt|json|csv|yaml|yml|xml|html|css|js|ts|log)$/i.test(path)) {
          const text=new TextDecoder().decode(await this.atomicFs.readBinary(path));
          if(hasConflictMarkers(text)) throw new Error("原文件仍有冲突标记，请先完成合并");
        }
        if (!remote.exists) await this.client.createDirectory(this.getSettings().remoteBasePath);
        await this.executeAction(path, record.remotePath, {action:"upload",reason:"User confirmed merge",isConflict:false},local,remote);
      } else if (remote.exists) {
        await this.remoteMutation(path,()=>this.client.deleteFile(record.remotePath));
        this.stateStore.delete(path);
      } else this.stateStore.delete(path);
      this.stateStore.clearConflict(path);
      try { await this.stateStore.save(); }
      catch (error) { this.stateStore.setConflict(record); throw error; }
      // Snapshot copies remain excluded even after resolution; never upload
      // archived remote versions as new notes.
      this.setStatus("冲突已处理", false);
      if(!this.interactiveConflictRequests) new Notice(`冲突已解决并同步，已从列表移除：${path}`);
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
