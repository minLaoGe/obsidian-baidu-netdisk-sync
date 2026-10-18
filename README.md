# Obsidian 百度网盘高可靠同步插件 (Baidu Netdisk Sync)

为 Obsidian 量身打造的高可靠、多端双向同步插件。依托百度网盘大容量云存储，保障**严格时间顺序执行**、**全流程事务原子性**、**3-Way 冲突零丢失保护**，并支持**端到端零知识加密 (E2EE)** 与**多设备一键跨端快速配对**机制。

---

## 🌟 致谢

特别感谢社区优秀开源项目 [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync) 在端到端加密（E2EE）与多设备跨端配对设计上带来的启发与技术参考。

---

## 🚀 核心架构与功能特性

### 1. 严格时间顺序（Ordering Guarantee）
- **本地防抖缓冲池（Debounce Manager）**：在 Obsidian 中高频键入或自动保存时，通过可配置窗口（默认 3 秒）将多次修改合并为单次有效变更，杜绝打字期间高频发包引起的网络倒序与网盘接口频控。
- **严格 FIFO 串行异步执行队列**：确保对于任何文件与元数据，始终按产生的逻辑时间序列单调推进，消除并发交错。
- **全局同步互斥锁（Sync Mutex Lock）**：全量比对期间独占锁，防止手动连续点击或定时轮询与正在运行的增量任务重叠。

### 2. 全流程事务原子性（Atomicity Guarantee）
- **本地写入原子性（Atomic Local Write）**：
  从网盘拉取文件写入本地时，绝不直接向目标文件流式写入：
  1. 写入唯一命名的临时文件（`${path}.synctmp.${timestamp}`）；
  2. 校验写入后的临时文件大小与 MD5 哈希；
  3. 校验完全一致后，调用底层文件系统的原子替换（Replace / Rename）覆盖目标文件；
  4. 遇到异常或断电自动清理临时文件，确保旧版本完好无损，绝不留下损坏文件。
- **远端上传两阶段提交（Two-Phase Commit）**：
  结合百度网盘官方 OpenAPI 的分块预协商与秒传机制：`precreate` $\to$ 分块 `superfile2` $\to$ 最终 `create` commit，只有全部校验无误后网盘端才会生成新的文件节点。
- **状态持久化原子性**：
  `sync-state.json` 采用写临时文件 $\to$ JSON 格式校验 $\to$ 原子替换的持久化策略。

### 3. 三方差异冲突防护（3-Way Conflict-Safe Resolution）
基于【当前本地】、【当前网盘】、【上次成功同步基准（Base Snapshot）】进行三方对比：
- **本地修改，远端未变**：自动推送（Upload）。
- **远端修改，本地未变**：自动拉取（Download）。
- **两端并发修改且哈希不同（真实冲突）**：
  - **默认策略（安全分支副本）**：保留本地编辑内容原封不动，将远端冲突版本拉取并另存为 `${文件名}.conflict-${时间戳}.${扩展名}`，并在 Obsidian 界面弹出 Notice 提示，保证数据零丢失。
  - **可选策略**：支持在设置中切换为“以最新时间戳为准（keep_newer）”、“强制本地优先”或“强制远端优先”。

### 4. 工业级端到端加密（E2EE）
- 采用 Web Crypto API 原生实现的 **AES-256-GCM** 高级加密标准 + **PBKDF2**（600,000 次 SHA-256 哈希迭代）派生高强度密钥。
- 文件在离开本地设备前完成加密，网盘端仅存放密文，兼顾大容量同步与笔记隐私保护。

### 5. 跨设备一键快速配对（Multi-Device Fast Pairing）
- 电脑端授权成功后，点击 **“📤 导出加密配对码”**，设置临时 PIN 码，一键生成加密字符串。
- 手机/平板端安装插件后，点击 **“📥 导入配置配对码”**，粘贴并输入 PIN 码即可秒级完成组网，无需在移动端浏览器繁琐登录百度账号或申请开发者应用！

---

## 🛠️ 安装与使用

### 手动安装方式
1. 打开你的 Obsidian 知识库目录，进入 `.obsidian/plugins/`；
2. 新建文件夹 `obsidian-baidu-netdisk-sync`；
3. 将仓库构建出的 `main.js`、`manifest.json`、`styles.css` 放入该文件夹；
4. 在 Obsidian “设置 -> 第三方插件” 中刷新并启用 **Baidu Netdisk Sync**。

---

## 💻 本地构建开发

```bash
# 安装依赖
npm install

# 生产环境编译打包
npm run build

# 开发监听模式
npm run dev
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
特别感谢社区项目 [owl234/obsidian-baidu-netdisk-sync](https://github.com/owl234/obsidian-baidu-netdisk-sync)。
