# TODO（待办清单）

> 记录已确认但尚未修复的问题，按优先级排序。

## 高优先级

- [ ] **clp 语言包缓存路径跨平台 bug**（`src/i18n-core.js:4051/4092`）
  - `translateClpLanguagePacks()` / `restoreClpLanguagePacks()` 硬编码 `AppData/Roaming/Cursor/clp`（Windows 路径）
  - macOS 实际为 `~/Library/Application Support/Cursor/clp`，Linux 为 `~/.config/Cursor/clp`
  - 影响：Mac/Linux 用户安装官方 zh-hans 语言包后，clp 补译步骤静默跳过，漏译一批词条
  - 修复方向：仿照 `src/storage.js` 的 `getDbPath()` 按平台分叉

## 中优先级

- [ ] **0 命中规则审计**（详见 `audit/zero-hit-rules` 分支产出）
  - aux 数组约 2500 条中约 972 条在当前 glass 包零命中，需分类：版本兼容（保留）/ 疑似失效 / 死规则