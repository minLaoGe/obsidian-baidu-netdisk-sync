## 1.0.2

- Desktop file replacement uses native rename without deleting the target first, with verified backup/journal data and fsync before commit.
- Sync state uses the same recoverable transaction writer; failed saves can retry and corrupt state blocks sync.
- Recovery is restricted to journalled files in the plugin transaction directory; user .syncbak files are untouched.
- Fix encrypted conflict baselines and reject uploads when encryption is enabled without a password.
- Add 71 assertions covering crash snapshots, IO faults, corruption, state retries, encryption regressions, and actual Windows file replacement.
- Type checking and production build pass.

### Compatibility and limits

This release is desktop-only and requires Obsidian 1.14.4 or later. The name is now Baidu Sync Safe; the plugin ID remains baidu-sync.

Atomicity covers individual desktop file replacement on supported local filesystems. It does not provide a distributed transaction across files, sync metadata, and Baidu Netdisk, or guarantee zero data loss under arbitrary power failure. Mobile support is not released.

### 安装

从本 Release 下载 main.js、manifest.json、styles.css，放入知识库的 .obsidian/plugins/baidu-sync/ 目录，然后在第三方插件设置中启用 Baidu Sync Safe。官方社区收录尚需提交与审核。
