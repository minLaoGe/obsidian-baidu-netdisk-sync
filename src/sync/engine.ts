import { App, Notice, TAbstractFile, TFile } from "obsidian";
import { BaiduClient } from "../api/baidu-client";
import { decryptData, encryptData, isEncrypted } from "../crypto/e2ee";
import { ConflictDecision, determineSyncAction, FileStateInspection, generateConflictPath } from "./conflict";
import { DebounceManager, FifoQueue, Mutex } from "./queue";
import { SyncStateStore } from "./state";
import { ConflictStrategy, PluginSettings, RemoteFileInfo, SyncLogEntry, SyncResult } from "../types";
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
    await this.stateStore.load();
    const { restored, cleaned } = await this.atomicFs.recoverCrashAndCleanStale();
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
    
    // Ignore internal temporary and system folders
    if (norm.startsWith(".trash/") || norm.startsWith(".git/")) return true;
    if (norm.includes(".synctmp.")) return true;

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
        await this.syncSingleFile(file.path);
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
        await this.syncSingleFile(file.path);
      });
    });
  }

  /**
   * Sync a single file safely within sync lock
   */
  public async syncSingleFile(vaultPath: string): Promise<void> {
    if (this.shouldIgnore(vaultPath)) return;

    return this.syncMutex.acquire(async () => {
      try {
        const settings = this.getSettings();
        if (!settings.accessToken) return;

        const remotePath = toRemotePath(settings.remoteBasePath, vaultPath);
        const base = this.stateStore.get(vaultPath);

        const localInspection = await this.inspectLocalFile(vaultPath);
        const remoteInspection = await this.inspectRemoteFile(remotePath);

        const decision = determineSyncAction(localInspection, remoteInspection, base);

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

      this.isSyncing = true;
      this.setStatus("正在同步...", true);
      this.log("info", "开始执行全量双向同步比对...");

      try {
        await this.client.createDirectory(settings.remoteBasePath);

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
        let index = 0;

        // 4. Process all paths sequentially to guarantee ordering
        for (const path of allPaths) {
          index++;
          this.setStatus(`同步进度 (${index}/${allPaths.size})`, true);

          try {
            const remotePath = toRemotePath(settings.remoteBasePath, path);
            const base = baseEntries[path];

            const localFile = localMap.get(path);
            const localInspection = await this.inspectLocalFile(path, localFile);

            const remoteItem = remoteMap.get(path);
            const remoteInspection: FileStateInspection = remoteItem
              ? {
                  exists: true,
                  mtime: remoteItem.serverMtime,
                  md5: remoteItem.md5,
                  size: remoteItem.size,
                  fsId: remoteItem.fsId,
                }
              : { exists: false };

            const decision = determineSyncAction(localInspection, remoteInspection, base);

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
                this.log("warn", `冲突已处理 (生成安全副本): ${path}`);
              } else if (decision.action === "delete_local" || decision.action === "delete_remote") {
                result.deleted++;
                this.log("info", `删除同步完成: ${path}`);
              }
            }
          } catch (itemErr: any) {
            this.log("error", `同步失败: ${path}`, itemErr.message || String(itemErr));
            result.errors.push({ path, error: itemErr.message || String(itemErr) });
          }
        }

        // 5. Update state and commit
        this.stateStore.setLastFullSyncTimestamp(Date.now());
        await this.stateStore.save();

        this.setStatus("已同步", false);
        const summary = `同步完成: ↑${result.uploaded} ↓${result.downloaded} ⚠${result.conflicted} ✕${result.deleted}${
          result.errors.length ? ` (失败: ${result.errors.length})` : ""
        }`;
        new Notice(summary);
        this.log("info", summary);
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
        const localRawMd5 = local.md5 || calculateMd5(buffer);

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
        await this.resolveConflict(localPath, remotePath, local, remote, base);
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

  /**
   * Conflict handler respecting configured conflict strategy
   */
  private async resolveConflict(
    localPath: string,
    remotePath: string,
    local: FileStateInspection,
    remote: FileStateInspection,
    base?: any
  ): Promise<void> {
    const settings = this.getSettings();
    const strategy = settings.conflictStrategy || "create_conflict_file";

    if (strategy === "keep_local" && local.exists) {
      let buffer = await this.atomicFs.readBinary(localPath);
      const localMd5 = local.md5 || calculateMd5(buffer);
      if (settings.enableE2EE && settings.e2eePassword) {
        buffer = await encryptData(buffer, settings.e2eePassword);
      }
      const uploadResult = await this.client.uploadFile(remotePath, buffer);
      this.stateStore.set(localPath, {
        path: localPath,
        localMtime: local.mtime || Date.now(),
        localMd5: localMd5,
        remoteFsId: uploadResult.fsId,
        remoteMtime: Date.now(),
        remoteMd5: uploadResult.md5 || localMd5,
        lastSyncTime: Date.now(),
      });
      new Notice(`冲突已处理 (保留本地版本): ${localPath}`);
      return;
    }

    if (strategy === "keep_remote" && remote.exists && remote.fsId) {
      let data = await this.client.downloadFile(remote.fsId);
      if (isEncrypted(data) || settings.enableE2EE) {
        if (!settings.e2eePassword) {
          throw new Error(`无法解密远端冲突文件: ${localPath}`);
        }
        data = await decryptData(data, settings.e2eePassword);
      }
      const downloadedMd5 = calculateMd5(data);
      await this.atomicFs.atomicWrite(localPath, data, downloadedMd5);
      const newStat = await this.app.vault.adapter.stat(localPath);
      this.stateStore.set(localPath, {
        path: localPath,
        localMtime: newStat ? newStat.mtime : Date.now(),
        localMd5: downloadedMd5,
        remoteFsId: remote.fsId,
        remoteMtime: remote.mtime || Date.now(),
        remoteMd5: remote.md5 || downloadedMd5,
        lastSyncTime: Date.now(),
      });
      new Notice(`冲突已处理 (保留远端版本): ${localPath}`);
      return;
    }

    if (strategy === "keep_newer" && local.exists && remote.exists) {
      const localMtime = local.mtime || 0;
      const remoteMtime = remote.mtime || 0;
      if (localMtime >= remoteMtime) {
        let buffer = await this.atomicFs.readBinary(localPath);
        const localMd5 = local.md5 || calculateMd5(buffer);
        if (settings.enableE2EE && settings.e2eePassword) {
          buffer = await encryptData(buffer, settings.e2eePassword);
        }
        const uploadResult = await this.client.uploadFile(remotePath, buffer);
        this.stateStore.set(localPath, {
          path: localPath,
          localMtime: localMtime,
          localMd5: localMd5,
          remoteFsId: uploadResult.fsId,
          remoteMtime: Date.now(),
          remoteMd5: uploadResult.md5 || localMd5,
          lastSyncTime: Date.now(),
        });
        new Notice(`冲突已处理 (保留较新本地版本): ${localPath}`);
        return;
      } else if (remote.fsId) {
        let data = await this.client.downloadFile(remote.fsId);
        if (isEncrypted(data) || settings.enableE2EE) {
          if (!settings.e2eePassword) {
            throw new Error(`无法解密较新的远端冲突版本: ${localPath}`);
          }
          data = await decryptData(data, settings.e2eePassword);
        }
        const downloadedMd5 = calculateMd5(data);
        await this.atomicFs.atomicWrite(localPath, data, downloadedMd5);
        this.stateStore.set(localPath, {
          path: localPath,
          localMtime: remoteMtime,
          localMd5: downloadedMd5,
          remoteFsId: remote.fsId,
          remoteMtime: remoteMtime,
          remoteMd5: remote.md5 || downloadedMd5,
          lastSyncTime: Date.now(),
        });
        new Notice(`冲突已处理 (保留较新远端版本): ${localPath}`);
        return;
      }
    }

    // Default safe strategy: create_conflict_file (Zero Data Loss)
    if (remote.exists && remote.fsId) {
      const conflictPath = generateConflictPath(localPath);
      let remoteData = await this.client.downloadFile(remote.fsId);

      if (isEncrypted(remoteData) || settings.enableE2EE) {
        if (!settings.e2eePassword) {
          throw new Error(`无法解密远端冲突副本: ${localPath}`);
        }
        remoteData = await decryptData(remoteData, settings.e2eePassword);
      }

      await this.atomicFs.atomicWrite(conflictPath, remoteData);

      if (local.exists) {
        this.stateStore.set(localPath, {
          path: localPath,
          localMtime: local.mtime || Date.now(),
          localMd5: local.md5 || "",
          remoteFsId: remote.fsId,
          remoteMtime: remote.mtime || Date.now(),
          remoteMd5: remote.md5 || "",
          lastSyncTime: Date.now(),
        });
      }

      new Notice(
        `检测到冲突：“${localPath}”！\n已保留本地内容，远端版本另存为：“${conflictPath}”`,
        8000
      );
    }
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

  private async inspectRemoteFile(remotePath: string): Promise<FileStateInspection> {
    try {
      const parentDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
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
    } catch (e) {
      // Ignore
    }
    return { exists: false };
  }
}
