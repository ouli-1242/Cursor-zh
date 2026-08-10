const fs = require('fs');

const APP = 'D:/Program Files/cursor/resources/app';
const terms = [
  // 按钮类
  'Fix All', 'Review Again', 'Open settings', 'Install Now', 'Delete chat',
  'Close Chat', 'Close Other Chats', 'Side chats', 'Go back', 'Always Run',
  'Got it', 'Try again', 'Send now', 'Copy Image', 'Download Image',
  'Fix with Agent', 'Find with Agent', 'Fix in Agent', 'Commit Changes',
  'Copy URL', 'Copy remote URL', 'Copy JSON', 'Copy File Path',
  'Open in External Browser', 'Open in IDE', 'Open as Pane', 'Open Virtual Machine',
  'Mark as Read', 'Mark as Ready', 'Rebase merge', 'Merge commit', 'Merge manually',
  // 设置类
  'Default Mode', 'Design Mode', 'New Environment', 'Manage Environments',
  'Edit MCP configuration', 'Delete MCP server', 'Enable Action', 'Scroll to bottom',
  'New session', 'Confirm Action', 'Delete Scheduled Task?', 'Cancel all runs',
  // 状态类
  'No changes', 'Loading context...', 'Loading chat...', 'Needs Attention',
  'Needs authentication', 'Loading suggestion', 'Download request content',
  'Failed to load diff', 'Could not be merged',
  // PR 类
  'Merge commit', 'Rebase merge', 'View setup instructions',
];

for (const file of ['workbench.glass.main.js', 'workbench.desktop.main.js']) {
  const c = fs.readFileSync(APP + '/out/vs/workbench/' + file, 'utf8');
  console.log(`\n========== ${file} ==========`);
  for (const t of terms) {
    const hits = [];
    let idx = 0;
    while ((idx = c.indexOf(t, idx)) >= 0 && hits.length < 5) {
      const start = Math.max(0, idx - 40);
      hits.push(c.substring(start, start + Math.min(150, c.length - start)));
      idx += t.length;
    }
    if (hits.length) {
      console.log(`\n### "${t}" x${hits.length}`);
      hits.forEach(h => console.log('  - ' + h));
    }
  }
}