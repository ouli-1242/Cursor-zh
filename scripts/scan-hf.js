const fs = require('fs');
const path = require('path');

const APP = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const terms = [
  'Unknown error',
  'Create PR', 'Create PRs',
  'Copy Link',
  'Start New Chat', 'Start New Chat?',
  'Checkout Branch',
  'Open Agent',
  'Copy ID',
  'Connect GitHub',
  'Open as Editor',
  'Clear override',
  'Add to Home',
  'Continue Anyway',
  'Grant repository access',
  'Clear search',
  'Connect your Repos to Cursor',
];

const files = {
  glass: path.join(APP, 'out/vs/workbench/workbench.glass.main.js'),
  desk: path.join(APP, 'out/vs/workbench/workbench.desktop.main.js'),
};

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) { console.log(`SKIP ${name}: not found`); continue; }
  const c = fs.readFileSync(file, 'utf8');
  console.log(`\n========== ${name} ==========`);
  for (const t of terms) {
    let idx = 0, count = 0;
    const hits = [];
    while ((idx = c.indexOf(t, idx)) >= 0 && count < 6) {
      const start = Math.max(0, idx - 60);
      const len = Math.min(180, c.length - start);
      hits.push(c.substring(start, start + len).replace(/\n/g, '\\n'));
      idx += t.length; count++;
    }
    if (hits.length) {
      console.log(`\n### "${t}" x${count}`);
      hits.forEach(h => console.log('  - ' + h));
    }
  }
}
