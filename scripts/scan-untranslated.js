// 扫描当前汉化文件中 UI 属性里仍是英文的值（未翻译候选）
const fs = require('fs');
const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const WB = path.join(APP_ROOT, 'out/vs/workbench');
const glass = fs.readFileSync(path.join(WB, 'workbench.glass.main.js'), 'utf8');
const desk = fs.readFileSync(path.join(WB, 'workbench.desktop.main.js'), 'utf8');

// UI 属性
const attrs = ['children', 'label', 'title', 'placeholder', 'aria-label', 'tooltip', 'message', 'hintText', 'text', 'description', 'actionTitle', 'primaryLabel'];

function extract(src, name) {
  const found = new Map(); // phrase -> {count, example}
  for (const attr of attrs) {
    const re = new RegExp(`(?:${attr}):"([^"]{3,80})"`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = m[1];
      // 过滤：含中文（已翻译）、纯数字、URL/路径/代码标识符
      if (/[\u4e00-\u9fff]/.test(val)) continue;           // 已翻译
      if (/^[\d\s%.,+-]+$/.test(val)) continue;             // 纯数字
      if (/[\\/]/.test(val)) continue;                       // 路径
      if (/^[a-z][a-zA-Z0-9]*$/.test(val)) continue;         // 驼峰/标识符
      if (/^[A-Z][A-Z0-9_]+$/.test(val)) continue;           // 常量
      if (/https?:|\.com|\.org|\.io|\.json|\.md|\.ts|\.js/.test(val)) continue;
      if (!/[a-zA-Z]/.test(val)) continue;
      // 必须是英文句子（含空格 > 0 或 特定短词）
      if (!val.includes(' ')) continue;
      const key = val;
      if (found.has(key)) found.get(key).count++;
      else found.set(key, { count: 1 });
    }
  }
  // 输出
  const sorted = [...found.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`===== ${name} 未翻译 UI 候选（${sorted.length} 个） =====`);
  for (const [val, { count }] of sorted.slice(0, 80)) {
    console.log(String(count).padStart(3) + '  ' + val);
  }
}

extract(glass, 'glass');
console.log('\n');
extract(desk, 'desk');