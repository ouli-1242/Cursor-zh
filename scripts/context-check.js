const fs = require('fs');
const path = require('path');

// 备份文件路径
const cursorPath = 'd:\\Program Files\\cursor\\resources\\app';
const backupMain = path.join(cursorPath, 'out', 'vs', 'workbench', 'workbench.desktop.main.js.backup');
const backupGlass = path.join(cursorPath, 'out', 'vs', 'workbench', 'workbench.glass.main.js.backup');

// 要检查的未翻译文本列表
const termsToCheck = [
    'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All',
    'Home', 'Collapse All', 'Docs',
    'Connect SSH', 'Connect WSL', 'Clone Repository'
];

function showContext(filePath, label, term) {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    
    // 转义正则特殊字符
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // 查找所有可能的上下文形式
    const patterns = [
        // 属性形式：title:"Undo" 或 label:"Undo"
        new RegExp(`.{0,80}["']${escaped}["'].{0,80}`, 'g'),
        // 三元表达式形式：?"Undo":"Undo All"
        new RegExp(`.{0,80}\\?"${escaped}".{0,80}`, 'g'),
        // 构造函数形式：new ks("undo","Undo"
        new RegExp(`.{0,80}${escaped}.{0,80}`, 'g')
    ];
    
    console.log(`\n=== ${label}: "${term}" ===\n`);
    
    let found = false;
    for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        let match;
        let count = 0;
        while ((match = pattern.exec(content)) !== null && count < 5) {
            // 排除键盘扫描表（包含数字索引的数组）
            const context = match[0];
            if (/\[\d+,\d+,/.test(context) || /VK_/.test(context)) {
                continue;
            }
            console.log(`[pattern ${i}]: ...${context}...`);
            found = true;
            count++;
        }
    }
    
    if (!found) {
        console.log('Not found in UI context');
    }
}

for (const term of termsToCheck) {
    showContext(backupMain, 'main.js', term);
    showContext(backupGlass, 'glass.js', term);
}
