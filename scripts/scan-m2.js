const fs = require('fs');

const APP = 'D:/Program Files/cursor/resources/app';
const terms = [
  'Run in Cloud', 'Log in', 'Log In', 'New Chat', 'Cancel (esc)', 'No (esc)',
  'Team Pool', 'My Machines', 'Create Cloud Automation', 'Delete Task',
  'Replace Chat', 'Resize sidebar', 'Import Chat', 'Data Sharing',
  'Remove local plugin', 'No changes', 'Open in External',
  'Start New Chat already covered', 'Side chats',
  'Claude Code', 'Import Claude Code Conversations',
];

for (const file of ['workbench.glass.main.js', 'workbench.desktop.main.js']) {
  const c = fs.readFileSync(APP + '/out/vs/workbench/' + file, 'utf8');
  console.log(`\n========== ${file} ==========`);
  for (const t of terms) {
    if (!t || t.includes('already')) continue;
    const hits = [];
    let idx = 0;
    while ((idx = c.indexOf(t, idx)) >= 0 && hits.length < 4) {
      const start = Math.max(0, idx - 40);
      hits.push(c.substring(start, start + Math.min(130, c.length - start)));
      idx += t.length;
    }
    if (hits.length) {
      console.log(`\n### "${t}" x${hits.length}`);
      hits.forEach(h => console.log('  - ' + h));
    }
  }
}