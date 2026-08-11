// 验证 src/ui.js 展示组件（捕获返回值断言内容）
const assert = require('assert');
const ui = require('../src/ui.js');

const b = ui.banner('2.0.0');
assert.ok(b.includes('Cursor-zh'), 'banner 应含标题');
assert.ok(b.includes('v2.0.0'), 'banner 应含版本号');

assert.ok(ui.step(1, 3, '检测').includes('步骤 1/3'), 'step 应含步骤编号');
assert.ok(ui.ok('x').includes('●'), 'ok 应含圆点');
assert.ok(ui.warn('x').includes('●'), 'warn 应含圆点');
assert.ok(ui.err('x').includes('●'), 'err 应含圆点');
assert.ok(ui.info('x').includes('●'), 'info 应含圆点');
assert.ok(ui.section('常见问题').includes('常见问题'), 'section 应含标题');
assert.ok(ui.divider().includes('─'), 'divider 应含横线');

assert.strictEqual(ui.displayWidth('abc'), 3, 'ASCII 按 1');
assert.strictEqual(ui.displayWidth('中文'), 4, '中文按 2');

const fl = ui.fileList([
  { left: ui.info('安装路径'), right: 'D:/x' },
  { left: ui.info('版本号'), right: '3.15.6' },
]);
assert.ok(fl.split('\n').length === 2, 'fileList 两行');
assert.ok(fl.includes('D:/x'), 'fileList 含 right');

console.log('✅ verify-ui 全部通过');