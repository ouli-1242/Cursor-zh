const fs = require('fs');
const path = require('path');

const cursorPath = process.argv[2] || 'd:\\Program Files\\cursor\\resources\\app';
const backupMain = path.join(cursorPath, 'out', 'vs', 'workbench', 'workbench.desktop.main.js.backup');
const backupGlass = path.join(cursorPath, 'out', 'vs', 'workbench', 'workbench.glass.main.js.backup');

// 精确搜索的模式
const patterns = [
    // Undo相关
    { regex: /children:"Undo"/g, desc: 'children:"Undo"' },
    { regex: /children:"Redo"/g, desc: 'children:"Redo"' },
    { regex: /reject:"Undo"/g, desc: 'reject:"Undo"' },
    { regex: /\?"Undo":"Undo All"/g, desc: '?"Undo":"Undo All"' },
    { regex: /\?"Undo Cell":"Undo"/g, desc: '?"Undo Cell":"Undo"' },
    { regex: /label:"Undo"/g, desc: 'label:"Undo"' },
    { regex: /label:"Redo"/g, desc: 'label:"Redo"' },
    
    // Home/Collapse/Docs/Connect
    { regex: /children:"Home"/g, desc: 'children:"Home"' },
    { regex: /children:"Collapse All"/g, desc: 'children:"Collapse All"' },
    { regex: /children:"Docs"/g, desc: 'children:"Docs"' },
    { regex: /children:"Connect SSH"/g, desc: 'children:"Connect SSH"' },
    { regex: /children:"Connect WSL"/g, desc: 'children:"Connect WSL"' },
    { regex: /title:"Home"/g, desc: 'title:"Home"' },
    { regex: /title:"Collapse All"/g, desc: 'title:"Collapse All"' },
    { regex: /label:"Home"/g, desc: 'label:"Home"' },
    { regex: /label:"Collapse All"/g, desc: 'label:"Collapse All"' },
    
    // NLS函数调用形式 E("id","Text")
    { regex: /E\("undo","Undo"\)/g, desc: 'E("undo","Undo")' },
    { regex: /E\("redo","Redo"\)/g, desc: 'E("redo","Redo")' },
    { regex: /E\("cut","Cut"\)/g, desc: 'E("cut","Cut")' },
    { regex: /E\("copy","Copy"\)/g, desc: 'E("copy","Copy")' },
    { regex: /E\("paste","Paste"\)/g, desc: 'E("paste","Paste")' },
    { regex: /E\("selectAll","Select All"\)/g, desc: 'E("selectAll","Select All")' },
    
    // 右键菜单label
    { regex: /label:"Undo"/g, desc: 'label:"Undo"' },
    { regex: /label:"Redo"/g, desc: 'label:"Redo"' },
    { regex: /label:"Copy Message"/g, desc: 'label:"Copy Message"' },
];

function checkFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`\n===== ${label} =====`);
    
    for (const { regex, desc } of patterns) {
        const matches = content.match(regex);
        if (matches && matches.length > 0) {
            console.log(`  ✅ ${desc}: ${matches.length} 处`);
            
            // 显示第一个匹配的上下文
            regex.lastIndex = 0;
            const match = regex.exec(content);
            if (match) {
                const idx = match.index;
                const start = Math.max(0, idx - 60);
                const end = Math.min(content.length, idx + match[0].length + 60);
                const ctx = content.slice(start, end).replace(/\s+/g, ' ');
                console.log(`     上下文: ...${ctx}...`);
            }
        }
    }
}

checkFile(backupMain, 'workbench.desktop.main.js.backup');
checkFile(backupGlass, 'workbench.glass.main.js.backup');
