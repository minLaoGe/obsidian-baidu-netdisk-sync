# Baidu Sync Safe — Obsidian 百度网盘同步

## English

Baidu Sync Safe synchronizes an Obsidian vault with Baidu Netdisk. It supports manual and scheduled bidirectional sync, conflict copies, optional AES-256-GCM end-to-end encryption, and encrypted configuration transfer between devices.

**Requirements:** Obsidian 1.14.4 or later, a Baidu Netdisk account, and a personal Baidu developer application with AppKey/AppSecret.

**Install:** Download `main.js`, `manifest.json`, and `styles.css` from this repository's [latest release](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest). Place them in `<vault>/.obsidian/plugins/baidu-sync/` and enable **Baidu Sync Safe** under Community plugins. Alternatively, install via BRAT with repository path `minLaoGe/obsidian-baidu-netdisk-sync`.

**Set up:** Create an application in the Baidu Netdisk developer console, enter its AppKey and AppSecret in plugin settings, open the authorization page, exchange the authorization code for a token, and test connectivity. Choose a remote directory before starting sync. To enable encryption, set a nonempty encryption password on every device. Keep an independent backup before the first sync.

**File safety:** Desktop replacement uses native filesystem rename with verified backup and journal files and pre-commit fsync. Mobile replacement uses a journaled transaction log to ensure safe restart recovery. Startup recovery only processes plugin-owned journal entries. The plugin makes requests to Baidu for authorization, uploads and downloads, and uses the clipboard for user-triggered configuration transfer.

**Credits:** The link to owl234's project in the Chinese acknowledgements below is intentional attribution for encryption and configuration-sharing design references; installation and downloads for this plugin use the minLaoGe repository linked above.

---

## 中文

为 Obsidian 打造的高可靠百度网盘双向同步插件。依托百度网盘大容量云存储，提供**单设备串行执行**、**双模式文件替换与事务恢复**、**3-Way 冲突副本保护**，并支持**端到端零知识加密（E2EE）**与**多设备一键跨端快速配对**机制。

---

## 🌟 致谢

特别感谢社区优秀开源项目 [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync) 在端到端加密（E2EE）与多设备跨端配对设计上带来的启发与技术参考。

---

## 📖 百度网盘账号授权（OAuth 2.0）保姆级获取步骤

只需在电脑端首次操作一次，后续手机或其它设备可直接通过加密配对码一键导入！

### 第一步：登录百度网盘开放平台
1. 浏览器打开 [百度网盘开放平台控制台](https://pan.baidu.com/union/console/applist)；
2. 登录你常用的百度网盘个人账号（首次进入点击注册开发者，普通个人账号绑定手机即可免费开通）。

### 第二步：创建个人开发者应用
1. 进入「控制台」 → 点击「创建应用」；
2. **应用类别**：选择「软件」或「移动 / 桌面应用」；
3. **应用名称**：任意输入（例如 `ObsidianSync` 或 `MyObsidian`）；
4. **开通权限**：保持默认的基础网盘读写权限（`basic,netdisk`）即可，无需额外特殊申请；
5. 点击提交创建。

### 第三步：获取 AppKey 与 AppSecret
1. 进入刚创建的应用详情页面，切换到「开发信息」一栏；
2. 复制你的 **AppKey（Client ID）** 与 **AppSecret（SecretKey）**；
3. 打开 Obsidian 插件设置页面，分别粘贴进 **AppKey** 和 **AppSecret** 输入框。

### 第四步：网页授权与换取 Token
1. 在插件设置中点击「1. 获取网页授权码」按钮，会自动在浏览器中弹出百度官方授权登录页面；
2. 登录账号并点击「允许授权」；
3. 授权成功后，页面会展示一段授权码（Code）；
4. 复制该 Code 粘贴回插件设置中的输入框，点击「2. 兑换并保存 Token」；
5. 提示兑换成功后，点击「测试连通性」，显示你的百度网盘用户名即代表配置成功！

> [!TIP]
> 百度网盘 Token 到期前插件会自动无感续期，日常使用无需手动维护。

---

## 📱 多设备快速配对指南（电脑 → 手机 / 其它电脑）

主设备配置完成后，其它设备无需再繁琐地申请开发者和扫码，可通过加密配对码一键同步配置：

1. **在主设备（电脑端）**：
   - 进入插件设置 → 找到「多设备快速配对与配置迁移」；
   - 点击 **「📤 导出加密配对码」**，设置一个临时保护密码（PIN 码），点击生成并复制配对码（以 `BDSYNC:v1:` 开头）。
2. **在手机端或第二台电脑**：
   - 在新设备的 Obsidian 中安装并启用本插件；
   - 进入插件设置，点击 **「📥 导入配置配对码」**；
   - 粘贴配对码，输入刚才设置的保护 PIN 码，点击「解密并应用配置」；
   - 导入后即刻拥有完整的同步配置与鉴权凭证，立即开始双向同步！

---

## 🛠️ 安装与使用

在插件通过 Obsidian 官方社区商店审核之前，你可以选择以下任一方式进行安装：

### 方法一：使用 BRAT 插件自动安装（推荐，全平台通用）
BRAT（Obsidian42 - BRAT）是官方社区认可的测试插件管理器，支持自动拉取与后续一键更新：
1. 在 Obsidian 打开「设置」 → 「第三方插件」 → 「社区插件市场」；
2. 搜索并安装 **`BRAT`** 插件（全名 `Obsidian42 - BRAT`），安装后启用；
3. 进入 BRAT 插件设置，点击 **`Add Beta plugin`**；
4. 在输入框中填入本仓库地址：
   ```text
   minLaoGe/obsidian-baidu-netdisk-sync
   ```
5. 点击 `Add Plugin`，BRAT 将自动下载最新版本文件并安装就绪；
6. 返回「第三方插件」列表，启用 **Baidu Sync Safe** 即可。

### 方法二：手动安装（桌面端）
1. 打开你的 Obsidian 知识库根目录，进入 `.obsidian/plugins/` 目录；
2. 新建名为 `baidu-sync` 的文件夹；
3. 将构建发布的 `main.js`、`manifest.json`、`styles.css` 这 3 个文件放入该文件夹；
4. 在 Obsidian「设置」 → 「第三方插件」中点击刷新，并启用 **Baidu Sync Safe**。

### 方法三：手动安装（移动端 iOS / Android）
1. 准备好 `main.js`、`manifest.json`、`styles.css` 3 个文件，发送至手机；
2. 将文件移动至手机端知识库的插件目录：
   - **Android**：使用手机文件管理（或 MT 管理器），进入 `你的知识库/.obsidian/plugins/`，新建 `baidu-sync` 文件夹并将 3 个文件放入（若未显示 `.obsidian`，请在文件管理器设置中开启“显示隐藏文件”）。
   - **iOS / iPadOS**：打开系统自带「文件」App →「我的 iPhone」→「Obsidian」→ 进入你的知识库目录；点击右上角 `...` 选择「显示所有隐藏文件」，进入 `.obsidian/plugins/`，新建 `baidu-sync` 文件夹并将 3 个文件拷贝进去。
3. 打开手机端 Obsidian「设置」 → 「第三方插件」 → 点击刷新并启用插件。

---

## 🚀 核心架构与功能特性

### 1. 严格时间顺序（Ordering Guarantee）
- **本地防抖缓冲池（Debounce Manager）**：在 Obsidian 中高频键入或自动保存时，通过可配置窗口（默认 3 秒）将多次修改合并为单次有效变更，杜绝打字期间高频发包引起的网络倒序与网盘接口频控。
- **严格 FIFO 串行异步执行队列**：确保对于任何文件与元数据，始终按产生的逻辑时间序列单调推进，消除并发交错。
- **全局同步互斥锁（Sync Mutex Lock）**：全量比对期间独占锁，防止手动连续点击或定时轮询与正在运行的增量任务重叠。

### 2. 双模式安全写入与崩溃事务恢复
- **桌面端（原生原子覆盖）**：在桌面端利用底层文件系统 `rename` 一步到位原子替换目标文件，彻底消除“先删旧文件、再改名新文件”之间的丢失空档；并在写入后显式调用 `fsync` 确保数据落盘。
- **移动端（事务预写日志 WAL）**：针对移动端没有原生原子覆盖接口的情况，在 `.obsidian/plugins/baidu-sync/transactions/` 目录下保留 `.new`、`.old` 与校验日志。若在操作中途遭遇断电或闪退，启动时恢复引擎会自动校验 MD5 并无损还原，确保笔记完好无损。
- **容灾恢复与数据校验**：所有文件替换与下载均经过哈希重读验证；同步基线（`sync-state.json`）同样采用事务机制保存，基线损坏不会静默覆盖，保障数据确定性。

### 3. 三方差异冲突防护（3-Way Conflict-Safe Resolution）
基于「当前本地」、「当前网盘」、「上次成功同步基准（Base Snapshot）」进行三方对比：
- **本地修改，远端未变**：自动推送（Upload）。
- **远端修改，本地未变**：自动拉取（Download）。
- **两端并发修改且哈希不同（真实冲突）**：
  - **默认策略（安全分支副本）**：保留本地编辑内容原封不动，将远端冲突版本拉取并另存为 `${文件名}.conflict-${时间戳}.${扩展名}`，并在 Obsidian 界面弹出 Notice 提示，同时收敛基线，保留两个版本供用户检查与合并。
  - **可选策略**：支持在设置中切换为“以最新时间戳为准（keep_newer）”、“强制本地优先”或“强制远端优先”。
- **修改与删除冲突**：无论发生“本地修改 vs 远端删除”还是“本地删除 vs 远端修改”，均严格遵循“以修改方优先”原则保留数据，杜绝误删风险。

### 4. 工业级端到端加密（E2EE）
- 采用 Web Crypto API 原生实现的 **AES-256-GCM** 高级加密标准 + **PBKDF2**（600,000 次 SHA-256 哈希迭代）派生高强度密钥。
- 文件在离开本地设备前完成加密，网盘端仅存放密文，兼顾大容量同步与笔记隐私保护。
- 零 Node.js 内置依赖，纯原生跨平台，全平台环境均可顺畅运行。

---

## 💻 本地构建开发

```bash
# 安装依赖
npm install

# 生产环境编译打包
npm run build

# 执行可靠性回归测试
npm test

# 开发监听模式
npm run dev
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
