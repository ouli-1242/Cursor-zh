# Cursor-zh

Cursor-zh 是一个 Cursor 编辑器的本地汉化工具：把界面上的英文文案替换成中文，并自动修复文件校验值，避免出现"安装已损坏"提示。支持一键汉化、随时还原。

> ⚠️ 本工具不是 Cursor 官方项目，也不修改你的账号、模型、插件、项目代码或云端配置，只处理本机 Cursor 的应用资源文件。

## 快速开始

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

启动后是三步引导界面：

1. **检测 Cursor**——自动定位安装路径，展示版本号、写入权限、是否正在运行、是否已汉化
2. **确认操作**——展示将处理哪些文件，选择「一键汉化」「恢复英文」「查看常见问题」或退出
3. **执行 + 完成引导**——需要管理员权限时会先说明再请求；完成后提示重启、验证和备份信息

路径会自动搜索（Windows 注册表 / macOS 应用目录 / Linux 常见路径），找不到时会引导手动输入，任何安装位置都能用。

也可以命令行静默执行（适合脚本）：

```bash
node index.js --action=translate --cursor-path="/Applications/Cursor.app/Contents/Resources/app"   # 汉化
node index.js --action=restore --cursor-path="/Applications/Cursor.app/Contents/Resources/app"    # 恢复英文
```

## 它翻译什么

| 范围 | 说明 |
|---|---|
| 主窗口 | 菜单、设置页、右键菜单、聊天界面等 |
| Agent 窗口（Glass）| 新版 Cursor 的独立智能体窗口 |
| 原生提示 | 系统菜单、加载提示（nls.messages.json）|
| 托盘菜单 | Electron 主进程的系统托盘 |
| 用户存储 | 模式描述、模型参数（如 Thinking intensity）|
| 远程扩展 | remote-ssh / remote-wsl / remote-containers 命令面板 |
| 语言包缓存 | 官方中文语言包未覆盖的 Cursor 新词条 |

## 支持平台

- **Windows**：用户目录安装、Program Files 安装均支持（自动读注册表）
- **macOS**：`/Applications/Cursor.app` 及用户目录安装（自动签名修复）
- **Linux**：常见安装路径（`/opt`、`/usr/share` 等）；AppImage 或非标准路径建议手动指定

Cursor 更新会覆盖修改过的文件，需要重新运行汉化；大版本更新后如有新英文，工具会随版本更新词库。

## 使用注意

- **汉化前请完全退出 Cursor**（含托盘和后台进程），否则用户存储步骤会跳过
- 汉化后**重启 Cursor 才能生效**
- 恢复英文不会丢失对话历史（用户存储是字段级还原，只改回汉化字段）

## 配置与备份

- 路径配置保存在 `~/.cursor-zh/config.json`
- 汉化前自动备份原版文件（`.backup` + 版本元数据），Cursor 升级后自动更新备份
- 恢复英文时优先使用备份文件还原，还原后删除备份

## 权限说明

- 安装目录可写则直接执行
- 无权限时（如 Program Files）会请求管理员权限，Windows/macOS 走系统提权；Linux 可用 `sudo` 运行
- 工具不上传任何文件或数据，汉化流程不需要联网

## 常见问题

**汉化后界面没变化？**
完全退出并重启 Cursor；确认定位的是正在使用的安装目录；Cursor 更新后需重新运行汉化。

**提示"安装已损坏"？**
工具已自动修复校验值。若仍出现，先恢复英文再重新汉化，或检查是否被安全软件阻止写入。

**macOS 提示无法打开或已损坏？**
工具会自动清理隔离属性并重新签名。若仍失败，可手动执行：
```bash
xattr -cr /Applications/Cursor.app
codesign --force --deep --sign - /Applications/Cursor.app
```

**模型参数（如 Thinking intensity）过一会儿恢复英文？**
工具已注入显示层映射，一般不会再恢复；若出现，重新运行汉化即可。

**如何完全退出 Cursor？**
右键托盘图标选择"退出"，并在任务管理器中确认 Cursor.exe 已结束。

> 交互界面里也内置了「查看常见问题」菜单，随时可查看。

## 安全边界

- 使用前先退出 Cursor
- 保留 `.backup` 文件方便恢复
- 从可信来源获取工具或自行构建，不要运行来历不明的二进制

## 找回 / 反馈

发现漏翻、误翻或运行失败，欢迎提交 Issue，附上：操作系统、Cursor 版本、报错日志、漏翻界面截图（尽量含英文原文）。不要粘贴账号 Token、API Key 或私有代码。

## 开发说明（维护者）

```
index.js            CLI 入口（交互界面 / 静默模式）
src/platform.js     路径检测、权限、提权、进程/版本读取
src/ui.js           交互界面展示组件
src/i18n-core.js    翻译引擎、备份还原、校验修复
src/dict.js         翻译词典
src/storage.js      用户存储（state.vscdb）翻译与还原
scripts/verify-hf.js 等  验证脚本（提交词条前跑）
scripts/gen-*.js     未翻译清单生成（补词循环）
```

## 致谢

基于 [rongwei-lab/cursor-chinese](https://github.com/rongwei-lab/cursor-chinese)（MIT License）改进。

## 许可证

MIT License。