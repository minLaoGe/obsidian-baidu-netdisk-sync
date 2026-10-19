# 更新日志与问题排查解决指南 (Changelog & Technical Guide)

本文档详细记录了 `obsidian-baidu-netdisk-sync` 各版本的更新记录、重大问题排查根因分析（Root Cause Analysis）以及底层技术解决方案。

---

## 📌 版本 1.0.8 (2026-10-20)

### 1. 核心解决的问题：安卓端大文件拉取闪退 (Crash / SIG 9)
- **现象**：在手机端执行同步时，应用无任何弹窗错误直接退回桌面（闪退）。
- **根因分析 (ADB Logcat)**：
  通过 Android 开发者调试协议抓取系统崩溃日志（PID 12902）：
  ```text
  FATAL EXCEPTION: pool-43-thread-1
  Process: md.obsidian, PID: 12902
  java.lang.OutOfMemoryError: Failed to allocate a 170368280 byte allocation with 47442608 free bytes and 45MB until OOM, target footprint 268435456, growth limit 268435456
      at java.lang.StringFactory.newStringFromBytes(StringFactory.java:98)
      at java.lang.StringFactory.newStringFromBytes(StringFactory.java:79)
      at android.util.Base64.encodeToString(Base64.java:459)
      at com.capacitorjs.plugins.app.AppPlugin.requestUrlAndroid(...)
  Process 12902 exited due to signal 9 (Killed)
  ```
  **技术原因**：
  安卓版 Obsidian 基于 Capacitor 容器构建。在下载大于 30MB~60MB 的大文件（如 60.94MB 的 PDF 文档）时，调用原生的 `requestUrlAndroid`。Java 原生层为了将二进制响应通过桥接通道传给前端 WebView，会将字节流转换为 Base64 字符串：
  `60.94MB 原始字节` $\rightarrow$ `85.2MB Base64 字节` $\rightarrow$ `170,368,280 字节（Java UTF-16 String 字符串）`。
  安卓 ART 虚拟机对单个 App 设置了 `256MB` 堆内存硬限制（`growth limit 268435456`），瞬时内存需求超 310MB，导致 Dalvik/ART 抛出未捕获的 `OutOfMemoryError`，应用被系统发送 `SIG 9` 强制杀死。
- **技术解决方案**：
  - 重构底层 `BaiduClient.downloadFile`：对超大文件采用百度网盘支持的 **HTTP Range 4MB 分片流式拉取**。
  - 每次跨桥请求仅传输 4MB 分片，Java 堆临时对象仅占 ~20MB 并即时由 GC 回收。
  - 前端在 JavaScript V8 原生内存分配 `Uint8Array` 连续空间拼接各分片，不占用安卓 Java 堆。
- **验证结果**：
  在真实三星 S24 Android 手机上对 **60.93 MB** PDF 文件进行真机实测，在 25.4 秒内平稳下载完成，进程稳定，无任何内存暴涨或闪退。

---

### 2. 核心解决的问题：实质相同内容的文件反复冲突
- **现象**：多端同步时，两边文件文字一模一样，但每次同步仍然弹出冲突警告，并生成大量 `.conflict-...` 冗余副本。
- **根因分析**：
  旧版逻辑使用 `sameFileVersion` 比对修改时间戳（`mtime`）。由于安卓本地文件系统（EXT4/F2FS）与百度网盘服务器的文件修改时间存在秒级偏差或舍入误差，导致实质内容完全相同的文件被误判为不同版本。
- **技术解决方案**：
  - 弃用单纯的时间戳强校验，全面改用 MD5 内容哈希（`sameFileContent`）。
  - **同步前置自愈（Step 0）**：在每次全量同步启动前，自动巡检挂起的历史冲突列表。若本地文件已与远端或冲突副本哈希一致，立即自动标记为已解决、更新同步基准线，并自动安全清理冗余的 `.conflict-...` 副本文件。
  - **下载判定自愈**：在下载排队与合并流程中，若两端哈希一致，直接作为 `noop`（无变更）处理，静默合并基准，不再弹窗打扰用户。

---

### 3. 功能增强：有界并发与防覆盖安全检查
- **独立配置上传与下载并发数**：
  - 设置面板中将「上传并发数」与「下载并发数」正式解耦为两个独立控制项（1~3 可调）。
  - 手机端默认推荐保持 1~2 并发，电脑端可开启 3 并发跑满速度。
- **排队期间防覆盖二次哈希复核**：
  - 在并发多文件下载时，文件在排队等待期间若被用户在本地编辑过，下载完成落盘前会自动重新读取本地文件进行哈希比对。
  - 检测到本地已发生编辑，即刻阻断覆盖并升级至安全冲突分支，绝不静默覆盖本地最新修改。

---

## 📌 版本 1.0.7 (2026-10-19)

### 1. 核心解决的问题：手机端同步停滞与 UnknownHostException 报错
- **现象**：手机端全量同步进行到数分钟时突然停滞，随后报错：
  `UnknownHostException: Unable to resolve host "pan.baidu.com": No address associated with hostname`。
- **根因分析 (ADB CDP 抓包)**：
  通过 Chrome DevTools Protocol（CDP）端口 9223 审查手机端 Obsidian 运行时状态：
  首次冷启动全量同步时由于遍历两千余项文件，持续时间较长；当用户离开手机或手机息屏后，Android 系统的电池优化管理（Doze Mode / App Standby）立刻切断了 Obsidian 的后台网络访问权限，导致 DNS 模块无法解析百度域名。
- **解决方案与指引**：
  - 在移动端同步进度面板与设置页面中加入醒目的前台亮屏提醒：全量同步期间请保持屏幕常亮并停留于 Obsidian 前台。
  - 增加网络异常自诊断与友好错误提示（科学上网分流与系统专用 DNS 提示）。

---

## 📌 版本 1.0.6 (2026-10-19)

### 1. 功能新增：移动端专属可见同步进度看板
- **特性**：
  - 手机端点击手动同步后，自动唤起可视化的进度卡片。
  - 实时显示当前同步阶段、处理进度（已完成/总文件数）、耗时、当前处理路径、各项计数器（上传/下载/跳过/冲突/失败）。
  - 支持最小化为底部浮动进度条，关闭卡片不会中断后台同步任务。

---

## 📌 架构设计与数据安全保障原则

1. **两阶段提交原子文件系统 (2-Phase Commit AtomicFileSystem)**：
   所有本地落盘操作必须经过 `.new` 临时文件与 `.old` 备份文件的事务记录；若发生意外断电或闪退，下次启动时自动根据日志回滚或提交，绝不留下损坏的半截文件。
2. **基准线保守推进原则 (Fail-Closed Baseline)**：
   只有当文件成功传输且本地安全落盘校验通过后，`sync-state.json` 才会记录该文件的最新基准。任何步骤出错，该文件基准保持不变，下次同步自动无感重试。
3. **有界并发防风控机制**：
   并发数严格限制在 1~3，避免触发百度网盘 OpenAPI 的 `errno: 31034` 频率风控与 IP 临时封禁。
