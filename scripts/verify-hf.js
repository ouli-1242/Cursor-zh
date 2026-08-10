const fs = require('fs');
const path = require('path');

// 从 i18n-core.js 提取内部结构,模拟实际替换顺序,验证:
// 1. 替换后脚本括号结构仍平衡(不破坏代码)
// 2. 无残留英文 UI 词条
//
// 与旧实现的差异:
// 旧实现用逐条 split/join,受限于性能把 aux 截断在 general:"General"(只测 333/2521 条)。
// 现改为与 translateAuxiliaryJsFile 完全相同的单次 mega-regex(lookup 替换)。
// 残留检查只对"已触发"的规则做单趟正则扫描——未触发的规则本就不匹配当前包,
// 不算残留;同时避免对 46MB 包做 ~2500 次 includes(O(n×m))。
const src = fs.readFileSync(path.join(__dirname, '../src/i18n-core.js'), 'utf8');

function extractArray(name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.includes(`const ${name} = [`));
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i]) || /\];\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end + 1).join('\n');
  const arrText = block.slice(block.indexOf('['), block.lastIndexOf(']') + 1);
  return eval(arrText);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

// 与 i18n-core.js auxInterfaceMegaRegex 完全相同的构建方式
const aux = extractArray('auxiliaryInterfaceReplacements');
const valid = aux.filter(([en]) => en);
const lookup = new Map(valid);
const regex = new RegExp(
  [...valid].sort((a, b) => b[0].length - a[0].length).map(([en]) => escapeRegExp(en)).join('|'),
  'g'
);

// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const glass = fs.readFileSync(path.join(APP_ROOT, 'out/vs/workbench/workbench.glass.main.js'), 'utf8');

const t0 = Date.now();
const fired = new Set();
const out = glass.replace(regex, (match) => {
  fired.add(match);
  return lookup.get(match);
});
console.log(`规则数: ${valid.length}  命中: ${fired.size} 条唯一规则  用时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 残留检查：只对已触发且 en 不含中文的规则，单趟正则扫描输出
const firedList = [...fired].filter(en => !hasCJK(en));
const t1 = Date.now();
const firedRegex = new RegExp(firedList.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|'), 'g');
const stillPresent = new Set();
let m;
while ((m = firedRegex.exec(out)) !== null) stillPresent.add(m[0]);
const remaining = firedList.filter(en => stillPresent.has(en));
console.log(`残留英文: ${remaining.length}  (0 命中规则: ${valid.length - fired.size})  用时: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
if (remaining.length) console.log(remaining.slice(0, 20));

// 结构性检查:括号相对失衡度在翻译前后必须保持不变。
// (逐字括号计数含字符串内的括号,绝对数量无意义;关键是"翻译是否引入额外失衡")
function balance(s) {
  return {
    po: (s.match(/\(/g) || []).length,
    pc: (s.match(/\)/g) || []).length,
    bo: (s.match(/\{/g) || []).length,
    bc: (s.match(/\}/g) || []).length,
    so: (s.match(/\[/g) || []).length,
    sc: (s.match(/\]/g) || []).length,
  };
}
const b0 = balance(glass), b1 = balance(out);
const imbalanceDelta = {
  '()': (b0.po - b0.pc) - (b1.po - b1.pc),
  '{}': (b0.bo - b0.bc) - (b1.bo - b1.bc),
  '[]': (b0.so - b0.sc) - (b1.so - b1.sc),
};
const preserved = Object.values(imbalanceDelta).every(v => v === 0);
console.log('原始失衡度:  ', JSON.stringify({ '()': b0.po - b0.pc, '{}': b0.bo - b0.bc, '[]': b0.so - b0.sc }));
console.log('翻译后失衡度:', JSON.stringify({ '()': b1.po - b1.pc, '{}': b1.bo - b1.bc, '[]': b1.so - b1.sc }));
console.log(preserved ? '✅ 括号失衡度保持(未引入结构性破坏)' : '⚠️ 括号失衡度变化: ' + JSON.stringify(imbalanceDelta));