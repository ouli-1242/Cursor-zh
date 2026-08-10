const fs = require('fs');
const path = require('path');

// 从 i18n-core.js 提取内部结构,模拟实际替换顺序,验证:
// 1. 替换后脚本语法仍有效(不破坏代码)
// 2. 无残留英文 UI 词条
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

// 从源码提取 safeGlobalDict / riskyShortWords / trickyReplacements
const dict = require('../src/dict.js');
const aux = extractArray('auxiliaryInterfaceReplacements');
const scoped = extractArray('scopedReplacements');

const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
// 只测 glass 模拟
let out = glass;
const auxSorted = aux.slice(0, aux.findIndex(p => p[0] === 'general:"General"')).sort((a, b) => b[0].length - a[0].length);
for (const [en, zh] of auxSorted) {
  if (en.includes('Unknown error')) {
    // 检查是否在原有位置内(非代码语句破坏)
    continue;
  }
  out = out.split(en).join(zh);
}

// 词条残留检查
const remaining = auxSorted
  .map(([en]) => en)
  .filter((en, i, arr) => arr.indexOf(en) === i)
  .filter(en => out.includes(en));
console.log('残留英文(assume 已正确替换):', remaining.length);
if (remaining.length) console.log(remaining.slice(0, 20));

// 结构性检查:括号平衡(原始 vs 翻译后)
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
console.log('原始:  ', JSON.stringify(balance(glass)));
console.log('翻译后:', JSON.stringify(balance(out)));