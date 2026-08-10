const fs = require('fs');

const APP = 'D:/Program Files/cursor/resources/app';
const terms = [
  'Always Run', 'Manage Usage', 'Move to folder', 'Search or enter URL',
  'Invite by email', 'Close Window', 'Open Composer Settings',
  'Fix with Agent', 'Copy remote URL', 'Connect Slack',
  'Delete chat', 'Clear History', 'Got it',
  'New Chat', 'Clear Search', 'Copy Branch',
  'Copy URL', 'View All', 'Clear all',
  'Dismiss', 'Cancel All',
];

for (const file of ['workbench.glass.main.js', 'workbench.desktop.main.js']) {
  const c = fs.readFileSync(APP + '/out/vs/workbench/' + file, 'utf8');
  console.log(`\n========== ${file} ==========`);
  for (const t of terms) {
    const hits = [];
    let idx = 0;
    while ((idx = c.indexOf(t, idx)) >= 0 && hits.length < 3) {
      const start = Math.max(0, idx - 35);
      hits.push(c.substring(start, start + Math.min(110, c.length - start)));
      idx += t.length;
    }
    if (hits.length) {
      console.log(`\n### "${t}" x${hits.length}`);
      hits.forEach(h => console.log('  - ' + h));
    }
  }
}