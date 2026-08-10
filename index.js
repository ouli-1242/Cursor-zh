#!/usr/bin/env node

/**
 * Cursor-zh — 入口文件
 *
 * 执行逻辑 (防止 sudo-prompt + inquirer 死锁):
 *
 *   1. 解析 process.argv，如果检测到 --action=translate 或 --action=restore
 *      → 直接静默执行对应操作，不启动 inquirer 菜单（提权后的子进程走这条路）
 *
 *   2. 否则 → 展示 inquirer 交互菜单让用户选择操作
 *      → 检测是否有写入权限
 *        → 有权限：直接执行
 *        → 无权限：通过 sudo-prompt 以管理员身份重拉自身，追加 --action 参数
 */

const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const {
    resolveCursorPath,
    parseCursorPathArg,
    findAllCursorCandidates,
    normalizeToAppPath,
    buildPathsFromAppPath,
    loadConfig,
    isValidAppPath,
    saveConfig,
    hasWritePermission,
    elevateAndRun,
    isCursorRunning,
    readCursorVersion,
    CONFIG_FILE,
} = require('./src/platform');
const { translate, restore } = require('./src/i18n-core');
const ui = require('./src/ui');
const { version } = require('./package.json');

// ═══════════════════════════════════════════════
// 解析命令行参数
// ═══════════════════════════════════════════════

/** 检测主 JS 是否已汉化（含字面中文；minified 英文包非 ASCII 全为 \\u 转义） */
function isBundleTranslated(mainJsPath) {
    try {
        const content = fs.readFileSync(mainJsPath, 'utf8');
        return (content.match(/[一-鿿]/g) || []).length > 50;
    } catch {
        return false;
    }
}

function parseAction() {
    const actionArg = process.argv.find(arg => arg.startsWith('--action='));
    if (!actionArg) return null;
    return actionArg.split('=')[1]; // 'translate' | 'restore'
}

function getCliCursorPath() {
    return parseCursorPathArg();
}

// ═══════════════════════════════════════════════
// Cursor 路径解析（自动 / 手动 / 多选）
// ═══════════════════════════════════════════════

function pathHint() {
    if (process.platform === 'win32') {
        return '%LOCALAPPDATA%\\Programs\\cursor 或 Cursor.exe 所在目录';
    }
    if (process.platform === 'darwin') {
        return '/Applications/Cursor.app 或 .../Contents/Resources/app';
    }
    return 'Cursor 安装目录或 resources/app 路径';
}

async function promptManualPath() {
    const { manualPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'manualPath',
            message: chalk.white.bold('请输入 Cursor 安装路径：'),
            validate: (input) => {
                const trimmed = (input || '').trim();
                if (!trimmed) return '路径不能为空';
                if (!normalizeToAppPath(trimmed)) {
                    return `无法识别为有效的 Cursor 目录（需包含 workbench.desktop.main.js）。提示：${pathHint()}`;
                }
                return true;
            },
        },
    ]);
    const appPath = normalizeToAppPath(manualPath.trim());
    saveConfig({ cursorAppPath: appPath });
    return buildPathsFromAppPath(appPath);
}

async function promptSelectPath(candidates, preselected) {
    const choices = candidates.map((p, i) => ({
        name: p,
        value: p,
        short: p,
    }));

    choices.push(new inquirer.Separator());
    choices.push({
        name: chalk.cyan('📁 手动输入其他路径...'),
        value: '__manual__',
    });
    choices.push({
        name: chalk.gray('🔍 重新自动搜索'),
        value: '__rescan__',
    });

    const { selected } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selected',
            message: chalk.white.bold('检测到多个 Cursor 安装，请选择：'),
            choices,
            default: preselected && candidates.includes(preselected) ? preselected : 0,
        },
    ]);

    if (selected === '__manual__') return promptManualPath();
    if (selected === '__rescan__') return obtainCursorPaths({ forceRescan: true });

    saveConfig({ cursorAppPath: selected });
    return buildPathsFromAppPath(selected);
}

async function promptConfirmOrChange(paths) {
    const { choice } = await inquirer.prompt([
        {
            type: 'list',
            name: 'choice',
            message: chalk.white.bold('已定位 Cursor，是否使用此路径？'),
            choices: [
                { name: chalk.green(`✓ 使用: ${paths.appPath}`), value: 'use' },
                { name: chalk.cyan('📁 手动指定其他路径'), value: 'manual' },
                { name: chalk.gray('🔍 重新自动搜索'), value: 'rescan' },
            ],
        },
    ]);

    if (choice === 'use') return paths;
    if (choice === 'manual') return promptManualPath();
    return obtainCursorPaths({ forceRescan: true });
}

/**
 * 获取 Cursor 路径对象（交互式会提示用户选择）
 * @param {{ forceRescan?: boolean, skipConfirm?: boolean }} [options]
 */
async function obtainCursorPaths(options = {}) {
    const { forceRescan = false, skipConfirm = false } = options;
    const cliPath = getCliCursorPath();

    if (cliPath && !forceRescan) {
        const fromCli = resolveCursorPath({ cliPath });
        if (fromCli) return fromCli;
        console.log(chalk.red.bold('  ❌ 命令行指定的 Cursor 路径无效！'));
        console.log(chalk.yellow(`  参数: ${cliPath}`));
        console.log(chalk.gray(`  提示: ${pathHint()}`));
        return null;
    }

    if (!forceRescan) {
        const resolved = resolveCursorPath({});
        if (resolved) {
            const candidates = findAllCursorCandidates();
            if (candidates.length > 1) {
                return promptSelectPath(candidates, resolved.appPath);
            }
            const config = loadConfig();
            if (config.cursorAppPath && isValidAppPath(config.cursorAppPath)) {
                return resolved;
            }
            if (!skipConfirm) {
                return promptConfirmOrChange(resolved);
            }
            return resolved;
        }
    }

    console.log(chalk.yellow('  🔍 正在自动搜索 Cursor 安装路径...'));
    const candidates = findAllCursorCandidates();

    if (candidates.length === 0) {
        console.log(chalk.red.bold('  ❌ 未在默认位置找到 Cursor。'));
        console.log(chalk.gray(`  可手动指定安装目录（${pathHint()}）`));
        console.log(chalk.gray(`  配置将保存至: ${CONFIG_FILE}`));
        console.log('');
        return promptManualPath();
    }

    if (candidates.length === 1) {
        if (skipConfirm) {
            saveConfig({ cursorAppPath: candidates[0] });
            return buildPathsFromAppPath(candidates[0]);
        }
        return promptConfirmOrChange(buildPathsFromAppPath(candidates[0]));
    }

    return promptSelectPath(candidates);
}

// ═══════════════════════════════════════════════
// 静默模式（提权后的子进程入口）
// ═══════════════════════════════════════════════

async function runSilent(action) {
    const cliPath = getCliCursorPath();
    const paths = resolveCursorPath({ cliPath: cliPath || undefined });

    if (!paths) {
        console.error('❌ 找不到 Cursor 安装目录！');
        console.error('请使用 --cursor-path 指定路径，例如：');
        console.error('  node index.js --action=translate --cursor-path="C:\\Users\\你\\AppData\\Local\\Programs\\cursor"');
        process.exit(1);
    }

    if (action === 'translate') {
        translate(paths);
    } else if (action === 'restore') {
        restore(paths);
    } else {
        console.error(`❌ 未知操作: ${action}`);
        process.exit(1);
    }

    process.exit(0);
}

// ═══════════════════════════════════════════════
// 交互模式（用户双击/终端运行入口）
// ═══════════════════════════════════════════════

const FAQ = [
    ['汉化后界面没变化？', '请完全退出并重启 Cursor；确认定位的是正在使用的安装目录；Cursor 更新后需重新运行汉化。'],
    ['提示"安装已损坏"？', '工具已自动修复校验值。若仍出现，先"恢复英文"再重新汉化，或检查是否被安全软件阻止写入。'],
    ['模型参数（如 Thinking intensity）过一会儿恢复英文？', '工具已注入显示层映射，一般不会再恢复。若出现，重新运行汉化即可。'],
    ['如何完全退出 Cursor？', '右键托盘图标选择"退出"，并在任务管理器中确认 Cursor.exe 已结束。'],
];

async function showFaq() {
    console.log(ui.section('常见问题'));
    for (const [q, a] of FAQ) {
        console.log(`  ${chalk.white.bold(q)}`);
        console.log(`    ${chalk.gray(a)}`);
        console.log('');
    }
}

async function runInteractive() {
    console.log(ui.banner(version));

    // ── 步骤 1: 检测 Cursor 状态 ──
    console.log(ui.step(1, 3, '检测 Cursor'));
    const paths = await obtainCursorPaths();
    if (!paths) {
        await waitForExit();
        return;
    }

    const writable = hasWritePermission(paths.mainJsPath);
    const running = isCursorRunning();
    const translated = isBundleTranslated(paths.mainJsPath);
    const ver = readCursorVersion(paths.appPath);

    console.log(ui.fileList([
        { left: ui.ok('安装路径'), right: paths.appPath },
        { left: ui.info('版本号'), right: ver ? `Cursor ${ver}` : chalk.gray('未知') },
        { left: writable ? ui.ok('写入权限') : ui.warn('写入权限'), right: writable ? '可直接修改' : '将请求管理员权限' },
        { left: running ? ui.warn('运行状态') : ui.info('运行状态'), right: running ? 'Cursor 正在运行，汉化前请先完全退出' : '未运行' },
        { left: translated ? ui.warn('汉化状态') : ui.info('汉化状态'), right: translated ? '当前已汉化，可恢复英文后重新汉化' : '当前为英文原版' },
    ]));
    console.log(ui.divider());

    // ── 步骤 2: 确认操作 ──
    console.log(ui.step(2, 3, '确认操作'));
    const targets = [
        ['主窗口', paths.mainJsPath],
        ['附加窗口（Agent/Glass）', paths.glassJsPath],
        ['原生提示文案', paths.nlsMessagesPath],
        ['托盘菜单', paths.mainProcessJsPath],
        ['校验值文件', paths.productJsonPath],
    ].filter(([, p]) => p && fs.existsSync(p));
    console.log(ui.info('将处理以下文件：'));
    console.log(ui.fileList(targets.map(([name, p]) => ({ left: ui.info(name), right: path.basename(p) }))));
    console.log(ui.info('其他：clp 语言包缓存 / 用户扩展 / state.vscdb（按需自动处理）'));
    console.log('');

    // ── 操作选择 ──
    let action;
    while (true) {
        const res = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: chalk.white.bold('请选择操作：'),
                choices: [
                    { name: chalk.green('🚀 一键汉化'), value: 'translate' },
                    { name: chalk.yellow('⏪ 恢复英文'), value: 'restore' },
                    { name: chalk.cyan('📖 查看常见问题'), value: 'faq' },
                    new inquirer.Separator(),
                    { name: chalk.gray('❌ 退出'), value: 'exit' },
                ],
            },
        ]);
        action = res.action;
        if (action === 'faq') {
            await showFaq();
            continue; // 返回菜单
        }
        break;
    }

    if (action === 'exit') {
        console.log(chalk.gray('\n  再见！👋'));
        return;
    }

    // ── 步骤 3: 执行 ──
    console.log(ui.step(3, 3, action === 'translate' ? '执行汉化' : '恢复英文'));
    const needElevation = !hasWritePermission(paths.mainJsPath);
    if (needElevation) {
        console.log(ui.warn('修改 Cursor 核心文件需要管理员权限。'));
        console.log(ui.info('请在系统弹窗中确认授权，授权后会自动继续。'));
        console.log('');
        try {
            await elevateAndRun(action, paths.appPath);
            console.log('');
            console.log(`${ui.ok(chalk.green.bold('操作已在管理员权限下完成！'))}\n`);
        } catch (e) {
            console.log('');
            console.log(`${ui.err(chalk.red.bold('提权失败或用户取消'))} ${chalk.red(e.message)}\n`);
            await waitForExit();
            return;
        }
    } else {
        if (action === 'translate') {
            translate(paths);
        } else {
            restore(paths);
        }
    }

    // ── 完成引导 ──
    console.log(ui.section(action === 'translate' ? '汉化完成，接下来…' : '还原完成，接下来…'));
    if (action === 'translate') {
        console.log(ui.warn('请完全退出并重启 Cursor，界面文案才会更新。'));
        console.log(`  ${chalk.gray('验证：')} 设置页、菜单、Agent 窗口应出现中文。`);
        console.log(`  ${chalk.gray('备份：')} 原版文件保存在 .backup 文件旁。`);
        console.log(`  ${chalk.gray('还原：')} 随时可再次运行本工具选"恢复英文"。`);
    } else {
        console.log(ui.ok('已还原英文原版，重启 Cursor 生效。'));
    }
    console.log('');
    await waitForExit();
}

async function waitForExit() {
    if (process.stdout.isTTY) {
        await inquirer.prompt([
            {
                type: 'input',
                name: 'exit',
                message: chalk.gray('按 Enter 键退出...'),
            },
        ]);
    }
}

// ═══════════════════════════════════════════════
// 入口拦截：优先判断是否为静默模式
// ═══════════════════════════════════════════════

const silentAction = parseAction();
if (silentAction) {
    runSilent(silentAction).catch(err => {
        console.error(chalk.red('❌ 操作失败: ') + err.message);
        console.error(chalk.yellow('  可尝试运行还原操作恢复英文原版。'));
        process.exit(1);
    });
} else {
    runInteractive().catch(err => {
        console.error(chalk.red('❌ 发生未预料的错误: ') + err.message);
        process.exit(1);
    });
}
