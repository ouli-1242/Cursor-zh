const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');
function extractArray(src, startMarker) {
  // 行级定位：不能用括号计数——条目字符串内带 `]`（minified JS 片段）会让
  // 括号计数提前归零、数组被错误截断。
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.includes(startMarker));
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end + 1).join('\n');
  return block.slice(block.indexOf('['), block.lastIndexOf(']') + 1);
}
function parseRules(block) {
  const re = /\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g;
  const rules = [];
  let m;
  while ((m = re.exec(block)) !== null) rules.push([m[1], m[2]]);
  return rules;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 模拟翻译：对文件应用规则（长优先）
function translate(src, rules) {
  const sorted = [...rules].sort((a, b) => b[0].length - a[0].length);
  for (const [en, zh] of sorted) {
    src = src.split(en).join(zh);
  }
  return src;
}

const auxRules = parseRules(extractArray(src, 'const auxiliaryInterfaceReplacements = '));
const scopedRules = parseRules(extractArray(src, 'const scopedReplacements = '));

// 调试：打印提取到的 New User 相关规则
console.log('===== 提取到的 New User 相关规则 =====');
for (const [en, zh] of auxRules) {
  if (en.includes('New User') || en.includes('Enter a name') || en.includes('my-custom') || en.includes('==="skill"')) {
    console.log(' EN:', JSON.stringify(en));
    console.log(' ZH:', JSON.stringify(zh));
  }
}
console.log('====================================\n');

// 找出含 Z=== / C=== / te=== / x=== / New User 的规则来验证
const keywords = ['==="skill"', 'New User ${', 'Enter a name for the new ${', 'my-custom-${', 'E(7683,null)', 'Enter Command Name'];
function filter(rules) { return rules.filter(([en]) => keywords.some(k => en.includes(k))); }

// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glass = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const desk = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.glass.main.js'), 'glass');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.desktop.main.js'), 'desk');

const gOut = translate(glass, filter(auxRules));
const dOut = translate(desk, filter(scopedRules));

// 调试：源文件与规则的字节对比
{
  const rule = auxRules.find(r => r[0].includes('Enter a name'));
  const i = glass.indexOf('Enter a name');
  console.log('源文件片段:', JSON.stringify(glass.slice(i - 40, i + 80)));
  console.log('规则 EN:', JSON.stringify(rule[0]));
  console.log('源 contains EN:', glass.includes(rule[0]));
  console.log('gOut contains EN:', gOut.includes(rule[0]));
  console.log('gOut contains 为新的:', gOut.includes('为新的'));
}

console.log('\n===== glass 模拟替换后实际片段 =====');
let idx = gOut.indexOf('New User ${');
if (idx === -1) idx = gOut.indexOf('新建用户');
if (idx !== -1) console.log(gOut.slice(Math.max(0, idx - 200), idx + 400));
idx = gOut.indexOf('e.g., my-custom');
if (idx !== -1) console.log('\n占位符区域:', gOut.slice(Math.max(0, idx - 120), idx + 120));
idx = gOut.indexOf('输入命令名称');
if (idx !== -1) console.log('\n命令对话框区域:', gOut.slice(Math.max(0, idx - 120), idx + 80));

console.log('\n===== glass 模拟替换后 New User 相关片段 =====');
// 直接找替换后的关键结果（3.15 构建变量: J=类型名 / Z=小写类型）
const checks = [
  ['新建用户${J}', '标题用 J 变量'],
  ['为新的${Z}输入名称', 'prompt 用 Z 中文变量'],
  ['e.g., my-custom-${Z}', '占位符保持英文 e.g., my-custom-skill'],
  ['prompt:"输入命令名称",placeHolder:"命令名称"', '命令对话框（非压缩形态）'],
];
for (const [s, label] of checks) {
  console.log((gOut.includes(s) ? '✓' : '✗') + ' ' + label);
}

console.log('\n===== desktop 模拟替换后 ===');
const dchecks = [
  ['新建用户${re}', 'desktop 标题 re'],
  ['为新的${ee}输入名称', 'desktop prompt ee'],
  ['e.g., my-custom-${ee}', 'desktop 占位符英文'],
];
for (const [s, label] of dchecks) {
  console.log((dOut.includes(s) ? '✓' : '✗') + ' ' + label);
}

// 确认替换后不再有会被误译的英文 prompt 原文
console.log('\n===== 残留检查（不应有英文原文） =====');
for (const kw of ['New User ${J}', 'New User ${re}', 'Enter a name for the new ${Z}', 'Enter a name for the new ${ee}']) {
  if (gOut.includes(kw) || dOut.includes(kw)) console.log('✗ 残留: ' + kw);
}
for (const kw of ['my-custom-技能', 'my-custom-子代理']) {
  if (gOut.includes(kw) || dOut.includes(kw)) console.log('✗ 占位符被中文污染: ' + kw);
}
console.log('残留检查完成');