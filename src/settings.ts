import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { BaiduClient } from "./api/baidu-client";
import { exportEncryptedConfig, importEncryptedConfig } from "./crypto/configShare";
import { ConflictStrategy, PluginSettings } from "./types";
import type BaiduNetdiskSyncPlugin from "./main";

export const DEFAULT_SETTINGS: PluginSettings = {
  appKey: "",
  secretKey: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  username: "",
  remoteBasePath: "/apps/obsidian-vault",
  autoSync: false,
  mobileManualSync: Platform.isMobile,
  incrementalSync: true,
  syncPaused: false,
  uploadConcurrency: 3,
  downloadConcurrency: 3,
  syncIntervalMinutes: 15,
  syncOnStartup: true,
  syncOnModifyDebounceSeconds: 3,
  conflictStrategy: "git_merge",
  ignoredPatterns: [".trash", ".git", ".DS_Store"],
  enableE2EE: false,
  e2eePassword: "",
  syncObsidianConfig: false,
  syncPlugins: false,
  syncThemes: false,
};

export class BaiduSyncSettingTab extends PluginSettingTab {
  plugin: BaiduNetdiskSyncPlugin;

  constructor(app: App, plugin: BaiduNetdiskSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Title
    new Setting(containerEl).setName("百度网盘同步设置 (Baidu Netdisk Sync)").setHeading();

    if (Platform.isMobile) {
      new Setting(containerEl).setName("手机手动同步模式")
        .setDesc("开启时仅点击立即同步才传输文件，关闭启动、定时和文件变动触发。同步时请保持 Obsidian 亮屏在前台，切勿锁屏或切到后台。")
        .addToggle(toggle => toggle.setValue(this.plugin.settings.mobileManualSync).onChange(async value => {
          this.plugin.settings.mobileManualSync = value;
          await this.plugin.saveSettings(); this.plugin.resetAutoSyncTimer();
        }));
      new Setting(containerEl).setName("手机同步")
        .setDesc("提示：首次或全量同步耗时较长，请保持手机亮屏停留在当前页面。若提示 UnknownHostException 请检查网络或关闭代理/专用DNS。")
        .addButton(button => button.setButtonText("立即同步").setCta().onClick(async () => { await this.plugin.runSync(); }))
        .addButton(button => button.setButtonText("查看进度").onClick(() => this.plugin.openSyncProgress()))
        .addButton(button => button.setButtonText("查看冲突").onClick(() => this.plugin.openConflictReview()));
    }

    // --- Section 1: Detailed OAuth & Credential Guide ---
    new Setting(containerEl).setName("1. 百度网盘账号授权 (OAuth 2.0)").setHeading();

    const guideBox = containerEl.createDiv({ cls: "baidu-sync-card" });
    guideBox.addClass("baidu-sync-ui-1");
    guideBox.addClass("baidu-sync-ui-2");

    const titleEl = guideBox.createEl("div", {
      cls: "baidu-sync-card-title",
      text: "📖 凭证获取详细保姆级操作指南（只需操作一次）：",
    });
    titleEl.addClass("baidu-sync-ui-3");
    titleEl.addClass("baidu-sync-ui-4");
    titleEl.addClass("baidu-sync-ui-5");

    const ol = guideBox.createEl("ol");
    ol.addClass("baidu-sync-ui-6");
    ol.addClass("baidu-sync-ui-7");

    const li1 = ol.createEl("li");
    li1.appendText("访问 ");
    const linkUnion = li1.createEl("a", {
      text: "百度网盘开放平台控制台 (pan.baidu.com/union)",
      href: "https://pan.baidu.com/union/console/applist",
    });
    linkUnion.addClass("baidu-sync-ui-8");
    linkUnion.addClass("baidu-sync-ui-9");
    li1.appendText(" 并登录百度个人账号（首次进入点击注册开发者，普通个人账号即可快速开通）。");

    const li2 = ol.createEl("li");
    li2.appendText("在控制台点击【创建应用】，应用类别选择【软件】或【移动/桌面应用】，应用名称任意填写（例如 ");
    li2.createEl("code", { text: "ObsidianSync" });
    li2.appendText("），开通基础网盘权限。");

    const li3 = ol.createEl("li");
    li3.appendText("创建完成后进入应用详情页，在【开发信息】中获取该应用的 ");
    li3.createEl("strong", { text: "AppKey (Client ID)" });
    li3.appendText(" 与 ");
    li3.createEl("strong", { text: "AppSecret (SecretKey)" });
    li3.appendText("，分别填入下方的输入框中。");

    const li4 = ol.createEl("li");
    li4.appendText("点击下方的【1. 获取网页授权码】，在弹出的官方页面登录并授权，将网页返回的授权码粘贴至下方输入框，点击【2. 兑换并保存 Token】即可自动完成绑定！");

    const tipDiv = guideBox.createDiv();
    tipDiv.addClass("baidu-sync-ui-10");
    tipDiv.addClass("baidu-sync-ui-11");
    tipDiv.addClass("baidu-sync-ui-12");
    tipDiv.setText("配置完成后可使用加密配对码迁移到另一台桌面设备。当前版本仅支持桌面端。");

    // App Key Input
    new Setting(containerEl)
      .setName("AppKey (Client ID)")
      .setDesc("百度开放平台应用对应的 AppKey")
      .addText((text) =>
        text
          .setPlaceholder("请填入应用的 AppKey")
          .setValue(this.plugin.settings.appKey)
          .onChange(async (value) => {
            this.plugin.settings.appKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // App Secret Input
    new Setting(containerEl)
      .setName("AppSecret (SecretKey)")
      .setDesc("百度开放平台应用对应的 SecretKey")
      .addText((text) =>
        text
          .setPlaceholder("请填入应用的 SecretKey")
          .setValue(this.plugin.settings.secretKey)
          .onChange(async (value) => {
            this.plugin.settings.secretKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // OAuth Assistant
    let authCodeInput = "";
    new Setting(containerEl)
      .setName("OAuth 网页授权向导")
      .setDesc("点击获取授权码，并在弹出的浏览器页面允许授权后换取 Token")
      .addButton((btn) =>
        btn.setButtonText("1. 获取网页授权码").onClick(() => {
          if (!this.plugin.settings.appKey) {
            new Notice("请先在上方填入 AppKey！");
            return;
          }
          const authUrl = BaiduClient.getAuthUrl(this.plugin.settings.appKey, "oob");
          window.open(authUrl, "_blank");
        })
      )
      .addText((text) =>
        text.setPlaceholder("粘贴网页返回的授权码").onChange((val) => {
          authCodeInput = val.trim();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("2. 兑换并保存 Token")
          .setCta()
          .onClick(async () => {
            if (!authCodeInput) {
              new Notice("请先粘贴网页返回的授权码！");
              return;
            }
            if (!this.plugin.settings.appKey || !this.plugin.settings.secretKey) {
              new Notice("请确保上方已填入 AppKey 和 AppSecret！");
              return;
            }
            try {
              btn.setDisabled(true);
              btn.setButtonText("正在兑换...");
              const res = await BaiduClient.exchangeCodeForToken(
                authCodeInput,
                this.plugin.settings.appKey,
                this.plugin.settings.secretKey,
                "oob"
              );
              this.plugin.settings.accessToken = res.access_token;
              this.plugin.settings.refreshToken = res.refresh_token;
              this.plugin.settings.tokenExpiresAt = Date.now() + (res.expires_in || 2592000) * 1000;
              await this.plugin.saveSettings();
              new Notice("百度网盘 Token 兑换成功并已持久化保存！插件将自动无感续期。");
              this.display();
            } catch (err: any) {
              new Notice(`Token 兑换失败: ${err.message || String(err)}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText("2. 兑换并保存 Token");
            }
          })
      );

    // Direct Access Token (Optional / Advance)
    new Setting(containerEl)
      .setName("或：直接填入 Access Token (可选高级方式)")
      .setDesc("若你已有百度开发者控制台生成的 Access Token，也可以直接粘贴在此处跳过向导")
      .addText((text) =>
        text
          .setPlaceholder("12.xxxxxx...")
          .setValue(this.plugin.settings.accessToken)
          .onChange(async (value) => {
            this.plugin.settings.accessToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Connectivity Test
    new Setting(containerEl)
      .setName("连接测试")
      .setDesc(
        this.plugin.settings.username
          ? `当前已连接百度账号: ${this.plugin.settings.username}`
          : "点击测试当前 Access Token 连通性并获取百度网盘昵称"
      )
      .addButton((btn) =>
        btn.setButtonText("测试连通性").onClick(async () => {
          try {
            btn.setDisabled(true);
            const user = await this.plugin.baiduClient.getUserInfo();
            this.plugin.settings.username = user.netdiskName || user.baiduName || "已连接";
            await this.plugin.saveSettings();
            new Notice(`连接成功！百度网盘账号：${this.plugin.settings.username}`);
            this.display();
          } catch (err: any) {
            new Notice(`连接失败: ${err.message || String(err)}`);
          } finally {
            btn.setDisabled(false);
          }
        })
      );

    // --- Section 2: Multi-Device Quick Pairing ---
    new Setting(containerEl).setName("2. 多设备快速配对与配置迁移 (Multi-Device Fast Pairing)").setHeading();

    new Setting(containerEl)
      .setName("跨端配置导出与导入")
      .setDesc("仅需在电脑端配置一次，导出受 AES-256-GCM 密码保护的配对码；手机/平板端一键粘贴导入，秒级组网！")
      .addButton((btn) =>
        btn.setButtonText("📤 导出加密配对码").onClick(() => {
          new ConfigExportModal(this.app, this.plugin.settings).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("📥 导入配置配对码").onClick(() => {
          new ConfigImportModal(this.app, async (newConfig) => {
            this.plugin.settings.appKey = newConfig.appKey || this.plugin.settings.appKey;
            this.plugin.settings.secretKey = newConfig.secretKey || this.plugin.settings.secretKey;
            this.plugin.settings.accessToken = newConfig.accessToken || this.plugin.settings.accessToken;
            this.plugin.settings.refreshToken = newConfig.refreshToken || this.plugin.settings.refreshToken;
            this.plugin.settings.tokenExpiresAt = newConfig.tokenExpiresAt || this.plugin.settings.tokenExpiresAt;
            this.plugin.settings.remoteBasePath = newConfig.remoteBasePath || this.plugin.settings.remoteBasePath;
            this.plugin.settings.enableE2EE = newConfig.enableE2EE ?? this.plugin.settings.enableE2EE;
            this.plugin.settings.e2eePassword = newConfig.e2eePassword || this.plugin.settings.e2eePassword;
            if (newConfig.conflictStrategy) {
              this.plugin.settings.conflictStrategy = newConfig.conflictStrategy as ConflictStrategy;
            }
            if (Array.isArray(newConfig.ignoredPatterns)) {
              this.plugin.settings.ignoredPatterns = newConfig.ignoredPatterns;
            }
            await this.plugin.saveSettings();
            new Notice("配置已成功导入并生效！");
            this.display();
          }).open();
        })
      );

    // --- Section 3: End-to-End Encryption ---
    new Setting(containerEl).setName("3. 端到端零知识加密 (E2EE)").setHeading();

    new Setting(containerEl)
      .setName("启用端到端加密")
      .setDesc("文件上传前在本地经由 AES-256-GCM + PBKDF2 高强度加密，网盘端仅存放密文，防范隐私泄露与扫描")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableE2EE).onChange(async (val) => {
          this.plugin.settings.enableE2EE = val;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.enableE2EE) {
      new Setting(containerEl)
        .setName("E2EE 加解密密码")
        .setDesc("用于本地加解密的统一密钥。所有同步设备必须配置完全相同的密码，否则将无法解密！")
        .addText((text) =>
          text
            .setPlaceholder("请输入高强度密钥")
            .setValue(this.plugin.settings.e2eePassword || "")
            .onChange(async (val) => {
              this.plugin.settings.e2eePassword = val.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    // --- Section 4: Sync & Ordering Configuration ---
    new Setting(containerEl).setName("4. 同步与时序设置 (Sync & Ordering Configuration)").setHeading();

    new Setting(containerEl)
      .setName("网盘备份根路径")
      .setDesc("百度网盘中存放此知识库的绝对目录路径（以 / 开头，例如 /apps/obsidian-vault）")
      .addText((text) =>
        text
          .setPlaceholder("/apps/obsidian-vault")
          .setValue(this.plugin.settings.remoteBasePath)
          .onChange(async (val) => {
            this.plugin.settings.remoteBasePath = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("启动时自动同步")
      .setDesc("Obsidian 启动加载插件后自动执行一次全量双向同步")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (val) => {
          this.plugin.settings.syncOnStartup = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("定时自动同步")
      .setDesc("启用后台周期性自动同步")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (val) => {
          this.plugin.settings.autoSync = val;
          await this.plugin.saveSettings();
          this.plugin.resetAutoSyncTimer();
        })
      );

    new Setting(containerEl)
      .setName("上传并发数")
      .setDesc("全量同步同时上传 1–3 个不同文件；单文件提交仍保持顺序。")
      .addDropdown((dropdown) =>
        dropdown.addOptions({ "1": "1（串行）", "2": "2", "3": "3（推荐）" })
          .setValue(String(this.plugin.settings.uploadConcurrency || 3))
          .onChange(async (value) => {
            this.plugin.settings.uploadConcurrency = Number(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("下载并发数")
      .setDesc("全量同步同时拉取 1–3 个不同文件；单文件写盘互斥与防覆盖冲突保护仍保持顺序。")
      .addDropdown((dropdown) =>
        dropdown.addOptions({ "1": "1（串行）", "2": "2", "3": "3（推荐）" })
          .setValue(String(this.plugin.settings.downloadConcurrency || this.plugin.settings.uploadConcurrency || 3))
          .onChange(async (value) => {
            this.plugin.settings.downloadConcurrency = Number(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("冲突解决模式")
      .setDesc("发生双向修改冲突时的处理方式。Git 单文件合并模式（推荐）会像 Git 一样直接在当前正文中标出 <<<<<<< LOCAL / ======= / >>>>>>> REMOTE，不产生额外副本文件。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            git_merge: "Git 标记合并（推荐：单文件内标注冲突，不生成副本）",
            create_conflict_file: "双副本保留（生成带时间戳的独立 .conflict 副本文件）"
          })
          .setValue(this.plugin.settings.conflictStrategy || "git_merge")
          .onChange(async (value) => {
            this.plugin.settings.conflictStrategy = value as ConflictStrategy;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动同步间隔 (分钟)")
      .setDesc("每隔多少分钟自动执行一次后台同步比对")
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.syncIntervalMinutes = num;
              await this.plugin.saveSettings();
              this.plugin.resetAutoSyncTimer();
            }
          })
      );

    new Setting(containerEl)
      .setName("编辑防抖延迟 (秒)")
      .setDesc("本地编辑文件后等待停止输入的缓冲时间（保证严格 FIFO 时序，避免打字期间高频并发请求）")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.syncOnModifyDebounceSeconds))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.syncOnModifyDebounceSeconds = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // --- Section 5: Conflict Strategy ---
    new Setting(containerEl).setName("5. 冲突与数据保护策略 (Conflict Resolution)").setHeading();

    new Setting(containerEl)
      .setName("冲突交由人工解决")
      .setDesc("保留本地原文件和网盘副本；暂停冲突文件同步，确认已解决后才提交，不再按时间或来源自动覆盖。")
      .addButton(b => b.setButtonText(`查看待处理冲突 (${this.plugin.syncEngine.getPendingConflicts().length})`)
        .onClick(() => this.plugin.openConflictReview()));

    new Setting(containerEl)
      .setName("同步 .obsidian 配置目录")
      .setDesc("是否同步 Obsidian 内部配置（自动精准排除设备专用的 workspace 缓存）")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncObsidianConfig).onChange(async (val) => {
          this.plugin.settings.syncObsidianConfig = val;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.syncObsidianConfig) {
      new Setting(containerEl)
        .setName("同步插件 (plugins)")
        .setDesc("同步 .obsidian/plugins 目录下的社区插件")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.syncPlugins).onChange(async (val) => {
            this.plugin.settings.syncPlugins = val;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("同步外观与主题 (themes)")
        .setDesc("同步 .obsidian/themes 目录下的外观主题")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.syncThemes).onChange(async (val) => {
            this.plugin.settings.syncThemes = val;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("自定义忽略规则")
      .setDesc("每行一个路径前缀或文件名，匹配的文件不会同步")
      .addTextArea((area) =>
        area
          .setPlaceholder(".trash\n.git\n.DS_Store")
          .setValue((this.plugin.settings.ignoredPatterns || []).join("\n"))
          .onChange(async (val) => {
            this.plugin.settings.ignoredPatterns = val
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("增量同步索引")
      .setDesc("默认开启：日常只检查变更记录和受影响目录；首次、索引异常或每 24 小时完整校验。旧版设备或直接在网盘修改的内容由完整校验发现。")
      .addToggle(t=>t.setValue(this.plugin.settings.incrementalSync).onChange(async value=>{
        this.plugin.settings.incrementalSync=value;await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("完整校验同步")
      .setDesc("立即扫描全部目录，用于发现直接在网盘或旧版客户端修改的文件。")
      .addButton(b=>b.setButtonText("立即完整校验").onClick(async()=>{await this.plugin.runSync(true);}));

    new Setting(containerEl).setName("暂停所有同步")
      .setDesc("暂停全量、定时、本地修改同步和冲突提交；已开始的单个文件操作完成后停止。")
      .addToggle(t => t.setValue(this.plugin.settings.syncPaused).onChange(async value => {
        this.plugin.settings.syncPaused = value;
        await this.plugin.saveSettings();
        this.plugin.resetAutoSyncTimer();
        this.plugin.updateStatusBar(value ? "已暂停" : "就绪",false);
      }));

    // --- Section 6: Actions & Logs ---
    new Setting(containerEl).setName("6. 手动操作与日志 (Actions & Logs)").setHeading();

    new Setting(containerEl)
      .setName("全量双向同步")
      .setDesc("有限并发上传不同文件，并保留单文件提交顺序、冲突保护与原子写入")
      .addButton((btn) =>
        btn
          .setButtonText("立即同步")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("查看同步日志").onClick(() => {
          new SyncLogModal(this.app, this.plugin.syncEngine.getLogs()).open();
        })
      );
  }
}

/**
 * Modal for exporting encrypted configuration
 */
class ConfigExportModal extends Modal {
  private generatedCode: string = "";

  constructor(app: App, private settings: PluginSettings) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName("📤 导出受保护的配对码").setHeading();
    contentEl.createEl("p", {
      text: "请设置一个临时的保护密码（PIN 码），用于加密当前所有百度网盘授权凭据与同步配置：",
    });

    const pinInput = contentEl.createEl("input", {
      type: "password",
      placeholder: "设置临时配对密码",
    });
    pinInput.addClass("baidu-sync-ui-13");
    pinInput.addClass("baidu-sync-ui-14");
    pinInput.addClass("baidu-sync-ui-15");

    const btnContainer = contentEl.createDiv();
    const generateBtn = btnContainer.createEl("button", {
      text: "生成加密配对码",
      cls: "mod-cta",
    });

    const resultArea = contentEl.createEl("textarea");
    resultArea.addClass("baidu-sync-ui-13");
    resultArea.addClass("baidu-sync-ui-16");
    resultArea.addClass("baidu-sync-ui-17");
    resultArea.addClass("baidu-sync-hidden");
    resultArea.readOnly = true;

    const copyBtn = contentEl.createEl("button", {
      text: "📋 复制配对码",
    });
    copyBtn.addClass("baidu-sync-ui-18");
    copyBtn.addClass("baidu-sync-hidden");

    generateBtn.onclick = async () => {
      const pin = pinInput.value.trim();
      if (!pin) {
        new Notice("请输入配对保护密码！");
        return;
      }
      try {
        const code = await exportEncryptedConfig(this.settings, pin);
        this.generatedCode = code;
        resultArea.value = code;
        resultArea.removeClass("baidu-sync-hidden");
        copyBtn.removeClass("baidu-sync-hidden");
        new Notice("配对码生成成功！请点击复制。");
      } catch (err: any) {
        new Notice(`生成失败: ${err.message || String(err)}`);
      }
    };

    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.generatedCode);
        new Notice("配对码已复制到剪贴板！去手机端粘贴即可导入。");
      } catch {
        resultArea.focus(); resultArea.select();
        new Notice("无法访问剪贴板，请长按配对码手动复制。");
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Modal for importing encrypted configuration
 */
class ConfigImportModal extends Modal {
  constructor(app: App, private onImport: (config: any) => Promise<void>) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName("📥 导入外部设备配置").setHeading();
    contentEl.createEl("p", {
      text: "粘贴从其他设备导出的配对码（以 BDSYNC:v1: 开头），并输入导出时设置的保护密码：",
    });

    const codeArea = contentEl.createEl("textarea", {
      placeholder: "粘贴配对码 (BDSYNC:v1:...)",
    });
    codeArea.addClass("baidu-sync-ui-13");
    codeArea.addClass("baidu-sync-ui-19");
    codeArea.addClass("baidu-sync-ui-20");

    const pinInput = contentEl.createEl("input", {
      type: "password",
      placeholder: "输入配对保护密码",
    });
    pinInput.addClass("baidu-sync-ui-13");
    pinInput.addClass("baidu-sync-ui-21");
    pinInput.addClass("baidu-sync-ui-15");

    const applyBtn = contentEl.createEl("button", {
      text: "解密并应用配置",
      cls: "mod-cta",
    });

    applyBtn.onclick = async () => {
      const code = codeArea.value.trim();
      const pin = pinInput.value.trim();

      if (!code || !pin) {
        new Notice("请完整填写配对码与密码！");
        return;
      }

      try {
        applyBtn.disabled = true;
        applyBtn.setText("解密中...");
        const config = await importEncryptedConfig(code, pin);
        await this.onImport(config);
        this.close();
      } catch (err: any) {
        new Notice(`导入失败: ${err.message || String(err)}`);
      } finally {
        applyBtn.disabled = false;
        applyBtn.setText("解密并应用配置");
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Modal for viewing sync logs
 */
class SyncLogModal extends Modal {
  constructor(app: App, private logs: any[]) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName("📜 百度网盘同步日志 (最近 200 条)").setHeading();

    if (this.logs.length === 0) {
      contentEl.createEl("p", { text: "暂无同步日志记录。" });
      return;
    }

    const logContainer = contentEl.createDiv({ cls: "baidu-sync-log-container" });
    logContainer.addClass("baidu-sync-ui-22");
    logContainer.addClass("baidu-sync-ui-23");
    logContainer.addClass("baidu-sync-ui-24");
    logContainer.addClass("baidu-sync-ui-10");
    logContainer.addClass("baidu-sync-ui-25");
    logContainer.addClass("baidu-sync-ui-26");
    logContainer.addClass("baidu-sync-ui-27");

    for (const log of this.logs) {
      const dateStr = new Date(log.timestamp).toLocaleTimeString();
      const line = logContainer.createDiv({ cls: `baidu-sync-log-${log.level}` });
      line.addClass("baidu-sync-ui-28");


      line.setText(`[${dateStr}] [${log.level.toUpperCase()}] ${log.message}${log.detail ? ` (${log.detail})` : ""}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
