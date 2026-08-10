const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');

// 提取 aux 数组（const auxiliaryInterfaceReplacements = [ ... ];）
function extractArray(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('marker not found: ' + startMarker);
  const open = src.indexOf('[', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
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

const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const desk = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js', 'utf8');

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
  'E(7683,null)', 'Enter Command Name', 'Z==="skill"', 'C==="skill"',
  'te==="skill"', 'x==="skill"', 'New User ${ne}', 'New User ${Y}', 'New User ${T}',
  'New User ${x}', 'New User ${oe}', 'New User ${ee}', 'New User ${M}', 'New User ${I}',
  'Enter a name for the new ${Y}', 'my-custom-${Y}', 'User Rules apply',
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