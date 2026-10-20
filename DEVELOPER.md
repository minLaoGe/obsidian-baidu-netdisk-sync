# Baidu Sync Safe — 开发者与底层技术文档 (Developer Guide)

> 本文档包含了 `obsidian-baidu-netdisk-sync` 的底层设计原理、算法决策、测试用例与开发基准测试指南。如需查看面向普通用户的安装与使用教程，请参阅 [README.md](./README.md)。

---

## English Technical Overview

An Obsidian plugin for desktop, Android, and iOS for bidirectional sync with Baidu Netdisk. Requires
**Obsidian 1.14.4+**, a Baidu Netdisk account, and a Baidu developer application.

- **Bounded transfers:** full sync uploads and downloads 1–3 independent files concurrently (configurable in settings). Each file retains ordered precreate, missing-block upload, and atomic commit.
- **Large file protection:** uses HTTP Range 4MB chunked streaming to prevent Android Capacitor Base64 OutOfMemoryError crashes.
- **Identical content auto-resolution:** files with matching MD5 hashes are automatically resolved and cleaned up without generating redundant `.conflict` copies.
- **Delta sync:** unchanged files are skipped. Identical-content local save events make no Baidu request. Full sync still checks the remote inventory for edits on other devices.
- **Human-reviewed conflicts:** for genuinely conflicting files, keep the local original and remote snapshot, persist a pending record, and pause that file until the user merges and confirms.
- **File safety:** existing atomic desktop replacement, verified backups, crash-recovery journals, serialized state checkpoints, and full/incremental sync isolation remain in place.
- **Optional encryption:** AES-256-GCM encryption and password-protected configuration transfer between devices.

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

## 中文技术设计与架构

### 核心安全架构

- **大文件防闪退分片拉取**：大文件（PDF/音视频等）采用 HTTP Range 4MB 分片流式拉取，避免触发安卓 Capacitor Base64 内存暴涨（256MB ART 限制），保障手机平稳不闪退。
- **相同内容冲突自动消解**：两端内容哈希（MD5）一致时自动标记解决，更新基线并自动清理冗余 `.conflict` 副本。
- **独立并发控制**：设置中支持分别配置「上传并发数」与「下载并发数」（1~3），兼顾传输速度与稳定性。
- **排队防覆盖安全检查**：下载落盘前复核本地内容哈希，若排队期间本地被编辑则自动升级为冲突保护，绝不静默覆盖最新笔记。
- **两阶段原子落盘**：`AtomicFileSystem` 事务文件保障断网不丢笔记、不损坏文件。

### 目录枚举与删除安全防护

Baidu `method=list` 忽略递归标志。插件显式枚举每个子目录，并在省略 `has_more` 时遵循完整分页。缺失子目录、畸形响应、重复分页和越界目录项会在应用任何计划前中止扫描。冷启动/审计删除等待人工确认。在经过验证的增量轮次（或本地变更事件）中，已跟踪删除仅在另一端版本仍与基准匹配时自动传播；修改/删除冲突保持人工处理。原子写锁在单个渲染进程内的模块副本之间共享；仅完全清理的过时日志项可被跳过，孤立负载保持被阻止并保留。“暂停所有同步”阻止全量、定时、本地变更同步及解决提交。

### 相同版本去重

生成冲突副本前校验实际内容与修改时间。内容哈希一致且修改时间在百度网盘的秒级精度下相同，则保留原文件并更新同步基线，不重复上传或创建冲突副本。时间缺失、时间不同或内容不同不适用此规则。对已登记冲突，点击“更新远端副本”重新校验；满足条件时清除待办，内容相同的重复副本移入本地回收站，修改过的副本保留。

冲突页面的“打开原文件/远端副本”在 Obsidian 内部标签页打开并聚焦笔记。原文件和副本均提供删除按钮，二次确认后移入本地回收站；此操作不修改网盘，也不会自动清除待处理状态。删除原文件后，需要另行明确确认提交，才会将删除同步到远端。

点击“比较并合并”可查看逐行增删 diff，在同一个编辑框中按 Git 风格冲突标记人工合并，或采用任一方内容。没有历史正文基线，因此不自动执行三方合并。保存使用原子写入，并检查打开比较后双方快照是否变化；未清除冲突标记时不能保存或提交。仅支持不超过 2 MB 的 UTF-8 文本。备份副本保留供恢复，最终合并内容写入原文件，点击“保存并解决冲突”后自动提交同步。

合并编辑器的“保存并解决冲突”原子保存原文件，检查远端版本并提交，成功后自动从冲突列表移除，无需再次确认；提交失败或远端有新变化则保留待办和已保存内容。

冲突列表支持逐项勾选、全选，再批量接受所选本地或远端版本。确认窗口说明覆盖和删除方向；逐项提交，成功项移出列表，失败项保留并显示原因。接受远端前备份被替换的本地内容，远端再次变化时拒绝覆盖并要求重新检查。

批量冲突操作等待当前文件安全完成，并让全量扫描/后续传输让出执行机会；不使用不完整的远端清单作删除判断。窗口显示等待状态和逐项进度，关闭窗口不取消已经提交的任务。

### 增量同步索引机制

默认启用“增量同步索引”。首次同步扫描全部网盘目录，在插件数据目录生成原子保存、带校验和的 `remote-index.json`；后续先列出远端 `.baidu-sync-index-v1` 中的独立变更记录，只检查受影响目录。无变化时不递归列举笔记目录、不重新下载历史记录。仍读取本地文件内容计算哈希，避免仅凭时间戳漏掉改动。

- 批量上传共用分组变更记录（每组最多 200 个路径），不为每个文件额外生成一对记录；单文件实时同步单独登记。
- 先成功发布 begin 记录，才允许上传或删除原文件；最后发布 done。中断留下的 begin 在每轮复查真实远端状态。记录不是“文件已删除”的依据：删除前重新查询真实目录，并比较同步基线。
- 两台设备使用随机独立记录名，不覆盖同一个总 JSON。上传失败、记录发布失败、目录响应异常或索引校验失败均不会推进不可靠状态；本地检查点继续使用原子写入。
- 增量轮次中，已跟踪文件删除且另一端未修改时，自动同步删除；本地删除进入回收站。修改/删除冲突、首次同步和完整校验发现的删除继续人工确认，已有冲突不被自动清除。
- 每 24 小时完整校验一次；命令面板“完整校验网盘并同步（重建增量索引）”或设置中的“立即完整校验”可主动执行。索引损坏、历史记录被修改或移除时回退完整校验，绝不拿不完整清单判定删除。
- 直接在百度网盘或未升级的客户端中修改不会生成记录，需要完整校验才能全部发现。使用此模式的设备应都升级；覆盖前仍重新查询目标的真实远端版本。百度普通文件覆盖接口不提供跨设备条件写入锁，这套索引不承诺将同一文件的并发编辑自动合并。
- 远端控制目录不当作笔记同步，索引与记录中不保存令牌或密码。当前不自动清理记录，避免离线设备漏掉历史变化；记录积累较多时列举成本会随之增长。

新增测试涵盖两份独立知识库共享同一远端的新增、修改、删除、修改/删除冲突、无变化请求数、并发记录、索引损坏、未完成提交、索引丢失、强制校验与失败回退。

一次真实网盘只读验证（2026-10-19，2,124 个文件）：首次完整索引 123 次请求、54.7 秒；紧接的无变更检查 1 次请求、0.3 秒。该数字仅包含远端索引检查，不包含本地哈希扫描或文件传输；不同网络与目录规模会影响耗时。可用 `node tests/index-live-readonly.cjs /absolute/path/to/plugin/data.json /absolute/path/to/vault` 复测，须先安全停止在途同步；此诊断不写入网盘，只原子保存本机索引。

### 本地哈希缓存与旧版本兼容

哈希映射使用独立的 `hash-cache-<scope>.json` 文件，不改变 `sync-state.json` 的 v1 基线格式、远端文件布局或变更日志协议。升级时保留已有基线，不要求清空缓存或重新同步全部文件。缺少 revision、localSize 或 conflicts 的旧基线也可读取。

旧版本忽略新增缓存文件，新旧设备可继续同步同一远端目录；旧版本不会获得哈希缓存加速。缓存只从本机成功上传或实际下载内容建立，不直接将历史基线当作内容验证证明。未知内容仍下载核对。降回支持原 v1 基线和日志协议的旧版无需转换该缓存；这不代表所有历史版本的其他功能或平台都兼容。

---

## 本地开发与调试

### 环境要求与构建流程

使用 Node.js 18+ 或 22 LTS：

```bash
# 安装依赖
npm ci

# TypeScript 静态类型校验
npm run typecheck

# 运行全套自动化测试 (10 个测试套件)
npm test

# 生产环境打包构建 (生成 main.js)
npm run build
```

### 真实网盘基准压测（可选）

> [!NOTE]
> 该命令会创建仅含随机测试内容的临时网盘目录，下载校验后删除，不改笔记或同步基线：

```bash
node tests/benchmark-live.cjs /absolute/path/to/plugin/data.json
node tests/benchmark-live.cjs /absolute/path/to/plugin/data.json --large-only
```

> [!CAUTION]
> 严禁将真实的插件 `data.json`、Access Token、AppSecret 或同步基线提交上传到公开代码仓库！

---

## 致谢与许可证

感谢 [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync) 对端到端加密与配置迁移设计提供的参考。

[MIT License](LICENSE)。
