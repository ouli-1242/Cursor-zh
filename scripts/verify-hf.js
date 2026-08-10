const fs = require('fs');
const path = require('path');

// 从 i18n-core.js 提取内部结构,模拟实际替换顺序,验证:
// 1. 替换后脚本括号结构仍平衡(不破坏代码)
// 2. 无残留英文 UI 词条
//
// 与旧实现的差异:
// 旧实现用逐条 split/join 应用规则,受限于性能把 aux 截断在
// general:"General"(2521 条只测前 333 条)并跳过 'Unknown error' 规则。
// 现改为与 translateAuxiliaryJsFile 完全相同的单次 mega-regex(lookup 替换),
// 完整覆盖全部规则,单次扫描 46MB 包 <2s。
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
let hits = 0;
const out = glass.replace(regex, (match) => {
  hits++;
  return lookup.get(match);
});
console.log(`规则数: ${valid.length}  命中: ${hits}  用时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 词条残留检查。
// 排除两类伪装者:
//  - en 含中文的重译规则(如 '"AI 代码追踪统计 - Tab"'→'...补全'),英文全新包上不触发,但会误报
//  - 命中数为 0 的规则(其 en 未出现在输出里才算"已覆盖";出现在输出里即为真残留)
const enSet = [...new Set(valid.map(([en]) => en))].filter(en => !hasCJK(en));
const zeroHit = valid.filter(([en]) => !glass.includes(en)).length;
const remaining = enSet.filter(en => out.includes(en));
console.log('残留英文:', remaining.length, '  (0 命中规则:', zeroHit, '条)');
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