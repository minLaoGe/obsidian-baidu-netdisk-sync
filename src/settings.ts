import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
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
  syncIntervalMinutes: 15,
  syncOnStartup: true,
  syncOnModifyDebounceSeconds: 3,
  conflictStrategy: "create_conflict_file",
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
    containerEl.createEl("h1", { text: "百度网盘同步设置 (Baidu Netdisk Sync)" });

    // --- Section 1: Detailed OAuth & Credential Guide ---
    containerEl.createEl("h2", { text: "1. 百度网盘账号授权 (OAuth 2.0)" });

    const guideBox = containerEl.createDiv({ cls: "baidu-sync-card" });
    guideBox.style.lineHeight = "1.6";
    guideBox.style.fontSize = "13px";

    const titleEl = guideBox.createEl("div", {
      cls: "baidu-sync-card-title",
      text: "📖 凭证获取详细保姆级操作指南（只需操作一次）：",
    });
    titleEl.style.fontSize = "14px";
    titleEl.style.fontWeight = "600";
    titleEl.style.marginBottom = "6px";

    const ol = guideBox.createEl("ol");
    ol.style.margin = "0 0 10px 18px";
    ol.style.padding = "0";

    const li1 = ol.createEl("li");
    li1.appendText("访问 ");
    const linkUnion = li1.createEl("a", {
      text: "百度网盘开放平台控制台 (pan.baidu.com/union)",
      href: "https://pan.baidu.com/union/console/applist",
    });
    linkUnion.style.color = "var(--text-accent)";
    linkUnion.style.textDecoration = "underline";
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
    tipDiv.style.fontSize = "12px";
    tipDiv.style.color = "var(--text-muted)";
    tipDiv.style.marginTop = "6px";
    tipDiv.innerHTML = "💡 <b>小贴士：</b>如果后续需要在手机/平板等移动端使用，无需在手机上重复申请凭证！配置完成后，直接使用下方【2. 多设备快速配对】导出加密配对码，在手机端一键导入即可。";

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
    containerEl.createEl("h2", { text: "2. 多设备快速配对与配置迁移 (Multi-Device Fast Pairing)" });

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
    containerEl.createEl("h2", { text: "3. 端到端零知识加密 (E2EE)" });

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
    containerEl.createEl("h2", { text: "4. 同步与时序设置 (Sync & Ordering Configuration)" });

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
    containerEl.createEl("h2", { text: "5. 冲突与数据保护策略 (Conflict Resolution)" });

    new Setting(containerEl)
      .setName("冲突解决策略")
      .setDesc("当本地与网盘同时修改产生分歧时的裁决机制")
      .addDropdown((drop) =>
        drop
          .addOption("create_conflict_file", "安全分支副本 (推荐：零数据丢失，保留本地并生成冲突文件)")
          .addOption("keep_newer", "以较新修改时间为准 (Last-Write-Wins)")
          .addOption("keep_local", "强制以本地为准 (覆盖远端)")
          .addOption("keep_remote", "强制以远端为准 (覆盖本地)")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (val) => {
            this.plugin.settings.conflictStrategy = val as ConflictStrategy;
            await this.plugin.saveSettings();
          })
      );

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

    // --- Section 6: Actions & Logs ---
    containerEl.createEl("h2", { text: "6. 手动操作与日志 (Actions & Logs)" });

    new Setting(containerEl)
      .setName("全量双向同步")
      .setDesc("立即按严格时间顺序和原子检查机制执行比对与同步")
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

    contentEl.createEl("h2", { text: "📤 导出受保护的配对码" });
    contentEl.createEl("p", {
      text: "请设置一个临时的保护密码（PIN 码），用于加密当前所有百度网盘授权凭据与同步配置：",
    });

    const pinInput = contentEl.createEl("input", {
      type: "password",
      placeholder: "设置临时配对密码",
    });
    pinInput.style.width = "100%";
    pinInput.style.marginBottom = "12px";
    pinInput.style.padding = "8px";

    const btnContainer = contentEl.createDiv();
    const generateBtn = btnContainer.createEl("button", {
      text: "生成加密配对码",
      cls: "mod-cta",
    });

    const resultArea = contentEl.createEl("textarea");
    resultArea.style.width = "100%";
    resultArea.style.height = "120px";
    resultArea.style.marginTop = "12px";
    resultArea.style.display = "none";
    resultArea.readOnly = true;

    const copyBtn = contentEl.createEl("button", {
      text: "📋 复制配对码",
    });
    copyBtn.style.marginTop = "8px";
    copyBtn.style.display = "none";

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
        resultArea.style.display = "block";
        copyBtn.style.display = "inline-block";
        new Notice("配对码生成成功！请点击复制。");
      } catch (err: any) {
        new Notice(`生成失败: ${err.message || String(err)}`);
      }
    };

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(this.generatedCode);
      new Notice("配对码已复制到剪贴板！去手机端粘贴即可导入。");
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

    contentEl.createEl("h2", { text: "📥 导入外部设备配置" });
    contentEl.createEl("p", {
      text: "粘贴从其他设备导出的配对码（以 BDSYNC:v1: 开头），并输入导出时设置的保护密码：",
    });

    const codeArea = contentEl.createEl("textarea", {
      placeholder: "粘贴配对码 (BDSYNC:v1:...)",
    });
    codeArea.style.width = "100%";
    codeArea.style.height = "100px";
    codeArea.style.marginBottom = "10px";

    const pinInput = contentEl.createEl("input", {
      type: "password",
      placeholder: "输入配对保护密码",
    });
    pinInput.style.width = "100%";
    pinInput.style.marginBottom = "16px";
    pinInput.style.padding = "8px";

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

    contentEl.createEl("h2", { text: "📜 百度网盘同步日志 (最近 200 条)" });

    if (this.logs.length === 0) {
      contentEl.createEl("p", { text: "暂无同步日志记录。" });
      return;
    }

    const logContainer = contentEl.createDiv({ cls: "baidu-sync-log-container" });
    logContainer.style.maxHeight = "400px";
    logContainer.style.overflowY = "auto";
    logContainer.style.fontFamily = "monospace";
    logContainer.style.fontSize = "12px";
    logContainer.style.backgroundColor = "var(--background-secondary)";
    logContainer.style.padding = "10px";
    logContainer.style.borderRadius = "6px";

    for (const log of this.logs) {
      const dateStr = new Date(log.timestamp).toLocaleTimeString();
      const line = logContainer.createDiv({ cls: `baidu-sync-log-${log.level}` });
      line.style.marginBottom = "4px";

      const colorMap: Record<string, string> = {
        info: "var(--text-normal)",
        success: "var(--text-success, #48c774)",
        warn: "var(--text-warning, #ffdd57)",
        error: "var(--text-error, #f14668)",
      };

      line.style.color = colorMap[log.level] || "var(--text-normal)";
      line.setText(`[${dateStr}] [${log.level.toUpperCase()}] ${log.message}${log.detail ? ` (${log.detail})` : ""}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
