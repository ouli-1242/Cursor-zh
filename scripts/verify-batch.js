const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');

// 提取 aux 数组（const auxiliaryInterfaceReplacements = [ ... ];）
// 行级定位：不能用括号计数——条目字符串内带 `]`（minified JS 片段）会让
// 括号计数提前归零、数组被错误截断（旧实现只拿到 171/2521 条）。
function extractArray(src, startMarker) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.includes(startMarker));
  if (start === -1) throw new Error('marker not found: ' + startMarker);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end + 1).join('\n');
  return block.slice(block.indexOf('['), block.lastIndexOf(']') + 1);
}

const auxSrc = extractArray(src, 'const auxiliaryInterfaceReplacements = ');
const scopedSrc = extractArray(src, 'const scopedReplacements = ');

// 解析 ['en', 'zh'] 规则对
function parseRules(blockSrc) {
  const re = /\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g;
  const rules = [];
  let m;
  while ((m = re.exec(blockSrc)) !== null) {
    rules.push([unescapeStr(m[1]), unescapeStr(m[2])]);
  }
  return rules;
}
function unescapeStr(s) {
  return s.replace(/\\(['\\`$])/g, '$1').replace(/\\n/g, '\n');
}

const auxRules = parseRules(auxSrc);
const scopedRules = parseRules(scopedSrc);

// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glass = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const desk = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');

function count(src, en) {
  let i = src.indexOf(en), n = 0;
  while (i !== -1) { n++; i = src.indexOf(en, i + en.length); }
  return n;
}

// 重点验证本次新增的规则（按 en 关键词过滤）
const keywords = [
  'Filter By', '{value:"scope"', '{value:"author"', '{value:"name"',
  'Manage in Dashboard', 'Show ${k} more', '["Show ', 'Show ",g," more',
  'moreLabel:"Show more"', 'confirmLabel??', 'cancelLabel??', 'title??"Prompt"',
  'E(7683,null)', 'Enter Command Name',
  // New User Skill/Subagent 对话框与命令创建规则：用通用前缀，变量名无论怎么改都覆盖
  '==="skill"', 'New User ${', 'Enter a name for the new ${', 'my-custom-${',
  'User Rules apply',
  'p$m={light:', 'glassOsEdit',
];

console.log('===== aux 规则命中（glass） =====');
let auxHit = 0, auxTotal = 0;
for (const [en, zh] of auxRules) {
  if (!keywords.some(k => en.includes(k))) continue;
  auxTotal++;
  const c = count(glass, en);
  if (c === 0) { console.log('✗ 未命中'.padEnd(10), en.slice(0, 60)); }
  else { auxHit++; console.log('✓ ' + String(c).padEnd(3), en.slice(0, 60)); }
}
console.log('aux 关键规则命中率:', auxHit + '/' + auxTotal);

console.log('\n===== scoped 规则命中（desktop） =====');
let scHit = 0, scTotal = 0;
for (const [en, zh] of scopedRules) {
  if (!keywords.some(k => en.includes(k))) continue;
  scTotal++;
  const c = count(desk, en);
  if (c === 0) { console.log('✗ 未命中'.padEnd(10), en.slice(0, 60)); }
  else { scHit++; console.log('✓ ' + String(c).padEnd(3), en.slice(0, 60)); }
}
console.log('scoped 关键规则命中率:', scHit + '/' + scTotal);