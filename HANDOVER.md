# Cursor-zh 交接文档

> 写给接手维护 Cursor-zh 汉化工具的人。本文档涵盖项目架构、汉化机制、规则添加方法、已知坑位与未完成事项。

## 1. 项目是什么

Cursor-zh 是一个本地汉化 Cursor 编辑器界面的工具。它修改 Cursor 安装目录中的前端资源文件，将英文 UI 文案替换为中文，并修复文件校验值避免"安装已损坏"提示。

- 仓库: https://github.com/ouli-1242/Cursor-zh.git
- 运行: `npm start`（交互式）或 `node index.js --action=translate --cursor-path="D:\Program Files\cursor"`
- 恢复: `node index.js --action=restore --cursor-path="..."`

## 2. 项目结构

| 文件 | 职责 |
|---|---|
| `index.js` | 命令入口、交互菜单、路径解析、提权 |
| `src/platform.js` | 跨平台路径检测、权限检查、提权执行 |
| `src/i18n-core.js` | **核心汉化引擎**（最重要） |
| `src/dict.js` | 词典：`safeGlobalDict`（全局长句）、`nativeNlsDict`（原生 NLS）、`riskyShortWords`（需保护的短词） |
| `src/storage.js` | state.vscdb 用户存储补丁（SQLite） |
| `src/rule.dev.js`（若有） | 开发辅助 |

## 3. 汉化目标文件

Cursor 有两个窗口，各自独立 bundle，需分别处理：

- **glass** = `out/vs/workbench/workbench.glass.main.js` —— **Agents 窗口**
- **desk** = `out/vs/workbench/workbench.desktop.main.js` —— **IDE 主窗口**
- `out/nls.messages.json` —— 原生菜单/提示文案（nls 消息表）
- `out/main.js` —— Electron 主进程（托盘菜单）
- `product.json` —— 校验值

处理关系：
- **aux 数组**（`auxiliaryInterfaceReplacements`）→ 处理 glass
- **scoped 数组**（`scopedReplacements`）→ 处理 desk
- **tricky 数组**（正则）→ glass/desk 共用
- **safeGlobalDict / nativeNlsDict** → 全局长句 + nls 表

## 4. 汉化流程（translate 执行顺序）

1. 定位 Cursor 目录 → 生成文件路径
2. 备份（`.backup` + `.backup.meta` 版本元数据；Cursor 升级后自动更新备份）
3. 读 `workbench.desktop.main.js`，按顺序替换：
   - 安全长句大正则（safeGlobalDict）
   - 裸文本长句
   - scoped 数组（desk 专用精确替换）
   - tricky 正则（顽固词条）
   - 短词 UI 属性替换（riskyShortWords，带键位表保护 `isProtectedKeybindingContext`）
4. 写回 → 更新 product.json checksum
5. 处理 glass（aux 数组，同样流程）
6. 翻译 nls.messages.json
7. 翻译用户扩展（remote-ssh/wsl 等）
8. **storage.js 补丁**（state.vscdb，需 Cursor 已关闭）

## 5. 规则系统（如何添加翻译）

### 5.1 在 aux 数组（glass）或 scoped 数组（desk）加词条

```js
['英文原文', '中文翻译'],
```

用**精确字符串替换**（indexOf），长串优先匹配。找到英文在文件中的**确切形式**（含引号/属性名）再添加。

### 5.2 三种数组的选择

| 情况 | 放哪 |
|---|---|
| 词条只在 glass 出现 | aux 数组 |
| 词条只在 desk 出现 | scoped 数组 |
| 两边都有 | 两个数组都加 |
| 正则才能匹配（动态模板/转义） | tricky 数组 |
| nls 表词条 | dict.js 的 safeGlobalDict/nativeNlsDict |

### 5.3 关键原则

- **不要用裸短词通用替换**（如 `"Delete"`、"Keep"）：会污染键盘扫描表、代码比较（`e==="Delete"`）、键名表。用 UI 属性形式（`label:"Delete"`、`children:"Delete"`）或完整短语。
- **先查英文在文件里的确切形式**：用 `grep -o '.\{0,20\}英文.\{0,20\}'` 看上下文，确认是 UI 还是代码。
- **nls 索引词条**：`E(索引, fallback)` 或 `ft(索引, fallback)` 查表，若 nls 表未汉化则 fallback 英文 → 转字面量（直接替换整个表达式）。
- **长词优先**：aux/scoped 按长度降序匹配，先翻译长句，短词规则兜底。

## 6. 已知坑位（务必阅读）

### 6.1 Thinking intensity 被服务端覆盖

- 模型参数名（Thinking intensity）是**服务端下发**存于 state.vscdb 的 `availableDefaultModels2.parameterDefinitions.name`
- Cursor 启动时会从服务端刷新，**覆盖**本地补丁 → 显示回英文
- **解决方案（已实现）**：
  1. storage.js 补丁：翻译 state.vscdb 数据（需 Cursor 关闭）
  2. **显示层映射**：在 glass 的 `kR_` 函数、desk 的 `mSg` 函数注入代码，把 `parameterDefinitions` 里 name 为 "Thinking intensity" 的映射为"思考强度"（无论数据中英文都显示中文）
- **曾踩坑**：safeGlobalDict 里有 `"Thinking intensity": "思考强度"` 会**污染注入代码**（把注入的判断 `p.name==="Thinking intensity"` 也翻译成中文导致失效）。已移除该词条。**不要再把 "Thinking intensity" 加入 safeGlobalDict**。

### 6.2 storage.js 依赖 Cursor 关闭

- `isCursorRunning()` 检测 Cursor.exe，检测到运行则**跳过补丁**
- 运行汉化前必须完全退出 Cursor（含托盘）
- 补丁日志：`已汉化 X 个模式描述 + Y 个参数定义`

### 6.3 运行时动态文本（无法汉化）

以下内容不在任何代码文件，是 Cursor 运行时生成，**无法通过汉化触达**：
- `Current workspace: xxx`（状态栏 tooltip）
- `10 Files`、`11 Files`（输入框附件计数）
- `Server Error`（服务端错误横幅）
- `Search files, content, and symbols...`（命令面板提示）
- `View 9 More`、`Thought for 1s`（部分拼接）

### 6.4 短词污染风险

通用替换 `"Delete"`/`"Local"`/`"Resume"` 等会破坏：
- 键盘扫描表（`[1,82,"Delete",...]`）
- 代码比较（`e==="Skipped"`）
- 枚举/状态值

**必须**用 UI 属性形式（`label:`/`children:`/`title:`/`hintText:`）或完整短语。

### 6.5 glassOsEdit 编辑菜单

Agents 编辑菜单用 `title:E({key:"glassOsEditXXX",...}, "&&Undo")` nls 形式，nls 表无这些 key 翻译 → fallback 英文。已转字面量（`title:"撤销"` 等）。

## 7. storage.js 补丁细节

- 操作 `state.vscdb`（SQLite），key = `src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser`
- 翻译：
  - `composerState.modes4[].description`（Agent 模式描述）
  - `availableDefaultModels2[].parameterDefinitions[].name/markdownTooltip`（Thinking intensity 等）
- 依赖 Cursor 内置 node.exe（`resources/app/resources/helpers/node.exe`）或系统 node（需能加载 `@vscode/sqlite3`）
- 首次运行备份 `.zh-backup`（完整快照，作为字段级还原的英文原文来源）
- **restore 为字段级还原**：只从 `.zh-backup` 提取 modes4/参数定义的英文原文，改回 `applicationUser` 键内被汉化的字段；对话数据（`cursorDiskKV` 表、`composer.composerHeaders` 键）等其余数据一律不动，**不会丢失近期对话**。还原后删除 `.zh-backup`，下次汉化会重新备份英文原文
- 还原仅当"当前值 === 本工具的中文翻译"时执行，用户手动修改过的字段不会被覆盖
- 需要 `--app-path`（加载 @vscode/sqlite3）；`--db-path` 可覆盖数据库路径（测试/诊断）

## 8. 常用调试命令

```bash
# 汉化前先看英文在文件里的形式
grep -o '.\{0,20\}英文短语.\{0,20\}' "D:\Program Files\cursor\resources\app\out\vs\workbench\workbench.glass.main.js"

# 语法检查
node -e "require('./src/i18n-core.js'); require('./src/dict.js'); require('./src/storage.js')"

# 单独跑 storage 补丁（诊断）
node src/storage.js --action=translate --app-path="D:\Program Files\cursor\resources\app"

# 查 state.vscdb 参数状态
node -e "const path=require('path'),os=require('os');const sqlite3=require('D:/Program Files/cursor/resources/app/node_modules/@vscode/sqlite3');const db=new sqlite3.Database(path.join(os.homedir(),'AppData','Roaming','Cursor','User','globalStorage','state.vscdb'));db.get('SELECT value FROM ItemTable WHERE key = ?',['src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'],(e,r)=>{const s=r.value;console.log('Thinking intensity:',(s.match(/Thinking intensity/g)||[]).length,'思考强度:',(s.match(/思考强度/g)||[]).length);db.close();})"
```

## 9. 添加翻译的标准流程

1. 用户反馈截图/英文词条
2. 用 grep 在 glass/desk 找确切形式
3. 判断放 aux（glass）/ scoped（desk）/ dict / tricky
4. 检查有无短词污染风险（键名表/代码比较）
5. 添加规则 → `node -e "require('./src/i18n-core.js')"` 语法检查 → 验证命中
6. 提醒用户：**完全退出 Cursor** 后重跑汉化
7. 提交推送 GitHub

## 10. 当前状态（2026-08-08）

### 已覆盖
- Agents/IDE 大量菜单、按钮、状态词条（百余条）
- AI 操作动词状态对象（47 组 loading/completed）
- glassOsEdit 编辑菜单、命令面板、欢迎页、文件树、Git 面板、MCP 面板、搜索面板
- Thinking intensity 显示层映射（一次汉化生效）
- state.vscdb 参数定义补丁

### 未完成 / 待办
1. **未翻译 UI 清单**：`C:\Users\ouli\Desktop\未翻译UI清单.md`（高频 15 条、中频 230 条、低频 1804 条）——按需翻译
2. **运行时文本**（无法触达）：Current workspace、附件计数、Server Error 等
3. **View 9 More**：未定位到代码
4. `Explore` 等 loading 前缀（`loadingAction:` 字段）未全覆盖——用 `"Exploring"` 已补，但 `Explored tools` 等已完成
5. Cursor 更新后需重跑汉化；新版本结构变化需更新规则

## 11. 验证方法

- 用户跑汉化后**重启 Cursor** 观察
- 确认 Thinking intensity：开 Cursor 后等待，看是否保持"思考强度"（映射应保证）
- 出现英文：截图反馈 → 按第 9 节流程加规则
- 出现白屏/崩溃：检查是否规则污染了代码（键盘表/枚举），恢复英文重跑排查

## 12. 推送

```bash
git add src/i18n-core.js src/dict.js src/storage.js
git commit -m "feat: 补充 ..."
git push
```

`scripts/` 下的调试脚本（verify-*.js、scan-*.js 等）不提交，保留在工作区供诊断用。