const fs = require('fs');
const path = require('path');

// Cursor 安装根目录（默认 D: 盘，可用 argv[2] 覆盖）
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const glass = fs.readFileSync(path.join(APP_ROOT, 'out/vs/workbench/workbench.glass.main.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n-core.js'), 'utf8');

// 6 个 glass 原生编辑菜单条目（3.15 构建函数名是 T，旧版是 E，两种都覆盖）
const entries = [
  ['glassOsEditUndo', '"&&Undo"'],
  ['glassOsEditRedo', '"&&Redo"'],
  ['glassOsEditCut', '"Cu&&t"'],
  ['glassOsEditCopy', '"&&Copy"'],
  ['glassOsEditPaste', '"&&Paste"'],
  ['glassOsEditSelectAll', '"Select &&All"'],
];

let found = 0;
let missingRule = false;
for (const [key, text] of entries) {
  const ctx = `{key:"${key}",comment:["&& denotes a mnemonic"]},${text}`;
  const eForm = `title:E(${ctx})`;
  const tForm = `title:T(${ctx})`;

  // 1) i18n-core.js 源里 E 与 T 两种规则都必须存在（防 probe 与管线漂移）
  const inSrcE = i18nSrc.includes(`'${eForm}'`);
  const inSrcT = i18nSrc.includes(`'${tForm}'`);
  if (!inSrcE || !inSrcT) {
    console.log('规则缺失!', key, 'E:', inSrcE ? '有' : '无', 'T:', inSrcT ? '有' : '无');
    missingRule = true;
  }

  // 2) glass bundle 里两种形态的字面命中
  for (const [label, form] of [['E', eForm], ['T', tForm]]) {
    const idxs = [];
    let i = glass.indexOf(form);
    while (i !== -1) { idxs.push(i); i = glass.indexOf(form, i + form.length); }
    console.log((idxs.length > 0 ? '命中' : '未命中').padEnd(4), String(idxs.length).padEnd(2), `${label}  ${form.slice(0, 60)}`);
    found += idxs.length;
  }
}
console.log('总命中:', found);
console.log(missingRule ? '⚠️ 存在源缺失规则' : '✅ 所有规则在 i18n-core.js 中齐全');