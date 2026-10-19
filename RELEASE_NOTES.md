## 1.0.8 安卓防闪退分片拉取、相同内容冲突自动消解与独立并发设置

- **安卓端超大文件分片流式下载（彻底解决 OOM 闪退）**：
  - **排查根因**：通过 ADB 系统日志深入定位，安卓版 Obsidian 运行于 Capacitor 容器，调用原生 `requestUrlAndroid` 拉取大文件（如 60MB+ 的 PDF 或音视频）时，Java 堆分配 Base64 字符串会瞬间突破安卓 Dalvik/ART 虚拟机的 256MB 堆内存硬上限，引发 `java.lang.OutOfMemoryError` 并导致系统发送 `SIG 9` 强制闪退。
  - **核心修复**：重构底层 `downloadFile` 实现，对超大文件采用 HTTP `Range: bytes=start-end` 4MB 分片流式拉取，各分片在 Java 层内存仅占 ~20MB 并即时回收，最后在 JavaScript V8 原生内存高效拼接。真机实测 60.93MB 大文件 25.4 秒稳定拉取无闪退。
- **相同内容冲突自动消解与冗余副本清理**：
  - 解决因手机文件系统与百度网盘修改时间戳（mtime）存在秒级偏差导致实质内容相同的文件反复被判为冲突的问题。
  - 改用 MD5 内容哈希（`sameFileContent`）判定：同步启动时自动巡检历史冲突，若两端哈希相同立即自动标记为已解决、更新基准线并静默清理冗余的 `.conflict-...` 副本文件，告别人工繁琐确认。
- **有界并发下载与写盘防覆盖安全防线**：
  - 下载通道支持 1~3 有界并发（`runBounded`），显著提升多文件拉取速度。
  - 增加下载落盘前本地文件二次哈希复核：若排队等待期间本地发生了编辑，立即阻断覆盖并升级至冲突安全保护，绝不覆盖用户最新编辑。文件写盘继续采用 `AtomicFileSystem` 事务日志与互斥锁，确保原子落盘与断网自愈。
- **独立设置上传与下载并发数**：
  - 设置面板中将「上传并发数」与「下载并发数」正式拆分为独立选项（1~3 自由调节），手机端建议保持 1~2 并发以兼顾省电与内存稳定。

## 1.0.7 移动端前台亮屏提醒与网络异常指引

- **移动端前台亮屏注意事项**：进度弹窗与设置面板中增加明确指引，提醒用户在全量同步期间保持手机亮屏并停留在 Obsidian 前台，切勿锁屏息屏或切出后台（Android 系统电池省电策略在休眠时会切断网络，引发 `UnknownHostException` 域名解析失败）。
- **友好网络错误诊断**：对网络断开、超时及系统域名解析失败自动解析并给出排查建议（检查 WiFi/网络、关闭科学上网代理或系统专用 DNS）。
- **真机双向同步验证**：通过 Android 真机 ADB 实时连通性监控，实测通过 2700+ 项文件目录索引与文档附件传输。

## 1.0.6 安卓可见同步进度

- 手机手动同步自动打开详情，收起保留底部进度卡片，不依赖桌面状态栏。
- 显示当前阶段已完成/总文件数、耗时、当前文件、上传/下载/跳过/冲突/失败数量和最近记录。
- 设置新增“查看进度”，新增命令“查看百度同步进度”。关闭面板不会取消同步，重复点击手动同步复用当前任务。
- 进度按当前阶段文件数量计算，不虚构整体字节百分比；目录扫描没有计数时显示不定进度。
- 类型检查及生产构建通过，未执行真实网盘同步测试。

## Unreleased — Concurrent uploads, delta sync, and manual conflict review

### Added

- Configurable 1–3 upload workers for independent files, defaulting to three.
- Unchanged-content local saves skip network requests; unchanged full syncs skip directory creation and baseline rewrites. Sync summaries report skipped files.
- Persistent, human-reviewed conflicts with notices, status-bar count, settings/command entry points, original/remote snapshot links, refresh, and explicit resolution confirmation.
- Delete-versus-edit conflicts also await human review. Pending originals and snapshot copies are excluded from automatic sync; remote changes invalidate stale confirmation.

### Fixed and preserved

- Correct precreate return types and required-block handling; fix create error 31500.
- Let Obsidian calculate multipart Content-Length; fix ERR_INVALID_ARGUMENT.
- Serialize token refresh and atomic state checkpoints; stop dispatch and drain in-flight workers on checkpoint failure.
- Preserve per-file upload order, full/incremental sync isolation, local atomic replacement, and crash recovery. Hash actual uploaded bytes and recheck local content after queuing.
- Older automatic winner preferences no longer apply; original files are not overwritten merely to clear conflicts.

### Validation and upgrade

- TypeScript, production build, 104 reliability assertions, concurrency, delta and upload-protocol tests pass.
- Four real Baidu trials: serial 11.747/14.470s versus three workers 5.299/3.531s (about 2.97× by mean); 36 files and a separate multi-part file verified byte-for-byte after download.
- Wait for active sync to finish before reloading the updated plugin. Preserve credentials and existing sync state. Legacy conflict copies remain local; they are not retroactively assigned invented conflict baselines.
- Per-file atomicity is retained; this is not a vault-wide or cross-device transaction. This commit does not publish a release or change the release version.

## 1.0.4

- Address the community scanner UI errors: use Setting headings and CSS classes for settings and modal layouts.
- Keep dynamic pairing controls hidden until generation completes and use severity classes for log colors.
- Clarify desktop-only setup help; includes English documentation and all reliability fixes from 1.0.2.
- Typecheck, 71 reliability assertions, and production build pass.

Requires desktop Obsidian 1.14.4+. Community directory automated review is in progress.
