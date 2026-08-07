# 贡献指南

感谢你对 Cursor-zh 的关注！欢迎提交 Issue 和 Pull Request。

## 报告问题

提交 Issue 时请附上以下信息：

- 操作系统和架构（如 Windows x64、macOS arm64）
- Cursor 版本号
- 使用方式（源码运行 / 预编译成品）
- 漏翻请提供英文原文和界面截图
- 误翻请说明期望的翻译
- 运行失败请附上完整报错日志

**不要在公开 Issue 中粘贴**账号 Token、API Key、公司私有代码或日志中的敏感路径。

## 提交翻译

### 添加新词条

1. **安全长句**（推荐）：如果是完整的英文句子或短语，加入 `src/dict.js` 的 `safeGlobalDict`。这类词条不会与代码变量冲突，可以全局替换。

2. **短词**：如果是单词级别的翻译（如 "Local"、"Recent"），加入 `riskyShortWords`。这类词条只在 UI 属性上下文（`children`、`title`、`label`、`placeholder` 等）中替换，不会误伤代码逻辑。添加前请搜索备份文件确认该词不会出现在键盘扫描表或枚举中。

3. **原生菜单**：如果是 `nls.messages.json` 中的菜单项，加入 `nativeNlsDict`。

### 添加替换规则

如果英文文案是动态生成的（模板字符串、三元表达式、编译后变量名），无法通过全局词典匹配，需要在 `src/i18n-core.js` 中添加替换规则：

- **scopedReplacements**：主窗口（`workbench.desktop.main.js`）中的精确字符串匹配。
- **auxiliaryInterfaceReplacements**：Glass 窗口（`workbench.glass.main.js`）中的精确字符串匹配。
- **trickyReplacements / auxiliaryRegexReplacements**：需要正则匹配的复杂模式。

添加规则前，请先在 Cursor 的备份文件（`.backup`）中搜索确认目标文本的实际形式，包括压缩后的变量名和转义字符。

### 验证

提交前请运行语法检查：

```bash
node --check index.js
node --check src/i18n-core.js
node --check src/platform.js
node --check src/dict.js
```

如果修改了翻译逻辑，建议在本地 Cursor 上实际运行一次汉化和恢复，确认无白屏和功能异常。

## 提交 Pull Request

1. Fork 本仓库。
2. 创建分支：`git checkout -b fix/your-description`。
3. 提交更改，commit message 用中英文均可，简洁描述改了什么。
4. Push 并创建 Pull Request，说明修改内容和涉及的 Cursor 版本。

## 代码风格

- JavaScript 代码保持与现有风格一致（单引号、无分号结尾可选）。
- 注释使用中文，与现有文件保持一致。
- 词典条目按功能区域分组，每组前加注释行说明用途。
