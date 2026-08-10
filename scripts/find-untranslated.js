const fs = require('fs');
const path = require('path');

// 备份文件路径
const cursorPath = 'D:\\Program Files\\Cursor\\resources\\app';
const backupMain = path.join(cursorPath, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.desktop.main.js.backup');
const backupGlass = path.join(cursorPath, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.glass.main.js.backup');
const backupNls = path.join(cursorPath, 'out', 'nls.messages.json.backup');

// 已有的常见英文UI文本候选列表
const commonUiTerms = [
    // 菜单相关
    'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All',
    // 视图相关
    'Home', 'Collapse All', 'Docs',
    // 连接相关
    'Connect SSH', 'Connect WSL', 'Clone Repository',
    // 按钮和操作
    'Import', 'Export', 'Refresh', 'Search', 'Settings',
    'Open', 'Close', 'New', 'Delete', 'Save', 'Cancel', 'OK',
    'Yes', 'No', 'Apply', 'Reset', 'Submit', 'Confirm',
    // Agents相关
    'Recent', 'Agents', 'Plan', 'Debug', 'Multitask', 'Ask',
    // 文件和文件夹
    'File', 'Folder', 'Workspace', 'Repository',
    // 其他常见UI
    'Loading', 'Error', 'Warning', 'Success', 'Info',
    'Show', 'Hide', 'Toggle', 'Expand', 'Minimize', 'Maximize',
    'Select', 'Deselect', 'Check', 'Uncheck',
    'Enabled', 'Disabled', 'On', 'Off',
    'All', 'None', 'Some', 'Any',
    'First', 'Last', 'Previous', 'Next',
    'Up', 'Down', 'Left', 'Right',
    'Add', 'Remove', 'Edit', 'Create', 'Update',
    'Start', 'Stop', 'Pause', 'Resume', 'Continue',
    'Connect', 'Disconnect', 'Attach', 'Detach',
    'Upload', 'Download', 'Install', 'Uninstall',
    'Run', 'Build', 'Test', 'Debug', 'Deploy',
    'Commit', 'Push', 'Pull', 'Fetch', 'Merge', 'Rebase',
    'Branch', 'Tag', 'Stash', 'Stage', 'Unstage',
    'Discard', 'Restore', 'Revert', 'Reset',
    'Changes', 'Modified', 'Added', 'Deleted', 'Renamed', 'Untracked',
    'Uncommitted', 'Staged', 'Unstaged',
    'Terminal', 'Console', 'Output', 'Problems', 'Debug Console',
    'Explorer', 'Search', 'Source Control', 'Run and Debug', 'Extensions',
    'Marketplace', 'Canvas', 'Composer',
    // 模式描述
    'Plan Mode', 'Debug Mode', 'Multitask Mode', 'Ask Mode',
    // 具体描述文本
    'Generate an implementation plan',
    'Systematically diagnose and fix bugs using runtime traces',
    'Automatically import necessary modules for TypeScript',
    'Thinking intensity',
    'Open config'
];

function findUntranslated(filePath, label) {
    console.log(`\n===== Checking ${label} =====\n`);
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    
    for (const term of commonUiTerms) {
        // 检查是否作为独立UI文本出现（在引号内）
        const patterns = [
            new RegExp(`"${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'),
            new RegExp(`'${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g'),
            new RegExp(`:${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,}"]`, 'g')
        ];
        
        let totalMatches = 0;
        for (const pattern of patterns) {
            const matches = content.match(pattern);
            if (matches) totalMatches += matches.length;
        }
        
        if (totalMatches > 0) {
            results.push({ term, count: totalMatches });
        }
    }
    
    // 按出现次数排序
    results.sort((a, b) => b.count - a.count);
    
    for (const { term, count } of results) {
        console.log(`${term}: ${count} occurrences`);
    }
}

findUntranslated(backupMain, 'workbench.desktop.main.js.backup');
findUntranslated(backupGlass, 'workbench.glass.main.js.backup');
findUntranslated(backupNls, 'nls.messages.json.backup');
