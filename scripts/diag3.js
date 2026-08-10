const fs = require('fs');
const path = require('path');
const appPath = process.argv[2] || 'D:\\Program Files\\cursor\\resources\\app';

// 检查翻译后的文件状态
const targets = [
    'out\\nls.messages.json',
    'out\\vs\\workbench\\workbench.desktop.main.js',
    'out\\vs\\workbench\\workbench.glass.main.js',
];

const checks = [
    // NLS 菜单项
    { term: '"Undo"', nls: true, label: 'Undo in NLS' },
    { term: '"Redo"', nls: true, label: 'Redo in NLS' },
    { term: '"Cut"', nls: true, label: 'Cut in NLS' },
    { term: '"Copy"', nls: true, label: 'Copy in NLS' },
    { term: '"Paste"', nls: true, label: 'Paste in NLS' },
    { term: '"Select All"', nls: true, label: 'Select All in NLS' },
    { term: '"Collapse All"', nls: true, label: 'Collapse All in NLS' },
    // 中文翻译是否存在
    { term: '"撤销"', zh: true, label: '撤销 中文存在' },
    { term: '"重做"', zh: true, label: '重做 中文存在' },
    { term: '"剪切"', zh: true, label: '剪切 中文存在' },
];

for (const rel of targets) {
    const p = path.join(appPath, rel);
    if (!fs.existsSync(p)) {
        console.log(`${rel}: 不存在`);
        continue;
    }
    let content;
    try {
        content = fs.readFileSync(p, 'utf8');
    } catch(e) {
        console.log(`${rel}: 读取失败`);
        continue;
    }

    console.log(`\n=== ${rel} (${(content.length/1024/1024).toFixed(1)}MB) ===`);

    // 检查关键英文是否还存在
    const enTerms = ['"Undo"', '"Redo"', '"Cut"', '"Copy"', '"Paste"', '"Select All"', '"Collapse All"', '"Connect SSH"', '"Connect WSL"', '"Home"', '"Docs"'];
    for (const t of enTerms) {
        const count = (content.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (count > 0) {
            // 找上下文
            const idx = content.indexOf(t);
            const ctx = content.slice(Math.max(0, idx - 40), idx + t.length + 40).replace(/\s+/g, ' ').substring(0, 150);
            console.log(`  英文 "${t}": ${count}处, 例: ...${ctx}...`);
        }
    }
    
    // 检查中文是否存在
    const zhTerms = ['"撤销"', '"重做"', '"剪切"', '"粘贴"', '"全选"', '"全部折叠"', '"克隆仓库"', '"连接 SSH"', '"连接 WSL"', '"文档"', '"首页"', '"仓库"'];
    for (const t of zhTerms) {
        const count = (content.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        console.log(`  中文 ${t}: ${count}处`);
    }
}

// 专门搜索Home在glass.js中的UI上下文
console.log('\n=== 专门搜索 Home UI 上下文 ===');
const glassPath = path.join(appPath, 'out\\vs\\workbench\\workbench.glass.main.js.backup');
if (fs.existsSync(glassPath)) {
    const gc = fs.readFileSync(glassPath, 'utf8');
    // 搜索带icon的Home（房子图标）或label/title/children形式
    const patterns = [
        /label:"Home"/g,
        /title:"Home"/g,
        /children:"Home"/g,
        />"Home"</g,
        /name:"Home"/g,
        /aria-label:"Home"/g,
        /ariaLabel:"Home"/g,
        /text:"Home"/g,
    ];
    for (const re of patterns) {
        let m;
        let count = 0;
        while ((m = re.exec(gc)) !== null && count < 3) {
            count++;
            const ctx = gc.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' ').substring(0, 200);
            console.log(`  ${re.source}: ...${ctx}...`);
        }
    }
}

// 搜索Docs的UI上下文
console.log('\n=== 专门搜索 Docs UI 上下文 ===');
const mainPath = path.join(appPath, 'out\\vs\\workbench\\workbench.desktop.main.js.backup');
if (fs.existsSync(mainPath)) {
    const mc = fs.readFileSync(mainPath, 'utf8');
    // Docs在侧边栏，可能是 type:"doc" 或 Epi={docs:"Docs"...}
    // 看之前诊断：Epi={docs:"Docs",contact:"Contact"}
    const docPatterns = [
        /docs:"Docs"/g,
        /"doc":"Docs"/g,
        /title:"Docs"/g,
        /label:"Docs"/g,
        /children:"Docs"/g,
        /name:"Docs"/g,
        /tooltip:"Docs"/g,
    ];
    for (const re of docPatterns) {
        let m;
        let count = 0;
        while ((m = re.exec(mc)) !== null && count < 3) {
            count++;
            const ctx = mc.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' ').substring(0, 200);
            console.log(`  ${re.source} (main): ...${ctx}...`);
        }
    }
}
