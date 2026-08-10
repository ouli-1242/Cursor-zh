// 定位 i18n-core.js 中 EN 含中文的重译规则（真死规则）
// 这些规则只在"已部分汉化"的 bundle 上触发，英文全新包上永远不触发。
const fs = require('fs');
const lines = fs.readFileSync('src/i18n-core.js', 'utf8').split('\n');
const hasCJK = (s) => /[一-鿿]/.test(s);

function arrayBounds(name) {
  const start = lines.findIndex(l => l.includes(`const ${name} = [`));
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start: start + 1, end: end + 1 };
}

// 行级扫描数组内所有 ['en','zh'] 条目，标注行号
function scanArray(name) {
  const { start, end } = arrayBounds(name);
  const hits = [];
  const re = /^\s*\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\],?\s*$/;
  for (let i = start; i < end; i++) {
    const m = lines[i - 1].match(re);
    if (!m) continue;
    const en = m[1].replace(/\\(['\\`$])/g, '$1');
    if (hasCJK(en)) hits.push({ line: i, en, zh: m[2] });
  }
  return hits;
}

for (const name of ['auxiliaryInterfaceReplacements', 'scopedReplacements']) {
  const hits = scanArray(name);
  console.log(`\n${name}: EN 含中文 ${hits.length} 条`);
  hits.forEach(h => console.log(`  L${h.line}: ${h.en.slice(0, 70)}`));
}