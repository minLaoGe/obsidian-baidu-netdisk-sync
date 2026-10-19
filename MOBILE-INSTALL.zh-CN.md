# Android / iOS 手机安装与同步

使用 Obsidian 1.14.4 或以上版本。将 main.js、manifest.json、styles.css 放入手机知识库的 .obsidian/plugins/baidu-sync/，然后在社区插件中启用 Baidu Sync Safe。iOS 可先在电脑准备插件目录，再将文件传入手机知识库；传入后重新加载插件。

手机默认开启手动同步模式。通过插件设置的“立即同步”按钮或命令面板开始。同步期间会持续显示阶段和文件进度；结束或失败后保留提示 8 秒。同步时请务必保持 Obsidian 在前台亮屏，切勿息屏或切换后台（系统休眠会切断网络导致 UnknownHostException 域名解析失败）。若遇网络中断，请检查代理分流或私人 DNS，保持亮屏后再次点击同步。

建议使用电脑生成的加密配对码导入账号配置。无法使用剪贴板时，长按配对码手动复制。每台设备使用相同的远端目录和加密密码。

首次迁移仅传入插件文件及账号配置，不复制其他设备的 sync-state.json、remote-index.json、transactions。每台设备应建立自己的同步基线。插件、主题与隐藏配置同步默认关闭。

Android 和 iOS 都使用 Obsidian DataAdapter 进行文件读写，通过备份、内容校验及事务日志支持失败恢复。桌面原生文件系统接口只在桌面端加载。移动端不承诺桌面文件系统同级原子替换能力。

验证情况：Android 真机已观察到上传成功；Android/iOS 平台模拟、无 Node.js 模块加载、手动模式、进度提示与回归测试通过。iOS 真机启动、配对、上传下载及中断恢复仍待验证。
