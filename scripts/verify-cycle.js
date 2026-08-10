const fs = require('fs');
const path = require('path');
// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glass = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const desk = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.glass.main.js'), 'glass');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.desktop.main.js'), 'desk');
function cnt(src, kw) {
  let i = src.indexOf(kw), n = 0;
  while (i !== -1) { n++; i = src.indexOf(kw, i + kw.length); }
  return n;
}
const rules = [
  ['title:{value:"Cycle model parameter",original:"Cycle model parameter"}', 'title:{value:"循环切换模型参数",original:"循环切换模型参数"}'],
  ['title:"Cycle Model Parameter"', 'title:"循环切换模型参数"'],
  ['label:`Cycle ${EP}`', 'label:`循环切换 ${EP}`'],
  ['\\xB7 Cycle ${En} (${bi})', '\\xB7 循环切换 ${En} (${bi})'],
  ['\\xB7 Cycle ${Jn} (${Lr})', '\\xB7 循环切换 ${Jn} (${Lr})'],
];
for (const [en, zh] of rules) {
  const g = cnt(glass, en), d = cnt(desk, en);
  console.log((g > 0 ? 'G' : ' ') + (d > 0 ? 'D' : ' ') + '  ' + en.padEnd(50) + ' glass:' + g + ' desk:' + d);
}
// 确认 i18n-core 中规则已加入
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');
console.log('\ni18n-core 含 循环切换规则:', src.includes('循环切换模型参数') ? '是' : '否');