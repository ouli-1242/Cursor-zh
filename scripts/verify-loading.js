const fs = require('fs');
const path = require('path');
// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glass = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const desk = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.glass.main.js'), 'glass');
require('./lib/bundle-state').checkBundle(path.join(WB, 'workbench.desktop.main.js'), 'desk');
const rules = [
  ['"Loading changes..."', '正在加载更改'],
  ['"Loading changes"', '正在加载更改'],
  ['"Loading cloud agent changes"', '云智能体更改'],
  ['"Preparing workspace"', '准备工作区'],
  ['"Send follow-up with subagent"', '带子代理'],
  ['"Continue chatting in Cursor"', 'Cursor 中继续聊天'],
  ['"Send follow-up"', '发送追问'],
];
function cnt(src, kw) {
  let i = src.indexOf(kw), n = 0;
  while (i !== -1) { n++; i = src.indexOf(kw, i + kw.length); }
  return n;
}
for (const [en, zh] of rules) {
  const g = cnt(glass, en), d = cnt(desk, en);
  console.log((g > 0 ? 'G' : ' ') + (d > 0 ? 'D' : ' ') + '  ' + en.padEnd(30) + ' glass:' + g + ' desk:' + d);
}
console.log('--- Agent Mode title 翻译规则（应 false） ---');
console.log(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8').includes("['title:\"Agent Mode\"'"));