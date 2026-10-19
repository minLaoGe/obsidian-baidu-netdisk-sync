# Baidu Sync Safe — Obsidian 百度网盘同步

## English

A desktop Obsidian plugin for bidirectional sync with Baidu Netdisk. Requires
**Obsidian 1.14.4+**, a Baidu Netdisk account, and a Baidu developer application.

- **Bounded uploads:** full sync uploads 1–3 independent files concurrently (default 3). Each file retains ordered precreate, missing-block upload, and final commit.
- **Delta sync:** unchanged files are skipped. Identical-content local save events make no Baidu request. Full sync still checks the remote inventory for edits on other devices.
- **Human-reviewed conflicts:** keep the local original and remote snapshot, persist a pending record, and pause that file until the user merges and confirms. Notices, a status-bar count, a settings button, and the command palette expose unresolved conflicts.
- **File safety:** existing atomic desktop replacement, verified backups, crash-recovery journals, serialized state checkpoints, and full/incremental sync isolation remain in place.
- **Optional encryption:** AES-256-GCM encryption and password-protected configuration transfer between desktop devices.

### Installation

Download `main.js`, `manifest.json`, and `styles.css` from the repository's
[latest release](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest)
and place them in `<vault>/.obsidian/plugins/baidu-sync/`. Alternatively install with
BRAT using `minLaoGe/obsidian-baidu-netdisk-sync`. Enable **Baidu Sync Safe** in
Community plugins. To use unreleased source changes, build the checked-out branch
and copy those three files to the same directory. This version is desktop-only.

Enter your AppKey and AppSecret in plugin settings, authorize with Baidu, exchange
the code for a token, test connectivity, and choose the remote directory. Make an
independent backup before first sync. When enabling encryption, configure the same
nonempty password on every device.

### Manual conflict resolution

1. Open pending conflicts from the status bar, settings, or **查看并人工解决同步冲突** command.
2. Compare the original with its `.conflict-...` remote snapshot; merge the chosen content into the original.
3. Click **确认已解决并提交**. If the original is absent, this explicitly applies its deletion remotely.

The remote is checked again before committing. New remote edits refresh the pending
snapshot and block stale confirmation. **更新远端副本** repairs a missing snapshot
or fetches a newer version. Other files keep syncing. Pending records survive restart;
conflict copies stay local and remain available after resolution. Older automatic
winner preferences are no longer applied. Legacy copies are preserved but are not
automatically converted into pending records with an invented remote baseline.

### Correctness and performance

The upload protocol now handles `return_type=1` as missing blocks and `return_type=2`
as rapid upload, fixing skipped-block error `31500`. Multipart requests let
Obsidian/Electron calculate Content-Length, fixing `ERR_INVALID_ARGUMENT`.

A four-round synthetic Baidu test measured about **2.97×** mean upload speedup with
three workers. All 36 files and an additional multi-part file passed downloaded
byte-for-byte verification. Actual vault speed varies; see [performance evidence](docs/PERFORMANCE.md).

Atomicity is per file, not a transaction spanning the entire vault, cloud service,
or simultaneous devices. Conflict review is a file workflow, not Git integration or
automatic text merging. Full scans retain content hashing rather than trusting only
mtime and size. The plugin contacts Baidu for authorization and file operations;
configuration transfer uses the clipboard only when requested.

---

## 中文

使用百度网盘同步 Obsidian 知识库，当前仅支持 **Obsidian 1.14.4 及以上桌面端**。

### 新增功能与修复

| 功能 | 行为 |
| --- | --- |
| 1–3 并发上传 | 默认 3 个不同文件并发；同一文件的分片和最终提交保持顺序 |
| 差异同步 | 内容未变不上传、不下载；重复保存不请求百度接口 |
| 减少无效操作 | 整轮无变化时不重复创建根目录、不重写同步基线；仍检查远端列表 |
| 人工冲突处理 | 保留双方版本、持久化待办、暂停冲突文件，不自动选择覆盖方 |
| 明确冲突提示 | 弹出提示、状态栏待处理数量、设置入口、命令面板入口 |
| 原子性保护 | 分片失败不提交；成功后原子保存基线；保存失败时停止派发并等待在途任务结束 |
| 上传协议修复 | 修正秒传判断，解决 `31500`；移除受限制请求头，解决桌面端 `ERR_INVALID_ARGUMENT` |

首次上传仍需传完所有待同步文件，后续才可根据基线跳过未修改内容。
自动本地修改任务保持顺序；上传并发针对全量同步中的独立文件。下载、删除、
冲突处理和本地原子替换保持串行。令牌刷新也串行处理。

### 安装

从本仓库 [Releases](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest)
下载 `main.js`、`manifest.json`、`styles.css`，放入
`<知识库>/.obsidian/plugins/baidu-sync/`，然后在第三方插件中启用 **Baidu Sync Safe**。
也可以通过 BRAT 添加 `minLaoGe/obsidian-baidu-netdisk-sync`。
未发布的分支代码需要先本地构建再复制三个文件。更新前保留旧插件文件，
并等待当前同步完成后再重新加载插件；已有 `data.json` 和同步基线不要删除。

## 📖 百度网盘账号授权（OAuth 2.0）保姆级获取步骤

只需在电脑端首次操作一次，后续手机或其他桌面设备可直接通过加密配对码一键导入！

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

主设备配置完成后，其他桌面设备无需再繁琐地申请开发者和扫码，可通过加密配对码一键同步配置：

1. **在主设备（电脑端）**：
   - 进入插件设置 → 找到「多设备快速配对与配置迁移」；
   - 点击 **「📤 导出加密配对码」**，设置一个临时保护密码（PIN 码），点击生成并复制配对码（以 `BDSYNC:v1:` 开头）。
2. **在手机端或第二台电脑**：
   - 在新设备的 Obsidian 中安装并启用本插件；
   - 进入插件设置，点击 **「📥 导入配置配对码」**；
   - 粘贴配对码，输入刚才设置的保护 PIN 码，点击「解密并应用配置」；
   - 导入后即刻拥有完整的同步配置与鉴权凭证，立即开始双向同步！

---


### 人工解决冲突

1. 出现提示后，点击状态栏的“待处理冲突”，或在设置/命令面板打开冲突列表。
2. 打开本地原文件与远端副本，人工比较，把最终内容合并到原文件。
3. 点击“确认已解决并提交”。**若原文件不存在，确认会将删除同步到网盘。**
4. 远端再次变化时会阻止旧确认，更新副本后请重新检查；缺失副本可通过“更新远端副本”补取。

未确认前不推进该文件的同步基线，不上传冲突副本；其他文件正常同步。待办在重启后仍保留，
解决后的副本也保留供追溯。旧版自动生成的副本不会删除，但不会凭空补造它们的待办基线。
这是类似 Git 的人工处理流程，不包含 Git 集成或自动文本合并。

### 验证与边界

生产构建、TypeScript 检查、104 项可靠性断言及并发、差异同步、上传协议测试通过。
覆盖崩溃恢复、磁盘故障、待处理冲突重启恢复、远端再次修改、缺失副本重建、
失败上传不提交、成功提交后再更新状态等场景。

[测速记录](docs/PERFORMANCE.md) 中的小文件对照实验平均约快 3 倍，
不保证所有文件或整个知识库都达到相同比例。
原子性针对单个文件提交与可恢复本地替换，不是整库或多设备之间的分布式事务。
端到端加密可选；首次同步前请保留独立备份。

## 本地开发

使用 Node.js 22 LTS：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

可选实测（会创建仅含随机测试内容的临时网盘目录，下载校验后删除，不改笔记或同步基线）：

```bash
node tests/benchmark-live.cjs /absolute/path/to/plugin/data.json
node tests/benchmark-live.cjs /absolute/path/to/plugin/data.json --large-only
```

不要将真实的插件 `data.json`、Access Token、AppSecret 或同步基线上传到代码仓库。

## 致谢与许可证

感谢 [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync)
对端到端加密与配置迁移设计提供的参考。本插件安装地址为上方 minLaoGe 仓库。

[MIT License](LICENSE)。
