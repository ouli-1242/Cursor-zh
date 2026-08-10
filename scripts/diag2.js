const fs = require('fs');
const path = require('path');

const appPath = process.argv[2] || 'D:\\Program Files\\cursor\\resources\\app';

// 所有需要诊断的文件
const filesToCheck = {
    'main.js (electron主进程)': path.join(appPath, 'out\\main.js'),
    'workbench.desktop.main.js': path.join(appPath, 'out\\vs\\workbench\\workbench.desktop.main.js.backup'),
    'workbench.glass.main.js': path.join(appPath, 'out\\vs\\workbench\\workbench.glass.main.js.backup'),
};

// 需要查找的词
const terms = ['Home', 'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All', 'Collapse All', 'Connect SSH', 'Connect WSL', 'Docs'];

for (const [name, filePath] of Object.entries(filesToCheck)) {
    // 优先检查 .backup
    let p = filePath;
    if (!fs.existsSync(p)) p = filePath + '.backup';
    if (!fs.existsSync(p)) {
        console.log(`\n=== ${name}: 文件不存在 (${filePath}) ===`);
        continue;
    }
    const content = fs.readFileSync(p, 'utf8');
    console.log(`\n=== ${name} (${(content.length/1024/1024).toFixed(1)}MB) ===`);

    for (const term of terms) {
        // 找前5个出现位置
        const results = [];
        const patterns = [
            // 各种可能的形式
            new RegExp('(["\'`])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\1', 'g'),
            new RegExp('>' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<', 'g'),
        ];
        
        // 先直接搜索
        let idx = 0;
        const seen = new Set();
        for (let pass = 0; pass < 20; pass++) {
            const found = content.indexOf(term, idx);
            if (found === -1) break;
            
            // 检查前后文是不是键盘扫描表
            const before = content.slice(Math.max(0, found - 25), found);
            const after = content.slice(found + term.length, found + term.length + 25);
            
            // 跳过键盘扫描表 [数字,"Term",数字,...]
            if (/\[\d+,"$/.test(before) && /",\d+,"/.test(after)) {
                idx = found + term.length;
                continue;
            }
            // 跳过键盘事件 .key==="Home"
            if (/\.key==="$/.test(before) || /key\.startsWith\("$/.test(before)) {
                idx = found + term.length;
                continue;
            }
            // 跳过 VK_HOME 等
            if (/VK_$/.test(before)) {
                idx = found + term.length;
                continue;
            }
            
            const ctx = content.slice(Math.max(0, found - 50), found + term.length + 50);
            const key = Math.max(0, found - 50);
            if (!seen.has(key)) {
                seen.add(key);
                results.push(ctx.replace(/\s+/g, ' ').substring(0, 200));
            }
            if (results.length >= 3) break;
            idx = found + term.length;
        }

        if (results.length > 0) {
            console.log(`\n  "${term}" (${results.length}处非键位):`);
            results.forEach((ctx, i) => console.log(`     [${i+1}] ...${ctx}...`));
        }
    }
}

// 也检查 nls.messages.json
const nlsPath = path.join(appPath, 'out\\nls.messages.json.backup');
if (fs.existsSync(nlsPath)) {
    const nls = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
    console.log('\n=== nls.messages.json ===');
    for (const term of terms) {
        const matches = [];
        nls.forEach((item, i) => {
            if (item === term || item === '&&' + term) {
                matches.push({ id: i, text: item });
            }
        });
        // 也搜包含的
        if (matches.length === 0) {
            nls.forEach((item, i) => {
                if (typeof item === 'string' && item.includes(term) && item.length < term.length + 30) {
                    matches.push({ id: i, text: item });
                }
            });
        }
        if (matches.length > 0) {
            console.log(`  "${term}": ${matches.length}处`);
            matches.slice(0, 5).forEach(m => console.log(`     id=${m.id}: "${m.text}"`));
        } else {
            console.log(`  "${term}": 未找到`);
        }
    }
}
