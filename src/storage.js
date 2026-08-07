#!/usr/bin/env node

/**
 * state.vscdb 用户存储汉化模块
 *
 * 修改 Cursor 用户 SQLite 数据库中的 composerState.modes4 数组，
 * 将各模式描述翻译为中文。
 *
 * 必须用 Cursor 内置 node.exe 运行（依赖 @vscode/sqlite3 native 模块，
 * 其 NODE_MODULE_VERSION 与系统 node 不一致）。
 *
 * 命令行用法：
 *   node storage.js --action=translate --app-path=<Cursor app 路径>
 *   node storage.js --action=restore
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────
// 模式描述翻译字典
// 仅翻译 description，保留 name（Plan/Debug/Multitask/Ask 保持英文）
// ─────────────────────────────────────────────
const modeDescriptionDict = {
    "agent": "规划、搜索、编辑并运行命令",
    "plan": "为完成任务创建详细计划",
    "chat": "向 Cursor 询问有关代码库的问题",
    "triage": "通过委派子智能体协调长期任务",
    "spec": "创建包含实现步骤的结构化计划",
    "debug": "使用运行时跟踪系统性地诊断和修复 Bug",
    "multitask": "并行运行并协调多个任务",
    "project": "用于项目级讨论的特殊对话模式"
};

// 模型参数定义翻译（parameterDefinitions 里的 name / markdownTooltip）
// 只翻译服务端下发的英文参数名，不改变参数 id 和枚举值
const parameterDefinitionDict = {
    name: {
        "Thinking intensity": "思考强度",
    },
    markdownTooltip: {
        "Controls the model thinking intensity for this run.": "控制本次运行的模型思考强度。",
    },
};

const STORAGE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const BACKUP_SUFFIX = '.zh-backup';

// ─────────────────────────────────────────────
// 路径解析
// ─────────────────────────────────────────────

function getDbPath() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

// ─────────────────────────────────────────────
// Cursor 进程检测
// ─────────────────────────────────────────────

function isCursorRunning() {
    try {
        if (process.platform === 'win32') {
            const out = execSync('tasklist /FI "IMAGENAME eq Cursor.exe" /NH', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
                timeout: 5000
            });
            return /Cursor\.exe/i.test(out);
        }
        // macOS / Linux
        execSync('pgrep -x Cursor || pgrep -x cursor', { stdio: 'ignore', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────
// 核心汉化逻辑
// ─────────────────────────────────────────────

function translateModes(appPath) {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        console.log('  ℹ️  state.vscdb 不存在，跳过用户存储汉化。');
        return;
    }

    if (isCursorRunning()) {
        console.log('  ⚠️  Cursor 正在运行，无法安全修改 state.vscdb。');
        console.log('     请先完全退出 Cursor，再重新运行汉化。');
        return;
    }

    // 加载 Cursor 内置 @vscode/sqlite3
    let sqlite3;
    try {
        const sqlite3Path = path.join(appPath, 'node_modules', '@vscode', 'sqlite3');
        sqlite3 = require(sqlite3Path);
    } catch (e) {
        console.log('  ⚠️  无法加载 @vscode/sqlite3:', e.message);
        console.log('     跳过用户存储汉化（非致命）。');
        return;
    }

    // 备份（仅首次）
    const backupPath = dbPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        try {
            fs.copyFileSync(dbPath, backupPath);
            console.log('  ✅ 已备份 state.vscdb');
        } catch (e) {
            console.log('  ⚠️  备份失败:', e.message);
            return;
        }
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            console.log('  ⚠️  打开数据库失败:', err.message);
            return;
        }

        db.get("SELECT value FROM ItemTable WHERE key = ?", [STORAGE_KEY], (err, row) => {
            if (err) {
                console.log('  ⚠️  查询失败:', err.message);
                db.close();
                return;
            }
            if (!row) {
                console.log('  ℹ️  未找到 applicationUser 键，跳过。');
                db.close();
                return;
            }

            const raw = row.value;
            const content = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            let data;
            try {
                data = JSON.parse(content);
            } catch (e) {
                console.log('  ⚠️  applicationUser JSON 解析失败:', e.message);
                db.close();
                return;
            }

            if (!data.composerState || !Array.isArray(data.composerState.modes4)) {
                console.log('  ℹ️  composerState.modes4 不存在，跳过。');
                db.close();
                return;
            }

            let changed = 0;
            for (const mode of data.composerState.modes4) {
                const zh = modeDescriptionDict[mode.id];
                if (zh && mode.description !== zh) {
                    mode.description = zh;
                    changed++;
                }
            }

            // 翻译模型配置里的参数定义（Thinking intensity 等）
            // 模型配置存于 availableDefaultModels2（数组，每项含 parameterDefinitions）
            const modelKey = typeof data.availableDefaultModels2 === 'object' && data.availableDefaultModels2 !== null
                ? 'availableDefaultModels2'
                : (data.availableDefaultModels1 ? 'availableDefaultModels1' : null);
            if (modelKey && Array.isArray(data[modelKey])) {
                for (const model of data[modelKey]) {
                    if (!model || !Array.isArray(model.parameterDefinitions)) continue;
                    for (const pd of model.parameterDefinitions) {
                        if (!pd || typeof pd !== 'object') continue;
                        for (const field of ['name', 'markdownTooltip']) {
                            const dict = parameterDefinitionDict[field];
                            if (!dict || !pd[field]) continue;
                            const zh = dict[pd[field]];
                            if (zh && pd[field] !== zh) {
                                pd[field] = zh;
                                changed++;
                            }
                        }
                    }
                }
            }

            if (changed === 0) {
                console.log('  ℹ️  modes4 描述与参数定义已是中文，无需修改。');
                db.close();
                return;
            }

            const newContent = JSON.stringify(data);
            db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [newContent, STORAGE_KEY], (err) => {
                if (err) {
                    console.log('  ⚠️  更新失败:', err.message);
                } else {
                    console.log(`  ✅ 已汉化 ${changed} 个模式描述（modes4）`);
                }
                db.close();
            });
        });
    });
}

// ─────────────────────────────────────────────
// 还原
// ─────────────────────────────────────────────

function restoreModes() {
    const dbPath = getDbPath();
    const backupPath = dbPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        return false;
    }
    try {
        if (isCursorRunning()) {
            console.log('  ⚠️  Cursor 正在运行，无法还原 state.vscdb。');
            return false;
        }
        fs.copyFileSync(backupPath, dbPath);
        fs.unlinkSync(backupPath);
        return true;
    } catch (e) {
        console.log('  ⚠️  还原失败:', e.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// 命令行入口
// ─────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const actionArg = args.find(a => a.startsWith('--action='));
    const appPathArg = args.find(a => a.startsWith('--app-path='));

    if (!actionArg) {
        console.error('用法: node storage.js --action=translate|restore [--app-path=<path>]');
        process.exit(1);
    }

    const action = actionArg.slice('--action='.length);

    if (action === 'translate') {
        if (!appPathArg) {
            console.error('translate 操作需要 --app-path 参数');
            process.exit(1);
        }
        const appPath = appPathArg.slice('--app-path='.length);
        translateModes(appPath);
    } else if (action === 'restore') {
        if (restoreModes()) {
            console.log('  ✅ 已还原 state.vscdb');
        } else {
            console.log('  ℹ️  未找到 state.vscdb 备份，无需还原。');
        }
    } else {
        console.error('未知操作:', action);
        process.exit(1);
    }
}

module.exports = { translateModes, restoreModes, modeDescriptionDict };
