/**
 * 纯展示 UI 组件库：所有函数返回字符串，调用方 console.log。
 * 无业务逻辑、无副作用，便于测试与复用。
 */
const chalk = require('chalk');

function banner(version) {
    const W = 44; // 框内容区宽度（不含边框）
    const center = (s) => {
        const dw = displayWidth(s);
        const left = Math.max(0, Math.floor((W - dw) / 2));
        const right = Math.max(0, W - dw - left);
        return ' '.repeat(left) + s + ' '.repeat(right);
    };
    const bar = chalk.cyan('═'.repeat(W));
    const line = `  ${chalk.cyan('╔')}${bar}${chalk.cyan('╗')}`;
    const title = `  ${chalk.cyan('║')} ${chalk.white.bold(center(`Cursor-zh  v${version || '?'}`))} ${chalk.cyan('║')}`;
    const sub = `  ${chalk.cyan('║')} ${chalk.gray(center('Cursor 本地汉化工具 · 一键汉化 / 随时还原'))} ${chalk.cyan('║')}`;
    const bottom = `  ${chalk.cyan('╚')}${bar}${chalk.cyan('╝')}`;
    return `\n${line}\n${title}\n${sub}\n${bottom}\n`;
}

function step(index, total, label) {
    return `\n  ${chalk.cyan.bold(`── 步骤 ${index}/${total}  ${label} ──`)}\n`;
}

const ok = (msg) => `${chalk.green('✅')} ${msg}`;
const warn = (msg) => `${chalk.yellow('⚠️')} ${msg}`;
const err = (msg) => `${chalk.red('❌')} ${msg}`;
const info = (msg) => `${chalk.cyan('ℹ️')} ${msg}`;

function section(title) {
    return `\n  ${chalk.blue.bold(title)}\n  ${chalk.blue('─'.repeat(Math.max(20, /* 全角对齐 */ title.length * 2)))}\n`;
}

function divider() {
    return chalk.gray('  ' + '─'.repeat(44));
}

/** 全角字符（中文/emoji/符号）按 2 列宽计算；变体选择符（U+FE0F）不占宽 */
function displayWidth(s) {
    let w = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (code === 0xfe0f) continue; // emoji 变体选择符不占宽
        w += code >= 0x1f000 || /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦一-鿿]/.test(ch) ? 2 : 1;
    }
    return w;
}

/** items: [{ left, right }] — left 列按全角宽对齐到 28 列 */
function fileList(items) {
    const lines = items.map(it => {
        const pad = Math.max(2, 28 - displayWidth(it.left));
        return `  ${it.left}${' '.repeat(pad)}${it.right || ''}`;
    });
    return lines.join('\n').replace(/[ \t]+$/gm, '');
}

module.exports = { banner, step, ok, warn, err, info, section, divider, fileList, displayWidth };