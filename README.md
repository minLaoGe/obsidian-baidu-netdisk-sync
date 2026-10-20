# Baidu Sync Safe — Obsidian 百度网盘安全双向同步插件

<p align="center">
  <img src="https://img.shields.io/badge/Obsidian-v1.14.4+-purple?style=for-the-badge&logo=obsidian&logoColor=white" alt="Obsidian" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Android%20%7C%20iOS-blue?style=for-the-badge&logo=apple&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/Release-v1.0.9-emerald?style=for-the-badge" alt="Release" />
  <img src="https://img.shields.io/badge/License-MIT-amber?style=for-the-badge" alt="License" />
</p>

<p align="center">
  <b>一款专为 Obsidian 打造的高可靠、跨平台百度网盘双向同步插件。</b><br/>
  充分发挥百度网盘大容量与高速网络优势，为桌面端与移动端用户提供稳定、顺畅、安全的知识库多端同步体验。
</p>

---

[🇨🇳 中文使用指南（置前）](#-中文使用指南) | [🌐 English Documentation](#-english-documentation) | [🛠️ 开发者文档 (DEVELOPER.md)](./DEVELOPER.md)

---

<a name="-中文使用指南"></a>
## 🇨🇳 中文使用指南

### 🌟 项目设计初衷与核心价值

Obsidian 社区拥有非常丰富优秀的同步方案。每个方案都有其适用的场景，而 **Baidu Sync Safe** 专注于为广大**希望使用百度网盘作为个人云端知识库存储介质**的用户，提供原生级、高稳定性的同步体验：

- **📦 充分利用百度网盘大容量云存储**：个人免费拥有 TB 级存储空间，笔记、超大 PDF 文献、长音频与丰富图床附件均可随心备份与同步，无需时刻担忧空间配额。
- **🚀 国内网络原生极速连通**：依托百度网盘全国高质量 CDN 节点与官方 OpenAPI，在国内多网络环境（家用宽带、校园网、移动 4G/5G）下均具备优秀的上传与下载速率。
- **📱 专为移动端深度优化体验**：针对手机设备内存与后台特点，深度定制流式传输与轻量化快筛，确保在移动端拥有轻快、顺畅、省电的使用体验。
- **🔐 严格的数据完整性与原子保障**：引入两阶段提交与本地原子写入，即使在网络突然中断或进程异常退出的情况下，也能确保笔记不被损坏。

---

### ✨ 核心功能亮点

1. **⚡ 零 I/O 快速指纹剪枝 (Fast-path 毫秒级比对)**
   - 针对包含数千篇笔记的大型知识库，采用 `mtime` + `size` 内存快速指纹比对机制。
   - 未改动的文件直接在内存中完成判定，**不读盘、不占闪存 I/O、不算 MD5，耗时 0 毫秒**。2,800+ 篇文件的全库核对缩短至 **50 毫秒以内**，大幅降低移动端 CPU 占用与发热。
2. **🛡️ HTTP Range 4MB 分片流式拉取（移动端大文件顺畅传输）**
   - 针对包含 50MB~100MB+ 大文件（如 PDF 扫描件或音视频），底层采用基于 HTTP Range 的 4MB 分片流式拉取技术。
   - 分片数据随拉取随释放，严格控制内存占用，保障手机与平板设备在处理大附件时平稳顺畅。
3. **🔄 相同内容 MD5 自动对齐与冗余副本清理**
   - 当检测到两端文件存在微小时间戳偏差，但实际内容 MD5 100% 一致时，引擎会自动认定为相同版本并对齐基准线，静默清理多余的 `.conflict` 副本，减少人工维护负担。
4. **🎨 桌面端与移动端统一实时进度 UI**
   - 桌面端自适应固定于窗口右下角（380px 卡片式悬浮），移动端贴合在底部操作栏上方。
   - 实时呈现当前传输阶段、文件进度条、耗时、正在处理的文件名以及上传/下载/跳过统计计数。
5. **🎛️ 独立配置上传与下载并发数（1~5 并发）**
   - 上传通道与下载通道均支持在 1~5 之间自由调节（1 适合弱网省电，3 为标准推荐，4~5 适合宽带极速传输）。
   - 下载写入前自动执行本地哈希复核，排队期间本地若被编辑立即升级为冲突保护，绝不静默覆盖最新笔记。
6. **🔐 AES-256-GCM 端到端可选加密与一键配对码导出**
   - 允许用户设置独立密码开启客户端 AES-256 加密，上传到网盘的均为主机加密后的密文。
   - 支持主设备一键生成加密配对码（`BDSYNC:v1:...`），副设备粘贴配对码输入 PIN 即可一键导入全部配置，无需在手机上重复申请开发者应用。

---

### 📖 保姆级长篇使用教程

#### 第一步：安装插件

##### 方式 A：从 GitHub Releases 离线安装（推荐）
1. 访问本项目的 [GitHub Releases 最新发布页面](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest)；
2. **桌面端（Windows / macOS / Linux）**：下载 `main.js`、`manifest.json`、`styles.css` 三个文件，在你的知识库目录中创建文件夹 `<知识库>/.obsidian/plugins/baidu-sync/`，将这三个文件放入其中；
3. **安卓端（Android 手机 / 平板）**：下载离线压缩包 `baidu-sync-1.0.9-android.zip`，解压后将 `baidu-sync` 文件夹整体复制到手机知识库路径下的 `.obsidian/plugins/` 目录；
4. 打开 Obsidian，进入「设置」→「第三方插件」，关闭安全模式，找到 **Baidu Sync Safe** 并开启启用。

##### 方式 B：通过 BRAT 插件管理器安装
1. 安装并启用社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat)；
2. 在 BRAT 设置中点击「Add Beta plugin」；
3. 输入仓库地址：`minLaoGe/obsidian-baidu-netdisk-sync`，点击确认即可完成安装，并可在后续享受新版本自动更新。

---

#### 第二步：创建百度网盘开发者应用（仅需电脑端操作一次）

> [!NOTE]
> 百度网盘开放平台个人开发者申请完全免费，使用个人手机号即可快速完成认证，无需企业资质。

1. **登录开放平台**：在电脑浏览器中访问 [百度网盘开放平台控制台](https://pan.baidu.com/union/console/applist)；
2. **完成开发者认证**：登录你常用的百度网盘账号，按照页面提示完成个人开发者认证；
3. **创建应用**：
   - 点击「创建应用」；
   - **应用类别**：选择「软件」或「移动 / 桌面应用」；
   - **应用名称**：自定义填写（例如 `MyObsidianSync` 或 `知识库同步`）；
   - **开通权限**：勾选默认的基础网盘读写权限（`basic, netdisk`）即可；
   - 点击提交创建。
4. **获取密钥**：进入刚创建的应用，点击「开发信息」标签页，复制两项关键信息：
   - **AppKey (Client ID)**
   - **AppSecret (SecretKey)**

---

#### 第三步：在 Obsidian 插件中一键授权与测试

1. 打开 Obsidian，进入「设置」→「Baidu Sync Safe」；
2. 将复制好的 **AppKey** 与 **AppSecret** 填入对应输入框；
3. 点击 **「1. 获取网页授权码」** 按钮，系统会自动在默认浏览器打开百度官方授权页面；
4. 登录账号并点击「允许授权」，授权成功后页面会生成一段授权码（Code）；
5. 复制这段 Code，回到 Obsidian 粘贴进输入框，点击 **「2. 兑换并保存 Token」**；
6. 点击下方 **「测试连通性」**，页面提示 `连接成功！网盘用户名：xxx` 即代表云端通信完全正常！

---

#### 第四步：多设备极速配对（电脑 → 手机 / 副电脑）

主设备配置成功后，**其他设备完全不需要再重复申请开发者账号或扫码**，直接使用加密配对码即可一键同步凭据：

1. **在主电脑上**：
   - 进入插件设置，滚动至「多设备快速配对与配置迁移」区块；
   - 点击 **「📤 导出加密配对码」**，设置一个临时的 6 位数 PIN 码；
   - 插件将自动生成一段加密字符串（以 `BDSYNC:v1:` 开头），点击复制到剪贴板；
2. **在手机或另一台电脑上**：
   - 在新设备的 Obsidian 中安装并启用本插件；
   - 进入插件设置，点击 **「📥 导入配置配对码」**；
   - 粘贴配对码，输入刚才设置的保护 PIN 码，点击「解密并应用配置」；
   - 导入完成！所有鉴权凭据与远程目录配置自动就绪，立即可以开始双向同步。

---

#### 第五步：日常同步与最佳配置推荐

- **自动同步间隔**：推荐设置为 `600` ~ `900` 秒（10~15 分钟），插件也支持最短 `10` 秒的高频自动同步。
- **编辑防抖延迟**：默认为 `3` 秒（最低支持 3 秒），等待用户一段文字输入停顿后由 Obsidian 正常完成物理写盘，避免打字期间高频发起网络请求。
- **全量同步防频繁冷却**：系统内置 10 秒冷却保护，短时间内连续点击状态栏不会重复触发全量扫描。
- **移动端（Android / iOS）使用建议**：
  - 手机端首次同步包含几千篇笔记时，请在 Obsidian 前台保持亮屏，避免系统锁屏休眠切断网络；
  - 建议将 Obsidian 加入手机系统的“电池优化白名单”（允许后台运行），保障同步顺畅。

---

#### 第六步：冲突管理与可视化合并

如果两台设备在离线状态下编辑了同一篇笔记且内容不同，同步引擎会触发安全冲突保护机制，绝不武断覆盖任何一边的修改：
1. **查看冲突**：点击状态栏图标或进度卡片，打开「待处理冲突」列表；
2. **比较并合并**：点击进入双向 Diff 对比界面，支持直观查看逐行增删，并在下方编辑器中按需手动合并；
3. **批量接受**：也支持勾选多个文件，一键选择“全部接受本地版本”或“全部接受网盘版本”；
4. **自动对齐**：如果检测到两边实质内容文字完全相同，插件会在同步启动时自动消解冲突，无需手动干预。

---

### ❓ 常见问题排查 (FAQ)

<details>
<summary><b>Q1: 上传或下载到一半突然断网，会怎么样？会全量重传吗？</b></summary>

**不会全量重传。**
- 插件采用两阶段提交事务机制，断网只会让未传完的那一个文件失败并记录到日志中；
- 之前已经传完的文件基准完好无损；
- 网络恢复后再次同步时，引擎在 50ms 内快速完成比对，**仅对刚才失败的那一个文件进行断点重传**，不会重新上传未修改的文件。
</details>

<details>
<summary><b>Q2: 提示「两端文件内容一模一样，已自动标记为已解决并更新基准」是什么意思？</b></summary>

这是插件的**智能冲突自动对齐机制**：
- 由于手机存储卡和百度网盘服务器的时间戳精度存在微小偏差，有时会引发版本对比误报；
- 插件在检测到双方实质内容哈希 100% 一致后，会自动替你对齐基准并清理多余的 `.conflict` 副本，保护笔记安全的同时免除手动确认烦恼。
</details>

<details>
<summary><b>Q3: 为什么有时候同步提示 `UnknownHostException` 或网络超时？</b></summary>

主要有两个排查方向：
1. **手机息屏休眠**：移动设备在锁屏或切到后台后，系统电池策略可能会休眠网络。建议同步大批文件时保持前台亮屏；
2. **代理分流或网络波动**：检查是否有代理规则阻断了百度网盘开放平台域名，或在手机设置中将“专用 DNS (Private DNS)”暂时关闭后重试。
</details>

<details>
<summary><b>Q4: 百度网盘 Access Token 过期了需要经常重新手动获取吗？</b></summary>

**不需要。**
插件内置了 OAuth 2.0 自动续期机制。在 Token 到期前，后台会自动携带 Refresh Token 换取新的凭据并静默保存，日常使用无需手动维护。
</details>

---

<a name="-english-documentation"></a>
## 🌐 English Documentation

### 🌟 Project Mission & Core Values

The Obsidian community has many wonderful synchronization tools. **Baidu Sync Safe** is specifically designed for users who wish to use **Baidu Netdisk as their primary cloud knowledge base storage**, offering a native, robust, and safe synchronization experience:

- **📦 Generous Free Cloud Storage**: Utilize TB-scale storage on Baidu Netdisk for notes, large PDF research papers, audio recordings, and image attachments without storage anxiety.
- **🚀 High-Speed Native Connectivity**: Benefiting from high-speed domestic CDN nodes and the official Baidu Netdisk OpenAPI, uploads and downloads remain fast and stable across various network environments.
- **📱 Tailored for Mobile Stability**: Specially tuned for mobile hardware constraints, featuring chunked streaming and lightweight memory-first auditing to ensure smooth, responsive, and battery-friendly operation.
- **🔐 Strict Data Integrity & Atomicity**: Built with two-phase atomic write semantics to guarantee that unexpected network drops or process exits never corrupt user notes.

---

### ✨ Key Features

1. **⚡ Zero-I/O Fast-Path Metadata Auditing**
   - Utilizes in-memory `mtime` + `size` fingerprints. Unmodified notes require **zero disk reads and zero hash calculations**.
   - Auditing 2,800+ notes takes **less than 50 milliseconds**, keeping mobile devices cool with negligible CPU usage.
2. **🛡️ HTTP Range 4MB Chunked Streaming (Smooth Mobile Large-File Transfers)**
   - Downloads large attachments (PDFs, media files) in 4MB chunks via HTTP Range requests.
   - Limits transient memory consumption within safe bounds, ensuring smooth downloads on mobile devices.
3. **🔄 Identical-Content Auto-Alignment & Duplicate Copy Cleanup**
   - Automatically detects files with matching content hashes despite timestamp discrepancies, aligns the baseline, and silently cleans up redundant `.conflict-...` copies.
4. **🎨 Unified Real-time Progress UI across Desktop & Mobile**
   - Floating status card anchored at the bottom-right corner on desktop (380px), and bottom tab bar on mobile.
   - Displays current phase, progress bar, elapsed time, active filenames, and live transfer counts.
5. **🎛️ Independent Upload & Download Concurrency (1–5 Workers)**
   - Independently tune concurrency pools for upload and download (1 for conservative power saving, 3 for standard recommended, 4–5 for high-speed networks).
   - Pre-commit hash checks protect files edited while queued from accidental overwrite.
6. **🔐 Optional AES-256-GCM End-to-End Encryption & One-Click Device Pairing**
   - Enables client-side AES-256 encryption before uploading to cloud storage.
   - Export an encrypted pairing string (`BDSYNC:v1:...`) on desktop and import on mobile in seconds without repeating developer registration.

---

### 📖 Step-by-Step Setup Guide

#### Step 1: Installation
- **From GitHub Releases**: Download `main.js`, `manifest.json`, and `styles.css` from the [Latest Release](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest) and place them in `<vault>/.obsidian/plugins/baidu-sync/`. On Android, extract `baidu-sync-1.0.9-android.zip` directly into the plugins folder.
- **Via BRAT**: Add `minLaoGe/obsidian-baidu-netdisk-sync` in the BRAT community plugin.
- Enable **Baidu Sync Safe** in Obsidian Community Plugins.

#### Step 2: Register Baidu Developer Application (One-time on PC)
1. Open the [Baidu Netdisk Open Platform Console](https://pan.baidu.com/union/console/applist);
2. Sign in with your Baidu account and complete free individual developer verification;
3. Click "Create Application", choose "Software" / "Mobile/Desktop", and pick default basic permissions (`basic, netdisk`);
4. Under "Development Info", copy your **AppKey (Client ID)** and **AppSecret (SecretKey)**.

#### Step 3: Authorize & Connect
1. In Obsidian settings, paste **AppKey** and **AppSecret**;
2. Click **"1. Get Web Auth Code"**, log in via browser, grant permissions, and copy the authorization code;
3. Paste back into Obsidian, click **"2. Exchange & Save Token"**;
4. Click **"Test Connectivity"** to confirm your account is connected!

#### Step 4: Quick Multi-Device Pairing (PC → Mobile)
1. **On your primary PC**: Go to plugin settings → "Export Encrypted Pairing Code", set a 6-digit PIN, and copy the string;
2. **On your mobile / second device**: In plugin settings, click "Import Pairing Code", paste the code, enter your PIN, and click apply. Configuration and authentication tokens sync instantly!

---

### 🛠️ Developer & Internal Architecture Documentation

For complete technical specifications, crash-recovery protocols, and automated test suites, please refer to:
👉 [**DEVELOPER.md — 开发者与底层技术文档**](./DEVELOPER.md)

---

### 📄 License & Acknowledgements

- Inspired by [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync) for end-to-end encryption concepts.
- Licensed under the [MIT License](LICENSE).
