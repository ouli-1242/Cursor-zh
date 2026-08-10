// 0 命中规则审计 v3（读英文原版 bundle）
// 完整模拟 translateAuxiliaryJsFile 的 glass 翻译管线(safe + long + aux + tricky + risky),
// 对 aux 中 glass 0 命中的规则分三类:
//   gone:        核心短语在原始 glass/desktop 都不存在 → 死规则, 可删
//   漏译候选:    核心短语在 dir 但仍为英文 → 当前包确实没译到, 需补规则
//   已覆盖:      核心短语已被其他规则翻译 → 冗余/版本兼容, 保留无害
const fs = require('fs');
const path = require('path');

const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glassOrig = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const deskOrig = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');
const lines = src.split('\n');
const { safeGlobalDict, riskyShortWords } = require(path.join(__dirname, '..', 'src', 'dict.js'));

function extractArray(name) {
  const start = lines.findIndex(l => l.includes(`const ${name} = [`));
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end + 1).join('\n');
}
const ev = (name) => { const b = extractArray(name); return eval(b.slice(b.indexOf('['), b.lastIndexOf(']') + 1)); };
const aux = ev('auxiliaryInterfaceReplacements');
const tricky = ev('trickyReplacements');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (s) => s.replace(/\$\{[^}]*\}/g, '{}').replace(/\s+/g, ' ').trim();
const normGlassOrig = normalize(glassOrig);
const normDeskOrig = normalize(deskOrig);

// ── 完整 glass 翻译模拟(与 translateAuxiliaryJsFile 一致) ──
function buildRegex(entries, quoted) {
  const valid = entries.filter(([en]) => en);
  return new RegExp(valid.sort((a, b) => b[0].length - a[0].length).map(([en]) => escapeRegExp(en)).join('|'), 'g');
}
const safeEntries = Object.entries(safeGlobalDict).sort((a, b) => b[0].length - a[0].length);
const quotedRegex = new RegExp(`(["'\`])(${safeEntries.map(([en]) => escapeRegExp(en)).join('|')})\\1`, 'g');
const longEntries = safeEntries.filter(([en]) => en.length >= 20);
const longRegex = longEntries.length ? new RegExp(longEntries.map(([en]) => escapeRegExp(en)).join('|'), 'g') : null;
const auxRegex = buildRegex(aux);
const auxLookup = new Map(aux.filter(([en]) => en));
const riskyWordsDesc = Object.keys(riskyShortWords).sort((a, b) => b.length - a.length);
const propRegex = new RegExp(`(${'children|title|label|placeholder|description|tooltip|text|name|message|detail|heading|markdownDescription|aria-label|ariaLabel|emptyStateText|currentLabel|breadcrumbLabel'})\\s*:\\s*(["'\`])(${riskyWordsDesc.map(escapeRegExp).join('|')})\\2`, 'g');

let out = glassOrig;
out = out.replace(quotedRegex, (m, q, en) => `${q}${safeGlobalDict[en]}${q}`);
if (longRegex) out = out.replace(longRegex, (m) => safeGlobalDict[m]);
out = out.replace(auxRegex, (m) => auxLookup.get(m));
for (const { regex, zh } of tricky) out = out.replace(regex, zh);
out = out.replace(propRegex, (m, prop, q, word) => `${prop}: ${q}${riskyShortWords[word]}${q}`);

// ── 每条 aux 规则 + 前置注释 ──
const re = /\/\/[^\n]*|\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g;
let m, lastComment = '', rules = [];
while ((m = re.exec(extractArray('auxiliaryInterfaceReplacements'))) !== null) {
  if (m[0].startsWith('//')) { lastComment = m[0].trim(); continue; }
  rules.push({ en: m[1], zh: m[2], comment: lastComment });
}

// 命中集合
const hit = new Set();
let mm;
while ((mm = auxRegex.exec(glassOrig)) !== null) hit.add(mm[0]);
const zeroHit = rules.filter(r => !hit.has(r.en));

function corePhrase(en) {
  const re2 = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let best = '', bm;
  while ((bm = re2.exec(en)) !== null) if (bm[2].length > best.length) best = bm[2];
  return best || en;
}

const cats = { gone: [], leak: [], covered: [] };
const normOut = normalize(out); // 只归一化一次
for (const r of zeroHit) {
  const core = normalize(corePhrase(r.en)).replace(/\\u2026/g, '…');
  if (core.length < 3) { cats.gone.push({ ...r, core }); continue; }
  if (!normGlassOrig.includes(core) && !normDeskOrig.includes(core)) { cats.gone.push({ ...r, core }); continue; }
  // 短语在原始包里存在 → 看翻译后是否仍是英文
  if (normOut.includes(core)) cats.leak.push({ ...r, core });
  else cats.covered.push({ ...r, core });
}

console.log('总规则:', rules.length, ' 命中:', hit.size, ' 0命中:', zeroHit.length);
for (const [cat, list] of Object.entries(cats)) {
  console.log(`\n===== ${cat}: ${list.length} 条 =====`);
  list.slice(0, 12).forEach(r => {
    const c = (r.comment || '').slice(0, 30);
    console.log(`  [${c}] EN=${r.en.slice(0, 52)}  → 核心:${('' + r.core).slice(0, 42)}`);
  });
  if (list.length > 12) console.log(`  ... 共 ${list.length} 条`);
}

// ── leak 明细: 按 EN 形态与核心短语特征细分 ──
const leakRules = cats.leak;
const subCats = {
  'leak-E-T漂移': [],   // EN 含 E( 或 T( NLS 调用 → 可能只需补 T 变体
  'leak-独特短语': [],   // 核心 ≥6 字符且不含中文 → 真实 UI 漏译候选
  'leak-通用短词-噪声': [], // 核心 <6 字符或无空格 → 大概率是代码里的通用词
};
for (const r of leakRules) {
  const core = String(r.core);
  if (r.en.includes('E(') || r.en.includes('T(')) { subCats['leak-E-T漂移'].push(r); continue; }
  if (core.length >= 6 && !/^[a-z]+$/.test(core)) subCats['leak-独特短语'].push(r);
  else subCats['leak-通用短词-噪声'].push(r);
}
console.log('\n===== leak 细分 =====');
for (const [sc, list] of Object.entries(subCats)) {
  console.log(`${sc}: ${list.length} 条`);
  list.slice(0, 8).forEach(r => console.log(`    EN=${r.en.slice(0, 60)}`));
  if (list.length > 8) console.log(`    ... 共 ${list.length} 条`);
}

// ── 写完整报告 ──
const reportPath = path.join(__dirname, '..', 'audit-zerohit-report.txt');
const lines2 = [];
lines2.push(`0 命中规则审计报告 (${new Date().toISOString().slice(0, 10)})`);
lines2.push(`总规则 ${rules.length} | 命中 ${hit.size} | 0命中 ${zeroHit.length}`);
lines2.push(`分类: gone ${cats.gone.length} | leak ${cats.leak.length} | covered ${cats.covered.length}`);
const dump = (title, list) => {
  lines2.push(`\n===== ${title} (${list.length}) =====`);
  list.forEach(r => lines2.push(`[${(r.comment || '').slice(0, 40)}] EN: ${r.en}  → 核心: ${r.core}`));
};
dump('gone-死规则候选可删', cats.gone);
dump('leak-漏译候选', cats.leak);
dump('covered-已覆盖冗余', cats.covered);
fs.writeFileSync(reportPath, lines2.join('\n'), 'utf8');
console.log('\n完整报告已写入:', reportPath);