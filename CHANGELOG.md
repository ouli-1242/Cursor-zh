# Changelog

## Unreleased

### 改进

- 大幅扩充翻译词典（`safeGlobalDict`），新增 500+ 条 UI 文案，覆盖 Agents 窗口、浏览器工具、聊天操作、Automations、设置页、更新渠道名称等新版界面。
- 新增 `nativeNlsDict` 原生 NLS 词典，覆盖 `nls.messages.json` 中的菜单项、窗口标题和加载状态。
- 新增 `riskyShortWords` 短词词典，仅在 UI 属性上下文（`children`、`title`、`label`、`placeholder` 等）中替换，避免误伤代码逻辑。
- 新增 `isProtectedKeybindingContext` 检测，跳过键盘扫描表、VK 键名和 KeyCode 枚举等代码区域。
- 新增作用域替换（`scopedReplacements`）和辅助窗口替换（`auxiliaryInterfaceReplacements`），精确处理动态模板字符串、三元表达式和编译后变量名。
- 新增顽固词条正则（`trickyReplacements`），处理带标点、特殊转义、单双引号混用的复杂长句。
- 新增 `workbench.glass.main.js` 独立处理流程，覆盖新版 Cursor Glass / Agents 窗口中的独立界面文案。
- 新增 Electron 主进程文件（`out/main.js`）处理路径，覆盖系统托盘菜单和更新提示。
- 将 `heading` 属性加入 UI 属性列表，覆盖命令面板分区标题的短词替换。

### 变更

- 移除 `keys.json`，将辅助数据合并入 `src/dict.js`。
- 移除 `dist/` 目录下的编译产物，改由 GitHub Release 分发。
- 更新 README 和 LICENSE，补充原项目归属说明。
- 项目更名为 `Cursor-zh`（npm 包名 `cursor-zh`），配置目录改为 `~/.cursor-zh/`。

## 1.0.7 - 2026-07-22

### 改进

- 补充 Windows 原生菜单的汉化，覆盖文件、编辑、选择、视图、转到、运行、终端和帮助。
- 补充 Automations 页面、Agents 欢迎页、窗口恢复和聊天编辑器标签页等新版界面文案。
- 重新生成 Windows x64 发布包并更新 SHA-256 校验值。

### 修复

- 修复 `nls.messages.json` 中带助记符菜单项未命中短词翻译的问题。
- 修复 Automations 侧栏和动态导航标题因编译后模板结构变化而保留英文的问题。

## 1.0.6 - 2026-07-20

### 改进

- 完善新版 Cursor Glass 设置侧栏汉化，覆盖浏览器与网络、Git 与 PR、工具与 MCP、个人资料、自定义、开发者等分类。
- 补充 Agents 设置页的对话、上下文与工具、执行与审批、网络搜索工具，以及 macOS `Command + Enter` 提交相关提示汉化。
- 补充索引设置的动态文件数量提示，并优化中文语序。
- 补充外观设置汉化，覆盖系统配色、浅色/深色主题、主题管理、动态效果和减少动画等选项。

### 修复

- 修复 Glass 独立窗口未复用主窗口动态模板替换规则，导致部分设置项重新显示英文的问题。
- 修复不同 Cursor 版本中快捷键符号和索引阈值动态渲染时无法命中汉化规则的问题。

## 1.0.5 - 2026-07-16

### 改进

- 新增 `nls.messages.json` 处理，覆盖扩展变更提示、重新加载窗口等原生提示文案，并纳入备份和一键恢复流程。
- 补充新版 Agents 设置页的代码块换行、语音提交关键词、探索子智能体模型、忽略文件、已配置钩子等文案汉化。
- 补充 AWS Bedrock 配置页的部署名称、访问密钥、测试模型和团队权限说明汉化。
- 补充 Glass 窗口二级菜单的分叉、复制、导出、固定、重命名、归档、在新窗口打开及链接复制等文案汉化。

### 修复

- 修复 `Extensions have been modified on disk`、`Reload Window` 等提示仍显示英文的问题。
- 修复短菜单词在上下文中遗漏或被全局替换误伤的风险，改为仅在界面属性位置精确替换。

## 1.0.4 - 2026-07-05

### 改进

- 新增 `workbench.glass.main.js` 处理，覆盖新版 Cursor Agents / Glass 窗口中的独立界面文案。
- 补充 Agents 窗口、仓库分组、输入框占位、拆分菜单、PR 偏好、忽略文件和多任务相关文案汉化。
- 新增 GitHub Release 打包脚本，macOS / Linux 发布为 `.tar.gz`，Windows 发布为 `.zip`。
- 生成 `SHA256SUMS` 校验文件，方便下载后核对发布包完整性。
- README 补充下载后显示为“文稿”的原因和处理方式。

### 修复

- 修复 macOS / Linux 裸二进制从 GitHub 下载后可能丢失可执行权限的问题。
- 修复新版 Cursor 中 `Repositories`、`Open Agents Window on startup`、`Plan, Build, / for skills, @ for context`、`Split Down` 和 `Split Right` 等遗漏英文。

## 1.0.3 - 2026-06-21

### 改进

- 调整终端启动界面风格，移除调侃式 Banner 和菜单文案。
- 将交互菜单简化为 `一键汉化`、`恢复英文` 和 `退出`。
- 补充 Rules、Skills、Subagents、Commands 二级菜单的空状态、加载失败、表单占位、保存按钮和错误提示汉化。
- 补充压缩资源中的 Rules 空状态兜底替换，覆盖 `No Rules Yet`、`Create rules to guide Agent behavior` 和 `New User Rule` 等未汉化文案。
- 重新生成 Windows、macOS、Linux x64 和 Linux arm64 成品。

## 1.0.2 - 2026-06-21

### 改进

- 将汉化过程中的随机提示文案改为进度条展示。
- 新增本次修改内容摘要，显示总修改数量、分类统计和部分命中文案。
- 备份提示增加文件名，便于区分正在处理的资源文件。
- 补充运行模式设置页汉化，包括审批与执行、运行模式、白名单和了解更多等文案。

## 1.0.1 - 2026-06-20

### 修复

- 补充 Agent 面板顶部 `New Agent` 的汉化。
- 补充聊天标签页更多菜单汉化，包括切换聊天面板、最大化聊天、关闭标签页、导出对话记录、复制请求 ID 和智能体设置等菜单项。
- 补充 Agent 搜索弹窗汉化，包括 `Search Agents...`、`No matching agents` 和 `Archived`。
- 补充输入框提示 `Plan, search, build anything` 及其悬浮提示汉化。

## 1.0.0 - 2026-06-20

首次正式发布 `Cursor-zh`。

### 新增

- 提供 Cursor 编辑器本地一键汉化能力，覆盖设置、Agent、工具调用、套餐与用量、MCP、Hooks、权限、沙盒等常见英文界面。
- 支持一键恢复英文原版，恢复时优先使用首次运行生成的原始备份文件。
- 支持自动定位 Cursor 常见安装路径，也支持通过 `--cursor-path` 手动指定 `resources/app` 目录。
- 提供 Windows、macOS 和 Linux 的预编译成品：
  - `cursor-zh-win-x64.exe`
  - `cursor-zh-macos-arm64`
  - `cursor-zh-macos-x64`
  - `cursor-zh-linux-x64`
  - `cursor-zh-linux-arm64`
- 新增 Linux 常见安装路径支持，覆盖 `/opt/Cursor`、`/usr/share/cursor`、`/usr/lib/cursor`、`~/.local/share/cursor` 等路径。

### 改进

- 将项目名称统一为 `Cursor-zh`。
- 自动更新 `product.json` 中资源文件 checksum，减少 Cursor 提示安装损坏的概率。
- macOS 下自动清理隔离属性并尝试重新签名，降低系统安全机制拦截概率。
- README 已补充使用方式、工作逻辑、解决的问题、创建问题说明和兼容性说明。
- 协议更新为 MIT。

### 注意

- 本工具不是 Cursor 官方项目，只修改本机 Cursor 应用资源文件，不会上传账号、项目代码、编辑器配置或其他个人数据。
- Cursor 更新后官方资源文件可能被覆盖，需要重新运行本工具。
- Cursor 大版本调整界面结构后，可能出现新的未汉化文案，需要继续更新词库或替换规则。
