const fs = require('fs');
const path = require('path');
// clp 缓存路径
const clpRoot = 'C:/Users/ouli/AppData/Roaming/Cursor/clp';
// 找 zh-cn 目录下的 nls.messages.json
function findNls() {
  const results = [];
  for (const dir of fs.readdirSync(clpRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/zh/i.test(dir.name)) continue;
    const dpath = path.join(clpRoot, dir.name);
    for (const e of fs.readdirSync(dpath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dpath, e.name, 'nls.messages.json');
      if (fs.existsSync(p)) results.push(p);
    }
  }
  return results;
}
const files = findNls();
console.log('clp nls 文件:', files);
for (const p of files) {
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('\n=== ' + p + ' (长度 ' + arr.length + ') ===');
  const targets = ['Close Window', 'Zen Mode', 'Render Whitespace', 'Agents Window', 'New Agents Window'];
  for (const t of targets) {
    const idx = arr.indexOf(t);
    if (idx !== -1) console.log('  [' + idx + '] "' + t + '" ← 英文未翻译');
  }
  // 统计中英文
  let zh = 0, en = 0;
  for (const v of arr) if (typeof v === 'string') /[\u4e00-\u9fa5]/.test(v) ? zh++ : en++;
  console.log('  中文: ' + zh + ' / 英文: ' + en);
}