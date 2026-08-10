const fs = require('fs');
const src = fs.readFileSync('src/i18n-core.js', 'utf8');
const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const desk = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js', 'utf8');
function cnt(s, k) { let i = s.indexOf(k), n = 0; while (i !== -1) { n++; i = s.indexOf(k, i + k.length); } return n; }
// 从 i18n-core 提取含 Done 的规则
const lines = src.split('\n').filter(l => l.includes('Done') && l.includes(','));
const re = /\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/;
const seen = new Set();
for (const l of lines) {
  const m = l.match(re);
  if (!m) continue;
  const en = m[1], zh = m[2];
  if (seen.has(en)) continue;
  seen.add(en);
  const g = cnt(glass, en), d = cnt(desk, en);
  if (g > 0 || d > 0) console.log((g ? 'G' : '.') + (d ? 'D' : '.') + '  ' + JSON.stringify(en) + '  glass:' + g + ' desk:' + d);
}