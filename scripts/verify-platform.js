const assert = require('assert');
const path = require('path');
const { isCursorRunning, readCursorVersion } = require('../src/platform.js');

const APP = process.argv[2] || 'D:/Program Files/cursor/resources/app';

// readCursorVersion：读真实安装的 product.json，应返回非空版本
const v = readCursorVersion(APP);
assert.ok(typeof v === 'string' && v.length > 0, `应读到版本号，实际: ${v}`);
console.log('✅ 版本号:', v);

// isCursorRunning：返回布尔即可（不崩溃）
assert.strictEqual(typeof isCursorRunning(), 'boolean');
console.log('✅ 运行检测:', isCursorRunning() ? 'Cursor 运行中' : 'Cursor 未运行');
console.log('✅ verify-platform 全部通过');