const fs = require('fs');
const s = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const kws = ['} added', '} deleted', ' added,', 'deleted)', 'added`', 'deleted`', 'tabLinesAdded', 'tabLinesDeleted'];
for (const kw of kws) {
  let i = s.indexOf(kw), n = 0;
  while (i !== -1 && n < 4) {
    const ctx = s.slice(Math.max(0, i - 45), i + 30).replace(/\n/g, ' ');
    if (/addToken|addClass|addEventListener|addDisposable/.test(ctx)) { i = s.indexOf(kw, i + kw.length); continue; }
    console.log('[' + kw + '] ' + ctx);
    n++;
    i = s.indexOf(kw, i + kw.length);
  }
  if (n === 0) console.log('[' + kw + '] 无');
}