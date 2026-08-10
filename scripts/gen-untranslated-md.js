// 生成未翻译 UI 候选清单 md 到桌面：排除已加翻译规则的词条，全部写入不截断
const fs = require('fs');
const path = require('path');

const APP_CORE = path.join(__dirname, '../src/i18n-core.js');
const src = fs.readFileSync(APP_CORE, 'utf8');
const dict = require(path.join(__dirname, '../src/dict.js'));

function extractArray(name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.includes(`const ${name} = [`));
  if (start < 0) throw new Error('not found ' + name);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end + 1).join('\n');
  const arrText = block.slice(block.indexOf('['), block.lastIndexOf(']') + 1);
  return eval(arrText);
}

const aux = extractArray('auxiliaryInterfaceReplacements');
const scoped = extractArray('scopedReplacements');

// 已覆盖集合：规则中的英文子串（引号内容）+ 词典 key
const covered = new Set();
for (const [en] of [...aux, ...scoped]) {
  if (!en) continue;
  const ms = en.match(/"[^"]*"/g) || [];
  ms.forEach(m => covered.add(m.slice(1, -1)));
  if (!en.includes('"') && !en.includes("'")) covered.add(en);
}
for (const k of Object.keys(dict.safeGlobalDict || {})) covered.add(k);
for (const k of Object.keys(dict.riskyShortWords || {})) covered.add(k);
console.log('已覆盖词条数:', covered.size);

const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const desk = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js', 'utf8');

const attrs = ['children', 'label', 'title', 'placeholder', 'aria-label', 'tooltip', 'message', 'hintText', 'text', 'description', 'actionTitle', 'primaryLabel', 'secondaryLabel', 'name', 'prompt'];

function extract(src) {
  const found = new Map();
  for (const attr of attrs) {
    const re = new RegExp(`(?:${attr}):"([^"]{3,120})"`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = m[1];
      if (/[\u4e00-\u9fff]/.test(val)) continue;
      if (/^[\d\s%.,+-]+$/.test(val)) continue;
      if (/[\\/]/.test(val)) continue;
      if (/^[a-z][a-zA-Z0-9]*$/.test(val)) continue;
      if (/^[A-Z][A-Z0-9_]+$/.test(val)) continue;
      if (/https?:|\.com|\.org|\.io|\.json|\.md|\.ts|\.js|\.css/.test(val)) continue;
      if (!/[a-zA-Z]/.test(val)) continue;
      if (!val.includes(' ')) continue;
      if (covered.has(val)) continue;
      if (found.has(val)) found.get(val).count++;
      else found.set(val, { count: 1 });
    }
  }
  return found;
}

const g = extract(glass);
const d = extract(desk);
const all = new Map();
for (const [k, v] of g) all.set(k, { g: v.count, d: 0 });
for (const [k, v] of d) {
  if (all.has(k)) all.get(k).d = v.count;
  else all.set(k, { g: 0, d: v.count });
}
for (const [k, v] of all) v.count = Math.max(v.g, v.d);

// 排除：测试项/专有名词/代码调试类/运行时（与历史清单保持一致）
const skipSet = new Set([
  'Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5', 'Item 6', 'Option 1', 'Option 2', 'Option 3', 'Input 1', 'Input 2',
  'Dummy Option Alpha', 'Dummy Option Beta', 'Dummy Option Gamma', 'Merge Editor',
  'Open in Statsig', 'Statsig configurations refreshed successfully', 'Refreshing Statsig configurations...',
  'Cloud agent repository is disabled outside Glass', 'The document uri', '$(copilot) ',
  'Open in Prompt Quality', 'DEV OVERRIDE', 'Interactive resource Uri', 'Glass present',
  'Styled Messages', 'Edit Icon', 'React Transcript', 'Multiple Messages', 'Focus Outline',
  'Enable Data Handle Debugging', 'Download Cursor Private Inference', 'Undo Apply', 'Remember Preference',
  'Continue Update', 'This is the first message.', 'This is the second message, which is de-emphasized.',
  'The agent\u2019s machine may not be running. Send a message to restart.',
  'Origin repositories support single-repo agents only.',
  'Apply changes to the main working directory', 'Save changes to a stash and restore them later',
  'Permanently discard your current changes before switching branches', 'Cancel the checkout operation',
  'Failed to open the MCP authentication flow.', 'Failed to start Cloud Agent', 'Failed to log out of MCP server.',
  'Request ID copied to clipboard', 'Message copied to clipboard', 'Copied path to clipboard',
  'No request ID found', 'Composer not found', 'No matching commands', 'No Active Agent Conversation',
  'Custom Modes', 'No items.', 'No available options', 'No change', 'No agents yet', 'No notes yet', 'No project',
  // ── 品牌/专有名词（保留原文） ──
  'Claude Code',
  'Cursor Chat',
  'GitHub Copilot',
  'Cloudflare',
  'Datadog',
  'VSIX Extensions',
  'MCP Tools',
  // ── 调试/开发者工具标签（面向开发者，非普通 UI） ──
  'Monaco scroll offset buffer', 'Monaco full file cell buffer',
  'Network & IPC Profiler is running', 'Local Trace Mode', 'Continuous RPC File Recording',
  'Index Diagnostics', 'Loading State', 'Progress Bar',
  'First test option', 'Second test option', 'Third test option',
  'Warning Secondary', 'Error Secondary', 'Success Secondary', 'Informational Secondary',
  'THIS SHOULD BE A LINTER ERROR', 'char-insert diff-range-empty',
  'Abort the operation', 'Stop profiler and show results',
  // ── 占位符/模板/示例（含变量，不可直译） ──
  '${path} (metadata)', '$(plus) ', 'e.g. us-east-1', 'Type a long message here...',
  'Error: composerId is required',
  // ── VS Code API 参数说明（无 UI 展示） ──
  'The text document in which to start', 'The position at which to start', 'An array of locations.',
  'The cell range options', 'Skip this parameter', 'Human readable title for the diff editor',
]);

// 前缀/包含匹配：Monaco 调试标签、含 Claude Code / MCP Tools 的组合词条
const skipPrefix = ['Monaco ', 'Monaco'];
const skipIncludes = ['Claude Code', 'MCP Tools'];

const keep = [];
for (const [k, v] of all) {
  if (skipSet.has(k)) continue;
  if (skipPrefix.some(p => k.startsWith(p))) continue;
  if (skipIncludes.some(p => k.includes(p))) continue;
  if (k.length > 60 && /^[A-Z]/.test(k) && k.split(' ').length >= 6) continue;
  keep.push({ phrase: k, count: v.count });
}
keep.sort((a, b) => b.count - a.count);

const high = keep.filter(x => x.count >= 4);
const mid = keep.filter(x => x.count >= 2 && x.count < 4);
const low = keep.filter(x => x.count === 1);

let md = `# Cursor-zh 未翻译 UI 文案清单\n\n生成时间: 2026-08-08（排除已添加翻译规则的词条后重新扫描 glass/desk 主文件）\n\n> 数值 = 在 UI 属性（children/label/title/tooltip 等）中仍显示英文的出现次数。已排除测试项、专有名词、代码调试类、运行时动态文本及已添加规则的词条。\n\n`;
md += `共 ${keep.length} 条候选（高频 ${high.length}、中频 ${mid.length}、低频 ${low.length}）\n\n`;

md += `## 高优先级（≥4 次出现）\n\n| 次数 | 英文 | 建议翻译 |\n|---|---|---|\n`;
for (const x of high) md += `| ${x.count} | ${x.phrase} |  |\n`;

md += `\n## 中优先级（2-3 次）\n\n| 次数 | 英文 | 建议翻译 |\n|---|---|---|\n`;
for (const x of mid) md += `| ${x.count} | ${x.phrase} |  |\n`;

md += `\n## 低频（1 次）\n\n| 次数 | 英文 | 建议翻译 |\n|---|---|---|\n`;
for (const x of low) md += `| ${x.count} | ${x.phrase} |  |\n`;

const outPath = 'C:/Users/ouli/Desktop/未翻译UI清单.md';
fs.writeFileSync(outPath, md, 'utf8');
console.log('已写入:', outPath, '| 总候选:', keep.length, '| 高:', high.length, '| 中:', mid.length, '| 低:', low.length);