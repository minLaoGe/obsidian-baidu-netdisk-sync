import { Notice, Plugin } from "obsidian";
import { BaiduClient } from "./api/baidu-client";
import { BaiduSyncSettingTab, DEFAULT_SETTINGS } from "./settings";
import { SyncEngine } from "./sync/engine";
import { ConflictReviewModal } from "./conflicts-ui";
import { PluginSettings } from "./types";

export default class BaiduNetdiskSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  baiduClient!: BaiduClient;
  syncEngine!: SyncEngine;
  private statusBarItem!: HTMLElement;
  private autoSyncIntervalId?: number;

  async onload() {
    console.log("Loading Baidu Netdisk Sync Plugin...");
    await this.loadSettings();

    // 1. Initialize Baidu API client
    this.baiduClient = new BaiduClient({
      appKey: this.settings.appKey,
      secretKey: this.settings.secretKey,
      accessToken: this.settings.accessToken,
      refreshToken: this.settings.refreshToken,
      tokenExpiresAt: this.settings.tokenExpiresAt,
      onTokenRefreshed: async (tokenData) => {
        this.settings.accessToken = tokenData.access_token;
        this.settings.refreshToken = tokenData.refresh_token;
        this.settings.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
        await this.saveSettings();
      },
    });

    // 2. Initialize Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(this.settings.syncPaused ? "已暂停" : "就绪", false);

    // 3. Initialize Sync Engine
    this.syncEngine = new SyncEngine(
      this.app,
      () => this.settings,
      this.baiduClient,
      (statusText, isBusy) => {
        this.updateStatusBar(statusText, isBusy);
      }
    );

    await this.syncEngine.initialize();
    this.updateStatusBar(this.settings.syncPaused ? "已暂停" : "就绪", false);
    if (this.syncEngine.getPendingConflicts().length) {
      new Notice(`有 ${this.syncEngine.getPendingConflicts().length} 个同步冲突待人工处理，点击状态栏查看。`,15000);
    }
    this.addCommand({id:"review-baidu-conflicts",name:"查看并人工解决同步冲突",
      callback:()=>this.openConflictReview()});


    // 4. Add Ribbon Icon for quick sync
    this.addRibbonIcon("refresh-cw", "百度网盘同步", async () => {
      await this.runSync();
    });

    // 5. Add Commands for command palette / hotkeys
    this.addCommand({
      id: "sync-baidu-netdisk",
      name: "立即开始双向同步",
      callback: async () => {
        await this.runSync();
      },
    });

    this.addCommand({id:"audit-baidu-netdisk",name:"完整校验网盘并同步（重建增量索引）",callback:async()=>{await this.runSync(true);}});

    // 6. Register Setting Tab
    this.addSettingTab(new BaiduSyncSettingTab(this.app, this));

    // 7. Register Vault Event Listeners with Debounce Ordering
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.syncEngine.handleLocalFileModified(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.syncEngine.handleLocalFileModified(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.syncEngine.handleLocalFileDeleted(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Handle rename as delete old + create new
        this.syncEngine.handleLocalFileDeleted({ path: oldPath } as any);
        this.syncEngine.handleLocalFileModified(file);
      })
    );

    // 8. Auto Sync Timer
    this.resetAutoSyncTimer();

    // 9. Startup Sync
    if (!this.settings.syncPaused && this.settings.syncOnStartup && this.settings.accessToken) {
      setTimeout(() => {
        this.runSync();
      }, 3000); // Wait 3s after startup for vault index to be fully loaded
    }
  }

  onunload() {
    console.log("Unloading Baidu Netdisk Sync Plugin...");
    if (this.autoSyncIntervalId) {
      window.clearInterval(this.autoSyncIntervalId);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.baiduClient) {
      this.baiduClient.updateCredentials(
        this.settings.accessToken,
        this.settings.refreshToken,
        this.settings.tokenExpiresAt
      );
    }
  }

  public updateStatusBar(status: string, isBusy: boolean) {
    if (!this.statusBarItem) return;
    const icon = isBusy ? "⏳ " : "☁️ ";
    const pending = this.syncEngine?.getPendingConflicts().length || 0;
    this.statusBarItem.setText(`${icon}百度网盘: ${status}${pending ? ` ⚠ 待处理冲突 ${pending}` : ""}`);
    this.statusBarItem.title = "点击执行百度网盘同步";
    this.statusBarItem.onclick = () => {
      if (this.syncEngine.getPendingConflicts().length) this.openConflictReview();
      else this.runSync();
    };
  }

  public openConflictReview() { new ConflictReviewModal(this.app, this.syncEngine).open(); }

  public async runSync(forceFull=false) {
    if (this.settings.syncPaused) { new Notice("同步已暂停，请先在插件设置中解除暂停。"); return; }
    if (!this.settings.accessToken) {
      new Notice("请先在设置中配置百度网盘 Access Token！");
      return;
    }
    await this.syncEngine.runFullSync(forceFull);
  }

  public resetAutoSyncTimer() {
    if (this.autoSyncIntervalId) {
      window.clearInterval(this.autoSyncIntervalId);
      this.autoSyncIntervalId = undefined;
    }

    if (!this.settings.syncPaused && this.settings.autoSync && this.settings.syncIntervalMinutes > 0) {
      const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
      this.autoSyncIntervalId = window.setInterval(() => {
        this.runSync();
      }, intervalMs);
      console.log(`Auto sync scheduled every ${this.settings.syncIntervalMinutes} minutes.`);
    }
  }
}
