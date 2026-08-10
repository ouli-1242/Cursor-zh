// 生成 clp 语言包缓存的未翻译英文清单
const fs = require('fs');
const path = require('path');
const clpRoot = 'C:/Users/ouli/AppData/Roaming/Cursor/clp';

// 找 zh 目录下的 nls.messages.json
function findNls() {
  const results = [];
  for (const dir of fs.readdirSync(clpRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/zh/i.test(dir.name)) continue;
    const dpath = path.join(clpRoot, dir.name);
    for (const e of fs.readdirSync(dpath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dpath, e.name, 'nls.messages.json');
      if (fs.existsSync(p)) results.push(p);
    }
  }
  return results;
}

// 已覆盖的词典（避免重复列出已翻译的）
const dict = require(path.join(__dirname, '..', 'src', 'dict.js'));
const covered = new Set([...Object.keys(dict.safeGlobalDict), ...Object.keys(dict.nativeNlsDict)]);

const files = findNls();
const all = new Map(); // 英文 -> count
for (const p of files) {
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    if (/[\u4e00-\u9fa5]/.test(v)) continue;            // 已翻译
    if (/^[\d\s%.,+-]+$/.test(v)) continue;              // 纯数字
    if (/[\\/]/.test(v)) continue;                       // 路径
    if (/^[a-z][a-zA-Z0-9]*$/.test(v)) continue;         // 标识符
    if (/^[A-Z][A-Z0-9_]+$/.test(v)) continue;           // 常量
    if (/https?:|\.com|\.org|\.io/.test(v)) continue;
    if (!/[a-zA-Z]/.test(v)) continue;
    if (!v.includes(' ')) continue;                      // 单词跳过（短词污染风险）
    if (covered.has(v)) continue;                        // 已在词典
    if (all.has(v)) all.get(v).count++;
    else all.set(v, { count: 1 });
  }
}

const sorted = [...all.entries()].sort((a, b) => b[1].count - a[1].count);
const high = sorted.filter(([, v]) => v.count >= 2);
const low = sorted.filter(([, v]) => v.count === 1);

let md = `# clp 语言包缓存未翻译英文清单\n\n> 来源: %APPDATA%\\Cursor\\clp\\...zh-cn\\<commit>\\nls.messages.json\n> 官方 zh-hans 语言包未翻译的 Cursor 词条（界面实际 nls 来源）。已排除已加入词典的词条、单词、路径/URL。\n\n`;
md += `共 ${sorted.length} 条（出现≥2次 ${high.length}、1次 ${low.length}）\n\n`;
md += `## 出现 ≥2 次\n\n| 次数 | 英文 | 建议翻译 |\n|---|---|---|\n`;
for (const [k, v] of high) md += `| ${v.count} | ${k} |  |\n`;
md += `\n## 出现 1 次\n\n| 英文 | 建议翻译 |\n|---|---|\n`;
for (const [k] of low.slice(0, 400)) md += `| ${k} |  |\n`;
if (low.length > 400) md += `\n...（共 ${low.length} 条，仅显示前 400）\n`;

const outPath = 'C:/Users/ouli/Desktop/clp未翻译清单.md';
fs.writeFileSync(outPath, md, 'utf8');
console.log('已写入:', outPath, '| 总:', sorted.length, '| ≥2次:', high.length, '| 1次:', low.length);