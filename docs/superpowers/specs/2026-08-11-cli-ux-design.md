# CLI 交互界面重构设计

> 日期：2026-08-11　分支：feat/cli-ux　产品：Cursor-zh

## 目标

重构 `npm start`（交互模式）的终端展示与引导流程，三个方向并重：

1. **视觉美化**：ASCII 艺术标题横幅 + 彩色徽章 + 分节结构 + 步骤指示
2. **流程引导**：检测 → 确认 → 执行 → 完成引导 的四步结构化体验
3. **信息透明**：展示 Cursor 版本/路径来源/写权限/运行状态/汉化状态/备份信息

目标用户：**平衡**——默认简洁清晰，关键步骤强引导，技术细节可见但不啰嗦。

## 范围

**做**：
- 新建 `src/ui.js`（纯展示组件，无业务逻辑）
- `src/platform.js` 增加 `isCursorRunning()` 与 `readCursorVersion()`
- `index.js` 交互模式重构为引导流程

**不做**：
- 静默模式 `--action` 保持现状（脚本/CI 兼容）
- 路径探测/提权/i18n-core 核心逻辑不变
- clp/getClpRoot 已跨平台，不涉及

## 架构

```
index.js（引导主流程）        src/ui.js（纯展示组件）
     │                            │
     ├─ 步骤1 检测                ├─ banner()        ASCII 标题
     ├─ 步骤2 确认                ├─ step()          步骤指示
     ├─ 步骤3 执行+引导           ├─ ok/warn/err/info 徽章
     └─ 复用 platform.js          ├─ section()       分节标题
         ├─ isCursorRunning()      └─ fileList()      文件清单
         ├─ readCursorVersion()
         └─ （既有路径/权限/提权）
```

## 组件设计：`src/ui.js`

纯函数、无副作用、无业务依赖；错误输入安全降级（如无颜色环境）。

| 函数 | 行为 |
|---|---|
| `banner()` | ASCII 艺术 "Cursor-zh" + 副标题「Cursor 本地汉化工具 · 一键汉化 / 随时还原」+ 版本号（来自 package.json） |
| `step(index, total, label)` | `步骤 1/3  检测 Cursor 状态`（青色加粗） |
| `ok(msg)` / `warn(msg)` / `err(msg)` / `info(msg)` | ✅/⚠️/❌/ℹ️ 前缀 + 对应颜色 |
| `section(title)` | 分节标题（蓝色，上下留白一行） |
| `fileList(items)` | 表格化清单：`✔ 名称       路径/大小`；溢出省略；中文对齐用全角计算 |
| `divider()` | 分隔线（`─`） |
| `lines(text)` | 多行文本逐行输出，自动对齐 |

终端宽度：全角字符（中文/emoji）按 2 列对齐，避免表格错位。

## 流程设计：`index.js` 交互模式

### 启动
- `banner()` → 空行 →「自动检测 Cursor 安装…」

### 步骤 1：检测 Cursor 状态
1. 定位路径（沿用现有 `obtainCursorPaths`）：
   - 优先级：`--cursor-path` → 保存配置 → 自动搜索 → 0 个时引导手动输入
   - 展示**路径来源**：`📂 Cursor 路径  <path>（来源：自动搜索/配置/手动）`
2. 展示状态行（`ok`/`warn` 徽章）：
   - 版本：`readCursorVersion(appPath)`（读 product.json，读不到显示「未知」）
   - 写权限：`hasWritePermission(mainJsPath)` → 有/无（无则提示将请求管理员权限）
   - 运行状态：`isCursorRunning()` → 运行中则 `warn`「汉化前请完全退出 Cursor，否则用户存储步骤会跳过」
   - 汉化状态：读主 JS 判断含中文 → 已汉化则提示「已汉化过，可恢复英文后重译」；未汉化则提示「当前为英文原版」

### 步骤 2：确认操作
1. `section('确认操作')`
2. 展示将修改的文件清单（`fileList`）：
   - 主 JS（workbench.desktop.main.js）
   - 附加窗口（workbench.glass.main.js，如存在）
   - 原生提示（nls.messages.json，如存在）
   - 托盘主进程（main.js，如存在）
   - product.json（校验值）
   - 其他：clp 语言包缓存 / 用户扩展 / state.vscdb（按需提示）
3. 操作选择（沿用 inquirer list）：
   - 🚀 一键汉化（绿色）
   - ⏪ 恢复英文（黄色）
   - 📖 查看常见问题（新增，展开 FAQ 后返回）
   - ❌ 退出

### 步骤 3：执行 + 完成引导
**提权时**：先 `info` 解释「修改 Cursor 核心文件需要管理员权限，请在系统弹窗中确认」再请求。
**执行**：彩色进度条（复用/优化现有 createProgress，染色）。
**完成后引导**（`section('完成')`）：
- 汉化：⚠️ 提示「**重启 Cursor 才能生效**」→ 如何验证（设置页出现中文）→ 备份位置（.backup 文件）→ 如何恢复英文
- 恢复：提示已还原的文件数 → 重启生效

### 错误处理
- 主流程 try/catch：红色卡片展示错误 → 建议（可尝试恢复英文）
- 未找到 Cursor / 无写入权限：给出明确出路（手动路径 / 提权 / 换安装位置）

## 路径处理（对用户透明）

- Cursor 安装路径：**自动搜索为主，找不到引导手动输入**（机制已存在，展示来源）
- clp：跟随用户 home 的平台标准目录，与 Cursor 安装位置无关，无需用户操作；未装语言包自动跳过

## 测试与验证

- `npm start` 手动走查：
  1. 正常流程（已装 Cursor、英文原版、有权限）→ 三步走通 + 完成引导正确
  2. 无权限 → 提权解释文案正确、取消不崩溃
  3. 多个/零个 Cursor → 选择/手动输入引导正确
  4. 已汉化状态 → 状态行正确提示
  5. 运行中 → 警告出现
- `node index.js --action=translate --cursor-path=...` 静默模式回归不受影响
- `node --check` 语法 + 引擎加载
- 终端无颜色环境（TTY 检测）展示可读

## 交付物

- `src/ui.js`（新）
- `src/platform.js`（+isCursorRunning / readCursorVersion）
- `index.js`（交互模式重构）