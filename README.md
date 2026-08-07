# Cursor-zh

Cursor-zh 是一个用于汉化 Cursor 编辑器界面的本地工具。它通过修改 Cursor 安装目录中的前端资源文件，将部分英文界面文案替换为中文，并同步修复 Cursor 的文件校验信息，尽量避免出现"安装已损坏"等提示。

> ⚡ **性能**：整体汉化仅需 **约 3 秒**（40MB+ 主文件），短词替换阶段 **0.27 秒**（较旧实现提速 99%）。详见[性能优化](#性能优化)。

> 注意：本工具不是 Cursor 官方项目，也不会修改 Cursor 的账号、模型、插件、项目代码或云端配置。它只处理本机已安装 Cursor 的应用资源文件。

## 致谢

本项目基于 [rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese) 改进，感谢原作者的工作。在此基础上进行了以下增强：

- **大幅扩充翻译词典**：新增 500+ 条 UI 文案翻译，覆盖 Agents 窗口、浏览器工具、聊天操作、Automations、设置页等新版界面。
- **增强替换引擎**：新增作用域替换（scoped replacements）、辅助窗口替换（auxiliary interface replacements）和顽固词条正则（tricky regex），精确处理动态模板字符串、三元表达式和编译后变量名。
- **短词保护机制**：引入 `isProtectedKeybindingContext` 检测，避免在键盘扫描表、VK 键名等代码上下文中误替换短词，防止白屏。
- **Glass 窗口独立处理**：针对 Cursor 新版拆分的 `workbench.glass.main.js` 独立 bundle，实现与主窗口一致的替换能力。
- **Electron 主进程支持**：新增 `out/main.js` 处理路径，覆盖系统托盘菜单和更新提示等原生界面。
- **移除 `keys.json`**：将辅助数据合并入 `dict.js`，简化项目结构。
- **性能优化**：合并大正则 + 预编译 + 预检跳过，短词替换阶段从 37 秒降至 0.27 秒（提速 99%）；界面片段替换从逐条扫描 ~3500 次合并为 2 次大正则扫描，整体汉化耗时从约 40 秒降至 3 秒以内。详见下文[性能优化](#性能优化)。
- **健壮性增强**：备份文件增加版本检测，Cursor 升级后自动更新备份避免版本降级；写入采用原子复制策略避免数据丢失窗口；附加功能（扩展翻译、存储翻译）失败不中断核心汉化。
- **用户存储翻译**：通过 SQLite 操作 `state.vscdb`，翻译动态加载的 Agents 模式描述与模型参数定义（`Thinking intensity` → `思考强度` 等）。
- **参数名显示层映射**：在模型转换函数注入映射，即使 Cursor 启动后服务端刷新模型配置将数据覆盖回英文，界面仍显示中文，避免"汉化后过一会儿恢复英文"。
- **用户扩展翻译**：自动翻译远程开发扩展（remote-ssh/remote-wsl/remote-containers）的命令面板文本。

## 它解决什么

Cursor 的官方界面中仍有不少英文文案，尤其是设置页、Agent 运行状态、工具调用状态、套餐与用量、MCP、Hooks、权限、沙盒和新版本新增界面。本工具用于：

- 将 Cursor 常见英文 UI 文案替换为中文。
- 补充 Cursor 新版本中遗漏或新增的英文界面。
- 支持一键汉化和恢复英文原版。
- 自动备份原始资源文件，便于回退。
- 自动更新 `product.json` 校验值，减少"安装已损坏"提示。
- macOS 下自动清理隔离属性并重新签名，减少系统拦截。

## 支持平台

- Windows：支持常见的 Cursor 用户目录安装和 Program Files 安装路径。
- macOS：支持 `/Applications/Cursor.app` 和用户目录下的 `Applications/Cursor.app`。
- Linux：支持常见的 `/opt/Cursor`、`/usr/share/cursor`、`/usr/lib/cursor`、`~/.local/share/cursor` 等安装路径；如果使用 AppImage 或非标准路径，建议手动指定 `resources/app`。
- Cursor 更新后，官方资源文件会被覆盖，需要重新运行本工具。
- Cursor 大版本更新后，如果出现新英文或结构变化，需要更新词库或核心替换规则后重新编译。

## 使用方式

需要 Node.js 18 或更高版本。

> ⚠️ **重要：运行汉化前请先完全退出 Cursor**（包括托盘和后台进程）。工具会修改 `state.vscdb` 用户存储，检测到 Cursor 正在运行时会跳过该步骤，导致模式下拉、模型参数（如 Thinking intensity）等动态内容无法汉化。

安装依赖：

```bash
npm install
```

启动交互式菜单：

```bash
npm start
```

运行后按提示选择：

- `一键汉化`：修改 Cursor 资源文件并应用中文。
- `恢复英文`：从 `.backup` 备份恢复原始文件。
- `退出`：关闭工具。

也可以通过命令行静默执行，适合脚本或 CI 场景：

```bash
# 汉化
node index.js --action=translate --cursor-path="/Applications/Cursor.app/Contents/Resources/app"

# 恢复英文
node index.js --action=restore --cursor-path="/Applications/Cursor.app/Contents/Resources/app"
```

## 工作逻辑

工具运行时大致按以下步骤执行：

1. 定位 Cursor 安装目录。
   - 优先使用命令行传入的 `--cursor-path`。
   - 其次使用已保存的配置。
   - 最后自动扫描常见安装路径。

2. 生成待处理文件路径。
   - `out/vs/workbench/workbench.desktop.main.js`（主窗口）
   - `out/vs/workbench/workbench.glass.main.js`（Glass / Agents 窗口，新版 Cursor 独有）
   - `out/nls.messages.json`（原生菜单与提示文案）
   - `out/vs/code/electron-sandbox/workbench/workbench.html`
   - `product.json`

3. 创建原始备份。
   - 首次运行会生成 `.backup` 文件和 `.backup.meta` 版本元数据。
   - 再次运行时保留已有备份，避免把已汉化文件覆盖成备份。
   - Cursor 升级后版本变化时，自动更新备份为新版原版，避免还原导致版本降级。

4. 执行汉化替换。
   - `src/dict.js` 保存三类词典：`safeGlobalDict`（安全长句）、`nativeNlsDict`（原生 NLS 菜单）、`riskyShortWords`（需上下文保护的短词）。
   - `src/i18n-core.js` 按以下顺序分层处理：安全长句大正则替换 → 裸文本长句替换 → 作用域精确替换（scoped） → 顽固词条正则（tricky） → 短词 UI 属性上下文替换（含键位表保护）。
   - 所有正则在模块加载时预编译，短词替换通过 3 个合并大正则单次扫描完成，`replaceStringWithCount` 内置 `indexOf` 预检跳过不匹配规则。
   - 对 `Read`、`file`、`Agent` 等高频短词，仅在 `children`、`title`、`label`、`placeholder` 等 UI 属性上下文中替换，并通过 `isProtectedKeybindingContext` 跳过键盘扫描表和 VK 键名等代码区域。

5. 写回 Cursor 核心 JS 文件。

6. 更新 `product.json` 中对应资源文件的 checksum。

7. macOS 下执行系统兼容处理。
   - 清理隔离属性：`xattr -cr`
   - 本地重新签名：`codesign --force --deep --sign -`

8. 翻译用户扩展。扫描 `~/.cursor/extensions/` 中的远程开发扩展（remote-ssh/remote-wsl/remote-containers），翻译其 `package.json` 中的命令面板标题和分类。失败时跳过，不影响核心汉化。

9. 翻译用户存储。通过 SQLite 操作 `state.vscdb`，翻译 `composerState.modes4` 中动态加载的 Agents 模式描述，以及 `availableDefaultModels2` 中的模型参数定义（如 `Thinking intensity`）。需 Cursor 已完全退出，失败时跳过。
10. 参数名显示层映射。在模型转换函数（`kR_`/`mSg`）注入参数名映射，保证界面常显中文，抵抗 Cursor 启动时服务端对模型配置的覆盖。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `index.js` | 命令入口、交互菜单、静默模式入口 |
| `src/platform.js` | 跨平台路径检测、配置保存、权限检查、提权执行 |
| `src/i18n-core.js` | 核心汉化、备份恢复、校验修复、macOS 签名处理 |
| `src/dict.js` | 安全词典（`safeGlobalDict`）、原生 NLS 词典（`nativeNlsDict`）、短词词典（`riskyShortWords`） |
| `src/storage.js` | 用户存储翻译（state.vscdb 中 Agents 模式描述与模型参数定义的 SQLite 操作，含参数定义汉化计数日志） |
| `scripts/package-release.js` | 打包脚本，生成压缩包和 SHA-256 校验文件 |

## 性能优化

针对 Cursor 的 `workbench.desktop.main.js`（约 38MB）和 `workbench.glass.main.js`（约 46MB），旧实现逐词循环扫描导致耗时约 37 秒。通过以下优化将短词替换阶段降至 0.27 秒，整体汉化耗时从约 40 秒降至 3 秒以内：

| 阶段 | 旧实现 | 优化后 | 提升 |
| --- | --- | --- | --- |
| 短词替换 | ~37 秒（573 次扫描） | 0.27 秒（3 次扫描） | **≈137x** |
| 界面片段替换 | ~3478 次扫描 | 2 次大正则扫描 | 大幅减少 |
| 整体汉化 | ~40 秒 | **< 3 秒** | **≈13x** |

核心手段：

- **合并大正则**：将 191 个短词的 3 类上下文（UI 属性赋值、JSX 文本节点、HTML 标签内文本）分别合并为 1 个大正则（`megaPropRegex`、`megaJsxRegex`、`megaHtmlRegex`），扫描次数从 573 次（191 × 3）降至 3 次，命中数完全一致。
- **界面片段大正则**：将 `scopedReplacements`（~1803 条）和 `auxiliaryInterfaceReplacements`（~1675 条）各自合并为 1 个大正则 + Map 查找表，扫描次数从 ~3478 次降至 2 次（主文件和 Glass 文件各 1 次）。按 key 长度降序排列确保长串优先匹配。
- **正则预编译**：所有正则在模块加载时一次性构建并缓存（`safeMegaRegex`、`megaPropRegex` 等），替换阶段直接复用，避免重复 `new RegExp` 开销。键位表保护检测的 `getProtectedRegexes` 也使用 `Map` 缓存按短词惰性构建。
- **字符串预检跳过**：`replaceStringWithCount` 在替换前先做 `indexOf` 预检，不包含目标字符串时直接返回，避免对 38MB+ 文件执行无谓的 `split`/`join` 操作。
- **长句优先匹配**：安全长句按长度降序排列构建正则，确保 "Close All" 优先于 "Close" 匹配，既保证正确性又减少后续短词阶段的工作量。
- **轻量进度条**：TTY 模式下原地刷新进度，非 TTY 模式仅输出阶段完成行，避免日志文件刷出大量重复行。

## 配置与备份

工具会在用户目录保存 Cursor 路径配置：

```text
~/.cursor-zh/config.json
```

工具会在 Cursor 安装目录旁生成备份文件和版本元数据：

```text
workbench.desktop.main.js.backup
workbench.desktop.main.js.backup.meta    # 记录 Cursor 版本号，用于升级检测
workbench.html.backup
product.json.backup
```

恢复英文时会优先使用这些备份文件，还原后自动删除备份和元数据，下次汉化重新创建。

## 权限说明

如果 Cursor 安装目录当前用户可写，工具会直接执行。

如果没有写入权限：

- Windows/macOS 会尝试通过 `sudo-prompt` 请求管理员权限。
- Linux 桌面环境如果支持系统提权提示，也会尝试请求管理员权限；如果提权不可用，请用 `sudo` 运行工具或手动指定用户可写的 Cursor 安装路径。
- 提权后会重新运行同一个工具，并带上当前选择的操作参数。

本工具不会主动上传文件、代码或用户数据。它的网络行为主要可能来自安装依赖或打包工具下载基础运行时；日常汉化流程本身不需要联网。

## 常见问题

### 汉化后没有变化

请确认：

- 已完全退出并重启 Cursor。
- 选择的是当前正在使用的 Cursor 安装目录。
- Cursor 更新后是否覆盖了资源文件，必要时重新运行汉化。

### 提示 Cursor 安装已损坏

本工具会尝试自动更新 `product.json` checksum。若仍出现提示，可以：

- 关闭 Cursor 后重新运行汉化。
- 使用"恢复英文"回退后再汉化。
- 检查是否被系统权限或安全软件阻止写入。

### macOS 提示无法打开或已损坏

工具会自动执行 `xattr` 和 `codesign`。如果仍失败，可以手动执行：

```bash
xattr -cr /Applications/Cursor.app
codesign --force --deep --sign - /Applications/Cursor.app
```

### Cursor 更新后英文又出现

Cursor 更新会覆盖已修改的资源文件。重新运行本工具即可。如果新版本增加了新的英文文案，需要补充词典或核心替换规则。

### 模型参数（如 Thinking intensity）汉化后过一会儿恢复英文

Cursor 启动时可能从服务端刷新模型配置，覆盖 `state.vscdb` 中的参数名。本工具已通过显示层映射解决：在模型转换函数（`kR_`/`mSg`）注入参数名映射，即使数据被覆盖回英文，界面仍显示中文，无需重复汉化。

### 可以恢复官方英文吗

可以。运行工具后选择"恢复英文"，或执行：

```bash
node index.js --action=restore --cursor-path="/Applications/Cursor.app/Contents/Resources/app"
```

## 创建问题与反馈

如果发现漏翻、误翻或运行失败，建议提交问题时附带以下信息：

- 操作系统和架构，例如 macOS arm64、macOS x64、Windows x64。
- Cursor 版本号。
- 执行命令和完整报错日志。
- 漏翻界面的截图。
- 如果是漏翻，尽量提供英文原文。

不要在公开问题中粘贴账号 Token、API Key、公司私有代码、日志中的敏感路径或内部项目内容。

## 开发说明

安装依赖：

```bash
npm install
```

检查语法：

```bash
node --check index.js
node --check src/i18n-core.js
node --check src/platform.js
node --check src/dict.js
```

本地运行：

```bash
npm start
```

如需构建各平台预编译产物（可选）：

```bash
npm run build          # 全部平台
npm run build:win      # 仅 Windows
npm run build:mac      # 仅 macOS
npm run build:linux    # 仅 Linux
npm run build:release  # 构建 + 打包发布压缩包和校验文件
```

## 安全边界

本工具会修改 Cursor 应用安装目录中的资源文件，因此建议：

- 使用前先退出 Cursor。
- 保留 `.backup` 文件，方便恢复。
- 从可信来源获取工具或自行从源码构建。
- 不要把未知来源的二进制文件放到生产或敏感环境中直接运行。

## 贡献

欢迎提交 Issue 和 Pull Request。如果是漏翻或误翻，请附上英文原文和界面截图。参与贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目使用 MIT License。详见 [LICENSE](LICENSE)。本项目基于 [rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese)（MIT License）改进。
