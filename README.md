# Baidu Sync Safe — Obsidian 百度网盘同步

## English

An Obsidian plugin for desktop, Android, and iOS for bidirectional sync with Baidu Netdisk. Requires
**Obsidian 1.14.4+**, a Baidu Netdisk account, and a Baidu developer application.

- **Bounded transfers:** full sync uploads and downloads 1–3 independent files concurrently (configurable in settings). Each file retains ordered precreate, missing-block upload, and atomic commit.
- **Large file protection:** uses HTTP Range 4MB chunked streaming to prevent Android Capacitor Base64 OutOfMemoryError crashes.
- **Identical content auto-resolution:** files with matching MD5 hashes are automatically resolved and cleaned up without generating redundant `.conflict` copies.
- **Delta sync:** unchanged files are skipped. Identical-content local save events make no Baidu request. Full sync still checks the remote inventory for edits on other devices.
- **Human-reviewed conflicts:** for genuinely conflicting files, keep the local original and remote snapshot, persist a pending record, and pause that file until the user merges and confirms.
- **File safety:** existing atomic desktop replacement, verified backups, crash-recovery journals, serialized state checkpoints, and full/incremental sync isolation remain in place.
- **Optional encryption:** AES-256-GCM encryption and password-protected configuration transfer between devices.

### Installation

Download `main.js`, `manifest.json`, and `styles.css` from the repository's
[latest release](https://github.com/minLaoGe/obsidian-baidu-netdisk-sync/releases/latest)
and place them in `<vault>/.obsidian/plugins/baidu-sync/`. Alternatively install with
BRAT using `minLaoGe/obsidian-baidu-netdisk-sync`. Enable **Baidu Sync Safe** in
Community plugins. To use unreleased source changes, build the checked-out branch
and copy those three files to the same directory. Mobile defaults to manual sync and shows a persistent progress notice. Keep Obsidian in the foreground during sync. See [mobile setup](MOBILE-INSTALL.zh-CN.md). iOS compatibility has simulation coverage; physical-device testing is pending.

Enter your AppKey and AppSecret in plugin settings, authorize with Baidu, exchange
the code for a token, test connectivity, and choose the remote directory. Make an
independent backup before first sync. When enabling encryption, configure the same
nonempty password on every device.

### Manual conflict resolution

1. Open pending conflicts from the status bar, settings, or **查看并人工解决同步冲突** command.
2. Use **比较并合并** to review the line diff and edit one merged result. **保存并解决冲突** saves and commits it, removing the pending record on success.
3. Alternatively, select conflicts and accept their local or remote versions in a batch. For edits made directly in the original, click **确认已解决并提交**; an absent original explicitly applies deletion remotely.

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

使用百度网盘同步 Obsidian 知识库，支持 **Obsidian 1.14.4 及以上桌面端、Android 和 iOS**；手机默认手动同步，并显示持续更新的进度提示。详见 [手机安装说明](MOBILE-INSTALL.zh-CN.md) 与 [更新日志及排查解决指南](CHANGELOG.md)。

- **大文件防闪退分片拉取**：大文件（PDF/音视频等）采用 HTTP Range 4MB 分片流式拉取，避免触发安卓 Capacitor Base64 内存暴涨（256MB ART 限制），保障手机平稳不闪退。
- **相同内容冲突自动消解**：两端内容哈希（MD5）一致时自动标记解决，更新基线并自动清理冗余 `.conflict` 副本。
- **独立并发控制**：设置中支持分别配置「上传并发数」与「下载并发数」（1~3），兼顾传输速度与稳定性。
- **排队防覆盖安全检查**：下载落盘前复核本地内容哈希，若排队期间本地被编辑则自动升级为冲突保护，绝不静默覆盖最新笔记。
- **两阶段原子落盘**：`AtomicFileSystem` 事务文件保障断网不丢笔记、不损坏文件。

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
2. 点击“比较并合并”，查看逐行 diff 并编辑合并结果；点击“保存并解决冲突”后自动提交，成功即从列表移除。也可勾选冲突，批量接受本地或远端版本。
3. 若直接在原文件中完成编辑，点击“确认已解决并提交”。**若原文件不存在，确认会将删除同步到网盘。**
4. 远端再次变化时会阻止旧确认，更新副本后请重新检查；缺失副本可通过“更新远端副本”补取。

未确认前不推进该文件的同步基线，不上传冲突副本；其他文件正常同步。待办在重启后仍保留，
解决后的副本也保留供追溯。旧版自动生成的副本不会删除，但不会凭空补造它们的待办基线。
这是类似 Git 的人工处理流程，不包含 Git 集成或自动文本合并。

### 验证与边界

生产构建、TypeScript 检查、138 项可靠性断言及并发、差异同步、上传协议测试通过。
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

## Directory enumeration and deletion safety fix

Baidu `method=list` ignores the recursion flag. The plugin now explicitly enumerates every subdirectory and follows full pages even when `has_more` is omitted. Missing child directories, malformed responses, repeated pages and out-of-directory entries abort the scan before applying any plan. Cold-start/audit deletions await manual confirmation. In validated incremental rounds (or local-change events), tracked deletion propagates automatically only when the other version still matches the baseline; modify/delete conflicts remain manual. Atomic write locks are shared across module copies in one renderer; only a fully cleaned stale journal entry may be skipped, while orphan payloads remain blocked and preserved. “暂停所有同步” blocks full, scheduled, local-change sync and resolution commits.

## 相同版本去重

生成冲突副本前会校验实际内容与修改时间。内容哈希一致且修改时间在百度网盘的秒级精度下相同，则保留原文件并更新同步基线，不重复上传或创建冲突副本。时间缺失、时间不同或内容不同不适用此规则。对已登记冲突，点击“更新远端副本”会重新校验；满足条件时清除待办，内容相同的重复副本移入本地回收站，修改过的副本保留。

冲突页面的“打开原文件/远端副本”会在 Obsidian 内部标签页打开并聚焦笔记。原文件和副本均提供删除按钮，二次确认后移入本地回收站；此操作不修改网盘，也不会自动清除待处理状态。删除原文件后，需要另行明确确认提交，才会将删除同步到远端。

点击“比较并合并”可查看逐行增删 diff，在同一个编辑框中按 Git 风格冲突标记人工合并，或采用任一方内容。没有历史正文基线，因此不自动执行三方合并。保存使用原子写入，并检查打开比较后双方快照是否变化；未清除冲突标记时不能保存或提交。仅支持不超过 2 MB 的 UTF-8 文本。备份副本保留供恢复，最终合并内容写入原文件，点击“保存并解决冲突”后自动提交同步。

合并编辑器的“保存并解决冲突”会原子保存原文件，检查远端版本并提交，成功后自动从冲突列表移除，无需再次确认；提交失败或远端有新变化则保留待办和已保存内容。

冲突列表支持逐项勾选、全选，再批量接受所选本地或远端版本。确认窗口说明覆盖和删除方向；逐项提交，成功项移出列表，失败项保留并显示原因。接受远端前备份被替换的本地内容，远端再次变化时拒绝覆盖并要求重新检查。

批量冲突操作会等待当前文件安全完成，并让全量扫描/后续传输让出执行机会；不使用不完整的远端清单作删除判断。窗口显示等待状态和逐项进度，关闭窗口不取消已经提交的任务。

## 增量同步索引

默认启用“增量同步索引”。首次同步扫描全部网盘目录，在插件数据目录生成原子保存、带校验和的 `remote-index.json`；后续先列出远端 `.baidu-sync-index-v1` 中的独立变更记录，只检查受影响目录。无变化时不递归列举笔记目录、不重新下载历史记录。仍读取本地文件内容计算哈希，避免仅凭时间戳漏掉改动。

- 批量上传共用分组变更记录（每组最多 200 个路径），不为每个文件额外生成一对记录；单文件实时同步单独登记。
- 先成功发布 begin 记录，才允许上传或删除原文件；最后发布 done。中断留下的 begin 会在每轮复查真实远端状态。记录不是“文件已删除”的依据：删除前重新查询真实目录，并比较同步基线。
- 两台设备使用随机独立记录名，不覆盖同一个总 JSON。上传失败、记录发布失败、目录响应异常或索引校验失败均不会推进不可靠状态；本地检查点继续使用原子写入。
- 增量轮次中，已跟踪文件删除且另一端未修改时，自动同步删除；本地删除进入回收站。修改/删除冲突、首次同步和完整校验发现的删除继续人工确认，已有冲突不会被自动清除。
- 每 24 小时完整校验一次；命令面板“完整校验网盘并同步（重建增量索引）”或设置中的“立即完整校验”可主动执行。索引损坏、历史记录被修改或移除时回退完整校验，绝不拿不完整清单判定删除。
- 直接在百度网盘或未升级的客户端中修改不会生成记录，需要完整校验才能全部发现。使用此模式的设备应都升级；覆盖前仍重新查询目标的真实远端版本。百度普通文件覆盖接口不提供跨设备条件写入锁，这套索引不承诺将同一文件的并发编辑自动合并。
- 远端控制目录不当作笔记同步，索引与记录中不保存令牌或密码。当前不自动清理记录，避免离线设备漏掉历史变化；记录积累较多时列举成本会随之增长。

新增测试涵盖两份独立知识库共享同一远端的新增、修改、删除、修改/删除冲突、无变化请求数、并发记录、索引损坏、未完成提交、索引丢失、强制校验与失败回退。

一次真实网盘只读验证（2026-10-19，2,124 个文件）：首次完整索引 123 次请求、54.7 秒；紧接的无变更检查 1 次请求、0.3 秒。该数字仅包含远端索引检查，不包含本地哈希扫描或文件传输；不同网络与目录规模会影响耗时。可用 `node tests/index-live-readonly.cjs /absolute/path/to/plugin/data.json /absolute/path/to/vault` 复测，须先安全停止在途同步；此诊断不写入网盘，只原子保存本机索引。
