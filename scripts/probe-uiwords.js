const fs = require('fs');
const glass = fs.readFileSync('D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js', 'utf8');
const targets = [
  ['Local', /(children|label|title|aria-label):"Local"|>Local</g],
  ['Private', /(label|title|aria-label):"Private"|>Private</g],
  ['Disabled', /(label|children|title):"Disabled"|>Disabled</g],
  ['Delete', /(label|title|tooltip|hintText|aria-label):"Delete"|>Delete</g],
  ['Personal', /(label|title):"Personal"|>Personal</g],
];
for (const [kw, re] of targets) {
  console.log('=== ' + kw + ' ===');
  let m, n = 0; const seen = new Set();
  while ((m = re.exec(glass)) !== null && n < 4) {
    const pos = m.index;
    const ctx = glass.slice(Math.max(0, pos - 40), pos + 30).replace(/\n/g, ' ');
    if (seen.has(ctx)) continue; seen.add(ctx);
    console.log('• ' + ctx); n++;
  }
  if (n === 0) console.log('  (无 UI 形式)');
}