const fs = require('fs');
const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const rules = [
  ['title:E({key:"glassOsEditUndo",comment:["&& denotes a mnemonic"]},"&&Undo")', 'title:"撤销"'],
  ['title:E({key:"glassOsEditRedo",comment:["&& denotes a mnemonic"]},"&&Redo")', 'title:"重做"'],
  ['title:E({key:"glassOsEditCut",comment:["&& denotes a mnemonic"]},"Cu&&t")', 'title:"剪切"'],
  ['title:E({key:"glassOsEditCopy",comment:["&& denotes a mnemonic"]},"&&Copy")', 'title:"复制"'],
  ['title:E({key:"glassOsEditPaste",comment:["&& denotes a mnemonic"]},"&&Paste")', 'title:"粘贴"'],
  ['title:E({key:"glassOsEditSelectAll",comment:["&& denotes a mnemonic"]},"Select &&All")', 'title:"全选"'],
];
let found = 0;
for (const [en, zh] of rules) {
  const idxs = [];
  let i = glass.indexOf(en);
  while (i !== -1) { idxs.push(i); i = glass.indexOf(en, i + en.length); }
  console.log((idxs.length > 0 ? '命中' : '未命中').padEnd(4), String(idxs.length).padEnd(2), en.slice(0, 50));
  found += idxs.length;
}
console.log('总命中:', found);