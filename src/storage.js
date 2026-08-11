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
 *   node storage.js --action=restore --app-path=<Cursor app 路径>
 *   （可选 --db-path=<state.vscdb 路径> 覆盖默认数据库路径，用于测试/诊断）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { execSync } = require('child_process');

// 统一状态圆点图标（与 i18n-core.js 一致）
const ICON = {
    ok: chalk.green('●'),
    warn: chalk.yellow('●'),
    info: chalk.cyan('●'),
};

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

function getDbPath(dbPathOverride) {
    if (dbPathOverride) return dbPathOverride;
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

function translateModes(appPath, dbPathOverride) {
    const dbPath = getDbPath(dbPathOverride);
    if (!fs.existsSync(dbPath)) {
        console.log(`  ${ICON.info} state.vscdb 不存在，跳过用户存储汉化。`);
        return;
    }

    if (isCursorRunning()) {
        console.log(`  ${ICON.warn} Cursor 正在运行，无法安全修改 state.vscdb。`);
        console.log('     请先完全退出 Cursor，再重新运行汉化。');
        return;
    }

    // 加载 Cursor 内置 @vscode/sqlite3
    let sqlite3;
    try {
        const sqlite3Path = path.join(appPath, 'node_modules', '@vscode', 'sqlite3');
        sqlite3 = require(sqlite3Path);
    } catch (e) {
        console.log(`  ${ICON.warn} 无法加载 @vscode/sqlite3: ${e.message}`);
        console.log('     跳过用户存储汉化（非致命）。');
        return;
    }

    // 备份（仅首次）
    const backupPath = dbPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        try {
            fs.copyFileSync(dbPath, backupPath);
            console.log(`  ${ICON.ok} 已备份 state.vscdb`);
        } catch (e) {
            console.log(`  ${ICON.warn} 备份失败: ${e.message}`);
            return;
        }
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            console.log(`  ${ICON.warn} 打开数据库失败: ${err.message}`);
            return;
        }

        db.get("SELECT value FROM ItemTable WHERE key = ?", [STORAGE_KEY], (err, row) => {
            if (err) {
                console.log(`  ${ICON.warn} 查询失败: ${err.message}`);
                db.close();
                return;
            }
            if (!row) {
                console.log(`  ${ICON.info} 未找到 applicationUser 键，跳过。`);
                db.close();
                return;
            }

            const raw = row.value;
            const content = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            let data;
            try {
                data = JSON.parse(content);
            } catch (e) {
                console.log(`  ${ICON.warn} applicationUser JSON 解析失败: ${e.message}`);
                db.close();
                return;
            }

            if (!data.composerState || !Array.isArray(data.composerState.modes4)) {
                console.log(`  ${ICON.info} composerState.modes4 不存在，跳过。`);
                db.close();
                return;
            }

            let modeChanged = 0, paramChanged = 0;
            for (const mode of data.composerState.modes4) {
                const zh = modeDescriptionDict[mode.id];
                if (zh && mode.description !== zh) {
                    mode.description = zh;
                    modeChanged++;
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
                                paramChanged++;
                            }
                        }
                    }
                }
            }

            if (modeChanged + paramChanged === 0) {
                console.log(`  ${ICON.info} 模式描述与参数定义已是中文，无需修改。`);
                db.close();
                return;
            }

            const newContent = JSON.stringify(data);
            db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [newContent, STORAGE_KEY], (err) => {
                if (err) {
                    console.log(`  ${ICON.warn} 更新失败: ${err.message}`);
                } else {
                    console.log(`  ${ICON.ok} 已汉化 ${modeChanged} 个模式描述 + ${paramChanged} 个参数定义（Thinking intensity 等）`);
                }
                db.close();
            });
        });
    });
}

// ─────────────────────────────────────────────
// SQLite 单键 JSON 读写（Promise 化）
// ─────────────────────────────────────────────

function dbGetValue(sqlite3, dbPath, mode, key) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, mode, (err) => {
            if (err) { reject(err); return; }
            db.get("SELECT value FROM ItemTable WHERE key = ?", [key], (err, row) => {
                db.close();
                if (err) { reject(err); return; }
                if (!row) { resolve(null); return; }
                const content = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
                let data;
                try { data = JSON.parse(content); } catch (e) { reject(e); return; }
                resolve(data);
            });
        });
    });
}

function dbUpdateValue(sqlite3, dbPath, key, value) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
            if (err) { reject(err); return; }
            db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [value, key], (err) => {
                db.close();
                if (err) reject(err); else resolve();
            });
        });
    });
}

// ─────────────────────────────────────────────
// 还原
// ─────────────────────────────────────────────

/**
 * 字段级还原：从首次备份（.zh-backup）的 applicationUser 提取英文原文，
 * 精确改回当前库 applicationUser 内被汉化的 modes4 描述与模型参数定义。
 * 只写这一个键，对话（cursorDiskKV / composerHeaders）等其余数据零接触。
 *
 * 仅在"当前值 === 本工具的中文翻译"时还原，绝不覆盖用户手动修改。
 *
 * @param {string} [appPath] Cursor app 路径（加载 @vscode/sqlite3 需要）
 * @param {string} [dbPathOverride] 覆盖数据库路径（测试/诊断用）
 * @returns {Promise<boolean>} 是否完成还原
 */
function restoreModes(appPath, dbPathOverride) {
    const dbPath = getDbPath(dbPathOverride);
    const backupPath = dbPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        return Promise.resolve(false);
    }
    if (isCursorRunning()) {
        console.log(`  ${ICON.warn} Cursor 正在运行，无法还原 state.vscdb。`);
        return Promise.resolve(false);
    }

    // 字段级还原需要 @vscode/sqlite3 读取备份里的英文原文
    let sqlite3;
    if (appPath) {
        try {
            sqlite3 = require(path.join(appPath, 'node_modules', '@vscode', 'sqlite3'));
        } catch (e) { /* 尝试下一步 */ }
    }
    if (!sqlite3) {
        console.log(`  ${ICON.warn} 无法加载 @vscode/sqlite3，无法进行字段级还原（需 --app-path 指定 Cursor 安装路径）。`);
        console.log('     已跳过还原，未改动数据库（避免整库覆盖丢失近期对话）。');
        return Promise.resolve(false);
    }

    const op = async () => {
        try {
            // 1. 读备份英文原文
            const backupData = await dbGetValue(sqlite3, backupPath, sqlite3.OPEN_READONLY, STORAGE_KEY);
            if (!backupData) {
                console.log(`  ${ICON.info} 备份中无 applicationUser 键，跳过字段级还原。`);
                return false;
            }

            // 2. 读当前库
            const currentData = await dbGetValue(sqlite3, dbPath, sqlite3.OPEN_READWRITE, STORAGE_KEY);
            if (!currentData) {
                console.log(`  ${ICON.info} 当前库无 applicationUser 键，跳过。`);
                return false;
            }

            // 3. 字段级还原
            let modeChanged = 0, paramChanged = 0;

            // 3a. 模式描述：备份按 id 索引英文原文
            const backupModes = new Map();
            if (backupData.composerState && Array.isArray(backupData.composerState.modes4)) {
                for (const m of backupData.composerState.modes4) {
                    if (m && m.id) backupModes.set(m.id, m.description);
                }
            }
            if (currentData.composerState && Array.isArray(currentData.composerState.modes4)) {
                for (const mode of currentData.composerState.modes4) {
                    if (!mode || !mode.id) continue;
                    const en = backupModes.get(mode.id);
                    const zh = modeDescriptionDict[mode.id];
                    if (en && zh && mode.description === zh) {
                        mode.description = en;
                        modeChanged++;
                    }
                }
            }

            // 3b. 参数定义：备份按 serverModelName + paramId 索引英文原文
            const backupParams = new Map(); // key = serverModelName + '::' + paramId
            const backupModels = Array.isArray(backupData.availableDefaultModels2)
                ? backupData.availableDefaultModels2
                : (Array.isArray(backupData.availableDefaultModels1) ? backupData.availableDefaultModels1 : []);
            for (const model of backupModels) {
                if (!model || !Array.isArray(model.parameterDefinitions)) continue;
                for (const pd of model.parameterDefinitions) {
                    if (!pd || !pd.id) continue;
                    const key = (model.serverModelName || model.name || '') + '::' + pd.id;
                    backupParams.set(key, { name: pd.name, markdownTooltip: pd.markdownTooltip });
                }
            }
            const modelKey = Array.isArray(currentData.availableDefaultModels2)
                ? 'availableDefaultModels2'
                : (Array.isArray(currentData.availableDefaultModels1) ? 'availableDefaultModels1' : null);
            if (modelKey) {
                for (const model of currentData[modelKey]) {
                    if (!model || !Array.isArray(model.parameterDefinitions)) continue;
                    for (const pd of model.parameterDefinitions) {
                        if (!pd || !pd.id) continue;
                        const key = (model.serverModelName || model.name || '') + '::' + pd.id;
                        const en = backupParams.get(key);
                        if (!en) continue;
                        const zhName = parameterDefinitionDict.name && parameterDefinitionDict.name[pd.name];
                        if (en.name && zhName && pd.name === zhName) {
                            pd.name = en.name;
                            paramChanged++;
                        }
                        const zhTip = parameterDefinitionDict.markdownTooltip && parameterDefinitionDict.markdownTooltip[pd.markdownTooltip];
                        if (en.markdownTooltip && zhTip && pd.markdownTooltip === zhTip) {
                            pd.markdownTooltip = en.markdownTooltip;
                            paramChanged++;
                        }
                    }
                }
            }

            if (modeChanged + paramChanged === 0) {
                console.log(`  ${ICON.info} 未发现需还原的汉化字段（已是英文或被手动修改，保持现状）。`);
                return false;
            }

            // 4. 只更新 applicationUser 一个键，其余数据不动
            await dbUpdateValue(sqlite3, dbPath, STORAGE_KEY, JSON.stringify(currentData));

            // 5. 还原完成，移除备份（下次汉化会重新备份英文原文）
            fs.unlinkSync(backupPath);
            console.log(`  ${ICON.ok} 已还原 ${modeChanged} 个模式描述 + ${paramChanged} 个参数定义（回到英文），对话数据未受影响。`);
            return true;
        } catch (e) {
            console.log(`  ${ICON.warn} 还原失败: ${e.message}`);
            console.log('     数据库未被改动，可重试。');
            return false;
        }
    };
    return op();
}

// ─────────────────────────────────────────────
// 命令行入口
// ─────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const actionArg = args.find(a => a.startsWith('--action='));
    const appPathArg = args.find(a => a.startsWith('--app-path='));
    const dbPathArg = args.find(a => a.startsWith('--db-path='));

    if (!actionArg) {
        console.error('用法: node storage.js --action=translate|restore [--app-path=<path>] [--db-path=<path>]');
        process.exit(1);
    }

    const action = actionArg.slice('--action='.length);
    const appPath = appPathArg ? appPathArg.slice('--app-path='.length) : null;
    const dbPathOverride = dbPathArg ? dbPathArg.slice('--db-path='.length) : null;

    if (action === 'translate') {
        if (!appPath) {
            console.error('translate 操作需要 --app-path 参数');
            process.exit(1);
        }
        translateModes(appPath, dbPathOverride);
    } else if (action === 'restore') {
        if (!appPath) {
            console.error('restore 操作需要 --app-path 参数（字段级还原需加载 Cursor 内置 @vscode/sqlite3）');
            process.exit(1);
        }
        restoreModes(appPath, dbPathOverride).then(ok => {
            if (ok) {
                console.log(`  ${ICON.ok} 已还原 state.vscdb`);
            } else {
                console.log(`  ${ICON.info} 未还原（无备份或无需还原）。`);
            }
        });
    } else {
        console.error('未知操作:', action);
        process.exit(1);
    }
}

module.exports = { translateModes, restoreModes, modeDescriptionDict };
