/**
 * 核心汉化逻辑 + Hash 修复 + Mac Gatekeeper 修复
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { safeGlobalDict, nativeNlsDict, riskyShortWords } = require('./dict');
const { PLATFORM } = require('./platform');

// 辅助：转义正则特殊字符
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ═══════════════════════════════════════════════
// 预编译正则（模块加载时一次性构建，后续复用）
// ═══════════════════════════════════════════════

// 安全长句：按长度降序排列，确保长句优先匹配
const safeEntries = Object.entries(safeGlobalDict).sort((a, b) => b[0].length - a[0].length);
const safePattern = safeEntries.map(([en]) => escapeRegExp(en)).join('|');

// 单次大正则：匹配被引号包裹的安全长句
const safeMegaRegex = new RegExp(`(["'\`])(${safePattern})\\1`, 'g');

// 长句裸文本正则（>=20 字符，不会与代码变量冲突）
const longEntries = safeEntries.filter(([en]) => en.length >= 20);
const longPattern = longEntries.map(([en]) => escapeRegExp(en)).join('|');
const longMegaRegex = longPattern ? new RegExp(`(${longPattern})`, 'g') : null;

// 危险短词的 UI 属性列表（仅限可见 UI 文案，勿覆盖键位/扫描表）
const uiProps = [
    'children', 'title', 'label', 'placeholder', 'description', 'tooltip', 'text',
    'name', 'message', 'detail', 'heading',
    'markdownDescription', 'aria-label', 'ariaLabel', 'emptyStateText',
    'currentLabel', 'breadcrumbLabel',
];
const uiPropsPattern = uiProps.join('|');

/** 键盘扫描表动态正则缓存：避免每次命中都 new RegExp，短词命中量大时收益明显 */
const protectedRegexCache = new Map();
function getProtectedRegexes(word) {
    let cached = protectedRegexCache.get(word);
    if (!cached) {
        const escaped = escapeRegExp(word);
        cached = {
            // 键盘扫描表格式: [数字,数字,"词"]
            scanTable: new RegExp(`\\[\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*["']${escaped}["']`),
            // 扫描表另一形态: "词",数字,"词"
            scanTableAlt: new RegExp(`["']${escaped}["']\\s*,\\s*\\d+\\s*,\\s*["']${escaped}["']`),
        };
        protectedRegexCache.set(word, cached);
    }
    return cached;
}

/** 键盘扫描表、VK_*、KeyCode 等键位元数据 — 禁止汉化短词误伤 */
function isProtectedKeybindingContext(content, index, word) {
    // 只检查紧邻的小范围（80 字符），避免误伤附近恰好引用 keybindingService 的 UI 代码
    const radius = 80;
    const start = Math.max(0, index - radius);
    const end = Math.min(content.length, index + radius + word.length);
    const slice = content.slice(start, end);

    if (/VK_[A-Z0-9_]+/.test(slice)) return true;
    if (/\bKeyCode\b|\bScanCode\b/.test(slice)) return true;
    // 键盘扫描表格式: [数字,数字,"词"] 或 "词",数字,"词"
    const { scanTable, scanTableAlt } = getProtectedRegexes(word);
    if (scanTable.test(slice)) return true;
    if (scanTableAlt.test(slice)) return true;

    return false;
}

// 危险短词：按长度降序排列后合并为 3 个大正则，单次扫描覆盖全部短词。
// 旧实现为每个短词单独建 3 个正则并循环全量扫描（191 词 × 3 = 573 次 38MB 扫描，约 37s），
// 合并后仅 3 次扫描，实测提速 99%（37s → 0.27s），命中数完全一致。
const riskyWordsDesc = Object.keys(riskyShortWords).sort((a, b) => b.length - a.length);
const riskyWordsPattern = riskyWordsDesc.map(escapeRegExp).join('|');

// UI 属性赋值: children: "General"
const megaPropRegex = new RegExp(`(${uiPropsPattern})\\s*:\\s*(["'\`])(${riskyWordsPattern})\\2`, 'g');
// JSX 文本节点: React.createElement("div", null, "General")
const megaJsxRegex = new RegExp(`(null|}|\\w)\\s*,\\s*(["'\`])(${riskyWordsPattern})\\2\\s*(?=[,)])`, 'g');
// HTML 标签内文本: >General<
const megaHtmlRegex = new RegExp(`>\\s*(${riskyWordsPattern})\\s*<`, 'g');

/**
 * 用合并大正则处理危险短词：单次扫描替代 191 次循环。
 * 命中后通过 riskyShortWords[word] 查表得中文，并经 isProtectedKeybindingContext 跳过键位表。
 * @param {string} jsContent
 * @param {{ record: (group: string, from: string, to: string, count: number) => void }} changes
 * @param {{ update: (label: string, detail?: string) => void }} [progress]
 * @returns {string}
 */
function applyRiskyShortWords(jsContent, changes, progress) {
    let propCount = 0;
    jsContent = jsContent.replace(megaPropRegex, (match, prop, quote, word, offset) => {
        if (isProtectedKeybindingContext(jsContent, offset, word)) return match;
        propCount++;
        changes.record('UI 属性短词', word, riskyShortWords[word], 1);
        return `${prop}: ${quote}${riskyShortWords[word]}${quote}`;
    });
    if (propCount > 0 && progress) progress.update('替换短词', `UI 属性 ${propCount} 处`);

    let jsxCount = 0;
    jsContent = jsContent.replace(megaJsxRegex, (match, pre, quote, word, offset) => {
        if (isProtectedKeybindingContext(jsContent, offset, word)) return match;
        jsxCount++;
        changes.record('JSX 文本短词', word, riskyShortWords[word], 1);
        return `${pre}, ${quote}${riskyShortWords[word]}${quote}`;
    });
    if (jsxCount > 0 && progress) progress.update('替换短词', `JSX 文本 ${jsxCount} 处`);

    let htmlCount = 0;
    jsContent = jsContent.replace(megaHtmlRegex, (match, word, offset) => {
        if (isProtectedKeybindingContext(jsContent, offset, word)) return match;
        htmlCount++;
        changes.record('HTML 文本短词', word, riskyShortWords[word], 1);
        return `>${riskyShortWords[word]}<`;
    });
    if (htmlCount > 0 && progress) progress.update('替换短词', `HTML 文本 ${htmlCount} 处`);

    return jsContent;
}

/**
 * 还原 composer mode 名称。riskyShortWords 会把 modes4 里的 name:"Agent" 翻译成"智能体"，
 * 但用户要求 mode 下拉的 Agent 保持英文（Plan/Debug/Multitask/Ask 同理保持原名）。
 * 在短词替换后调用，只还原 mode 定义数组里的 name 字段，不影响其他"智能体"文案。
 * 注意：只匹配 id:"xxx",name:"中文" 的 mode 定义形态，避免误伤其他 UI。
 */
function restoreComposerModeNames(jsContent) {
    // mode id → 应显示的英文名（与 modes4 里的原名一致）
    const modeNames = {
        agent: "Agent",
        triage: "Triage",
        plan: "Plan",
        spec: "Spec",
        debug: "Debug",
        multitask: "Multitask",
        ask: "Ask",
        project: "Project",
    };
    return jsContent.replace(/id:"([a-z]+)",name:"[^"]*"/g, (match, id) => {
        const name = modeNames[id];
        return name ? `id:"${id}",name:"${name}"` : match;
    });
}

// ═══════════════════════════════════════════════
// 终端进度展示
// ═══════════════════════════════════════════════

const PROGRESS_BAR_WIDTH = 24;

/**
 * 压缩并截断终端展示文本，避免正在替换的长模板撑满整行。
 * 这里保留“正在改什么”的关键信息，详细命中数量会在处理结束后汇总。
 */
function compactText(value, maxLength = 72) {
    const compact = String(value)
        .replace(/\s+/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
    const chars = Array.from(compact);
    if (chars.length <= maxLength) return compact;
    return chars.slice(0, maxLength - 1).join('') + '…';
}

function formatReplacementDetail(from, to, count) {
    const suffix = count > 0 ? `（${count} 处）` : '';
    return `${compactText(from, 30)} → ${compactText(to, 30)}${suffix}`;
}

/**
 * 轻量进度条：TTY 下原地刷新，非 TTY 下只输出阶段完成行。
 * 这样既适合截图里的交互终端，也不会在日志文件里刷出大量重复行。
 */
function createProgress(totalPhases) {
    let current = 0;
    const isTTY = Boolean(process.stdout.isTTY);

    const render = (label, detail = '') => {
        const percent = Math.min(100, Math.round((current / totalPhases) * 100));
        const filled = Math.round((percent / 100) * PROGRESS_BAR_WIDTH);
        const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
        const line = `  [${bar}] ${String(percent).padStart(3)}% ${label}${detail ? `：${compactText(detail)}` : ''}`;

        if (isTTY) {
            process.stdout.write(`\r\x1b[K${line}`);
        } else if (current > 0) {
            console.log(line);
        }
    };

    return {
        update(label, detail) {
            if (isTTY) render(label, detail);
        },
        step(label, detail) {
            current = Math.min(totalPhases, current + 1);
            render(label, detail);
        },
        finish(label, detail) {
            current = totalPhases;
            render(label, detail);
            process.stdout.write('\n');
        },
    };
}

function applyReplacementString(template, args) {
    return template.replace(/\$(\d+)/g, (match, index) => {
        const value = args[Number(index)];
        return value === undefined ? match : value;
    });
}

function replaceRegexWithCount(content, regex, replacement) {
    let count = 0;
    const nextContent = content.replace(regex, (...args) => {
        count++;
        if (typeof replacement === 'function') {
            return replacement(...args);
        }
        return applyReplacementString(replacement, args);
    });
    return { content: nextContent, count };
}

function replaceStringWithCount(content, search, replacement) {
    // 预检：不包含直接返回，避免对 10MB+ 文件做无谓的 split/join 扫描
    if (!search || content.indexOf(search) === -1) return { content, count: 0 };
    // 单次 split 即可同时得到替换结果与命中次数，省掉一次独立计数扫描
    const parts = content.split(search);
    const count = parts.length - 1;
    if (count === 0) return { content, count };
    return { content: parts.join(replacement), count };
}

function createChangeTracker(maxSamples = 12) {
    const groupCounts = new Map();
    const samples = [];

    return {
        record(group, from, to, count) {
            if (count <= 0) return;

            groupCounts.set(group, (groupCounts.get(group) || 0) + count);
            if (samples.length < maxSamples) {
                samples.push({ group, from, to, count });
            }
        },
        print() {
            const total = [...groupCounts.values()].reduce((sum, count) => sum + count, 0);
            console.log(`  ✅ 汉化替换完成，共修改 ${total} 处。`);

            if (groupCounts.size > 0) {
                console.log('  🧾 修改内容摘要：');
                for (const [group, count] of groupCounts.entries()) {
                    console.log(`    - ${group}: ${count} 处`);
                }
            }

            if (samples.length > 0) {
                console.log('  🔎 本次命中的部分内容：');
                samples.forEach(({ group, from, to, count }) => {
                    console.log(`    - ${group}: ${formatReplacementDetail(from, to, count)}`);
                });
            }
        },
    };
}


// ═══════════════════════════════════════════════
// 备份与还原
// ═══════════════════════════════════════════════

function backupFile(filePath, productJsonPath) {
    const backupPath = filePath + '.backup';
    const metaPath = backupPath + '.meta';
    const fileName = path.basename(filePath);

    // 读取当前 Cursor 版本（用于检测升级后备份是否陈旧）
    let currentVersion = null;
    if (productJsonPath && fs.existsSync(productJsonPath)) {
        try {
            const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
            currentVersion = product.version || null;
        } catch { /* ignore */ }
    }

    if (fs.existsSync(backupPath)) {
        // 检测备份是否对应当前版本（Cursor 升级后旧备份需覆盖）
        let backupVersion = null;
        try {
            if (fs.existsSync(metaPath)) {
                backupVersion = JSON.parse(fs.readFileSync(metaPath, 'utf8')).version || null;
            }
        } catch { /* ignore */ }

        if (currentVersion && backupVersion && currentVersion !== backupVersion) {
            // 版本不一致 → Cursor 已升级，旧备份是陈旧原版，覆盖为新原版
            fs.copyFileSync(filePath, backupPath);
            if (currentVersion) {
                try { fs.writeFileSync(metaPath, JSON.stringify({ version: currentVersion }), 'utf8'); } catch { /* ignore */ }
            }
            return `🔄 ${fileName}: 检测到 Cursor 升级（${backupVersion} → ${currentVersion}），已更新备份`;
        }
        return `🧩 ${fileName}: 已发现原版备份，保留当前文件继续汉化`;
    } else if (fs.existsSync(filePath)) {
        // 首次运行 → 创建备份
        fs.copyFileSync(filePath, backupPath);
        if (currentVersion) {
            try { fs.writeFileSync(metaPath, JSON.stringify({ version: currentVersion }), 'utf8'); } catch { /* ignore */ }
        }
        return `💾 ${fileName}: 已备份纯净原版文件`;
    }
    return null;
}

function restoreFromBackup(filePath) {
    const backupPath = filePath + '.backup';
    const metaPath = backupPath + '.meta';
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath);
        // 还原后删除备份和版本元数据，下次汉化重新创建
        try {
            fs.unlinkSync(backupPath);
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        } catch { /* ignore */ }
        return true;
    }
    return false;
}


// ═══════════════════════════════════════════════
// Hash 修复
// ═══════════════════════════════════════════════

function detectHashAlgo(hash) {
    const len = hash.length;
    if (len <= 24) return 'md5';
    if (len <= 44) return 'sha256';
    if (len <= 88) return 'sha512';
    return 'sha256';
}

/**
 * 安全写回大文件：优先临时文件替换；失败时回退为直接覆盖（兼容 Program Files 下文件被占用）
 */
function writeFileSafe(filePath, content, encoding = 'utf8') {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.cursor-i18n-${path.basename(filePath)}.${process.pid}.tmp`);

    const verifyExists = () => {
        if (!fs.existsSync(filePath)) {
            throw new Error(`写入后无法找到文件: ${filePath}`);
        }
    };

    const cleanupTmp = () => {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore
        }
    };

    try {
        fs.writeFileSync(tmpPath, content, encoding);
        try {
            // 用 copyFileSync 覆盖目标（避免先 unlink 再 rename 的窗口期，
            // 若原文件被占用 copyFileSync 会抛异常，原文件不受影响）
            fs.copyFileSync(tmpPath, filePath);
            cleanupTmp();
            verifyExists();
            return;
        } catch {
            cleanupTmp();
        }
    } catch {
        cleanupTmp();
    }

    fs.writeFileSync(filePath, content, encoding);
    verifyExists();
}

/**
 * 使用内存中的文件内容更新 product.json 校验值（避免写回后立刻读盘失败）
 * @param {string | Buffer} fileContent
 */
function fixProductHash(fileContent, productJsonPath, checksumFileName = 'workbench.desktop.main.js') {
    const contentBuffer = Buffer.isBuffer(fileContent)
        ? fileContent
        : Buffer.from(fileContent, 'utf8');

    if (!fs.existsSync(productJsonPath)) {
        throw new Error(`找不到 product.json: ${productJsonPath}`);
    }

    const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
    let hashUpdated = false;

    if (productJson.checksums) {
        for (const key in productJson.checksums) {
            if (key.endsWith(checksumFileName)) {
                const oldHash = productJson.checksums[key];
                const algo = detectHashAlgo(oldHash);
                const newHash = crypto.createHash(algo)
                    .update(contentBuffer)
                    .digest('base64')
                    .replace(/=+$/, '');
                productJson.checksums[key] = newHash;
                hashUpdated = true;
                break;
            }
        }
    }

    if (hashUpdated) {
        writeFileSafe(productJsonPath, JSON.stringify(productJson, null, '\t'), 'utf8');
    }
    return hashUpdated;
}


// ═══════════════════════════════════════════════
// Mac Gatekeeper 修复
// ═══════════════════════════════════════════════

function fixMacGatekeeper(appPath) {
    if (PLATFORM !== 'darwin') return;

    // 往上找到 .app 目录
    const appBundlePath = appPath.split('/Contents/')[0];
    if (!appBundlePath || !appBundlePath.endsWith('.app')) return;

    console.log('🍎 正在修复 macOS Gatekeeper 签名...');

    // 1. 清除隔离属性
    try {
        execSync(`xattr -cr "${appBundlePath}"`, { stdio: 'pipe' });
        console.log('  ✅ 已清除隔离属性 (xattr -cr)');
    } catch (e) {
        console.log('  ⚠️ 清除隔离属性失败: ' + e.message);
    }

    // 2. 重签名（容错：用户可能未安装 Xcode 命令行工具）
    try {
        execSync(`codesign --force --deep --sign - "${appBundlePath}"`, { stdio: 'pipe' });
        console.log('  ✅ 已完成本地重签名 (codesign)');
    } catch (e) {
        console.log('  ⚠️ codesign 重签名失败（可能未安装 Xcode 命令行工具），不影响使用: ' + e.message);
    }
}

// Glass / Agent 独立 bundle 中常见的新版 UI 片段。
// 这些替换只在附加 JS 文件里执行，避免为了新窗口文案扩大 desktop 主文件的短词替换面。
const auxiliaryInterfaceReplacements = [
    ['general:"General"', 'general:"通用"'],
    ['profile:"Profile"', 'profile:"个人资料"'],
    ['appearance:"Appearance"', 'appearance:"外观"'],
    ['fun:"Fun"', 'fun:"趣味"'],
    ['chat:"Agents"', 'chat:"智能体"'],
    ['browser:"Browser & Network"', 'browser:"浏览器与网络"'],
    ['tab:"Tab"', 'tab:"Tab 补全"'],
    ['models:"Models"', 'models:"模型"'],
    ['"git-prs":"Git & PRs"', '"git-prs":"Git 与 PR"'],
    ['customize:"Customize"', 'customize:"自定义"'],
    ['mcp:"Tools & MCPs"', 'mcp:"工具与 MCP"'],
    ['hooks:"Hooks"', 'hooks:"钩子"'],
    ['beta:"Beta"', 'beta:"测试功能"'],
    ['network:"Network"', 'network:"网络"'],
    ['"self-driving":"Self-driving PRs"', '"self-driving":"自动 PR"'],
    ['developer:"Developer"', 'developer:"开发者"'],
    ['title:"Conversation"', 'title:"对话"'],
    ['label:"Conversation"', 'label:"对话"'],
    ['"<div>Web Search Tool"', '"<div>网络搜索工具"'],
    ['"<span class=cursor-settings-new-badge>NEW"', '"<span class=cursor-settings-new-badge>新"'],
    ['children:"NEW"', 'children:"新"'],
    ['"<div>New project"', '"<div>新建项目"'],
    ['"<div>Open project"', '"<div>打开项目"'],
    ['"<div>Clone repo"', '"<div>克隆仓库"'],
    ['"<div>Connect via SSH"', '"<div>通过 SSH 连接"'],
    ['"<div>New Window"', '"<div>新窗口"'],
    ['"<span>Recent projects"', '"<span>最近项目"'],
    ['"<div class=empty-screen-view-all>View all (<!>)"', '"<div class=empty-screen-view-all>查看全部 (<!>)"'],
    ['`Open project: ${n.projectName}`', '`打开项目：${n.projectName}`'],
    ['"Open project"', '"打开项目"'],
    ['"Clone repo"', '"克隆仓库"'],
    ['"Connect via SSH"', '"通过 SSH 连接"'],
    ['"Connect via WSL"', '"通过 WSL 连接"'],
    ['"Try a new window for running parallel agents"', '"尝试使用新窗口运行并行智能体"'],
    ['"Plan New Idea"', '"规划新想法"'],
    ["'Plan New Idea'", "'规划新想法'"],
    ['`Plan New Idea`', '`规划新想法`'],
    ['label:"Plan New Idea"', 'label:"规划新想法"'],
    ['title:"Plan New Idea"', 'title:"规划新想法"'],
    ['children:"Plan New Idea"', 'children:"规划新想法"'],
    ['"Ask questions without making changes..."', '"提问但不修改..."'],
    ["'Ask questions without making changes...'", "'提问但不修改...'"],
    ['`Ask questions without making changes...`', '`提问但不修改...`'],
    ['placeholder:"Ask questions without making changes..."', 'placeholder:"提问但不修改..."'],
    ['description:"Ask questions without making changes"', 'description:"提问但不修改"'],
    ['label:"Local"', 'label:"本地"'],
    ['title:"Local"', 'title:"本地"'],
    ['children:"Local"', 'children:"本地"'],
    ['label:"Cursor Local"', 'label:"Cursor 本地"'],
    ['title:"Cursor Local"', 'title:"Cursor 本地"'],
    ['children:"Cursor Local"', 'children:"Cursor 本地"'],
    ['label:"Ultra Plan"', 'label:"Ultra 套餐"'],
    ['title:"Ultra Plan"', 'title:"Ultra 套餐"'],
    ['children:"Ultra Plan"', 'children:"Ultra 套餐"'],
    ['label:"New Agent"', 'label:"新建智能体"'],
    ['title:"New Agent"', 'title:"新建智能体"'],
    ['children:"New Agent"', 'children:"新建智能体"'],
    ['"aria-label":"New Agent"', '"aria-label":"新建智能体"'],
    ['"Open New Agent Chat"', '"打开新智能体聊天"'],
    ['original:"Open New Agent Chat"', 'original:"打开新智能体聊天"'],
    ['"New Agent in Project"', '"在项目中新建智能体"'],
    ['children:"New Agent in Project"', 'children:"在项目中新建智能体"'],
    ['heading:"New Agent with Model"', 'heading:"使用模型新建智能体"'],
    ['title:"New Agent with Model"', 'title:"使用模型新建智能体"'],
    ['title:"New Agent with Query"', 'title:"使用查询新建智能体"'],
    ['title:"New Agent with Context"', 'title:"使用上下文新建智能体"'],
    ['title:"New Agent (preserve editor panel)"', 'title:"新建智能体（保留编辑器面板）"'],
    ['description:"New Agents Window (Glass)"', 'description:"新建 Agents Window"'],
    ['metadata:{description:"New Agents Window (Glass)"}', 'metadata:{description:"新建 Agents Window"}'],
    ['`New Agent in ${tr}`', '`在 ${tr} 中新建智能体`'],
    ['`New Agent in ${ti.name}`', '`在 ${ti.name} 中新建智能体`'],
    ['`New Agent in ${n.displayName}`', '`在 ${n.displayName} 中新建智能体`'],
    ['label:"Search"', 'label:"搜索"'],
    ['title:"Search"', 'title:"搜索"'],
    ['children:"Search"', 'children:"搜索"'],
    ['placeholder:"Search"', 'placeholder:"搜索"'],
    ['label:"Automations"', 'label:"自动化"'],
    ['title:"Automations"', 'title:"自动化"'],
    ['children:"Automations"', 'children:"自动化"'],
    ['s===void 0?"Automations"', 's===void 0?"自动化"'],
    ['label:"Marketplace"', 'label:"插件市场"'],
    ['title:"Marketplace"', 'title:"插件市场"'],
    ['children:"Marketplace"', 'children:"插件市场"'],
    ['name:Je(9469,"Repositories")', 'name:Je(9469,"代码库")'],
    ['name:ot(9469,"Repositories")', 'name:ot(9469,"代码库")'],
    ['collectionLabel:"Repositories"', 'collectionLabel:"代码库"'],
    ['label:"Repositories"', 'label:"代码库"'],
    ['title:"Repositories"', 'title:"代码库"'],
    ['children:"Repositories"', 'children:"代码库"'],
    ['label:"Editor Window"', 'label:"编辑器窗口"'],
    ['title:"Editor Window"', 'title:"编辑器窗口"'],
    ['children:"Editor Window"', 'children:"编辑器窗口"'],
    ['"aria-label":"Editor Window"', '"aria-label":"编辑器窗口"'],
    ['label:"Open Editor Window"', 'label:"打开编辑器窗口"'],
    ['title:"Open Editor Window"', 'title:"打开编辑器窗口"'],
    ['children:"Open Editor Window"', 'children:"打开编辑器窗口"'],
    ['label:"Open in Editor Window"', 'label:"在编辑器窗口中打开"'],
    ['title:"Open in Editor Window"', 'title:"在编辑器窗口中打开"'],
    ['children:"Open in Editor Window"', 'children:"在编辑器窗口中打开"'],
    ['"Open in Editor Window"', '"在编辑器窗口中打开"'],
    ['"Import from Editor Window"', '"从编辑器窗口导入"'],
    ['`Import from Editor Window (${S})`', '`从编辑器窗口导入 (${S})`'],
    ['message:"Failed to start multitasking."', 'message:"启动多任务失败。"'],
    ['"Starting Multitask"', '"正在启动多任务"'],
    ['"Start Multitasking"', '"启动多任务"'],
    ['title:"Run tasks in parallel"', 'title:"并行运行任务"'],
    ['label:"Open Agents Window on startup"', 'label:"启动时打开 Agents Window"'],
    ['description:"When launching Cursor, open Agents Window by default"', 'description:"启动 Cursor 时默认打开 Agents Window"'],
    ['label:"Open Agents Window on Startup"', 'label:"启动时打开 Agents Window"'],
    ['description:"Open the Agents Window by default when Cursor launches"', 'description:"Cursor 启动时默认打开 Agents Window"'],
    ['label:"Code Block Word Wrap"', 'label:"代码块自动换行"'],
    ['description:"Wrap long lines in Agent conversation code blocks"', 'description:"在智能体对话代码块中自动换行长行"'],
    ['label:"Voice Submit Keywords"', 'label:"语音提交关键词"'],
    ['description:"Custom words that submit a voice prompt. Spaces and punctuation are ignored."', 'description:"用于提交语音提示的自定义词。会忽略空格和标点。"'],
    ['label:"Explore Subagent Model"', 'label:"探索子智能体模型"'],
    ['description:"Choose the model used by the Explore subagent for initial research"', 'description:"选择探索子智能体进行初始研究时使用的模型"'],
    ['description:"Choose the model used by Explore subagent for initial research"', 'description:"选择探索子智能体进行初始研究时使用的模型"'],
    ['label:"Deployment Name"', 'label:"部署名称"'],
    ['placeholder:"AWS Access Key ID"', 'placeholder:"AWS 访问密钥 ID"'],
    ['placeholder:"AWS Secret Access Key"', 'placeholder:"AWS 秘密访问密钥"'],
    ['label:"Access Key ID"', 'label:"访问密钥 ID"'],
    ['label:"Secret Access Key"', 'label:"秘密访问密钥"'],
    ['label:"Region"', 'label:"区域"'],
    ['label:"Test Model"', 'label:"测试模型"'],
    ['"Configure AWS Bedrock to use Anthropic Claude models through your AWS account."', '"配置 AWS Bedrock，通过你的 AWS 账号使用 Anthropic Claude 模型。"'],
    ['"Cursor Enterprise teams can configure IAM roles to access Bedrock without any Access Keys."', '"Cursor 企业团队可以配置 IAM 角色，无需访问密钥即可访问 Bedrock。"'],
    ['"Your team has configured AWS Bedrock access. You can use your teams Bedrock instance without any additional configuration."', '"你的团队已配置 AWS Bedrock 访问权限。无需额外配置即可使用团队的 Bedrock 实例。"'],
    ['title:"Ignore Files"', 'title:"忽略文件"'],
    ['label:"Hierarchical Cursor Ignore"', 'label:"分层 Cursor 忽略"'],
    ['label:"Ignore Symlinks in Cursor Ignore Search"', 'label:"在 Cursor 忽略搜索中忽略符号链接"'],
    ['return`Apply .cursorignore files to all subdirectories${n()?" (controlled by admin)":""}. Changing this setting requires restarting Cursor.`', 'return`将 .cursorignore 文件应用到所有子目录${n()?"（由管理员控制）":""}。更改此设置需要重启 Cursor。`'],
    ['return`Use with caution. Skip symlinks during .cursorignore file discovery. Enable only when all .cursorignore files are reachable without symlinks${i()?" (controlled by admin)":""}. Changing this setting requires restarting Cursor.`', 'return`谨慎使用。在查找 .cursorignore 文件时跳过符号链接。仅当无需符号链接即可访问所有 .cursorignore 文件时才启用${i()?"（由管理员控制）":""}。更改此设置需要重启 Cursor。`'],
    ['get title(){return`Configured Hooks (${I()})`}', 'get title(){return`已配置的钩子 (${I()})`}'],
    ['get title(){return`Configured Hooks (${A()})`}', 'get title(){return`已配置的钩子 (${A()})`}'],
    ['label:"Configured Hooks"', 'label:"已配置的钩子"'],
    ['label:"Execution Log"', 'label:"执行日志"'],
    ['"Extensions have been modified on disk. Please reload the window."', '"扩展已在磁盘上修改。请重新加载窗口。"'],
    ['label:"Fork"', 'label:"分叉"'],
    ['label:"Copy"', 'label:"复制"'],
    ['label:"Share"', 'label:"分享"'],
    ['label:"Export"', 'label:"导出"'],
    ['label:"Open in Web"', 'label:"在网页中打开"'],
    ['label:"Open in New Window"', 'label:"在新窗口中打开"'],
    ['label:"Rename"', 'label:"重命名"'],
    ['label:s?"Unpin":"Pin"', 'label:s?"取消固定":"固定"'],
    ['label:ge?"Discard":"Archive"', 'label:ge?"丢弃":"归档"'],
    ['label:"Copy Transcript"', 'label:"复制对话记录"'],
    ['label:"Copy Web Link"', 'label:"复制网页链接"'],
    ['label:"Copy Deep Link"', 'label:"复制深层链接"'],
    ['label:"Copy Branch"', 'label:"复制分支"'],
    ['children:"Open in New Window"', 'children:"在新窗口中打开"'],
    ['children:"Fork"', 'children:"分叉"'],
    ['children:"Copy"', 'children:"复制"'],
    ['children:"Export"', 'children:"导出"'],
    ['children:"Pin"', 'children:"固定"'],
    ['children:"Rename"', 'children:"重命名"'],
    ['children:"Archive"', 'children:"归档"'],
    ['label:"Split Up"', 'label:"向上拆分"'],
    ['label:"Split Down"', 'label:"向下拆分"'],
    ['label:"Split Left"', 'label:"向左拆分"'],
    ['label:"Split Right"', 'label:"向右拆分"'],
    ['Je(3511,"Split Up")', 'Je(3511,"向上拆分")'],
    ['Je(3512,"Split Down")', 'Je(3512,"向下拆分")'],
    ['Je(3513,"Split Left")', 'Je(3513,"向左拆分")'],
    ['Je(3514,"Split Right")', 'Je(3514,"向右拆分")'],
    ['Je(3515,"Split in Group")', 'Je(3515,"在组内拆分")'],
    ['ot(3511,"Split Up")', 'ot(3511,"向上拆分")'],
    ['ot(3512,"Split Down")', 'ot(3512,"向下拆分")'],
    ['ot(3513,"Split Left")', 'ot(3513,"向左拆分")'],
    ['ot(3514,"Split Right")', 'ot(3514,"向右拆分")'],
    ['ot(3515,"Split in Group")', 'ot(3515,"在组内拆分")'],
    ['"Upgrade to Ultra Plan for near unlimited use, or set a Spend Limit for overages."', '"升级到 Ultra 套餐以获得近乎无限的使用量，或设置超额消费限额。"'],
    ['detail:"Upgrade to Ultra Plan for near unlimited use, or set a Spend Limit for overages."', 'detail:"升级到 Ultra 套餐以获得近乎无限的使用量，或设置超额消费限额。"'],
    ['"Search branches..."', '"搜索分支..."'],
    ['placeholder:"Search branches..."', 'placeholder:"搜索分支..."'],
    ['"Loading branches..."', '"正在加载分支..."'],
    ['"No branches found"', '"未找到分支"'],
    ['"No branches available"', '"暂无可用分支"'],
    ['"Searching..."', '"正在搜索..."'],
    ['"Loading more..."', '"正在加载更多..."'],
    ['"Load more"', '"加载更多"'],
    ['title:"Current Branch"', 'title:"当前分支"'],
    ['"Current Branch"', '"当前分支"'],
    ['"Select branch"', '"选择分支"'],
    ['"Select Agent Branch"', '"选择智能体分支"'],
    ['"Tracked repositories"', '"已跟踪代码库"'],
    ['"Repositories and branches"', '"代码库和分支"'],
    ['"Branches"', '"分支"'],
    ['"Recent"', '"最近"'],
    ['children:"Current"', 'children:"当前"'],
    ['children:"Recent"', 'children:"最近"'],
    ['title:"Pull Requests"', 'title:"拉取请求"'],
    ['label:"Review Provider"', 'label:"评审提供方"'],
    ['label:"PR Link Destination"', 'label:"PR 链接打开位置"'],
    ['"Open pull request links inside Cursor or in the default browser"', '"在 Cursor 内或默认浏览器中打开拉取请求链接"'],
    ['return`Choose ${BtT(n)} for pull request links on web and desktop`', 'return`选择 ${BtT(n)} 作为网页和桌面端 PR 链接打开方式`'],
    ['`${e[0]} or ${e[1]}`', '`${e[0]} 或 ${e[1]}`'],
    ['`${e.slice(0,-1).join(", ")}, or ${e[e.length-1]}`', '`${e.slice(0,-1).join("、")}，或 ${e[e.length-1]}`'],
    ['return n==="externalBrowser"?"Default browser":"Inside Cursor"', 'return n==="externalBrowser"?"默认浏览器":"Cursor 内打开"'],
    ['{id:"inApp",label:"Inside Cursor"},{id:"externalBrowser",label:"Default browser"}', '{id:"inApp",label:"Cursor 内打开"},{id:"externalBrowser",label:"默认浏览器"}'],
    ['label:"Team default"', 'label:"团队默认值"'],
    ['"Open chat as editor tabs is unavailable while non-chat content is placed in the Secondary Side Bar."', '"当辅助侧边栏中放置了非聊天内容时，无法以编辑器标签页打开聊天。"'],
    ['label:"Open chat as editor tabs"', 'label:"以编辑器标签页打开聊天"'],
    ['description:"Show chats as editor tabs inside the chat area instead of the legacy stacked view"', 'description:"在聊天区域内以编辑器标签页显示聊天，而不是旧版堆叠视图"'],
    ['label:"Ignored Files"', 'label:"忽略的文件"'],
    ['description:"Glob patterns for files where Cursor Tab will not suggest"', 'description:"Cursor Tab 不提供建议的文件 Glob 匹配模式"'],
    ['placeholder:"e.g., *.md, **/generated/**"', 'placeholder:"例如：*.md, **/generated/**"'],
    ['title:"Configure Ignored Files"', 'title:"配置忽略文件"'],

    // 附加窗口（Glass）独有或 HTML 包裹的片段。
    ['"<div>Web Fetch Tool"', '"<div>网络抓取工具"'],
    ['"<div><span>Task Models"', '"<div><span>任务模型"'],
    ['automations:"Automations"', 'automations:"自动化"'],
        ['themeLabel:"Light"', 'themeLabel:"浅色"'],
        ['themeLabel:"Dark"', 'themeLabel:"深色"'],
        ['themeLabel:"High Contrast"', 'themeLabel:"高对比度"'],
        ['<span>On-Demand Usage', '<span>按需用量'],
        ['"undo","Undo"', '"undo","撤销"'],
        ['"redo","Redo"', '"redo","重做"'],
        ['"cut","Cut"', '"cut","剪切"'],
        ['"copy","Copy"', '"copy","复制"'],
        ['"paste","Paste"', '"paste","粘贴"'],
        ['"selectAll","Select All"', '"selectAll","全选"'],
        // ── Glass 编辑菜单 OS 原生组：title:E({key:"glassOsEditXXX",...},"&&Undo") 查不到 nls 翻译 fallback 英文，转字面量 ──
        ['title:E({key:"glassOsEditUndo",comment:["&& denotes a mnemonic"]},"&&Undo")', 'title:"撤销"'],
        ['title:E({key:"glassOsEditRedo",comment:["&& denotes a mnemonic"]},"&&Redo")', 'title:"重做"'],
        ['title:E({key:"glassOsEditCut",comment:["&& denotes a mnemonic"]},"Cu&&t")', 'title:"剪切"'],
        ['title:E({key:"glassOsEditCopy",comment:["&& denotes a mnemonic"]},"&&Copy")', 'title:"复制"'],
        ['title:E({key:"glassOsEditPaste",comment:["&& denotes a mnemonic"]},"&&Paste")', 'title:"粘贴"'],
        ['title:E({key:"glassOsEditSelectAll",comment:["&& denotes a mnemonic"]},"Select &&All")', 'title:"全选"'],
        // ── Agents 操作按钮动态文本（Undo/Copy 三元表达式，非 label 属性形式）──
        ['?"Undo Cell":"Undo"', '?"撤销单元格":"撤销"'],
        ['?"Undo Apply":"Undo"', '?"撤销应用":"撤销"'],
        ['?"Undo":"Undo All"', '?"撤销":"全部撤销"'],
        ['?"Undo All":"Undo"', '?"全部撤销":"撤销"'],
        ['?"Undo":"Accept"', '?"撤销":"接受"'],
        ['?"Copy Message":"Copy"', '?"复制消息":"复制"'],
        ['?"Copied":"Copy"', '?"已复制":"复制"'],
        ['reject:"Undo"', 'reject:"撤销"'],
        ['??"Undo"', '??"撤销"'],
        ['return"Undo All"', 'return"全部撤销"'],
        ['"glass.agentMetadataTooltip.copy","Copy"', '"glass.agentMetadataTooltip.copy","复制"'],
        ['"glassFileTreeCopyOp","Copy"', '"glassFileTreeCopyOp","复制"'],
        ['"glassFileTreeMove","Move"', '"glassFileTreeMove","移动"'],
        ['marketplace:"Marketplace"', 'marketplace:"插件市场"'],
        ['?"自定义":"Marketplace"', '?"自定义":"插件市场"'],
        ['rootLabel:"Marketplace"', 'rootLabel:"插件市场"'],
        ['[" ","Marketplace"]', '[" ","插件市场"]'],
        ['all:"All"', 'all:"全部"'],
        ['return"All"', 'return"全部"'],
    ['pageTitle:"Automations"', 'pageTitle:"自动化"'],
    ['defaultLabel:"Changes"', 'defaultLabel:"更改"'],

    // ── 用户反馈的未翻译词条：Glass/Agents 窗口专用 ──
    // ── 命令管理面板：筛选/排序下拉选项 ──
    ['label:"Filter By",ariaLabel:"Filter by options"', 'label:"筛选",ariaLabel:"筛选选项"'],
    ['{value:"scope",label:"Source",icon:"folder"}', '{value:"scope",label:"来源",icon:"folder"}'],
    ['{value:"author",label:"Author",icon:"person"}', '{value:"author",label:"作者",icon:"person"}'],
    ['{value:"name",label:"Name",icon:"text-aa"}', '{value:"name",label:"名称",icon:"text-aa"}'],
    // ── 命令/规则列表项操作按钮 ──
    ['?"Manage in Dashboard":"Open"', '?"在仪表盘中管理":"打开"'],
    // ── Show {num} more / Show more ──
    ['children:`Show ${k} more`', 'children:`显示 ${k} 更多`'],
    ['children:["Show ",g," more"]', 'children:["显示 ",g," 更多"]'],
    ['moreLabel:"Show more"', 'moreLabel:"显示更多"'],
    ['?"收起":"Show more"', '?"收起":"显示更多"'],
    // ── Prompt 对话框默认按钮与标题 ──
    ['confirmLabel??"Confirm"', 'confirmLabel??"确认"'],
    ['cancelLabel??"Cancel"', 'cancelLabel??"取消"'],
    ['title??"Prompt"', 'title??"提示"'],
    // ── 命令创建对话框（nls 索引转字面量 + 字面量版）──
    ['title:E(7683,null),placeHolder:E(7684,null),prompt:E(7685,null)', 'title:"输入命令名称",placeHolder:"e.g., my-custom-command",prompt:"请为新命令输入名称"'],
    ['prompt:"Enter Command Name",placeHolder:"Command name"', 'prompt:"输入命令名称",placeHolder:"命令名称"'],
    // ── New User Skill/Subagent 创建对话框（ne/T/oe/M 大写变量改中文供 title/prompt 用；skill/subagent 保持英文供占位符示例用）──
    ['Z==="skill"?"Skill":"Subagent"', 'Z==="skill"?"技能":"子代理"'],
    ['C==="skill"?"Skill":"Subagent"', 'C==="skill"?"技能":"子代理"'],
    ['title:`New User ${ne}`', 'title:`新建用户${ne}`'],
    ['prompt:`Enter a name for the new ${Y}`', 'prompt:`为新的${ne}输入名称`'],
    ['title:`New User ${T}`', 'title:`新建用户${T}`'],
    ['prompt:`Enter a name for the new ${x}`', 'prompt:`为新的${T}输入名称`'],
    // ── User Rules 提示 ──
    ['prompt:"User Rules apply to all of your chats"', 'prompt:"用户规则适用于你的所有对话"'],
    // ── 主题显示名 ──
    ['p$m={light:"Light",dark:"Dark",lightHighContrast:"Light High Contrast",darkHighContrast:"Dark High Contrast"}', 'p$m={light:"浅色",dark:"深色",lightHighContrast:"浅色高对比度",darkHighContrast:"深色高对比度"}'],
    // ── Git 面板加载状态 / 追问按钮 ──
    ['"Loading changes..."', '"正在加载更改..."'],
    ['"Loading changes"', '"正在加载更改"'],
    ['"Loading cloud agent changes"', '"正在加载云智能体更改"'],
    ['"Preparing workspace"', '"正在准备工作区"'],
    ['"Send follow-up with subagent"', '"带子代理发送追问"'],
    ['"Continue chatting in Cursor"', '"在 Cursor 中继续聊天"'],
    ['"Send follow-up"', '"发送追问"'],
    // ── Cycle 命令（循环切换模型参数，Ctrl+Alt+/；参数名由 vscdb 补丁翻译）──
    ['title:{value:"Cycle model parameter",original:"Cycle model parameter"}', 'title:{value:"循环切换模型参数",original:"循环切换模型参数"}'],
    ['title:"Cycle Model Parameter"', 'title:"循环切换模型参数"'],
    ['label:`Cycle ${EP}`', 'label:`循环切换 ${EP}`'],
    ['\\xB7 Cycle ${En} (${bi})', '\\xB7 循环切换 ${En} (${bi})'],
    // ── Done（完成）：按钮/状态/标签 ──
    ['primaryButtonLabel??"Done"', 'primaryButtonLabel??"完成"'],
    ['`Done \\u2022 ${s}`', '`完成 \\u2022 ${s}`'],
    ['"Agent complete"', '"智能体完成"'],
    ['"Done"', '"完成"'],
    // ── 欢迎页：Recent projects / Settings / Import / Show more ──
    ['<span>Recent projects</span>', '<span>最近项目</span>'],
    ['opacity-80">Settings\'', 'opacity-80">设置\''],
    ['?"Success!":', '?"成功!":'],
    ['?"Importing":"Import"', '?"导入中":"导入"'],
    ['`Show ${s} more recent ${s===1?"agent":"agents"}`', '`显示 ${s} 个更多最近智能体`'],
    // ── Thinking intensity 持久翻译：kR_ 注入参数名映射（服务端覆盖数据后仍显示中文）──
    ['function kR_(t){const e=XYo(t);return e.variants=e.variants??[],e.parameterDefinitions=e.parameterDefinitions??[],e}', 'function kR_(t){const e=XYo(t);return e.variants=e.variants??[],e.parameterDefinitions=(e.parameterDefinitions??[]).map(function(p){if(p&&p.name==="Thinking intensity")p.name="思考强度";return p}),e}'],
    // ── 远程扩展显示名（通用功能词，专有名词保持）──
    ['"Remote - SSH"', '"远程 - SSH"'],
    ['"Remote - WSL"', '"远程 - WSL"'],
    // ── 文件树/资源管理器/终端/预览/删除状态 ──
    ['Copied branch name to clipboard', '已复制分支名称到剪贴板'],
    ['"New Folder"', '"新建文件夹"'],
    ['"New File"', '"新建文件"'],
    ['"Refresh Explorer"', '"刷新资源管理器"'],
    ['"Deleted"', '"已删除"'],
    ['"Terminal"', '"终端"'],
    ['"Preview"', '"预览"'],
    ['label:"Source",ariaLabel:"Source"', 'label:"源码",ariaLabel:"源码"'],
    // ── 审查/保留更改按钮 ──
    ['Keep all changes', '保留所有更改'],
    ['Review Next File', '审查下一个文件'],
    // ── 审查界面按钮：Stop/Review/Accept/Reject ──
    ['"Stop"', '"停止"'],
    ['"Review"', '"审查"'],
    ['"Accept"', '"接受"'],
    ['"Reject"', '"拒绝"'],
    // ── AI 统计面板：Repo/Branch 前缀 ──
    ['Repo: ', '仓库：'],
    ['Branch: ', '分支：'],
    // ── 附加文件命令 ──
    ['"Add Files to New Chat"', '"添加文件到新聊天"'],
    ['"Add Files to Chat"', '"添加文件到聊天"'],
    // ── 文件上下文菜单 / 搜索面板 ──
    ['Reveal in File Explorer', '在文件资源管理器中显示'],
    ['Copy Remote URL', '复制远程 URL'],
    ['Diff View', '差异视图'],
    ['More search options', '更多搜索选项'],
    ['Match Case', '匹配大小写'],
    ['Match Whole Word', '匹配整个单词'],
    // ── 审查操作 / AI 统计行 ──
    ['Accept all changes', '接受所有更改'],
    ['Keep All', '保留全部'],
    ['} added, ${', '} 新增, ${'],
    ['} deleted`', '} 删除`'],
    ['} deleted)', '} 删除)'],
    // ── 审查界面 Keep / 审查变更 ──
    ['"Keep"', '"保留"'],
    ['Review Changes', '审查更改'],
    // ── 浏览器连接错误 ──
    ['"Connection Failed"', '"连接失败"'],
    ['"Restart Browser"', '"重启浏览器"'],
    // ── Show N more / MCP 状态 / 私有设置 ──
    ['Show ${', '显示 ${'],
    ['} enabled`', '} 已启用`'],
    ['Add for Myself', '为我添加'],
    ['Add to Project', '添加到项目'],
    ['Show Output', '显示输出'],
    // ── MCP 状态 / 私有 / 个人 / 删除 ──
    ['"Private"', '"私有"'],
    ['"Disabled"', '"已禁用"'],
    ['"Personal"', '"个人"'],
    ['hintText:"Delete"', 'hintText:"删除"'],
    // ── MCP 空状态 ──
    ['No MCP Tools', '没有 MCP 工具'],
    ['Add a custom MCP tool here or configure project-specific tools in', '在此添加自定义 MCP 工具，或在项目专用工具中配置'],
    ['Add Custom MCP', '添加自定义 MCP'],
    // ── 文件上下文菜单 ──
    ['Open in Browser', '在浏览器中打开'],
    ['Add File to Cursor Chat', '添加文件到 Cursor 聊天'],
    ['Add File to New Cursor Chat', '添加文件到新 Cursor 聊天'],
    // ── 状态栏/命令面板 ──
    ['Workspace Name', '工作区名称'],
    ['"AI Code Tracking Stats - Agent"', '"AI 代码追踪统计 - 智能体"'],
    ['"AI Code Tracking Stats - Tab"', '"AI 代码追踪统计 - Tab"'],
    // ── 更多操作 / 视图 / 关于窗口 ──
    ['More actions', '更多操作'],
    ['Render Whitespace', '显示空白'],
    ['Check for updates', '检查更新'],
    ['Copy version info', '复制版本信息'],
    // ── 命令面板 / 提示 / 网络日志 / 响应评价 ──
    ['Go to File', '转到文件'],
    ['Go to Symbol in Workspace', '转到工作区中的符号'],
    ['Hard reload (clears cache)', '硬重新加载(清除缓存)'],
    ['Auto-Review', '自动审查'],
    ['API requests', 'API 请求'],
    ['Agent requests', '智能体请求'],
    ['Codebase indexing', '代码库索引'],
    ['Authentication UI (login page)', '身份验证界面(登录页)'],
    ['Extension marketplace', '扩展市场'],
    ['Marketplace CDN', '市场 CDN'],
    ['Client updates', '客户端更新'],
    ['Binary file not shown', '未显示二进制文件'],
    ['Good response', '良好回复'],
    ['Bad response', '不良回复'],
    ['Copy Message', '复制消息'],
    ['Show all (<!> more)', '显示全部(<!> 更多)'],
    // ── Git 状态 / 继续 / 总结提示 ──
    ['"Unstaged"', '"未暂存"'],
    ['"Staged"', '"已暂存"'],
    ['children:"Resume"', 'children:"继续"'],
    ['label:"Resume"', 'label:"继续"'],
    ['Summarizing chat context', '正在总结对话上下文'],
    // ── 用户反馈的未翻译词条：Glass/Agents 窗口专用 ──
    // "New" 作为独立 UI 文案（不加入 riskyShortWords 因为会误伤 trimNew 等代码）
    ['children:"New"', 'children:"新建"'],
    ['label:"New"', 'label:"新建"'],
    ['title:"New"', 'title:"新建"'],
    ['placeholder:"New"', 'placeholder:"新建"'],
    ['name:"New"', 'name:"新建"'],
    ['>"New"', '>"新建"'],
    // Documentation
    ['children:"Documentation"', 'children:"文档"'],
    ['label:"Documentation"', 'label:"文档"'],
    ['title:"Documentation"', 'title:"文档"'],
    // Connected
    ['children:"Connected"', 'children:"已连接"'],
    ['label:"Connected"', 'label:"已连接"'],
    ['title:"Connected"', 'title:"已连接"'],
    ['>"Connected"', '>"已连接"'],
    // Installed
    ['children:"Installed"', 'children:"已安装"'],
    ['label:"Installed"', 'label:"已安装"'],
    ['title:"Installed"', 'title:"已安装"'],
    ['>"Installed"', '>"已安装"'],
    // Image
    ['children:"Image"', 'children:"图片"'],
    ['label:"Image"', 'label:"图片"'],
    ['title:"Image"', 'title:"图片"'],
    // Cloud
    ['children:"Cloud"', 'children:"云端"'],
    ['label:"Cloud"', 'label:"云端"'],
    ['title:"Cloud"', 'title:"云端"'],
    ['>"Cloud"', '>"云端"'],
    // Recents
    ['children:"Recents"', 'children:"最近"'],
    ['label:"Recents"', 'label:"最近"'],
    ['title:"Recents"', 'title:"最近"'],
    ['>"Recents"', '>"最近"'],
    // Run on / This PC
    ['children:"Run on"', 'children:"运行于"'],
    ['label:"Run on"', 'label:"运行于"'],
    ['children:"This PC"', 'children:"此电脑"'],
    ['label:"This PC"', 'label:"此电脑"'],
    ['"Run on This PC"', '"在此电脑上运行"'],
    ['"Run on Cloud"', '"在云端运行"'],
    // + Add
    ['children:"+ Add"', 'children:"+ 添加"'],
    ['label:"+ Add"', 'label:"+ 添加"'],
    ['>"+ Add"', '>"+ 添加"'],
    // User Config
    ['children:"User Config"', 'children:"用户配置"'],
    ['label:"User Config"', 'label:"用户配置"'],
    ['title:"User Config"', 'title:"用户配置"'],
    // From Marketplace / From Local Repo
    ['children:"From Marketplace"', 'children:"从插件市场"'],
    ['children:"From Local Repo"', 'children:"从本地仓库"'],
    // New Worktree
    ['children:"New Worktree"', 'children:"新建工作树"'],
    ['label:"New Worktree"', 'label:"新建工作树"'],
    ['title:"New Worktree"', 'title:"新建工作树"'],
    // Click or hold Ctrl M to dictate
    ['children:"Click or hold Ctrl M to dictate"', 'children:"点击或按住 Ctrl M 进行听写"'],
    ['placeholder:"Click or hold Ctrl M to dictate"', 'placeholder:"点击或按住 Ctrl M 进行听写"'],
    // Run Cursor anywhere...
    ['children:"Run Cursor anywhere..."', 'children:"在任何地方运行 Cursor..."'],
    ['placeholder:"Run Cursor anywhere..."', 'placeholder:"在任何地方运行 Cursor..."'],
    // Learn more（HTML 上下文）
    ['>Learn more\'', '>了解更多\''],
    ['>Learn more"', '>了解更多"'],
    ['>Learn more<', '>了解更多<'],
    // Give Feedback...
    ['"Give Feedback..."', '"提供反馈..."'],
    ['children:"Give Feedback..."', 'children:"提供反馈..."'],
    ['label:"Give Feedback..."', 'label:"提供反馈..."'],
    // 模板字符串中的动态 tooltip（safeMegaRegex 无法匹配反引号）
    ['`Toggle Agents Side Bar (${', '`切换智能体侧边栏 (${'],
    ['`Toggle Agents (${', '`切换智能体 (${'],
    ['`Toggle Primary Side Bar (${', '`切换主侧边栏 (${'],
    ['`Show Agents Side Bar (${', '`显示智能体侧边栏 (${'],
    // title 属性直接赋值（非 Te()/ft() 包裹，glass.js 中常见）
    ['title:"Show Terminal"', 'title:"显示终端"'],
    ['title:"Toggle Developer Tools"', 'title:"切换开发者工具"'],
    ['title:"Open Process Explorer"', 'title:"打开进程浏览器"'],
    ['title:"Report Issue"', 'title:"报告问题"'],
    // LABEL 直接赋值（Help菜单中的 Report Issue）
    ['.LABEL="Report Issue"', '.LABEL="报告问题"'],
    // ── 字体大小选项（Small/Default/Large/超大）──
    ['case .85:return"Small";case 1:return"Default";case 1.15:return"Large";case 1.3:return"超大"', 'case .85:return"小";case 1:return"默认";case 1.15:return"大";case 1.3:return"超大"'],
    // ── Show/Hide 切换按钮（title getter 三元表达式）──
    ['?"Hide":"Show"', '?"隐藏":"显示"'],
    // ── Import 按钮（Importing... 状态）──
    ['?"Importing\u2026":"Import"', '?"正在导入…":"导入"'],
    ['?"Importing...":"Import"', '?"正在导入...":"导入"'],
    // ── claude-code-import-indicator 状态标签 ──
    ['case"claude-code-import-indicator":return"Import"', 'case"claude-code-import-indicator":return"导入"'],
    // ── 模型列表刷新按钮（Refreshing.../Refresh model list 三元）──
    ['?"Refreshing...":"Refresh model list"', '?"正在刷新...":"刷新模型列表"'],
    // ── 模型选择器 Results/Suggested 标题（minified 变量名 tt）──
    ['title:tt?"Results":"Suggested"', 'title:tt?"结果":"推荐"'],
    // ── 命令面板/Agent 菜单 Suggested 分区标题 ──
    ['heading:"Suggested"', 'heading:"推荐"'],
    // ── 模型选择器搜索框 placeholder ──
    ['placeholder:"Add or search model"', 'placeholder:"添加或搜索模型"'],
    // ── 更新渠道名称：switch case 返回值 ──
    ['case"prerelease":return"Early Access"', 'case"prerelease":return"抢先体验"'],
    ['case"dev":return"Nightly"', 'case"dev":return"每夜构建"'],
    ['case"dogfood":return"Dogfood"', 'case"dogfood":return"内部测试"'],
    ['case"candidate":return"Candidate"', 'case"candidate":return"候选版"'],
    // ── 版本号解析中的渠道名 ──
    ['case"9":return"Nightly"', 'case"9":return"每夜构建"'],
    // ── 更新渠道名称：选项列表 label ──
    ['label:"Dogfood",id:"dogfood"', 'label:"内部测试",id:"dogfood"'],
    ['label:"Candidate",id:"candidate"', 'label:"候选版",id:"candidate"'],
    // ── 快捷键提示中的连词 or ──
    ['{children:"or"})', '{children:"或"})'],
    // ── Agent 面板底部快捷键提示（Select/Open/Back）──
    ['shortcut:"\\u2191\\u2193"}),label:"Select"', 'shortcut:"\\u2191\\u2193"}),label:"选择"'],
    ['{name:"return",size:"sm"}),label:"Open"', '{name:"return",size:"sm"}),label:"打开"'],
    ['shortcut:"backspace"}),label:"Back"', 'shortcut:"backspace"}),label:"返回"'],
    // ── 远程窗口 SSH/容器命令（glass.js 中出现）──
    ['title:"Open SSH Configuration File"', 'title:"打开 SSH 配置文件"'],
    ['label:"Dev Containers"', 'label:"开发容器"'],
    ['glassCategory:"Workspace"', 'glassCategory:"工作区"'],
    // ── Cursor Tab 通知/状态栏悬浮框（glass.js）──
    ['n.textContent="Model"', 'n.textContent="模型"'],
    ['o.textContent=n?"Unsnooze":"Snooze"', 'o.textContent=n?"取消暂停":"暂停"'],
    ['K$i="auto (default)"', 'K$i="自动（默认）"'],
    ['"Disable globally"', '"全局禁用"'],
    ['"No commit has been scored yet"', '"暂无已评分的提交"'],
    ['"$(git-commit) No commit scored"', '"$(git-commit) 无提交评分"'],
    ['"Select Cursor Tab snooze duration"', '"选择 Cursor Tab 暂停时长"'],
    ['"Temporarily disable Cursor Tab suggestions for a specified duration. You can unsnooze at any time."', '"临时禁用 Cursor Tab 建议一段指定时间，可随时取消暂停。"'],
    ['.LABEL="Snooze Cursor Tab"', '.LABEL="暂停 Cursor Tab"'],
    ['.LABEL="Unsnooze Cursor Tab"', '.LABEL="取消暂停 Cursor Tab"'],
    // ── Agents 面板：分组/排序/筛选标签 ──
    ['label:"Grouping"', 'label:"分组"'],
    ['children:"Grouping"', 'children:"分组"'],
    ['label:"Ordering"', 'label:"排序"'],
    ['children:"Ordering"', 'children:"排序"'],
    ['title:"Filters"', 'title:"筛选器"'],
    ['value:"repository",label:"Repository"', 'value:"repository",label:"仓库"'],
    ['value:"workspace",label:"Workspace"', 'value:"workspace",label:"工作区"'],
    ['value:"time",label:"Updated"', 'value:"time",label:"更新时间"'],
    ['value:"status",label:"Status"', 'value:"status",label:"状态"'],
    ['value:"environment",label:"Environment"', 'value:"environment",label:"环境"'],
    ['value:"updated",label:"Updated"', 'value:"updated",label:"更新时间"'],
    ['value:"created",label:"Created"', 'value:"created",label:"创建时间"'],
    ['value:"needs_attention",label:"Needs Attention"', 'value:"needs_attention",label:"需要关注"'],
    ['value:"unread_only",label:"Unread"', 'value:"unread_only",label:"未读"'],
    ['value:"running",label:"Working"', 'value:"running",label:"进行中"'],
    ['value:"draft",label:"Draft"', 'value:"draft",label:"草稿"'],
    ['value:"done",label:"Done"', 'value:"done",label:"已完成"'],
    ['value:"git:draft",label:"PR Draft"', 'value:"git:draft",label:"PR 草稿"'],
    ['value:"git:open",label:"PR Open"', 'value:"git:open",label:"PR 开放"'],
    ['value:"git:merged",label:"PR Merged"', 'value:"git:merged",label:"PR 已合并"'],
    ['value:"git:closed",label:"PR Closed"', 'value:"git:closed",label:"PR 已关闭"'],
    ['value:"git:none",label:"No PR"', 'value:"git:none",label:"无 PR"'],
    ['label:"Any time"', 'label:"任意时间"'],
    ['label:"Past day"', 'label:"过去一天"'],
    ['label:"Past week"', 'label:"过去一周"'],
    ['label:"Past month"', 'label:"过去一个月"'],
    ['value:"branch",label:"Branch"', 'value:"branch",label:"分支"'],
    ['value:"timestamp",label:"Updated"', 'value:"timestamp",label:"更新时间"'],
    ['value:"source",label:"Source"', 'value:"source",label:"来源"'],
    ['value:"cloud",label:"Cloud"', 'value:"cloud",label:"云端"'],
    ['value:"local",label:"Local"', 'value:"local",label:"本地"'],
    ['label:"Show",children:"Show"', 'label:"显示",children:"显示"'],
    ['{label:"Reset",onClick:', '{label:"重置",onClick:'],
    ['label:"Status",trailing:sb(dAi', 'label:"状态",trailing:sb(dAi'],
    ['children:"Machine"', 'children:"机器"'],
    // ── Group by 子菜单 ──
    ['label:"Group by Workspace"', 'label:"按工作区分组"'],
    ['label:"Group by Repository"', 'label:"按仓库分组"'],
    ['label:"Group by Updated"', 'label:"按更新时间分组"'],
    ['label:"Group by Status"', 'label:"按状态分组"'],
    ['label:"Group by Environment"', 'label:"按环境分组"'],
    // ── Changes 视图：作用域标签 ──
    ['lastTurn:"Last Turn",uncommitted:"Uncommitted",allChanges:"All",unstaged:"Unstaged",staged:"Staged",branch:"Branch"',
     'lastTurn:"最近一轮",uncommitted:"未提交",allChanges:"全部",unstaged:"未暂存",staged:"已暂存",branch:"分支"'],
    ['?"Branch Commits"', '?"分支提交"'],
    ['?"All Changes"', '?"所有更改"'],
    // ── Changes 视图：Stage/Unstage 操作 ──
    ['"Unstage All"', '"全部取消暂存"'],
    ['"Stage All Remaining Changes"', '"暂存所有剩余更改"'],
    ['"Stage All"', '"全部暂存"'],
    ['"Stage Remaining Changes"', '"暂存剩余更改"'],
    ['"Unstage File"', '"取消暂存文件"'],
    ['"Stage File"', '"暂存文件"'],
    ['children:"Find in Changes"', 'children:"在更改中查找"'],
    ['children:"Refresh Changes"', 'children:"刷新更改"'],
    ['content:"Discard All Changes"', 'content:"放弃所有更改"'],
    // ── Diff 视图：设置开关 ──
    ['{value:"unified",label:"Unified"}', '{value:"unified",label:"统一视图"}'],
    ['{value:"split",label:"Split"}', '{value:"split",label:"拆分视图"}'],
    ['children:"Ignore Whitespace"', 'children:"忽略空白字符"'],
    ['children:"Word Wrap"', 'children:"自动换行"'],
    ['children:"Line Numbers"', 'children:"行号"'],
    ['children:"Auto Save"', 'children:"自动保存"'],
    ['children:"Format on Save"', 'children:"保存时格式化"'],
    // ── 全屏/终端/URL 栏 ──
    ['?"Exit Full Screen":"Enter Full Screen"', '?"退出全屏":"进入全屏"'],
    ['?"Hide Terminal List":"Show Terminal List"', '?"隐藏终端列表":"显示终端列表"'],
    ['"aria-label":"Search or enter URL"', '"aria-label":"搜索或输入 URL"'],
    ['children:"Show Bookmark Bar"', 'children:"显示书签栏"'],
    // ── Canvas ──
    ['"Create a Canvas from chat"', '"从聊天创建画布"'],
    ['?"Hide Canvas List":"Show Canvas List"', '?"隐藏画布列表":"显示画布列表"'],
    // ── 文件操作 ──
    ['"Open a file to get started"', '"打开一个文件即可开始"'],
    ['label:"New File"', 'label:"新建文件"'],
    ['children:"No workspace folder open"', 'children:"没有打开的工作区文件夹"'],
    ['children:"Save File"', 'children:"保存文件"'],
    ['label:"Discard Changes"', 'label:"放弃更改"'],
    ['title:"Search Files"', 'title:"搜索文件"'],
    ['title:"Browse Files"', 'title:"浏览文件"'],
    ['title:"New Tab"', 'title:"新建标签页"'],
    ['.LABEL="New Tab"', '.LABEL="新建标签页"'],
    ['"collapse-all","Collapse All"', '"collapse-all","全部折叠"'],
    ['children:"Mark All as Read"', 'children:"全部标记为已读"'],
    // ── 模式（Plan/Agent/Ask/Debug/Multitask 全部保留英文）──
    ['title:"Toggle Git Blame"', 'title:"切换 Git Blame"'],
    // ── 命令面板 ──
    ['label:"Open Customize"', 'label:"打开自定义"'],
    ['label:"Open Skills"', 'label:"打开技能"'],
    ['label:"Open Subagents"', 'label:"打开子智能体"'],
    ['label:"Open Commands"', 'label:"打开命令"'],
    ['title:"Switch Theme"', 'title:"切换主题"'],
    ['title:"Switch to Cursor Light"', 'title:"切换到 Cursor 浅色"'],
    ['title:"Switch to Cursor Dark"', 'title:"切换到 Cursor 深色"'],
    ['title:"Switch to Cursor High Contrast"', 'title:"切换到 Cursor 高对比度"'],
    ['"Reset In-App Ad Views"', '"重置应用内广告视图"'],
    ['title:"Developer: Open Logs Folder"', 'title:"开发者：打开日志文件夹"'],
    ['title:"About Cursor"', 'title:"关于 Cursor"'],
    // ── 集成来源标签（glass.js 中的对象字面量）──
    ['desktop:"Desktop",sand:"Sand",web:"Web",mobile:"Mobile"', 'desktop:"桌面",sand:"沙盒",web:"网页",mobile:"移动端"'],
    ['scm:"Source Control"', 'scm:"源代码管理"'],
    ['setup:"Setup"', 'setup:"设置"'],
    ['automations:"Automations"', 'automations:"自动化"'],
    ['qabot_frontend:"Frontend QA"', 'qabot_frontend:"前端 QA"'],
    ['local:"Local",internal:"Subagent"', 'local:"本地",internal:"子智能体"'],
    ['text:"Desktop",title:"Open Desktop"', 'text:"桌面",title:"打开桌面"'],
    // ── glass 翻译键回退值 ──
    ['"glassFileTreeCreateFileLabel","New File"', '"glassFileTreeCreateFileLabel","新建文件"'],
    ['"glassCopyRelativePath","Copy Relative Path"', '"glassCopyRelativePath","复制相对路径"'],
    ['?"Copied Path":"Copy Path"', '?"已复制路径":"复制路径"'],
    ['return"Needs attention"', 'return"需要关注"'],
    ['void 0?"Automations"', 'void 0?"自动化"'],
    // ── Canvas 空状态描述 ──
    ['"glass.canvasActivationEmptyState.descriptionPrefix","Type"', '"glass.canvasActivationEmptyState.descriptionPrefix","输入"'],
    ['"glass.canvasActivationEmptyState.descriptionSuffix","to create or open a Canvas."', '"glass.canvasActivationEmptyState.descriptionSuffix","来创建或打开画布。"'],
    // ── Skills & Commands 分区标题 ──
    ['heading:"Skills & Commands"', 'heading:"技能与命令"'],
    // ── Open Customize 标题 ──
    ['title:"Open Customize"', 'title:"打开自定义"'],
    // ── Appearance 标题/标签 ──
    ['title:"Appearance"', 'title:"外观"'],
    ['label:"Appearance"', 'label:"外观"'],
    // ── Agents 面板：Environment/Source 子菜单触发器 ──
    ['label:"Environment",trailing:sb(dAi', 'label:"环境",trailing:sb(dAi'],
    ['children:"Environment"}', 'children:"环境"}'],
    ['label:"Source",trailing:sb(dAi', 'label:"来源",trailing:sb(dAi'],
    ['children:"Source"}', 'children:"来源"}'],
    // ── Changes 侧边栏 ──
    ['"aria-label":"Changes Sidebar"', '"aria-label":"更改侧边栏"'],
    ['"aria-label":"Discard All Changes"', '"aria-label":"放弃所有更改"'],
    ['title:"Uncommitted Changes"', 'title:"未提交的更改"'],
    // ── Git 操作按钮（Sgi 对象）──
    ['createBranchAndCommit:{label:"Create Branch & Commit",loadingLabel:"Committing..."}', 'createBranchAndCommit:{label:"创建分支并提交",loadingLabel:"提交中..."}'],
    ['createBranchCommitAndPush:{label:"Create Branch, Commit & Push",loadingLabel:"Committing..."}', 'createBranchCommitAndPush:{label:"创建分支、提交并推送",loadingLabel:"提交中..."}'],
    ['createBranch:{label:"Create Branch",loadingLabel:"Creating Branch..."}', 'createBranch:{label:"创建分支",loadingLabel:"创建分支中..."}'],
    ['commit:{label:"Commit",loadingLabel:"Committing..."}', 'commit:{label:"提交",loadingLabel:"提交中..."}'],
    ['commitAndPush:{label:"Commit & Push",loadingLabel:"Committing..."}', 'commitAndPush:{label:"提交并推送",loadingLabel:"提交中..."}'],
    ['createPrWithChanges:{label:"Commit & Create PR",loadingLabel:"Creating PR..."}', 'createPrWithChanges:{label:"提交并创建 PR",loadingLabel:"创建 PR 中..."}'],
    ['push:{label:"Push",loadingLabel:"Pushing..."}', 'push:{label:"推送",loadingLabel:"推送中..."}'],
    ['createPr:{label:"Create PR",loadingLabel:"Creating PR..."}', 'createPr:{label:"创建 PR",loadingLabel:"创建 PR 中..."}'],
    // ── Diff 标签页操作 ──
    ['action:"Create Branch"', 'action:"创建分支"'],
    ['action:"Commit"', 'action:"提交"'],
    ['action:"Push"', 'action:"推送"'],
    ['children:"Commit"', 'children:"提交"'],
    ['children:"Push"', 'children:"推送"'],
    // ── 命令面板 ──
    ['title:"Go to File"', 'title:"转到文件"'],
    // ── Debug 模式描述 ──
    ['description:"Systematically diagnose and fix bugs using runtime traces"', 'description:"使用运行时跟踪系统性地诊断和修复 Bug"'],
    // ── 日期分组 ──
    ['{today:"Today",yesterday:"Yesterday",last7Days:"Last 7 days",last30Days:"Last 30 days",older:"Older"}', '{today:"今天",yesterday:"昨天",last7Days:"过去 7 天",last30Days:"过去 30 天",older:"更早"}'],
    ['key:"today",label:"Today"', 'key:"today",label:"今天"'],
    ['key:"yesterday",label:"Yesterday"', 'key:"yesterday",label:"昨天"'],
    ['key:"last_7_days",label:"Last 7 Days"', 'key:"last_7_days",label:"过去 7 天"'],
    ['key:"last_30_days",label:"Last 30 Days"', 'key:"last_30_days",label:"过去 30 天"'],
    ['key:"older",label:"Older"', 'key:"older",label:"更早"'],
    ['["Today","Yesterday","This week","Older"]', '["今天","昨天","本周","更早"]'],
    ['?"Today":', '?"今天":'],
    ['?"Yesterday":', '?"昨天":'],
    ['?"This week":"Older"', '?"本周":"更早"'],
    ['"Previous 7 days"', '"过去 7 天"'],
    // ── "Changes" 标签/返回值 ──
    ['label:"Changes"', 'label:"更改"'],
    ['return"Changes"', 'return"更改"'],
    ['?"Change":"Changes"', '?"处更改":"处更改"'],
    // ── Glass 命令面板：键绑定命令标题 ──
    ['title:"Next Palette Filter"', 'title:"下一个面板筛选器"'],
    ['title:"Previous Palette Filter"', 'title:"上一个面板筛选器"'],
    ['title:"Select Model"', 'title:"选择模型"'],
    ['label:"Select Model"', 'label:"选择模型"'],
    ['tooltipTitle:"Select Model"', 'tooltipTitle:"选择模型"'],
    ['?void 0:"Select Model"', '?void 0:"选择模型"'],
    ['title:"Select Model",icon:"sparkle', 'title:"选择模型",icon:"sparkle'],
    // ── 用户反馈缺失：Git 提交面板（图7）──
    ['?"No committed changes":`No ${e} Changes`', '?"无已提交更改":`无 ${e} 更改`'],
    ['`No committed changes against ${e}`', '`相对 ${e} 无已提交更改`'],
    ['"No branch changes"', '"无分支更改"'],
    ['"No changes in selected commits"', '"所选提交中无更改"'],
    ['"No Changes"', '"无更改"'],
    ['"1 File Changed"', '"1 个文件已更改"'],
    ['`${e.length} Files Changed`', '`${e.length} 个文件已更改`'],
    ['"Files Changed"', '"文件已更改"'],
    ['n===1?"Commit":"Commits"', 'n===1?"提交":"提交"'],
    ['n===1?"Change":"Changes"', 'n===1?"更改":"更改"'],
    // ── 用户反馈缺失：Git 空状态（图12-15）──
    ['"No uncommitted changes on your local branch"', '"本地分支上无未提交更改"'],
    ['`No uncommitted changes \xB7 ${Aa} ${Aa===1?"commit":"commits"}`', '`无未提交更改 \xB7 ${Aa} 个${Aa===1?"提交":"提交"}`'],
    ['"No uncommitted changes"', '"无未提交更改"'],
    ['"No unstaged changes"', '"无未暂存更改"'],
    ['"No staged changes"', '"无暂存更改"'],
    ['"No changed files"', '"无更改文件"'],
    ['"No changed files to show"', '"没有要显示的更改文件"'],
    ['hintText:"Add files"', 'hintText:"添加文件"'],

    // ── 用户反馈缺失：图16/18/19 ──
    ['?"Move to Trash":"Discard"', '?"移到回收站":"丢弃"'],
    ['E("glassRecycle","Move to Recycle Bin")', 'E("glassRecycle","移到回收站")'],
    ['E("glassTrash","Move to Trash")', 'E("glassTrash","移到回收站")'],
    ['E("glassDelete","Delete")', 'E("glassDelete","删除")'],
    ['QLt={image:"Image",attachments:"', 'QLt={image:"图片",attachments:"'],
    ['$=d==="image"?"Image":"File"', '$=d==="image"?"图片":"文件"'],
    ['case"image":return"Image"', 'case"image":return"图片"'],
    ['i?"Close Settings":"设置"', 'i?"关闭设置":"设置"'],
    ['"Close Settings"', '"关闭设置"'],
    ['title:"Open Instance Selector"', 'title:"打开实例选择器"'],
    // ── 编辑菜单 nls 索引转字面量（Agents 窗口 nls 不生效时 fallback 英文）──
    ['title:E(192,null)', 'title:"撤销"'],
    ['title:E(193,null)', 'title:"撤销"'],
    ['title:E(194,null)', 'title:"撤销"'],
    ['title:E(195,null)', 'title:"重做"'],
    ['title:E(196,null)', 'title:"重做"'],
    ['title:E(197,null)', 'title:"重做"'],
    ['title:E(198,null)', 'title:"全选"'],
    ['title:E(199,null)', 'title:"全选"'],
    ['title:E(945,null)', 'title:"转到匹配括号"'],
    ['title:E(953,null)', 'title:"剪切"'],
    ['title:E(954,null)', 'title:"剪切"'],
    ['title:E(955,null)', 'title:"剪切"'],
    ['title:E(956,null)', 'title:"剪切"'],
    ['title:E(957,null)', 'title:"复制"'],
    ['title:E(958,null)', 'title:"复制"'],
    ['title:E(959,null)', 'title:"复制"'],
    ['title:E(960,null)', 'title:"复制"'],
    ['title:E(961,null)', 'title:"粘贴"'],
    ['title:E(962,null)', 'title:"粘贴"'],
    ['title:E(963,null)', 'title:"粘贴"'],
    ['title:E(964,null)', 'title:"粘贴"'],
    ['message:"Use a Git repository to track changes"', 'message:"使用 Git 仓库跟踪更改"'],
    ['children:"Initialize Repository"', 'children:"初始化仓库"'],
    ['label:"Initialize Repository"', 'label:"初始化仓库"'],
    ['title:"Initialize a git repository to create worktrees."', 'title:"初始化 Git 仓库以创建工作树。"'],
    ['children:"Initialize a git repository to create worktrees."', 'children:"初始化 Git 仓库以创建工作树。"'],
    ['"Cloud agents work in secure, isolated VMs with a clone of your repo. Connect your project and git provider to get started."', '"云智能体在安全、隔离的虚拟机中运行，带有你的仓库副本。连接你的项目和 Git 提供商即可开始。"'],
    ['"Cloud agents work in secure, isolated VMs with a clone of your repo. Connect to get started."', '"云智能体在安全、隔离的虚拟机中运行，带有你的仓库副本。连接即可开始。"'],
    // ── Expand/Collapse 三元（Agents 窗口）──
    ['?"Expand":"Collapse"', '?"展开":"折叠"'],
    ['?"Collapse":"Expand"', '?"折叠":"展开"'],
    ['content:"Expand",offset:6', 'content:"展开",offset:6'],
    ['"aria-label":"Expand"', '"aria-label":"展开"'],
    ['"aria-label":"Collapse"', '"aria-label":"折叠"'],
    ['t[t.Expand=1]="Expand"', 't[t.Expand=1]="展开"'],
    ['e[e.Expand=1]="Expand"', 'e[e.Expand=1]="展开"'],
    ['title:"Checkout Agent Branch"', 'title:"检出智能体分支"'],
    ['title:"Cycle Mode"', 'title:"切换模式"'],
    ['title:"Focus Chat Input"', 'title:"聚焦聊天输入"'],
    ['title:"Mark as Fixed"', 'title:"标记为已修复"'],
    ['title:"Proceed"', 'title:"继续"'],
    ['title:"Jump to Next File"', 'title:"跳转到下一个文件"'],
    ['title:"Jump to Previous File"', 'title:"跳转到上一个文件"'],
    ['title:"Jump to Next User Message"', 'title:"跳转到下一条用户消息"'],
    ['title:"Jump to Previous User Message"', 'title:"跳转到上一条用户消息"'],
    ['title:"Open diff menu"', 'title:"打开差异菜单"'],
    ['title:"Refresh Changes"', 'title:"刷新更改"'],
    ['title:"Review Changes"', 'title:"审查更改"'],
    ['title:"Scroll Down"', 'title:"向下滚动"'],
    ['title:"Scroll Up"', 'title:"向上滚动"'],
    ['title:"Edit Queued Message"', 'title:"编辑排队消息"'],
    ['title:"Remove Queued Message"', 'title:"移除排队消息"'],
    ['title:"Send Queued Message"', 'title:"发送排队消息"'],
    ['title:"Find in Terminal"', 'title:"在终端中查找"'],
    ['title:"Focus in Terminal"', 'title:"聚焦终端"'],
    ['title:"Go to Line"', 'title:"转到行"'],
    ['title:"Next Tab"', 'title:"下一个标签页"'],
    ['title:"Previous Tab"', 'title:"上一个标签页"'],
    ['title:"Toggle Fullscreen"', 'title:"切换全屏"'],
    ['title:"Toggle Design Mode"', 'title:"切换设计模式"'],
    ['title:"Accept Mode Switch"', 'title:"接受模式切换"'],
    ['title:"Toggle Performance Bar"', 'title:"切换性能栏"'],
    ['title:"Edit Pull Request Title"', 'title:"编辑拉取请求标题"'],
    ['title:"Use Current Branch"', 'title:"使用当前分支"'],
    ['title:"Copy Agent Deeplink"', 'title:"复制智能体深链接"'],
    ['title:"Edit Nearest User Message"', 'title:"编辑最近的用户消息"'],
    ['title:"Close Browser Tab"', 'title:"关闭浏览器标签页"'],
    ['title:"Find in Browser Page"', 'title:"在浏览器页面中查找"'],
    ['title:"Find Previous in Browser Page"', 'title:"在浏览器页面中查找上一个"'],
    ['title:"Hard Reload Browser Tab"', 'title:"硬刷新浏览器标签页"'],
    ['title:"Close Find in Preview"', 'title:"关闭预览中的查找"'],
    ['title:"Toggle Selection of File"', 'title:"切换文件选中状态"'],
    // ── Canvas / Marketplace ──
    ['children:"Create new canvas"', 'children:"创建新画布"'],
    ['children:"Create New"', 'children:"新建"'],
    ['description:"Set up a team marketplace"', 'description:"设置团队市场"'],
    ['description:"Add a marketplace from a repository"', 'description:"从仓库添加市场"'],
    ['description:"Add a marketplace from your local computer"', 'description:"从本地计算机添加市场"'],
    ['children:"Import from Github"', 'children:"从 Github 导入"'],
    ['children:"Import from Disk"', 'children:"从磁盘导入"'],
    // ── 面板标签 ──
    ['title:"Plans"', 'title:"计划"'],
    ['label:"Plans"', 'label:"计划"'],
    ['children:"Actions"', 'children:"操作"'],
    ['label:"On"', 'label:"开"'],
    ['label:"Off"', 'label:"关"'],
    ['open_browser:"Open Browser"', 'open_browser:"打开浏览器"'],
    // ── 按钮/标签 ──
    ['title:"Previous",shortcut:', 'title:"上一个",shortcut:'],
    ['title:"Build"', 'title:"构建"'],
    ['title:"Open",type:"tertiary"', 'title:"打开",type:"tertiary"'],
    ['children:"Proceed"', 'children:"继续"'],
    ['label:"Proceed"', 'label:"继续"'],
    ['return"Window"', 'return"窗口"'],
    ['"Notification Progress Demo: Starting demo..."', '"通知进度演示：正在启动演示..."'],
    // ── 设置页 ──
    ['title:"Close Settings"', 'title:"关闭设置"'],
    ['title:"Open Settings"', 'title:"打开设置"'],
    ['title:"Open Composer Settings"', 'title:"打开编写器设置"'],
    ['title:"Agent Settings"', 'title:"智能体设置"'],
    ['title:"Open Documentation"', 'title:"打开文档"'],
    ['title:"Open Source Control"', 'title:"打开源代码管理"'],
    ['title:"Open Usage Based Pricing"', 'title:"打开基于用量的定价"'],
    ['title:"Open Hooks"', 'title:"打开钩子"'],
    ['title:"Open Rules"', 'title:"打开规则"'],
    ['title:"Open Rule"', 'title:"打开规则"'],
    ['title:"Open Plugins"', 'title:"打开插件"'],
    ['title:"Open MCPs"', 'title:"打开 MCP"'],
    ['title:"Open Skills"', 'title:"打开技能"'],
    ['title:"Open Automations"', 'title:"打开自动化"'],
    ['title:"Open Tasks"', 'title:"打开任务"'],
    ['title:"Open Issues"', 'title:"打开问题"'],
    ['title:"Open Build Menu"', 'title:"打开构建菜单"'],
    ['title:"Open Canvas"', 'title:"打开画布"'],
    ['title:"Open Apps Panel"', 'title:"打开应用面板"'],
    ['title:"Open Gallery"', 'title:"打开画廊"'],
    ['title:"Open Run"', 'title:"打开运行"'],
    ['title:"Open Window"', 'title:"打开窗口"'],
    ['title:"Open Agent"', 'title:"打开智能体"'],
    ['title:"Open Agent by ID"', 'title:"按 ID 打开智能体"'],
    ['title:"Open Cloud Agent View by ID"', 'title:"按 ID 打开云智能体视图"'],
    ['title:"Open Cloud Agent by ID"', 'title:"按 ID 打开云智能体"'],
    ['title:"Open PR"', 'title:"打开 PR"'],
    ['title:"Open Plan"', 'title:"打开计划"'],
    ['title:"Open File"', 'title:"打开文件"'],
    ['title:"Open File (Right Pane)"', 'title:"打开文件（右侧面板）"'],
    ['title:"Open Tab"', 'title:"打开标签页"'],
    ['title:"Open Tabs"', 'title:"打开标签页"'],
    ['title:"Open SSH Config"', 'title:"打开 SSH 配置"'],
    ['title:"Open Virtual Machine"', 'title:"打开虚拟机"'],
    ['title:"Open Existing"', 'title:"打开现有"'],
    ['title:"Open Branch Selector"', 'title:"打开分支选择器"'],
    ['title:"Open Debug Directory"', 'title:"打开调试目录"'],
    ['title:"Open Recording Folder"', 'title:"打开录制文件夹"'],
    ['title:"Open Request Logs"', 'title:"打开请求日志"'],
    ['title:"Open Datadog Logs"', 'title:"打开 Datadog 日志"'],
    ['title:"Open Section Headers Quick Pick"', 'title:"打开分区标题快速选择"'],
    ['title:"Open Prompt Quality"', 'title:"打开提示词质量"'],
    ['title:"Open Project Tasks Page"', 'title:"打开项目任务页面"'],
    ['title:"Open Background Agent Overview"', 'title:"打开后台智能体概览"'],
    ['title:"Open Diff Menu"', 'title:"打开差异菜单"'],
    ['title:"Open Changes Menu"', 'title:"打开更改菜单"'],
    ['title:"Open Least Recent Agents"', 'title:"打开最久使用的智能体"'],
    ['title:"Open Recent Agents"', 'title:"打开最近使用的智能体"'],
    ['title:"Open environment.json"', 'title:"打开 environment.json"'],
    ['title:"Open from new branch"', 'title:"从新分支打开"'],
    ['title:"Open from this branch"', 'title:"从当前分支打开"'],
    ['title:"Open in Browser"', 'title:"在浏览器中打开"'],
    ['title:"Open in Cursor Browser"', 'title:"在 Cursor 浏览器中打开"'],
    ['title:"Open in Design Mode"', 'title:"在设计模式中打开"'],
    ['title:"Open in External Browser"', 'title:"在外部浏览器中打开"'],
    ['title:"Open in IDE"', 'title:"在 IDE 中打开"'],
    ['title:"Open in Prompt Quality"', 'title:"在提示词质量中打开"'],
    ['title:"Open in Datadog"', 'title:"在 Datadog 中打开"'],
    ['title:"Open in Statsig"', 'title:"在 Statsig 中打开"'],
    ['title:"Open a different workspace"', 'title:"打开其他工作区"'],
    ['title:"Open pull request"', 'title:"打开拉取请求"'],
    ['title:"Open new window in worktree"', 'title:"在工作树中打开新窗口"'],
    ['title:"Open terminal in worktree"', 'title:"在工作树中打开终端"'],
    ['title:"Open build menu"', 'title:"打开构建菜单"'],
    ['title:"Open settings"', 'title:"打开设置"'],
    ['title:"Open Link"', 'title:"打开链接"'],
    ['title:"Open Browser Tab"', 'title:"打开浏览器标签页"'],
    ['title:"About Allowlist"', 'title:"关于白名单"'],
    ['title:"About Cursor"', 'title:"关于 Cursor"'],
    ['title:"Access Settings"', 'title:"访问设置"'],
    ['title:"Agent Layout"', 'title:"智能体布局"'],
    ['title:"Agent Window"', 'title:"智能体窗口"'],
    ['title:"Agent Stores"', 'title:"智能体商店"'],
    ['title:"Agent Instructions"', 'title:"智能体指令"'],
    ['title:"Agent Settings"', 'title:"智能体设置"'],
    ['title:"Add Doc"', 'title:"添加文档"'],
    ['title:"Add MCP"', 'title:"添加 MCP"'],
    ['title:"Add MCP Server"', 'title:"添加 MCP 服务器"'],
    ['title:"Add Models"', 'title:"添加模型"'],
    ['title:"Add Path"', 'title:"添加路径"'],
    ['title:"Add Port"', 'title:"添加端口"'],
    ['title:"Add Secrets"', 'title:"添加密钥"'],
    ['title:"Add Skills"', 'title:"添加技能"'],
    ['title:"Add Folder"', 'title:"添加文件夹"'],
    ['title:"Add Link"', 'title:"添加链接"'],
    ['title:"Add link"', 'title:"添加链接"'],
    ['title:"Add folder"', 'title:"添加文件夹"'],
    ['title:"Add Marketplace"', 'title:"添加市场"'],
    ['title:"Add to Chat"', 'title:"添加到聊天"'],
    ['title:"Add to Home"', 'title:"添加到主页"'],
    ['title:"Add to Project"', 'title:"添加到项目"'],
    ['title:"Add to Side Chat"', 'title:"添加到侧边聊天"'],
    ['title:"Add to Team"', 'title:"添加到团队"'],
    ['title:"Add for Myself"', 'title:"为自己添加"'],
    ['title:"Add an agent to get started"', 'title:"添加智能体即可开始"'],
    ['title:"Add a to-do to get started"', 'title:"添加待办事项即可开始"'],
    ['title:"Adjust Plan"', 'title:"调整套餐"'],
    ['title:"Archive All"', 'title:"全部归档"'],
    ['children:"Archive All"', 'children:"全部归档"'],
    ['label:"Archive All"', 'label:"全部归档"'],
    ['?"Confirm":"Archive All"', '?"确认":"全部归档"'],
    ['children:"Remove from Sidebar"', 'children:"从侧边栏移除"'],
    ['label:"Remove from Sidebar"', 'label:"从侧边栏移除"'],
    ['children:"Connect SSH"', 'children:"连接 SSH"'],
    ['label:"Connect SSH"', 'label:"连接 SSH"'],
    ['children:"Connect WSL"', 'children:"连接 WSL"'],
    ['label:"Connect WSL"', 'label:"连接 WSL"'],
    ['"aria-label":"More actions"', '"aria-label":"更多操作"'],
    ['hintText:"More actions"', 'hintText:"更多操作"'],
    ['children:"No Commits"', 'children:"暂无提交"'],
    ['?"Loading Commits":"No Commits"', '?"正在加载提交":"暂无提交"'],
    ['children:"Click to select, drag to draw"', 'children:"点击选择，拖动绘制"'],
    ['hint.textContent = \'Click to select, drag to draw\'', 'hint.textContent = \'点击选择，拖动绘制\''],
    ['children:["Click or hold "', 'children:["点击或按住 "'],
    ['" to dictate"', '" 听写"'],
    ['title:"Archive Prior Chats"', 'title:"归档之前的聊天"'],
    ['title:"Ask Agent"', 'title:"询问智能体"'],
    ['title:"Ask Sidechat"', 'title:"询问侧边聊天"'],
    ['title:"Ask question"', 'title:"提问"'],
    ['title:"Accept All"', 'title:"全部接受"'],
    ['title:"Accept Edits"', 'title:"接受编辑"'],
    ['title:"Accept Suggestion"', 'title:"接受建议"'],
    ['title:"Accept Cursor Tab Suggestion"', 'title:"接受 Cursor Tab 建议"'],
    ['title:"Accept Partial Edit"', 'title:"接受部分编辑"'],
    ['title:"Accept & Run"', 'title:"接受并运行"'],
    ['title:"Apply Changes"', 'title:"应用更改"'],
    ['title:"Apply Manually"', 'title:"手动应用"'],
    ['title:"Apply Intelligently"', 'title:"智能应用"'],
    ['title:"Abort Chat"', 'title:"中止聊天"'],
    ['title:"Abort Agent and Restore Query"', 'title:"中止智能体并恢复查询"'],
    ['title:"Browse Files"', 'title:"浏览文件"'],
    ['title:"Browse MCPs"', 'title:"浏览 MCP"'],
    ['title:"Browse Marketplace"', 'title:"浏览市场"'],
    ['title:"Build Locally"', 'title:"本地构建"'],
    ['title:"Build in Cloud"', 'title:"在云端构建"'],
    ['title:"Build in New Agent"', 'title:"在新智能体中构建"'],
    ['title:"Build in Parallel"', 'title:"并行构建"'],
    ['title:"Build Plan"', 'title:"构建计划"'],
    ['title:"Build Progress"', 'title:"构建进度"'],
    ['title:"Cancel"', 'title:"取消"'],
    ['title:"Close Settings"', 'title:"关闭设置"'],
    ['title:"Copy Agent Deeplink"', 'title:"复制智能体深链接"'],
    ['title:"Discard Changes"', 'title:"放弃更改"'],
    ['title:"Discard All Changes"', 'title:"放弃所有更改"'],
    ['title:"Reject All Edits"', 'title:"拒绝所有编辑"'],
    ['title:"Reject Partial Edit"', 'title:"拒绝部分编辑"'],
    ['title:"Undo Edits"', 'title:"撤销编辑"'],
    ['title:"Undo All"', 'title:"全部撤销"'],
    ['title:"Undo & Apply"', 'title:"撤销并应用"'],
    ['title:"Undo Apply"', 'title:"撤销应用"'],
    ['title:"Undo File"', 'title:"撤销文件"'],
    ['title:"Rename Chat"', 'title:"重命名聊天"'],
    ['title:"Rename Folder"', 'title:"重命名文件夹"'],
    ['title:"Rename bookmark"', 'title:"重命名书签"'],
    ['title:"Rename folder"', 'title:"重命名文件夹"'],
    ['title:"Remove folder"', 'title:"移除文件夹"'],
    ['title:"Remove from History"', 'title:"从历史记录中移除"'],
    ['title:"Remove from List"', 'title:"从列表中移除"'],
    ['title:"Remove model"', 'title:"移除模型"'],
    ['title:"Remove Favorite"', 'title:"移除收藏"'],
    ['title:"Remove local plugin"', 'title:"移除本地插件"'],
    ['title:"Refresh All"', 'title:"全部刷新"'],
    ['title:"Refresh Explorer"', 'title:"刷新资源管理器"'],
    ['title:"Refresh Selected"', 'title:"刷新选中项"'],
    ['title:"Refresh Status"', 'title:"刷新状态"'],
    ['title:"Replace All"', 'title:"全部替换"'],
    ['title:"Replace Chat"', 'title:"替换聊天"'],
    ['title:"Replace Agent"', 'title:"替换智能体"'],
    ['title:"Reset All"', 'title:"全部重置"'],
    ['title:"Reset Chat Mode to Default"', 'title:"重置聊天模式为默认"'],
    ['title:"Reset Position"', 'title:"重置位置"'],
    ['title:"Reset cache"', 'title:"重置缓存"'],
    ['title:"Reset zoom"', 'title:"重置缩放"'],
    ['title:"Reset zoom to 100%"', 'title:"重置缩放至 100%"'],
    ['title:"Restore defaults"', 'title:"恢复默认值"'],
    ['title:"Run Now"', 'title:"立即运行"'],
    ['title:"Run Task"', 'title:"运行任务"'],
    ['title:"Run in Background"', 'title:"在后台运行"'],
    ['title:"Run Autonomously"', 'title:"自主运行"'],
    ['title:"Reopen Last Closed Tab"', 'title:"重新打开上次关闭的标签页"'],
    ['title:"Reopen PR"', 'title:"重新打开 PR"'],
    ['title:"Reopen conversation"', 'title:"重新打开对话"'],
    ['title:"Review Again"', 'title:"再次审查"'],
    ['title:"Review Code with Bugbot"', 'title:"用 Bugbot 审查代码"'],
    ['title:"Review Next File"', 'title:"审查下一个文件"'],
    ['title:"Review Plan"', 'title:"审查计划"'],
    ['title:"Review changes"', 'title:"审查更改"'],
    ['title:"Review next file"', 'title:"审查下一个文件"'],
    ['title:"Save Automation"', 'title:"保存自动化"'],
    ['title:"Save Environment"', 'title:"保存环境"'],
    ['title:"Save Environment as"', 'title:"保存环境为"'],
    ['title:"Save Image As..."', 'title:"另存图片为..."'],
    ['title:"Search Agents"', 'title:"搜索智能体"'],
    ['title:"Search Cursor Settings"', 'title:"搜索 Cursor 设置"'],
    ['title:"Search Extensions"', 'title:"搜索扩展"'],
    ['title:"Select Backend"', 'title:"选择后端"'],
    ['title:"Select Environment"', 'title:"选择环境"'],
    ['title:"Select Workspace"', 'title:"选择工作区"'],
    ['title:"Select Multiple"', 'title:"多选"'],
    ['title:"Send to Chat"', 'title:"发送到聊天"'],
    ['title:"Send to Cloud"', 'title:"发送到云端"'],
    ['title:"Send Test Notification"', 'title:"发送测试通知"'],
    ['title:"Send Queued Message Now"', 'title:"立即发送排队消息"'],
    ['title:"Send invite"', 'title:"发送邀请"'],
    ['title:"Share Transcript"', 'title:"分享记录"'],
    ['title:"Sign In"', 'title:"登录"'],
    ['title:"Sign Up"', 'title:"注册"'],
    ['title:"Skip For Now"', 'title:"暂时跳过"'],
    ['title:"Start New Chat"', 'title:"开始新聊天"'],
    ['title:"Start New Chat?"', 'title:"开始新聊天？"'],
    ['title:"Start New Thread With Summary"', 'title:"以摘要开始新线程"'],
    ['title:"Start onboarding"', 'title:"开始引导"'],
    ['title:"Stash Changes"', 'title:"暂存更改"'],
    ['title:"Suggest Changes"', 'title:"建议更改"'],
    ['title:"Switch mode"', 'title:"切换模式"'],
    ['title:"Switch to Auto"', 'title:"切换到自动"'],
    ['title:"Take Control"', 'title:"接管控制"'],
    ['title:"Take control"', 'title:"接管控制"'],
    ['title:"Try Again"', 'title:"重试"'],
    ['title:"Try again"', 'title:"重试"'],
    ['title:"Try Cloud Agent"', 'title:"试试云智能体"'],
    ['title:"Trust & Continue"', 'title:"信任并继续"'],
    ['title:"Undo All"', 'title:"全部撤销"'],
    ['title:"Unfold All"', 'title:"全部展开"'],
    ['title:"Unlink PR"', 'title:"取消关联 PR"'],
    ['title:"Unpublish Skill"', 'title:"取消发布技能"'],
    ['title:"Publish Skill"', 'title:"发布技能"'],
    ['title:"Update Cursor"', 'title:"更新 Cursor"'],
    ['title:"Upgrade to Pro"', 'title:"升级到 Pro"'],
    ['title:"Upgrade to Pro+"', 'title:"升级到 Pro+"'],
    ['title:"Upgrade to Ultra"', 'title:"升级到 Ultra"'],
    ['title:"Upgrade to use Cloud Agents"', 'title:"升级以使用云智能体"'],
    ['title:"View Agent"', 'title:"查看智能体"'],
    ['title:"View All Changes"', 'title:"查看所有更改"'],
    ['title:"View Automation"', 'title:"查看自动化"'],
    ['title:"View Changes"', 'title:"查看更改"'],
    ['title:"View Current Branch"', 'title:"查看当前分支"'],
    ['title:"View PR"', 'title:"查看 PR"'],
    ['title:"View Source"', 'title:"查看源代码"'],
    ['title:"View changelog"', 'title:"查看更新日志"'],
    ['title:"View on Web"', 'title:"在网页中查看"'],
    ['title:"View docs"', 'title:"查看文档"'],
    ['title:"View setup instructions"', 'title:"查看设置说明"'],
    ['title:"View referral history"', 'title:"查看推荐历史"'],
    ['title:"View Uncommitted Changes"', 'title:"查看未提交的更改"'],
    ['title:"Show History"', 'title:"显示历史记录"'],
    ['title:"Show Less"', 'title:"显示更少"'],
    ['title:"Show More"', 'title:"显示更多"'],
    ['title:"Show Minimap"', 'title:"显示缩略图"'],
    ['title:"Show Chat"', 'title:"显示聊天"'],
    ['title:"Show Changes"', 'title:"显示更改"'],
    ['title:"Show conversation"', 'title:"显示对话"'],
    ['title:"Show files"', 'title:"显示文件"'],
    ['title:"Show Output"', 'title:"显示输出"'],
    ['title:"Show Options"', 'title:"显示选项"'],
    ['title:"Show Status Bar"', 'title:"显示状态栏"'],
    ['title:"Shut down"', 'title:"关闭"'],
    ['title:"Pause Indexing"', 'title:"暂停索引"'],
    ['title:"Pause goal"', 'title:"暂停目标"'],
    ['title:"Resume goal"', 'title:"恢复目标"'],
    ['title:"Replace all"', 'title:"全部替换"'],
    ['title:"Preserve Case"', 'title:"保留大小写"'],
    ['title:"Use Regular Expression"', 'title:"使用正则表达式"'],
    ['title:"Use Cursor Browser"', 'title:"使用 Cursor 浏览器"'],
    ['title:"Use External Browser"', 'title:"使用外部浏览器"'],
    ['title:"Use Existing..."', 'title:"使用现有..."'],
    ['title:"Use in IDE"', 'title:"在 IDE 中使用"'],
    ['title:"Use in Agents Window"', 'title:"在智能体窗口中使用"'],
    ['title:"Use DMs"', 'title:"使用私信"'],
    ['title:"Use commit hash"', 'title:"使用提交哈希"'],
    ['title:"Pin / Unpin Agent"', 'title:"固定/取消固定智能体"'],
    ['title:"Pin to workspace"', 'title:"固定到工作区"'],
    ['title:"Recent commits"', 'title:"最近提交"'],
    ['title:"Recent commits - Select Commits"', 'title:"最近提交 - 选择提交"'],
    ['title:"Recent commits - Select Repositories"', 'title:"最近提交 - 选择仓库"'],
    ['title:"Recently changed"', 'title:"最近更改"'],
    ['title:"Your Tasks"', 'title:"你的任务"'],
    ['title:"Your branches"', 'title:"你的分支"'],
    ['title:"Other Agents"', 'title:"其他智能体"'],
    ['title:"Other Marketplaces"', 'title:"其他市场"'],
    ['title:"Available Marketplaces"', 'title:"可用市场"'],
    ['title:"All Plugins"', 'title:"所有插件"'],
    ['title:"All Members"', 'title:"所有成员"'],
    ['title:"All Tasks"', 'title:"所有任务"'],
    ['title:"All repositories"', 'title:"所有仓库"'],
    ['title:"All repos"', 'title:"所有仓库"'],
    ['title:"Team agents"', 'title:"团队智能体"'],
    ['title:"Team Default"', 'title:"团队默认"'],
    ['title:"Personal Usage"', 'title:"个人用量"'],
    ['title:"Usage Remaining"', 'title:"剩余用量"'],
    ['title:"Quick Question"', 'title:"快速提问"'],
    ['title:"Side Chat"', 'title:"侧边聊天"'],
    ['title:"Side chats"', 'title:"侧边聊天"'],
    ['title:"Past Chat"', 'title:"历史聊天"'],
    ['title:"Same chat"', 'title:"同一聊天"'],
    ['title:"Previous Agent"', 'title:"上一个智能体"'],
    ['title:"Previous Chat (Direct)"', 'title:"上一个聊天（直接）"'],
    ['title:"Previous Search Result"', 'title:"上一个搜索结果"'],
    ['title:"Self-Driving Mode"', 'title:"自动驾驶模式"'],
    ['title:"Self-Driving PRs"', 'title:"自动驾驶 PR"'],
    ['title:"Self-driving Settings"', 'title:"自动驾驶设置"'],
    ['title:"Remote Control"', 'title:"远程控制"'],
    ['title:"Remote Host"', 'title:"远程主机"'],
    ['title:"Background agent"', 'title:"后台智能体"'],
    ['title:"Browser Menu"', 'title:"浏览器菜单"'],
    ['title:"Browser Tab"', 'title:"浏览器标签页"'],
    ['title:"Browser Tools"', 'title:"浏览器工具"'],
    ['title:"Source Action..."', 'title:"源代码操作..."'],
    ['title:"Ordered list"', 'title:"有序列表"'],
    ['title:"Bullet list"', 'title:"无序列表"'],
    ['title:"Server Status"', 'title:"服务器状态"'],
    ['title:"Operation Complete"', 'title:"操作完成"'],
    ['title:"Pending approval"', 'title:"待批准"'],
    ['title:"Request received"', 'title:"请求已接收"'],
    ['title:"Something went wrong"', 'title:"出错了"'],
    ['title:"Something went wrong."', 'title:"出错了。"'],
    ['title:"Something is off"', 'title:"有问题"'],
    ['title:"Page isn\'t working"', 'title:"页面无法正常工作"'],
    ['title:"Can\'t connect to server"', 'title:"无法连接到服务器"'],
    ['title:"Outdated Client"', 'title:"客户端版本过旧"'],
    ['title:"Review required"', 'title:"需要审查"'],
    ['title:"Action Needed"', 'title:"需要操作"'],
    ['title:"Sign-in restricted"', 'title:"登录受限"'],
    ['title:"Payment Method Update Required"', 'title:"需要更新付款方式"'],
    ['title:"Payment failed"', 'title:"付款失败"'],
    ['title:"Plan ending soon"', 'title:"套餐即将到期"'],
    ['title:"You\'ve hit your hard limit"', 'title:"你已达到硬性限制"'],
    ['title:"You\'ve hit your rate limit on your current plan"', 'title:"你已达到当前套餐的速率限制"'],
    ['title:"Update Required"', 'title:"需要更新"'],
    ['title:"Restart to Update"', 'title:"重启以更新"'],
    ['title:"Refer friends, earn usage credits"', 'title:"推荐好友，赚取用量额度"'],
    ['title:"Referral link"', 'title:"推荐链接"'],
    ['title:"Public Profile"', 'title:"公开资料"'],
    ['title:"Profile Image"', 'title:"头像"'],
    ['title:"Share an invite link or send invites by email."', 'title:"分享邀请链接或通过电子邮件发送邀请。"'],
    ['title:"Teach Cursor New Skills"', 'title:"教 Cursor 新技能"'],
    ['title:"What should we build?"', 'title:"我们要构建什么？"'],
    ['title:"Ship better code, faster"', 'title:"更快地交付更好的代码"'],
    ['title:"The best way to code with AI"', 'title:"使用 AI 编程的最佳方式"'],
    ['title:"Verified by Cursor"', 'title:"Cursor 已验证"'],
    ['title:"Plugins, MCPs, Skills, and Rules have moved to Customize"', 'title:"插件、MCP、技能和规则已移至自定义"'],
    ['title:"We\'ve introduced a new home for all the ways to customize Cursor."', 'title:"我们为所有自定义 Cursor 的方式推出了新主页。"'],
    ['title:"Screen recording"', 'title:"屏幕录制"'],
    ['title:"Prepare workspace"', 'title:"准备工作区"'],
    ['title:"Preparing workspace"', 'title:"正在准备工作区"'],
    ['title:"Preparing save form..."', 'title:"正在准备保存表单..."'],
    ['title:"Preparing secrets form..."', 'title:"正在准备密钥表单..."'],
    ['title:"Stashing changes..."', 'title:"正在暂存更改..."'],
    ['title:"Applying changes locally…"', 'title:"正在本地应用更改…"'],
    ['title:"Starting processes..."', 'title:"正在启动进程..."'],
    ['title:"Stopping processes..."', 'title:"正在停止进程..."'],
    ['title:"Processes stopped"', 'title:"进程已停止"'],
    ['title:"Uploading snapshot to Cursor..."', 'title:"正在上传快照到 Cursor..."'],
    ['title:"Taking a little while..."', 'title:"需要一点时间..."'],
    ['title:"Still running locally?"', 'title:"仍在本地运行？"'],
    ['title:"Working on a Long Task?"', 'title:"正在处理长任务？"'],
    ['title:"Would you like to remember this preference for future sessions?"', 'title:"是否在以后的会话中记住此偏好？"'],
    ['title:"This action cannot be undone. Proceed anyway?"', 'title:"此操作无法撤销。确定继续？"'],
    ['title:"Are you sure you want to close this window?"', 'title:"确定要关闭此窗口吗？"'],
    ['title:"Are you sure you want to perform this action?"', 'title:"确定要执行此操作吗？"'],
    ['title:"Your changes will be lost if you don\'t save them."', 'title:"如果不保存，你的更改将丢失。"'],
    ['title:"This will permanently delete all your data. This action cannot be undone."', 'title:"这将永久删除你的所有数据。此操作无法撤销。"'],
    ['title:"Proceed anyway (changes might not apply correctly)"', 'title:"仍然继续（更改可能无法正确应用）"'],
    ['title:"This workspace"', 'title:"此工作区"'],
    ['title:"Add a Custom MCP Server"', 'title:"添加自定义 MCP 服务器"'],
    ['title:"Add a plugin to this agent"', 'title:"向此智能体添加插件"'],
    ['title:"Remove a plugin from this agent"', 'title:"从此智能体移除插件"'],
    ['title:"Add plugins to this marketplace so your team can install them."', 'title:"向此市场添加插件，以便你的团队可以安装。"'],
    ['title:"Add plugins or import from GitHub to make them available for your team."', 'title:"添加插件或从 GitHub 导入，以供团队使用。"'],
    ['title:"Browse the marketplace or import custom plugins to extend"', 'title:"浏览市场或导入自定义插件以扩展功能"'],
    ['title:"Slack Channel"', 'title:"Slack 频道"'],
    ['title:"Slack Token"', 'title:"Slack 令牌"'],
    ['title:"API Key"', 'title:"API 密钥"'],
    ['title:"Base URL"', 'title:"基础 URL"'],
    ['title:"OAuth 2.0 Client ID"', 'title:"OAuth 2.0 客户端 ID"'],
    ['title:"OAuth 2.0 Client Secret (optional)"', 'title:"OAuth 2.0 客户端密钥（可选）"'],
    ['title:"Access Key ID"', 'title:"访问密钥 ID"'],
    ['title:"AWS Bedrock"', 'title:"AWS Bedrock"'],
    ['title:"Azure OpenAI"', 'title:"Azure OpenAI"'],
    ['title:"Azure DevOps"', 'title:"Azure DevOps"'],
    ['title:"Anthropic API Key"', 'title:"Anthropic API 密钥"'],
    ['title:"Backend API"', 'title:"后端 API"'],
    ['title:"Backend Server"', 'title:"后端服务器"'],
    ['title:"Production Server"', 'title:"生产服务器"'],
    ['title:"CLI Credentials"', 'title:"CLI 凭证"'],
    ['title:"Active Connections"', 'title:"活动连接"'],
    ['title:"Scheduled Tasks"', 'title:"计划任务"'],
    ['title:"Save changes not supported yet"', 'title:"尚不支持保存更改"'],
    ['title:"This chat could not be loaded."', 'title:"无法加载此聊天。"'],
    ['title:"This pull request cannot be merged"', 'title:"此拉取请求无法合并"'],
    ['title:"This pull request tab does not have a branch name yet."', 'title:"此拉取请求标签页还没有分支名称。"'],
    ['title:"This task is missing its pull request URL."', 'title:"此任务缺少拉取请求 URL。"'],
    ['title:"This automation is private"', 'title:"此自动化是私有的"'],
    ['title:"This automation can only be viewed by the creator and team admins."', 'title:"此自动化只能由创建者和团队管理员查看。"'],
    ['title:"You don\'t have access to this automation\'s run history."', 'title:"你无权访问此自动化的运行历史。"'],
    ['title:"You\'ll be logged out of your Cursor account on this device."', 'title:"你将在此设备上登出 Cursor 账户。"'],
    ['title:"Unable to load automations."', 'title:"无法加载自动化。"'],
    ['title:"Unable to load organizations"', 'title:"无法加载组织"'],
    ['title:"Unable to load Microsoft Teams channels"', 'title:"无法加载 Microsoft Teams 频道"'],
    ['title:"Unable to load this step."', 'title:"无法加载此步骤。"'],
    ['title:"We couldn\'t generate your referral link. Try again."', 'title:"无法生成你的推荐链接。请重试。"'],
    ['title:"An error occurred while processing your request."', 'title:"处理请求时发生错误。"'],
    ['title:"An unexpected error occurred. Reload the window to try again."', 'title:"发生意外错误。重新加载窗口以重试。"'],
    ['title:"The certificate for this site is not trusted"', 'title:"此站点的证书不受信任"'],
    ['title:"Please update your payment method to keep using Cursor."', 'title:"请更新你的付款方式以继续使用 Cursor。"'],
    ['title:"Re-authorize your UPI payment method to restore automatic payments"', 'title:"重新授权你的 UPI 付款方式以恢复自动付款"'],
    ['title:"Rate limited by GitHub"', 'title:"被 GitHub 限流"'],
    ['title:"Reset this pane to a new agent"', 'title:"将此面板重置为新智能体"'],
    ['title:"Switch where this agent runs"', 'title:"切换此智能体的运行位置"'],
    ['title:"Open subagent preview in agents tray"', 'title:"在智能体托盘中打开子智能体预览"'],
    ['title:"Try Open Subagent Preview by ID"', 'title:"按 ID 尝试打开子智能体预览"'],
    ['title:"Open Browser Tab"', 'title:"打开浏览器标签页"'],
    ['title:"Activate Browser Tab"', 'title:"激活浏览器标签页"'],
    ['title:"Resize sidebar"', 'title:"调整侧边栏大小"'],
    ['title:"Resize sections"', 'title:"调整分区大小"'],
    ['title:"Resize section"', 'title:"调整分区大小"'],
    ['title:"Resize terminal tree"', 'title:"调整终端树大小"'],
    ['title:"Resize changes sidebar"', 'title:"调整更改侧边栏大小"'],
    ['title:"Resize canvas list"', 'title:"调整画布列表大小"'],
    ['title:"Resize browser sidebar"', 'title:"调整浏览器侧边栏大小"'],
    ['title:"Resize diff meter"', 'title:"调整差异度量器大小"'],
    ['title:"Resize pull request file trees"', 'title:"调整拉取请求文件树大小"'],
    ['title:"Resize All Heights"', 'title:"调整所有高度"'],
    ['title:"Try resizing this"', 'title:"试试调整大小"'],
    ['title:"Actions Palette"', 'title:"操作面板"'],
    ['title:"Bugbot"', 'title:"Bugbot"'],
    ['title:"Frontend QA"', 'title:"前端 QA"'],
    ['title:"Automate with Hooks"', 'title:"用钩子自动化"'],
    ['title:"Automation name"', 'title:"自动化名称"'],
    ['title:"Run command"', 'title:"运行命令"'],
    ['title:"Run in"', 'title:"运行于"'],
    ['title:"Score Commit for AI Content"', 'title:"为 AI 内容评分提交"'],
    ['title:"Scan and Triage Security Vulnerabilities"', 'title:"扫描和分类安全漏洞"'],
    ['title:"PR Routing & Approval"', 'title:"PR 路由与批准"'],
    ['title:"Squash & Merge"', 'title:"压缩并合并"'],
    ['title:"Squash merge"', 'title:"压缩合并"'],
    ['title:"Rebase Merge"', 'title:"变基合并"'],
    ['title:"Rebase merge"', 'title:"变基合并"'],
    ['title:"Push branch to remote"', 'title:"推送分支到远程"'],
    ['title:"Push local branch to remote"', 'title:"推送本地分支到远程"'],
    ['title:"Push unpushed commits"', 'title:"推送未推送的提交"'],
    ['title:"Branch Changes"', 'title:"分支更改"'],
    ['title:"Branch Pull Requests"', 'title:"分支拉取请求"'],
    ['title:"Branch Prefix"', 'title:"分支前缀"'],
    ['title:"Branch Name Unavailable"', 'title:"分支名称不可用"'],
    ['title:"View Current Branch"', 'title:"查看当前分支"'],
    ['title:"Use Current Branch"', 'title:"使用当前分支"'],
    ['title:"Checkout Agent Branch"', 'title:"检出智能体分支"'],
    ['title:"Open from new branch"', 'title:"从新分支打开"'],
    ['title:"Open from this branch"', 'title:"从当前分支打开"'],
    ['title:"Permanently discard your current changes before switching branches"', 'title:"切换分支前永久放弃当前更改"'],
    ['title:"Recommended to ensure correct base for changes"', 'title:"建议执行以确保更改的正确基础"'],
    ['title:"Save changes to a stash and restore them later"', 'title:"将更改保存到储藏并稍后恢复"'],
    ['title:"Save your changes and restore them later"', 'title:"保存更改并稍后恢复"'],
    ['title:"Stash and save your changes so you can restore them later"', 'title:"暂存并保存更改以便稍后恢复"'],
    ['title:"Stash + Overwrite"', 'title:"暂存并覆盖"'],
    ['title:"Binary file not shown"', 'title:"二进制文件未显示"'],
    ['title:"Only whitespace changes"', 'title:"仅有空白字符更改"'],
    ['title:"Search web"', 'title:"搜索网页"'],
    ['title:"Search with Google"', 'title:"用 Google 搜索"'],
    ['title:"Search again in all files"', 'title:"在所有文件中再次搜索"'],
    ['title:"Type to search actions"', 'title:"输入以搜索操作"'],
    ['title:"Report Bug"', 'title:"报告 Bug"'],
    ['title:"Report Good"', 'title:"报告良好"'],
    ['title:"Report Bad"', 'title:"报告问题"'],
    ['title:"Report Lag"', 'title:"报告卡顿"'],
    ['title:"Report with Comment"', 'title:"带评论报告"'],
    ['title:"Thumbs Up"', 'title:"点赞"'],
    ['title:"Thumbs Down"', 'title:"踩"'],
    ['title:"See Details"', 'title:"查看详情"'],
    ['title:"Show Apps Panel"', 'title:"显示应用面板"'],
    ['title:"Show Apps Sidebar"', 'title:"显示应用侧边栏"'],
    ['title:"Show Running Extensions"', 'title:"显示运行中的扩展"'],
    ['title:"Show Remote SSH Output"', 'title:"显示远程 SSH 输出"'],
    ['title:"Show Output Channel"', 'title:"显示输出通道"'],
    ['title:"Show Output Channel in Tab"', 'title:"在标签页中显示输出通道"'],
    ['title:"Show Status Bar"', 'title:"显示状态栏"'],
    ['title:"Show Notification Progress Demo"', 'title:"显示通知进度演示"'],
    ['title:"Reveal in File Explorer"', 'title:"在文件资源管理器中显示"'],
    ['title:"Open Developer Tools for Extension Host"', 'title:"打开扩展宿主的开发者工具"'],
    ['title:"Start Electron Trace"', 'title:"开始 Electron 跟踪"'],
    ['title:"Start Extension Host CPU Profiler"', 'title:"启动扩展宿主 CPU 分析器"'],
    ['title:"Start Extension Host Heap Allocation Profiler"', 'title:"启动扩展宿主堆分配分析器"'],
    ['title:"Start Remote Server CPU Profiler"', 'title:"启动远程服务器 CPU 分析器"'],
    ['title:"Start File Watch Recording"', 'title:"开始文件监视记录"'],
    ['title:"Start Request"', 'title:"开始请求"'],
    ['title:"Stop Bisect"', 'title:"停止二分查找"'],
    ['title:"Stop Control"', 'title:"停止控制"'],
    ['title:"Toggle Full Screen"', 'title:"切换全屏"'],
    ['title:"Toggle Search in Files"', 'title:"切换在文件中搜索"'],
    ['title:"Toggle File Tree"', 'title:"切换文件树"'],
    ['title:"Toggle Local / GitHub"', 'title:"切换本地 / GitHub"'],
    ['title:"Toggle Expansion of File"', 'title:"切换文件展开状态"'],
    ['title:"Reinstall Remote SSH Server and Reload Window"', 'title:"重新安装远程 SSH 服务器并重载窗口"'],
    ['title:"Open SSH Configuration File"', 'title:"打开 SSH 配置文件"'],
    ['title:"Set Up Workspace"', 'title:"设置工作区"'],
    ['title:"Set Value"', 'title:"设置值"'],
    ['title:"Set Log Level..."', 'title:"设置日志级别..."'],
    ['title:"Select a canvas from the sidebar"', 'title:"从侧边栏选择画布"'],
    ['title:"Select a local marketplace folder"', 'title:"选择本地市场文件夹"'],
    ['title:"Select a local plugin repo"', 'title:"选择本地插件仓库"'],
    ['title:"Select a Linux distro to connect."', 'title:"选择要连接的 Linux 发行版。"'],
    ['title:"Select an option"', 'title:"选择一个选项"'],
    ['title:"Select to End"', 'title:"选择到末尾"'],
    ['title:"Select All in Diff"', 'title:"在差异中全选"'],
    ['title:"Select All in File"', 'title:"在文件中全选"'],
    ['title:"Select Custom Chime Sound"', 'title:"选择自定义提示音"'],
    ['title:"Choose a mode"', 'title:"选择模式"'],
    ['title:"Choose a model"', 'title:"选择模型"'],
    ['title:"Choose a repo"', 'title:"选择仓库"'],
    ['title:"Choose a workspace"', 'title:"选择工作区"'],
    ['title:"Choose an environment"', 'title:"选择环境"'],
    // ── label 类型 ──
    ['label:"Close Settings"', 'label:"关闭设置"'],
    ['label:"Open Settings"', 'label:"打开设置"'],
    ['label:"Agent Mode"', 'label:"智能体模式"'],
    ['label:"Review Mode"', 'label:"审查模式"'],
    ['label:"Background Mode"', 'label:"后台模式"'],
    ['label:"Self-Driving Mode"', 'label:"自动驾驶模式"'],
    ['label:"Actions Palette"', 'label:"操作面板"'],
    ['label:"Save Automation"', 'label:"保存自动化"'],
    ['label:"Run Now"', 'label:"立即运行"'],
    ['label:"Run Task"', 'label:"运行任务"'],
    ['label:"Run in Background"', 'label:"在后台运行"'],
    ['label:"Run Autonomously"', 'label:"自主运行"'],
    ['label:"Personal Usage"', 'label:"个人用量"'],
    ['label:"Usage Remaining"', 'label:"剩余用量"'],
    ['label:"Quick Question"', 'label:"快速提问"'],
    ['label:"Side Chat"', 'label:"侧边聊天"'],
    ['label:"Background agent"', 'label:"后台智能体"'],
    ['label:"Other Agents"', 'label:"其他智能体"'],
    ['label:"All Tasks"', 'label:"所有任务"'],
    ['label:"Your Tasks"', 'label:"你的任务"'],
    ['label:"Team agents"', 'label:"团队智能体"'],
    ['label:"Available Marketplaces"', 'label:"可用市场"'],
    ['label:"Other Marketplaces"', 'label:"其他市场"'],
    ['label:"All Plugins"', 'label:"所有插件"'],
    ['label:"All Members"', 'label:"所有成员"'],
    ['label:"Recent commits"', 'label:"最近提交"'],
    ['label:"Recently changed"', 'label:"最近更改"'],
    ['label:"Your branches"', 'label:"你的分支"'],
    ['label:"Team Default"', 'label:"团队默认"'],
    ['label:"Remote Control"', 'label:"远程控制"'],
    ['label:"Remote Host"', 'label:"远程主机"'],
    ['label:"Browser Tab"', 'label:"浏览器标签页"'],
    ['label:"Browser Tools"', 'label:"浏览器工具"'],
    ['label:"Browser Menu"', 'label:"浏览器菜单"'],
    ['label:"Pending approval"', 'label:"待批准"'],
    ['label:"Action Needed"', 'label:"需要操作"'],
    ['label:"Review required"', 'label:"需要审查"'],
    ['label:"Sign In"', 'label:"登录"'],
    ['label:"Sign Up"', 'label:"注册"'],
    ['label:"Sign-in restricted"', 'label:"登录受限"'],
    ['label:"Skip For Now"', 'label:"暂时跳过"'],
    ['label:"Trust & Continue"', 'label:"信任并继续"'],
    ['label:"Try Again"', 'label:"重试"'],
    ['label:"Try Cloud Agent"', 'label:"试试云智能体"'],
    ['label:"Upgrade to Pro"', 'label:"升级到 Pro"'],
    ['label:"Upgrade to Pro+"', 'label:"升级到 Pro+"'],
    ['label:"Upgrade to Ultra"', 'label:"升级到 Ultra"'],
    ['label:"Refer friends, earn usage credits"', 'label:"推荐好友，赚取用量额度"'],
    ['label:"Referral link"', 'label:"推荐链接"'],
    ['label:"Public Profile"', 'label:"公开资料"'],
    ['label:"Profile Image"', 'label:"头像"'],
    ['label:"API Key"', 'label:"API 密钥"'],
    ['label:"Base URL"', 'label:"基础 URL"'],
    ['label:"Slack Channel"', 'label:"Slack 频道"'],
    ['label:"Slack Token"', 'label:"Slack 令牌"'],
    ['label:"AWS Bedrock"', 'label:"AWS Bedrock"'],
    ['label:"Azure OpenAI"', 'label:"Azure OpenAI"'],
    ['label:"Azure DevOps"', 'label:"Azure DevOps"'],
    ['label:"Anthropic API Key"', 'label:"Anthropic API 密钥"'],
    ['label:"Access Key ID"', 'label:"访问密钥 ID"'],
    ['label:"OAuth 2.0 Client ID"', 'label:"OAuth 2.0 客户端 ID"'],
    ['label:"Active Connections"', 'label:"活动连接"'],
    ['label:"Scheduled Tasks"', 'label:"计划任务"'],
    ['label:"Server Status"', 'label:"服务器状态"'],
    ['label:"Operation Complete"', 'label:"操作完成"'],
    ['label:"Something went wrong"', 'label:"出错了"'],
    ['label:"Can\'t connect to server"', 'label:"无法连接到服务器"'],
    ['label:"Outdated Client"', 'label:"客户端版本过旧"'],
    ['label:"Payment failed"', 'label:"付款失败"'],
    ['label:"Plan ending soon"', 'label:"套餐即将到期"'],
    ['label:"Update Required"', 'label:"需要更新"'],
    ['label:"Restart to Update"', 'label:"重启以更新"'],
    ['label:"Pause Indexing"', 'label:"暂停索引"'],
    ['label:"Screen recording"', 'label:"屏幕录制"'],
    ['label:"Binary file not shown"', 'label:"二进制文件未显示"'],
    ['label:"Only whitespace changes"', 'label:"仅有空白字符更改"'],
    ['label:"Stash Changes"', 'label:"暂存更改"'],
    ['label:"Squash & Merge"', 'label:"压缩并合并"'],
    ['label:"Rebase Merge"', 'label:"变基合并"'],
    ['label:"Replace all"', 'label:"全部替换"'],
    ['label:"Preserve Case"', 'label:"保留大小写"'],
    ['label:"Use Regular Expression"', 'label:"使用正则表达式"'],
    ['label:"Ordered list"', 'label:"有序列表"'],
    ['label:"Bullet list"', 'label:"无序列表"'],
    ['label:"Select Multiple"', 'label:"多选"'],
    ['label:"Select Workspace"', 'label:"选择工作区"'],
    ['label:"Select Environment"', 'label:"选择环境"'],
    ['label:"Select Backend"', 'label:"选择后端"'],
    ['label:"Send to Chat"', 'label:"发送到聊天"'],
    ['label:"Send to Cloud"', 'label:"发送到云端"'],
    ['label:"Send invite"', 'label:"发送邀请"'],
    ['label:"Share Transcript"', 'label:"分享记录"'],
    ['label:"Pin / Unpin Agent"', 'label:"固定/取消固定智能体"'],
    ['label:"Pin to workspace"', 'label:"固定到工作区"'],
    ['label:"Previous Agent"', 'label:"上一个智能体"'],
    ['label:"Add Doc"', 'label:"添加文档"'],
    ['label:"Add MCP"', 'label:"添加 MCP"'],
    ['label:"Add Models"', 'label:"添加模型"'],
    ['label:"Add Skills"', 'label:"添加技能"'],
    ['label:"Add Folder"', 'label:"添加文件夹"'],
    ['label:"Add Link"', 'label:"添加链接"'],
    ['label:"Add Marketplace"', 'label:"添加市场"'],
    ['label:"Add to Chat"', 'label:"添加到聊天"'],
    ['label:"Add to Team"', 'label:"添加到团队"'],
    ['label:"Add for Myself"', 'label:"为自己添加"'],
    ['label:"Open Documentation"', 'label:"打开文档"'],
    ['label:"Open Settings"', 'label:"打开设置"'],
    ['label:"Open Source Control"', 'label:"打开源代码管理"'],
    ['label:"Open Plugins"', 'label:"打开插件"'],
    ['label:"Open MCPs"', 'label:"打开 MCP"'],
    ['label:"Open Skills"', 'label:"打开技能"'],
    ['label:"Open Hooks"', 'label:"打开钩子"'],
    ['label:"Open Rules"', 'label:"打开规则"'],
    ['label:"Open Automations"', 'label:"打开自动化"'],
    ['label:"Open Build Menu"', 'label:"打开构建菜单"'],
    ['label:"Open Canvas"', 'label:"打开画布"'],
    ['label:"Open Gallery"', 'label:"打开画廊"'],
    ['label:"About Cursor"', 'label:"关于 Cursor"'],
    ['label:"Access Settings"', 'label:"访问设置"'],
    ['label:"Agent Settings"', 'label:"智能体设置"'],
    ['label:"Agent Layout"', 'label:"智能体布局"'],
    ['label:"Agent Window"', 'label:"智能体窗口"'],
    ['label:"Agent Instructions"', 'label:"智能体指令"'],
    ['label:"Agent Stores"', 'label:"智能体商店"'],
    ['label:"Discard Changes"', 'label:"放弃更改"'],
    ['label:"Discard All Changes"', 'label:"放弃所有更改"'],
    ['label:"Reject All Edits"', 'label:"拒绝所有编辑"'],
    ['label:"Accept All"', 'label:"全部接受"'],
    ['label:"Accept Edits"', 'label:"接受编辑"'],
    ['label:"Undo Edits"', 'label:"撤销编辑"'],
    ['label:"Undo All"', 'label:"全部撤销"'],
    ['label:"Apply Changes"', 'label:"应用更改"'],
    ['label:"Apply Manually"', 'label:"手动应用"'],
    ['label:"Apply Intelligently"', 'label:"智能应用"'],
    ['label:"Rename Chat"', 'label:"重命名聊天"'],
    ['label:"Rename Folder"', 'label:"重命名文件夹"'],
    ['label:"Remove folder"', 'label:"移除文件夹"'],
    ['label:"Remove model"', 'label:"移除模型"'],
    ['label:"Remove from List"', 'label:"从列表中移除"'],
    ['label:"Refresh All"', 'label:"全部刷新"'],
    ['label:"Refresh Explorer"', 'label:"刷新资源管理器"'],
    ['label:"Reset All"', 'label:"全部重置"'],
    ['label:"Reset Position"', 'label:"重置位置"'],
    ['label:"Reset zoom"', 'label:"重置缩放"'],
    ['label:"Restore defaults"', 'label:"恢复默认值"'],
    ['label:"View Agent"', 'label:"查看智能体"'],
    ['label:"View Changes"', 'label:"查看更改"'],
    ['label:"View All Changes"', 'label:"查看所有更改"'],
    ['label:"View PR"', 'label:"查看 PR"'],
    ['label:"View Source"', 'label:"查看源代码"'],
    ['label:"View changelog"', 'label:"查看更新日志"'],
    ['label:"View on Web"', 'label:"在网页中查看"'],
    ['label:"View docs"', 'label:"查看文档"'],
    ['label:"Show History"', 'label:"显示历史记录"'],
    ['label:"Show Less"', 'label:"显示更少"'],
    ['label:"Show More"', 'label:"显示更多"'],
    ['label:"Show Chat"', 'label:"显示聊天"'],
    ['label:"Show Changes"', 'label:"显示更改"'],
    ['label:"Show files"', 'label:"显示文件"'],
    ['label:"Show Output"', 'label:"显示输出"'],
    ['label:"Show Options"', 'label:"显示选项"'],
    ['label:"Show Status Bar"', 'label:"显示状态栏"'],
    ['label:"Shut down"', 'label:"关闭"'],
    ['label:"Take Control"', 'label:"接管控制"'],
    ['label:"Switch mode"', 'label:"切换模式"'],
    ['label:"Use Cursor Browser"', 'label:"使用 Cursor 浏览器"'],
    ['label:"Use External Browser"', 'label:"使用外部浏览器"'],
    ['label:"Use in IDE"', 'label:"在 IDE 中使用"'],
    ['label:"Use in Agents Window"', 'label:"在智能体窗口中使用"'],
    ['label:"Use DMs"', 'label:"使用私信"'],
    ['label:"Self-Driving PRs"', 'label:"自动驾驶 PR"'],
    ['label:"Self-driving Settings"', 'label:"自动驾驶设置"'],
    ['label:"Branch Changes"', 'label:"分支更改"'],
    ['label:"Branch Pull Requests"', 'label:"分支拉取请求"'],
    ['label:"Branch Prefix"', 'label:"分支前缀"'],
    ['label:"PR Routing & Approval"', 'label:"PR 路由与批准"'],
    ['label:"Scan and Triage Security Vulnerabilities"', 'label:"扫描和分类安全漏洞"'],
    ['label:"Automate with Hooks"', 'label:"用钩子自动化"'],
    ['label:"Teach Cursor New Skills"', 'label:"教 Cursor 新技能"'],
    ['label:"Plugins, MCPs, Skills, and Rules have moved to Customize"', 'label:"插件、MCP、技能和规则已移至自定义"'],
    ['label:"Verified by Cursor"', 'label:"Cursor 已验证"'],
    ['label:"The best way to code with AI"', 'label:"使用 AI 编程的最佳方式"'],
    ['label:"Ship better code, faster"', 'label:"更快地交付更好的代码"'],
    ['label:"What should we build?"', 'label:"我们要构建什么？"'],
    ['label:"Pending approval"', 'label:"待批准"'],
    ['label:"Request received"', 'label:"请求已接收"'],
    ['label:"Something is off"', 'label:"有问题"'],
    ['label:"Action Needed"', 'label:"需要操作"'],
    ['label:"Review required"', 'label:"需要审查"'],
    ['label:"Background agent"', 'label:"后台智能体"'],
    ['label:"Quick Question"', 'label:"快速提问"'],
    ['label:"Side Chat"', 'label:"侧边聊天"'],
    ['label:"Past Chat"', 'label:"历史聊天"'],
    ['label:"Same chat"', 'label:"同一聊天"'],
    ['label:"Save Image As..."', 'label:"另存图片为..."'],
    ['label:"Run command"', 'label:"运行命令"'],
    ['label:"Run in"', 'label:"运行于"'],
    ['label:"Search web"', 'label:"搜索网页"'],
    ['label:"Search with Google"', 'label:"用 Google 搜索"'],
    ['label:"Type to search actions"', 'label:"输入以搜索操作"'],
    ['label:"Report Bug"', 'label:"报告 Bug"'],
    ['label:"Report Good"', 'label:"报告良好"'],
    ['label:"Report Bad"', 'label:"报告问题"'],
    ['label:"Report Lag"', 'label:"报告卡顿"'],
    ['label:"Thumbs Up"', 'label:"点赞"'],
    ['label:"Thumbs Down"', 'label:"踩"'],
    ['label:"See Details"', 'label:"查看详情"'],
    ['label:"Reveal in File Explorer"', 'label:"在文件资源管理器中显示"'],
    ['label:"Select All in Diff"', 'label:"在差异中全选"'],
    ['label:"Select All in File"', 'label:"在文件中全选"'],
    ['label:"Select to End"', 'label:"选择到末尾"'],
    ['label:"Open Browser Tab"', 'label:"打开浏览器标签页"'],
    ['label:"Activate Browser Tab"', 'label:"激活浏览器标签页"'],
    ['label:"Source Action..."', 'label:"源代码操作..."'],
    ['label:"Operation Complete"', 'label:"操作完成"'],
    ['label:"Outdated Client"', 'label:"客户端版本过旧"'],
    ['label:"Payment Method Update Required"', 'label:"需要更新付款方式"'],
    ['label:"Payment failed"', 'label:"付款失败"'],
    ['label:"You\'ve hit your hard limit"', 'label:"你已达到硬性限制"'],
    ['label:"You\'ve hit your rate limit on your current plan"', 'label:"你已达到当前套餐的速率限制"'],
    ['label:"Usage Pricing Required"', 'label:"需要用量定价"'],
    ['label:"This workspace"', 'label:"此工作区"'],
    ['label:"This automation is private"', 'label:"此自动化是私有的"'],
    ['label:"Add a Custom MCP Server"', 'label:"添加自定义 MCP 服务器"'],
    ['label:"Add a plugin to this agent"', 'label:"向此智能体添加插件"'],
    ['label:"Remove a plugin from this agent"', 'label:"从此智能体移除插件"'],
    ['label:"Add plugins to this marketplace so your team can install them."', 'label:"向此市场添加插件，以便你的团队可以安装。"'],
    ['label:"Add plugins or import from GitHub to make them available for your team."', 'label:"添加插件或从 GitHub 导入，以供团队使用。"'],
    ['label:"Browse the marketplace or import custom plugins to extend"', 'label:"浏览市场或导入自定义插件以扩展功能"'],
    ['label:"Your changes will be lost if you don\'t save them."', 'label:"如果不保存，你的更改将丢失。"'],
    ['label:"This action cannot be undone. Proceed anyway?"', 'label:"此操作无法撤销。确定继续？"'],
    ['label:"Are you sure you want to close this window?"', 'label:"确定要关闭此窗口吗？"'],
    ['label:"Are you sure you want to perform this action?"', 'label:"确定要执行此操作吗？"'],
    ['label:"This will permanently delete all your data. This action cannot be undone."', 'label:"这将永久删除你的所有数据。此操作无法撤销。"'],
    ['label:"Proceed anyway (changes might not apply correctly)"', 'label:"仍然继续（更改可能无法正确应用）"'],
    ['label:"Would you like to remember this preference for future sessions?"', 'label:"是否在以后的会话中记住此偏好？"'],
    ['label:"An error occurred while processing your request."', 'label:"处理请求时发生错误。"'],
    ['label:"An unexpected error occurred. Reload the window to try again."', 'label:"发生意外错误。重新加载窗口以重试。"'],
    ['label:"The certificate for this site is not trusted"', 'label:"此站点的证书不受信任"'],
    ['label:"Please update your payment method to keep using Cursor."', 'label:"请更新你的付款方式以继续使用 Cursor。"'],
    ['label:"Rate limited by GitHub"', 'label:"被 GitHub 限流"'],
    ['label:"Unable to load automations."', 'label:"无法加载自动化。"'],
    ['label:"Unable to load organizations"', 'label:"无法加载组织"'],
    ['label:"Unable to load Microsoft Teams channels"', 'label:"无法加载 Microsoft Teams 频道"'],
    ['label:"Unable to load this step."', 'label:"无法加载此步骤。"'],
    ['label:"We couldn\'t generate your referral link. Try again."', 'label:"无法生成你的推荐链接。请重试。"'],
    ['label:"This chat could not be loaded."', 'label:"无法加载此聊天。"'],
    ['label:"This pull request cannot be merged"', 'label:"此拉取请求无法合并"'],
    ['label:"This pull request tab does not have a branch name yet."', 'label:"此拉取请求标签页还没有分支名称。"'],
    ['label:"This task is missing its pull request URL."', 'label:"此任务缺少拉取请求 URL。"'],
    ['label:"This automation can only be viewed by the creator and team admins."', 'label:"此自动化只能由创建者和团队管理员查看。"'],
    ['label:"You don\'t have access to this automation\'s run history."', 'label:"你无权访问此自动化的运行历史。"'],
    ['label:"You\'ll be logged out of your Cursor account on this device."', 'label:"你将在此设备上登出 Cursor 账户。"'],
    ['label:"Uploading snapshot to Cursor..."', 'label:"正在上传快照到 Cursor..."'],
    ['label:"Taking a little while..."', 'label:"需要一点时间..."'],
    ['label:"Still running locally?"', 'label:"仍在本地运行？"'],
    ['label:"Working on a Long Task?"', 'label:"正在处理长任务？"'],
    ['label:"Preparing workspace"', 'label:"正在准备工作区"'],
    ['label:"Preparing save form..."', 'label:"正在准备保存表单..."'],
    ['label:"Preparing secrets form..."', 'label:"正在准备密钥表单..."'],
    ['label:"Stashing changes..."', 'label:"正在暂存更改..."'],
    ['label:"Applying changes locally…"', 'label:"正在本地应用更改…"'],
    ['label:"Starting processes..."', 'label:"正在启动进程..."'],
    ['label:"Stopping processes..."', 'label:"正在停止进程..."'],
    ['label:"Processes stopped"', 'label:"进程已停止"'],
    ['label:"Page isn\'t working"', 'label:"页面无法正常工作"'],
    ['label:"Something went wrong"', 'label:"出错了"'],
    ['label:"Something went wrong."', 'label:"出错了。"'],
    ['label:"Add an agent to get started"', 'label:"添加智能体即可开始"'],
    ['label:"Add a to-do to get started"', 'label:"添加待办事项即可开始"'],
    ['label:"Select a canvas from the sidebar"', 'label:"从侧边栏选择画布"'],
    ['label:"Select a local marketplace folder"', 'label:"选择本地市场文件夹"'],
    ['label:"Select a local plugin repo"', 'label:"选择本地插件仓库"'],
    ['label:"Select a Linux distro to connect."', 'label:"选择要连接的 Linux 发行版。"'],
    ['label:"Select an option"', 'label:"选择一个选项"'],
    ['label:"Select Custom Chime Sound"', 'label:"选择自定义提示音"'],
    ['label:"Reset this pane to a new agent"', 'label:"将此面板重置为新智能体"'],
    ['label:"Switch where this agent runs"', 'label:"切换此智能体的运行位置"'],
    ['label:"Open subagent preview in agents tray"', 'label:"在智能体托盘中打开子智能体预览"'],
    ['label:"Try Open Subagent Preview by ID"', 'label:"按 ID 尝试打开子智能体预览"'],
    ['label:"Checkout Agent Branch"', 'label:"检出智能体分支"'],
    ['label:"Permanently discard your current changes before switching branches"', 'label:"切换分支前永久放弃当前更改"'],
    ['label:"Recommended to ensure correct base for changes"', 'label:"建议执行以确保更改的正确基础"'],
    ['label:"Save changes to a stash and restore them later"', 'label:"将更改保存到储藏并稍后恢复"'],
    ['label:"Save your changes and restore them later"', 'label:"保存更改并稍后恢复"'],
    ['label:"Stash and save your changes so you can restore them later"', 'label:"暂存并保存更改以便稍后恢复"'],
    ['label:"Stash + Overwrite"', 'label:"暂存并覆盖"'],
    ['label:"Push branch to remote"', 'label:"推送分支到远程"'],
    ['label:"Push local branch to remote"', 'label:"推送本地分支到远程"'],
    ['label:"Push unpushed commits"', 'label:"推送未推送的提交"'],
    ['label:"Score Commit for AI Content"', 'label:"为 AI 内容评分提交"'],
    ['label:"Run in"', 'label:"运行于"'],
    ['label:"Open from new branch"', 'label:"从新分支打开"'],
    ['label:"Open from this branch"', 'label:"从当前分支打开"'],
    ['label:"Replace all"', 'label:"全部替换"'],
    // ── children 类型 ──
    ['children:"Close Settings"', 'children:"关闭设置"'],
    ['children:"Open Settings"', 'children:"打开设置"'],
    ['children:"Agent Mode"', 'children:"智能体模式"'],
    ['children:"Review Mode"', 'children:"审查模式"'],
    ['children:"Background Mode"', 'children:"后台模式"'],
    ['children:"Self-Driving Mode"', 'children:"自动驾驶模式"'],
    ['children:"Accept All"', 'children:"全部接受"'],
    ['children:"Accept Edits"', 'children:"接受编辑"'],
    ['children:"Reject All Edits"', 'children:"拒绝所有编辑"'],
    ['children:"Undo Edits"', 'children:"撤销编辑"'],
    ['children:"Undo All"', 'children:"全部撤销"'],
    ['children:"Apply Changes"', 'children:"应用更改"'],
    ['children:"Apply Manually"', 'children:"手动应用"'],
    ['children:"Discard Changes"', 'children:"放弃更改"'],
    ['children:"Discard All Changes"', 'children:"放弃所有更改"'],
    ['children:"Rename Chat"', 'children:"重命名聊天"'],
    ['children:"Remove folder"', 'children:"移除文件夹"'],
    ['children:"Reset All"', 'children:"全部重置"'],
    ['children:"Reset Position"', 'children:"重置位置"'],
    ['children:"Restore defaults"', 'children:"恢复默认值"'],
    ['children:"Refresh All"', 'children:"全部刷新"'],
    ['children:"View Agent"', 'children:"查看智能体"'],
    ['children:"View Changes"', 'children:"查看更改"'],
    ['children:"View All Changes"', 'children:"查看所有更改"'],
    ['children:"View PR"', 'children:"查看 PR"'],
    ['children:"View Source"', 'children:"查看源代码"'],
    ['children:"View changelog"', 'children:"查看更新日志"'],
    ['children:"View on Web"', 'children:"在网页中查看"'],
    ['children:"View docs"', 'children:"查看文档"'],
    ['children:"Show History"', 'children:"显示历史记录"'],
    ['children:"Show Less"', 'children:"显示更少"'],
    ['children:"Show More"', 'children:"显示更多"'],
    ['children:"Show Chat"', 'children:"显示聊天"'],
    ['children:"Show Changes"', 'children:"显示更改"'],
    ['children:"Show files"', 'children:"显示文件"'],
    ['children:"Show Output"', 'children:"显示输出"'],
    ['children:"Show Options"', 'children:"显示选项"'],
    ['children:"Show Status Bar"', 'children:"显示状态栏"'],
    ['children:"Shut down"', 'children:"关闭"'],
    ['children:"Take Control"', 'children:"接管控制"'],
    ['children:"Take control"', 'children:"接管控制"'],
    ['children:"Switch mode"', 'children:"切换模式"'],
    ['children:"Sign In"', 'children:"登录"'],
    ['children:"Sign Up"', 'children:"注册"'],
    ['children:"Skip For Now"', 'children:"暂时跳过"'],
    ['children:"Trust & Continue"', 'children:"信任并继续"'],
    ['children:"Try Again"', 'children:"重试"'],
    ['children:"Try again"', 'children:"重试"'],
    ['children:"Try Cloud Agent"', 'children:"试试云智能体"'],
    ['children:"Upgrade to Pro"', 'children:"升级到 Pro"'],
    ['children:"Upgrade to Pro+"', 'children:"升级到 Pro+"'],
    ['children:"Upgrade to Ultra"', 'children:"升级到 Ultra"'],
    ['children:"Refer friends, earn usage credits"', 'children:"推荐好友，赚取用量额度"'],
    ['children:"Referral link"', 'children:"推荐链接"'],
    ['children:"Pin / Unpin Agent"', 'children:"固定/取消固定智能体"'],
    ['children:"Pin to workspace"', 'children:"固定到工作区"'],
    ['children:"Run Now"', 'children:"立即运行"'],
    ['children:"Run Task"', 'children:"运行任务"'],
    ['children:"Run in Background"', 'children:"在后台运行"'],
    ['children:"Run Autonomously"', 'children:"自主运行"'],
    ['children:"Run command"', 'children:"运行命令"'],
    ['children:"Pause Indexing"', 'children:"暂停索引"'],
    ['children:"Pause goal"', 'children:"暂停目标"'],
    ['children:"Resume goal"', 'children:"恢复目标"'],
    ['children:"Stash Changes"', 'children:"暂存更改"'],
    ['children:"Squash & Merge"', 'children:"压缩并合并"'],
    ['children:"Rebase Merge"', 'children:"变基合并"'],
    ['children:"Replace all"', 'children:"全部替换"'],
    ['children:"Preserve Case"', 'children:"保留大小写"'],
    ['children:"Use Regular Expression"', 'children:"使用正则表达式"'],
    ['children:"Use Cursor Browser"', 'children:"使用 Cursor 浏览器"'],
    ['children:"Use External Browser"', 'children:"使用外部浏览器"'],
    ['children:"Use in IDE"', 'children:"在 IDE 中使用"'],
    ['children:"Use in Agents Window"', 'children:"在智能体窗口中使用"'],
    ['children:"Use DMs"', 'children:"使用私信"'],
    ['children:"Ordered list"', 'children:"有序列表"'],
    ['children:"Bullet list"', 'children:"无序列表"'],
    ['children:"Select Multiple"', 'children:"多选"'],
    ['children:"Select Workspace"', 'children:"选择工作区"'],
    ['children:"Select Environment"', 'children:"选择环境"'],
    ['children:"Select Backend"', 'children:"选择后端"'],
    ['children:"Send to Chat"', 'children:"发送到聊天"'],
    ['children:"Send to Cloud"', 'children:"发送到云端"'],
    ['children:"Send invite"', 'children:"发送邀请"'],
    ['children:"Share Transcript"', 'children:"分享记录"'],
    ['children:"About Cursor"', 'children:"关于 Cursor"'],
    ['children:"Access Settings"', 'children:"访问设置"'],
    ['children:"Add Doc"', 'children:"添加文档"'],
    ['children:"Add MCP"', 'children:"添加 MCP"'],
    ['children:"Add Models"', 'children:"添加模型"'],
    ['children:"Add Skills"', 'children:"添加技能"'],
    ['children:"Add Folder"', 'children:"添加文件夹"'],
    ['children:"Add Link"', 'children:"添加链接"'],
    ['children:"Add link"', 'children:"添加链接"'],
    ['children:"Add folder"', 'children:"添加文件夹"'],
    ['children:"Add Marketplace"', 'children:"添加市场"'],
    ['children:"Add to Chat"', 'children:"添加到聊天"'],
    ['children:"Add to Team"', 'children:"添加到团队"'],
    ['children:"Add for Myself"', 'children:"为自己添加"'],
    ['children:"Open Settings"', 'children:"打开设置"'],
    ['children:"Open Source Control"', 'children:"打开源代码管理"'],
    ['children:"Open Plugins"', 'children:"打开插件"'],
    ['children:"Open MCPs"', 'children:"打开 MCP"'],
    ['children:"Open Skills"', 'children:"打开技能"'],
    ['children:"Open Hooks"', 'children:"打开钩子"'],
    ['children:"Open Rules"', 'children:"打开规则"'],
    ['children:"Open Automations"', 'children:"打开自动化"'],
    ['children:"Open Build Menu"', 'children:"打开构建菜单"'],
    ['children:"Open Canvas"', 'children:"打开画布"'],
    ['children:"Open Gallery"', 'children:"打开画廊"'],
    ['children:"Open Documentation"', 'children:"打开文档"'],
    ['children:"Open File"', 'children:"打开文件"'],
    ['children:"Open PR"', 'children:"打开 PR"'],
    ['children:"Open Plan"', 'children:"打开计划"'],
    ['children:"Open Browser Tab"', 'children:"打开浏览器标签页"'],
    ['children:"Activate Browser Tab"', 'children:"激活浏览器标签页"'],
    ['children:"Source Action..."', 'children:"源代码操作..."'],
    ['children:"Save Image As..."', 'children:"另存图片为..."'],
    ['children:"Browse Files"', 'children:"浏览文件"'],
    ['children:"Browse MCPs"', 'children:"浏览 MCP"'],
    ['children:"Browse Marketplace"', 'children:"浏览市场"'],
    ['children:"Build Locally"', 'children:"本地构建"'],
    ['children:"Build in Cloud"', 'children:"在云端构建"'],
    ['children:"Build in New Agent"', 'children:"在新智能体中构建"'],
    ['children:"Build in Parallel"', 'children:"并行构建"'],
    ['children:"Search Agents"', 'children:"搜索智能体"'],
    ['children:"Search Cursor Settings"', 'children:"搜索 Cursor 设置"'],
    ['children:"Search Extensions"', 'children:"搜索扩展"'],
    ['children:"Search web"', 'children:"搜索网页"'],
    ['children:"Search with Google"', 'children:"用 Google 搜索"'],
    ['children:"Type to search actions"', 'children:"输入以搜索操作"'],
    ['children:"Report Bug"', 'children:"报告 Bug"'],
    ['children:"Report Good"', 'children:"报告良好"'],
    ['children:"Report Bad"', 'children:"报告问题"'],
    ['children:"Report Lag"', 'children:"报告卡顿"'],
    ['children:"Thumbs Up"', 'children:"点赞"'],
    ['children:"Thumbs Down"', 'children:"踩"'],
    ['children:"See Details"', 'children:"查看详情"'],
    ['children:"Reveal in File Explorer"', 'children:"在文件资源管理器中显示"'],
    ['children:"Select All in Diff"', 'children:"在差异中全选"'],
    ['children:"Select All in File"', 'children:"在文件中全选"'],
    ['children:"Select to End"', 'children:"选择到末尾"'],
    ['children:"Select an option"', 'children:"选择一个选项"'],
    ['children:"Select Custom Chime Sound"', 'children:"选择自定义提示音"'],
    ['children:"Reset zoom"', 'children:"重置缩放"'],
    ['children:"Reset zoom to 100%"', 'children:"重置缩放至 100%"'],
    ['children:"Reset cache"', 'children:"重置缓存"'],
    ['children:"Reset this pane to a new agent"', 'children:"将此面板重置为新智能体"'],
    ['children:"Switch where this agent runs"', 'children:"切换此智能体的运行位置"'],
    ['children:"Pending approval"', 'children:"待批准"'],
    ['children:"Action Needed"', 'children:"需要操作"'],
    ['children:"Review required"', 'children:"需要审查"'],
    ['children:"Request received"', 'children:"请求已接收"'],
    ['children:"Operation Complete"', 'children:"操作完成"'],
    ['children:"Something went wrong"', 'children:"出错了"'],
    ['children:"Something went wrong."', 'children:"出错了。"'],
    ['children:"Something is off"', 'children:"有问题"'],
    ['children:"Can\'t connect to server"', 'children:"无法连接到服务器"'],
    ['children:"Outdated Client"', 'children:"客户端版本过旧"'],
    ['children:"Payment Method Update Required"', 'children:"需要更新付款方式"'],
    ['children:"Payment failed"', 'children:"付款失败"'],
    ['children:"Plan ending soon"', 'children:"套餐即将到期"'],
    ['children:"Update Required"', 'children:"需要更新"'],
    ['children:"Restart to Update"', 'children:"重启以更新"'],
    ['children:"You\'ve hit your hard limit"', 'children:"你已达到硬性限制"'],
    ['children:"You\'ve hit your rate limit on your current plan"', 'children:"你已达到当前套餐的速率限制"'],
    ['children:"Usage Pricing Required"', 'children:"需要用量定价"'],
    ['children:"Page isn\'t working"', 'children:"页面无法正常工作"'],
    ['children:"Binary file not shown"', 'children:"二进制文件未显示"'],
    ['children:"Only whitespace changes"', 'children:"仅有空白字符更改"'],
    ['children:"This workspace"', 'children:"此工作区"'],
    ['children:"This automation is private"', 'children:"此自动化是私有的"'],
    ['children:"Add a Custom MCP Server"', 'children:"添加自定义 MCP 服务器"'],
    ['children:"Add a plugin to this agent"', 'children:"向此智能体添加插件"'],
    ['children:"Remove a plugin from this agent"', 'children:"从此智能体移除插件"'],
    ['children:"Add plugins to this marketplace so your team can install them."', 'children:"向此市场添加插件，以便你的团队可以安装。"'],
    ['children:"Add plugins or import from GitHub to make them available for your team."', 'children:"添加插件或从 GitHub 导入，以供团队使用。"'],
    ['children:"Browse the marketplace or import custom plugins to extend"', 'children:"浏览市场或导入自定义插件以扩展功能"'],
    ['children:"Your changes will be lost if you don\'t save them."', 'children:"如果不保存，你的更改将丢失。"'],
    ['children:"This action cannot be undone. Proceed anyway?"', 'children:"此操作无法撤销。确定继续？"'],
    ['children:"Are you sure you want to close this window?"', 'children:"确定要关闭此窗口吗？"'],
    ['children:"Are you sure you want to perform this action?"', 'children:"确定要执行此操作吗？"'],
    ['children:"This will permanently delete all your data. This action cannot be undone."', 'children:"这将永久删除你的所有数据。此操作无法撤销。"'],
    ['children:"Proceed anyway (changes might not apply correctly)"', 'children:"仍然继续（更改可能无法正确应用）"'],
    ['children:"Would you like to remember this preference for future sessions?"', 'children:"是否在以后的会话中记住此偏好？"'],
    ['children:"An error occurred while processing your request."', 'children:"处理请求时发生错误。"'],
    ['children:"An unexpected error occurred. Reload the window to try again."', 'children:"发生意外错误。重新加载窗口以重试。"'],
    ['children:"The certificate for this site is not trusted"', 'children:"此站点的证书不受信任"'],
    ['children:"Please update your payment method to keep using Cursor."', 'children:"请更新你的付款方式以继续使用 Cursor。"'],
    ['children:"Rate limited by GitHub"', 'children:"被 GitHub 限流"'],
    ['children:"Unable to load automations."', 'children:"无法加载自动化。"'],
    ['children:"Unable to load organizations"', 'children:"无法加载组织"'],
    ['children:"Unable to load Microsoft Teams channels"', 'children:"无法加载 Microsoft Teams 频道"'],
    ['children:"Unable to load this step."', 'children:"无法加载此步骤。"'],
    ['children:"We couldn\'t generate your referral link. Try again."', 'children:"无法生成你的推荐链接。请重试。"'],
    ['children:"This chat could not be loaded."', 'children:"无法加载此聊天。"'],
    ['children:"This pull request cannot be merged"', 'children:"此拉取请求无法合并"'],
    ['children:"This pull request tab does not have a branch name yet."', 'children:"此拉取请求标签页还没有分支名称。"'],
    ['children:"This task is missing its pull request URL."', 'children:"此任务缺少拉取请求 URL。"'],
    ['children:"This automation can only be viewed by the creator and team admins."', 'children:"此自动化只能由创建者和团队管理员查看。"'],
    ['children:"You don\'t have access to this automation\'s run history."', 'children:"你无权访问此自动化的运行历史。"'],
    ['children:"You\'ll be logged out of your Cursor account on this device."', 'children:"你将在此设备上登出 Cursor 账户。"'],
    ['children:"Uploading snapshot to Cursor..."', 'children:"正在上传快照到 Cursor..."'],
    ['children:"Taking a little while..."', 'children:"需要一点时间..."'],
    ['children:"Still running locally?"', 'children:"仍在本地运行？"'],
    ['children:"Working on a Long Task?"', 'children:"正在处理长任务？"'],
    ['children:"Preparing workspace"', 'children:"正在准备工作区"'],
    ['children:"Preparing save form..."', 'children:"正在准备保存表单..."'],
    ['children:"Preparing secrets form..."', 'children:"正在准备密钥表单..."'],
    ['children:"Stashing changes..."', 'children:"正在暂存更改..."'],
    ['children:"Applying changes locally…"', 'children:"正在本地应用更改…"'],
    ['children:"Starting processes..."', 'children:"正在启动进程..."'],
    ['children:"Stopping processes..."', 'children:"正在停止进程..."'],
    ['children:"Processes stopped"', 'children:"进程已停止"'],
    ['children:"Add an agent to get started"', 'children:"添加智能体即可开始"'],
    ['children:"Add a to-do to get started"', 'children:"添加待办事项即可开始"'],
    ['children:"Select a canvas from the sidebar"', 'children:"从侧边栏选择画布"'],
    ['children:"Select a local marketplace folder"', 'children:"选择本地市场文件夹"'],
    ['children:"Select a local plugin repo"', 'children:"选择本地插件仓库"'],
    ['children:"Select a Linux distro to connect."', 'children:"选择要连接的 Linux 发行版。"'],
    ['children:"Open subagent preview in agents tray"', 'children:"在智能体托盘中打开子智能体预览"'],
    ['children:"Try Open Subagent Preview by ID"', 'children:"按 ID 尝试打开子智能体预览"'],
    ['children:"Checkout Agent Branch"', 'children:"检出智能体分支"'],
    ['children:"Permanently discard your current changes before switching branches"', 'children:"切换分支前永久放弃当前更改"'],
    ['children:"Recommended to ensure correct base for changes"', 'children:"建议执行以确保更改的正确基础"'],
    ['children:"Save changes to a stash and restore them later"', 'children:"将更改保存到储藏并稍后恢复"'],
    ['children:"Save your changes and restore them later"', 'children:"保存更改并稍后恢复"'],
    ['children:"Stash and save your changes so you can restore them later"', 'children:"暂存并保存更改以便稍后恢复"'],
    ['children:"Stash + Overwrite"', 'children:"暂存并覆盖"'],
    ['children:"Push branch to remote"', 'children:"推送分支到远程"'],
    ['children:"Push local branch to remote"', 'children:"推送本地分支到远程"'],
    ['children:"Push unpushed commits"', 'children:"推送未推送的提交"'],
    ['children:"Score Commit for AI Content"', 'children:"为 AI 内容评分提交"'],
    ['children:"Open from new branch"', 'children:"从新分支打开"'],
    ['children:"Open from this branch"', 'children:"从当前分支打开"'],
    ['children:"Verified by Cursor"', 'children:"Cursor 已验证"'],
    ['children:"Plugins, MCPs, Skills, and Rules have moved to Customize"', 'children:"插件、MCP、技能和规则已移至自定义"'],
    ['children:"The best way to code with AI"', 'children:"使用 AI 编程的最佳方式"'],
    ['children:"Ship better code, faster"', 'children:"更快地交付更好的代码"'],
    ['children:"What should we build?"', 'children:"我们要构建什么？"'],
    ['children:"Teach Cursor New Skills"', 'children:"教 Cursor 新技能"'],
    ['children:"Automate with Hooks"', 'children:"用钩子自动化"'],
    ['children:"Scan and Triage Security Vulnerabilities"', 'children:"扫描和分类安全漏洞"'],
    ['children:"PR Routing & Approval"', 'children:"PR 路由与批准"'],
    ['children:"Save Automation"', 'children:"保存自动化"'],
    ['children:"Run in"', 'children:"运行于"'],
    ['children:"Screen recording"', 'children:"屏幕录制"'],
    // ── heading 类型 ──
    ['heading:"Skills & Commands"', 'heading:"技能与命令"'],
    ['heading:"Actions"', 'heading:"操作"'],
    ['heading:"Plans"', 'heading:"计划"'],
    // ── Changes scope 标签（函数返回值）──
    ['label:()=>"Uncommitted"', 'label:()=>"未提交"'],
    ['label:()=>"Unstaged"', 'label:()=>"未暂存"'],
    ['label:()=>"Staged"', 'label:()=>"已暂存"'],
    // ── 开发者/调试命令 ──
    ['title:"Start File Watch Recording"', 'title:"开始文件监视记录"'],
    ['title:"Open Developer Tools for Extension Host"', 'title:"打开扩展宿主的开发者工具"'],
    ['title:"Start Extension Host CPU Profiler"', 'title:"启动扩展宿主 CPU 分析器"'],
    ['title:"Start Extension Host Heap Allocation Profiler"', 'title:"启动扩展宿主堆分配分析器"'],
    ['title:"Start Remote Server CPU Profiler"', 'title:"启动远程服务器 CPU 分析器"'],
    ['title:"Process Explorer"', 'title:"进程资源管理器"'],
    ['title:"Start Electron Trace"', 'title:"开始 Electron 跟踪"'],
    ['title:"Capture and Send Debugging Data"', 'title:"捕获并发送调试数据"'],
    ['title:"Delete Cloud-Agent Cache"', 'title:"删除云智能体缓存"'],
    ['title:"Display Workspace Metadata"', 'title:"显示工作区元数据"'],
    ['title:"Display Explorer Orchestrator Cache"', 'title:"显示资源管理器编排缓存"'],
    ['title:"Delete Old Chats..."', 'title:"删除旧聊天..."'],
    ['children:"Workspace Diagnostics"', 'children:"工作区诊断"'],
    ['original:"Start Extension Host CPU Profiler"', 'original:"启动扩展宿主 CPU 分析器"'],
    ['original:"Start Extension Host Heap Allocation Profiler"', 'original:"启动扩展宿主堆分配分析器"'],
    ['original:"Delete Old Chats..."', 'original:"删除旧聊天..."'],
    // ── Agents 窗口缺失的编辑菜单/操作按钮构造函数形式 ──
    ['new ks("undo","Undo"', 'new ks("undo","撤销"'],
    ['new ks("redo","Redo"', 'new ks("redo","重做"'],
    ['new ks("cut","Cut"', 'new ks("cut","剪切"'],
    ['new ks("copy","Copy"', 'new ks("copy","复制"'],
    ['new ks("paste","Paste"', 'new ks("paste","粘贴"'],
    ['new ks("selectAll","Select All"', 'new ks("selectAll","全选"'],
    ['new ks("collapse-all","Collapse All"', 'new ks("collapse-all","全部折叠"'],
    // ── children/label 缺失的编辑菜单项 ──
    ['children:"Cut"', 'children:"剪切"'],
    ['children:"Paste"', 'children:"粘贴"'],
    ['children:"Select All"', 'children:"全选"'],
    ['children:"No projects"', 'children:"暂无项目"'],
    ['children:"Reload"', 'children:"重新加载"'],
    ['children:"Clone Repository"', 'children:"克隆仓库"'],
    ['label:"Cut"', 'label:"剪切"'],
    ['label:"Paste"', 'label:"粘贴"'],
    ['label:"Select All"', 'label:"全选"'],
    ['label:"Clone Repository"', 'label:"克隆仓库"'],
    ['label:"Reload"', 'label:"重新加载"'],
    // ── Repos / Docs / Reload 其他形式 ──
    ['groupLabel:"Repos"', 'groupLabel:"仓库"'],
    ['buttonLabel:"Reload"', 'buttonLabel:"重新加载"'],
    ['doc:"Docs"', 'doc:"文档"'],
    ['title:"Docs"', 'title:"文档"'],
    ['case"doc":return"Docs"', 'case"doc":return"文档"'],
    ['case"docs":return"Docs"', 'case"docs":return"文档"'],
    // ── 用户反馈缺失：Ask Agent（label/children 形式）──
    ['label:"Ask Agent"', 'label:"询问智能体"'],
    ['children:"Ask Agent"', 'children:"询问智能体"'],
    // ── 用户反馈缺失：Show/Hide Details（三元 + HTML + textContent）──
    ['?"Hide Details":"Show Details"', '?"隐藏详情":"显示详情"'],
    ['>Show Details</button>', '>显示详情</button>'],
    ['btn.textContent = \'Hide Details\'', 'btn.textContent = \'隐藏详情\''],
    ['btn.textContent = \'Show Details\'', 'btn.textContent = \'显示详情\''],
    // ── 用户反馈缺失：Discard Anular Changes / Discard Changes（E 形式）──
    ['?"Discard Unstaged Changes":"Discard All Changes"', '?"放弃未暂存更改":"放弃所有更改"'],
    ['E("glassSaveConflictDiscard","Discard Changes")', 'E("glassSaveConflictDiscard","放弃更改")'],
    ['label:"Discard Tracked Only"', 'label:"仅放弃已跟踪"'],
    ['?"Move to Trash":"Discard All"', '?"移到回收站":"全部放弃"'],
    // ── 用户反馈缺失：Home、（Collapse All 其余形式）──
    ['label:"Home",workspaceIdentifier', 'label:"主页",workspaceIdentifier'],
    ['children:"Collapse All"', 'children:"全部折叠"'],
    ['title:ft(9500,"Collapse All")', 'title:ft(9500,"全部折叠")'],
    ['?"Collapse All":"Expand All"', '?"全部折叠":"全部展开"'],
    ["collapseAll: 'Collapse All'", "collapseAll: '全部折叠'"],
    // ── 用户反馈缺失：Docs（docs:"Docs" 对象映射值）──
    ['docs:"Docs",contact:"Contact"', 'docs:"文档",contact:"联系"'],
];

// 合并大正则：单次扫描替代逐条替换（~1675条 → 1次扫描）
const auxInterfaceLookup = new Map(auxiliaryInterfaceReplacements.filter(([en]) => en));
const auxInterfaceMegaRegex = new RegExp(
    auxiliaryInterfaceReplacements
        .filter(([en]) => en)
        .sort((a, b) => b[0].length - a[0].length)
        .map(([en]) => escapeRegExp(en))
        .join('|'),
    'g'
);

const trickyReplacements = [
    {
        // 攻克 1：Reset "Don't Ask Again" Dialogs 
        // 魔法解析：(?:'|\\'|\\u2019|’|&#39;) 涵盖了前端所有的单引号变体，(?:\\?["']|\\u0022|&quot;) 兼容所有双引号变体
        regex: /Reset\s+(?:\\?["']|\\u201[CD]|\\u0022|&quot;)Don(?:'|\\'|\\u2019|’|&#39;)t\s+Ask\s+Again(?:\\?["']|\\u201[CD]|\\u0022|&quot;)\s+Dialogs/gi,
        zh: '重置“不再询问”弹窗'
    },
    {
        // 攻克 2：See warnings and tips that you've hidden
        regex: /See\s+warnings\s+and\s+tips\s+that\s+you(?:'|\\'|\\u2019|’|&#39;)ve\s+hidden/gi,
        zh: '查看您已隐藏的警告和提示'
    },
    {
        // 攻克 3：No Hidden Dialogs Yet
        regex: /No\s+Hidden\s+Dialogs\s+Yet/gi,
        zh: '暂无隐藏的弹窗'
    },
    {
        // 攻克 4：You haven't marked any dialogs as "Don't ask again"...
        regex: /You\s+haven(?:'|\\'|\\u2019|’|&#39;)t\s+marked\s+any\s+dialogs\s+as\s+(?:\\?["']|\\u201[CD]|\\u0022|&quot;)Don(?:'|\\'|\\u2019|’|&#39;)t\s+ask\s+again(?:\\?["']|\\u201[CD]|\\u0022|&quot;)\.\s*Any\s+hidden\s+dialogs\s+will\s+appear\s+here\s+to\s+manage\./gi,
        zh: '您尚未将任何弹窗标记为“不再询问”。任何隐藏的弹窗都将显示在此处以供管理。'
    },
    {
        // 攻克 5：截图2 的软链接超长警告
        // 魔法解析：them 和 Changing 之间可能有 ${...} 条件表达式（团队管理员控制标记）
        regex: /Use\s+with\s+caution\.\s*Skip\s+symlinks\s+during\s+\.cursorignore\s+file\s+discovery\.\s*Only\s+enable\s+if\s+your\s+repository\s+has\s+many\s+symlinks\s+and\s+all\s+\.cursorignore\s+files\s+are\s+reachable\s+without\s+them(?:\$\{[^}]*\}[^C]*)?\.\s*Changing\s+this\s+setting\s+will\s+require\s+a\s+restart\s+of\s+Cursor\./gi,
        zh: '请谨慎使用。在查找 .cursorignore 文件时跳过符号链接。仅当代码库包含大量符号链接且均可直接访问时才启用。更改此设置需重启 Cursor。'
    },
    {
        // 攻克 6a：label:`Submit with ${Fs?"⌘ + ":"Ctrl + "}Enter`
        regex: /Submit\s+with\s+(\$\{[^}]+\}|\\u2318\s*\+\s*|⌘\s*\+\s*|Ctrl\s*\+\s*)Enter/gi,
        zh: '使用 $1Enter 提交'
    },
    {
        // 攻克 6b：description:`When enabled, ${Fs?"⌘ + ":"Ctrl + "}Enter submits chat and Enter inserts a newline`
        regex: /When\s+enabled,\s+(\$\{[^}]+\}|\\u2318\s*\+\s*|⌘\s*\+\s*|Ctrl\s*\+\s*)Enter\s+submits\s+chat\s+and\s+Enter\s+inserts\s+a\s+newline/gi,
        zh: '启用后，$1Enter 提交聊天，Enter 插入换行'
    },
    {
        // 攻克 7：Apply .cursorignore files to all subdirectories...
        regex: /Apply\s+(.{0,10}?)\.cursorignore(.{0,10}?)\s+files\s+to\s+all\s+subdirectories(?:\$\{[^}]*\}[^C]*)?\.\s*Changing\s+this\s+setting\s+will\s+require\s+a\s+restart\s+of\s+Cursor\./gi,
        zh: '将 $1.cursorignore$2 文件应用于所有子目录。更改此设置需重启 Cursor。'
    },
    {
        // 攻克 10：Automatically import necessary modules for ${r}
        // 实际文件中是模板字符串，TypeScript/C++ 通过变量 ${r} 注入
        regex: /Automatically\s+import\s+necessary\s+modules\s+for\s+(\$\{[^}]+\}|TypeScript|C\+\+)/gi,
        zh: '自动为 $1 导入必要的模块'
    },
    {
        // 攻克 10.5：Accept the next word of a suggestion via ${...}
        // 实际文件中快捷键是通过 keybindingService 动态获取的变量
        regex: /Accept\s+the\s+next\s+word\s+of\s+a\s+suggestion\s+via\s+(\$\{[^}]+\}|Ctrl\+RightArrow)/gi,
        zh: '使用 $1 接受建议的下一个词'
    },
    {
        // 攻克 11：Embed codebase for improved contextual understanding and knowledge...
        regex: /Embed\s+codebase\s+for\s+improved\s+contextual\s+understanding\s+and\s+knowledge\.\s*Embeddings\s+and\s+metadata\s+are\s+stored\s+in\s+the\s+([^,]{1,50}?),\s*but\s+all\s+code\s+is\s+stored\s+locally\./gi,
        zh: '嵌入代码库以提升上下文理解和知识运用。嵌入向量和元数据存储在$1中，但所有代码均存储在本地。'
    },
    {
        // 攻克 13：Files to exclude from indexing in addition to .gitignore.
        regex: /Files\s+to\s+exclude\s+from\s+indexing\s+in\s+addition\s+to\s+([\s\S]{0,10}?)\.gitignore([\s\S]{0,10}?)\./gi,
        zh: '除 $1.gitignore$2 外要从索引中排除的额外文件。'
    },
    {
        // 攻克 14：Add documentation to use as context...
        regex: /Add\s+documentation\s+to\s+use\s+as\s+context\.\s*You\s+can\s+also\s+use\s+([\s\S]{0,20}?)@Add([\s\S]{0,20}?)\s+in\s+Chat\s+or\s+while\s+editing\s+to\s+add\s+a\s+doc\./gi,
        zh: '添加文档以用作上下文。您也可以在聊天或编辑框中使用 $1@Add$2 来添加文档。'
    },
    {
        // 攻克 15：You're over your current usage limit...
        regex: /You(?:'|\\'|\\u2019|’|&#39;)re\s+over\s+your\s+current\s+usage\s+limit\s+and\s+your\s+requests\s+are\s+being\s+processed\s+with\s+(.{1,20}?)\s+in\s+the\s+slow\s+queue\./gi,
        zh: '您已超出当前使用额度，您的请求正在慢速队列中由 $1 处理。'
    },
    {
        // 攻克 16：Automatically parse links when pasted into Quick Edit (${Fs?"⌘":"Ctrl+"}K) input
        // 实际文件中快捷键部分是三元表达式动态生成
        regex: /Automatically\s+parse\s+links\s+when\s+pasted\s+into\s+Quick\s+Edit\s+\((\$\{[^}]+\}|Ctrl\+)K\)\s+input/gi,
        zh: '粘贴到快速编辑 ($1K) 输入框时自动解析链接'
    },
    {
        // 攻克 17：Automatically jump to the next diff when accepting changes with ${Fs?"⌘":"Ctrl+"}Y
        regex: /Automatically\s+jump\s+to\s+the\s+next\s+diff\s+when\s+accepting\s+changes\s+with\s+(\$\{[^}]+\}|Ctrl\+)Y/gi,
        zh: '使用 $1Y 接受更改时自动跳转到下一个差异'
    },
    {
        // 攻克 18：Show a hint for ${Fs?"⌘":"Ctrl+"}K in the Terminal
        regex: /Show\s+a\s+hint\s+for\s+(\$\{[^}]+\}|Ctrl\+)K\s+in\s+the\s+Terminal/gi,
        zh: '在终端中显示 $1K 提示'
    },
    {
        // 攻克 19：Preview Box for Terminal ${Fs?"⌘":"Ctrl+"}K
        regex: /Preview\s+Box\s+for\s+Terminal\s+(\$\{[^}]+\}|Ctrl\+)K/gi,
        zh: '终端 $1K 的预览框'
    },
    {
        // 攻克 20：Automatically index any new folders with fewer than 250,000 files
        // 实际代码是一个数组：["Automatically index any new folders with fewer than"," ",Ui(()=>...)," ","files"]
        regex: /\[\s*"Automatically\s+index\s+any\s+new\s+folders\s+with\s+fewer\s+than"\s*,\s*" "\s*,\s*(.+?)\s*,\s*" "\s*,\s*"files"\s*\]/gi,
        zh: '["自动索引少于", " ", $1, " ", "个文件的新文件夹"]'
    },
    {
        // 攻克 21：Automatically index repositories to speed up Grep searches. All data is stored locally.
        regex: /"Automatically\s+index\s+repositories\s+to\s+speed\s+up\s+Grep\s+searches\.\s+All\s+data\s+is\s+stored\s+locally\."/gi,
        zh: '"自动索引代码库以加速 Grep 搜索。所有数据均存储在本地。"'
    },
    {
        // 用量页重置日期中的动态天数：`${st} (${Bt} days)`。
        // 只替换带两个模板变量的日期片段，避免误伤普通英文文档或代码标识里的 days。
        regex: /`\$\{([^}]+)\}\s+\(\$\{([^}]+)\}\s+days\)`/g,
        zh: '`${$1} (${$2} 天)`'
    },
    {
        // 用量页“包含在当前套餐中”：`Included in ${planName}`。
        regex: /`Included\s+in\s+\$\{([^}]+)\}`/g,
        zh: '`包含在 ${$1} 中`'
    },
    {
        // 设置页搜索框占位：`Search settings ${...}`，变量名在 desktop/glass 中会随版本变化。
        regex: /Search\s+settings\s+\$\{([^}]+)\}/g,
        zh: '搜索设置 ${$1}'
    },
    {
        // 另一套用量图组件会把套餐名拼成：`Included in ${planName.trim()} Plan`。
        regex: /`Included\s+in\s+\$\{([^}]+)\}\s+Plan`/g,
        zh: '`包含在 ${$1} 套餐中`'
    },
    {
        // MCP 服务器状态文案由 fx1() 动态拼接，例如 “2 tools enabled”。
        regex: /e\.push\(`\$\{n\.enabledToolCount\}\s+tools`\),\(n\.promptCount\?\?0\)>0&&e\.push\(`\$\{n\.promptCount\}\s+prompts`\),\(n\.resourceCount\?\?0\)>0&&e\.push\(`\$\{n\.resourceCount\}\s+resources`\),e\.length>0\?`\$\{e\.join\(", "\)\}\s+enabled`:"No tools, prompts, or resources"/g,
        zh: 'e.push(`${n.enabledToolCount} 个工具`),(n.promptCount??0)>0&&e.push(`${n.promptCount} 个提示`),(n.resourceCount??0)>0&&e.push(`${n.resourceCount} 个资源`),e.length>0?`${e.join("，")}已启用`:"没有工具、提示或资源"'
    },
    {
        // Agent 运行轨迹：Thought for 1s / Thought for 2s。
        regex: /Thought\s+for\s+(\d+(?:\.\d+)?)ms/gi,
        zh: '思考了 $1 毫秒'
    },
    {
        regex: /Thought\s+for\s+(\d+(?:\.\d+)?)s/gi,
        zh: '思考了 $1 秒'
    },
    {
        regex: /Thought\s+for\s+(\d+(?:\.\d+)?)m/gi,
        zh: '思考了 $1 分钟'
    },
    {
        // 模板形式：`Thought for ${duration}` 或 `Thought for ${seconds}s`。
        regex: /`Thought\s+for\s+\$\{([^}]+)\}ms`/g,
        zh: '`思考了 ${$1} 毫秒`'
    },
    {
        regex: /`Thought\s+for\s+\$\{([^}]+)\}s`/g,
        zh: '`思考了 ${$1} 秒`'
    },
    {
        regex: /`Thought\s+for\s+\$\{([^}]+)\}m`/g,
        zh: '`思考了 ${$1} 分钟`'
    },
    {
        regex: /`Thought\s+for\s+\$\{([^}]+)\}`/g,
        zh: '`思考了 ${$1}`'
    },
    {
        // Agent 运行轨迹：Ran ${toolName}。
        regex: /`Ran\s+\$\{([^}]+)\}`/g,
        zh: '`已运行 ${$1}`'
    },
    {
        // Agent 运行轨迹：普通字符串形式，如 "Ran Check recent git history"。
        // 只处理引号内以 Ran 开头的 UI 文案，避免误伤代码标识。
        regex: /(["'`])Ran\s+/g,
        zh: '$1已运行：'
    },
    {
        // 认证错误卡片：Copy Request (${requestId})。
        regex: /`Copy\s+Request\s+\(\$\{([^}]+)\}\)`/g,
        zh: '`复制请求 (${$1})`'
    },
    {
        // 插件安装人数：Used by 1 teammate / Used by 2 teammates。
        regex: /`Used\s+by\s+\$\{([^}]+)\}\s+\$\{([^}]+)\===1\?"teammate":"teammates"\}`/g,
        zh: '`${$1} 位成员使用`'
    },
    {
        // 插件列表与提示输入里的搜索结果分组。
        regex: /Gdf\(t,a,d,"Results",c\)/g,
        zh: 'Gdf(t,a,d,"结果",c)'
    },
    {
        regex: /\{id:"search-results",title:"Results",items:t\}/g,
        zh: '{id:"search-results",title:"结果",items:t}'
    },
    {
        regex: /\[\{title:"Results",items:m\}\]/g,
        zh: '[{title:"结果",items:m}]'
    },
    {
        // 模型切换提示：`Switch Agent Mode (${mode})`，变量为当前模式名。
        regex: /`Switch\s+Agent\s+Mode\s*\(\$\{([^}]+)\}\)`/g,
        zh: '`切换 Agent 模式 (${$1})`'
    },
    {
        // 提交快捷键描述：`${...} submits chat, Enter inserts a newline, and primary actions move to ${...}`。
        // 两个片段都是三元表达式动态生成，用两个捕获组原样保留。
        regex: /`\$\{([^}]*)\}\s*submits chat, Enter inserts a newline, and primary actions move to \$\{([^}]*)\}`/g,
        zh: '`${$1} 提交聊天，Enter 插入换行，主要操作移到 ${$2}`'
    },
    {
        // PR 链接目标：`Choose ${...} for pull request links on web and desktop`，变量为 GitHub/Graphite/Cursor Review。
        regex: /`Choose\s+\$\{([^}]+)\}\s+for pull request links on web and desktop`/g,
        zh: '`为网页和桌面端的 PR 链接选择 ${$1}`'
    },
    {
        // 语音输入按钮：`Voice Input (${shortcut})`，快捷键动态注入。
        regex: /`Voice\s+Input\s+\(\$\{([^}]+)\}\)`/g,
        zh: '`语音输入 (${$1})`'
    },
    {
        // 开关状态三元：`...?"Enabled":"Disabled"`。
        regex: /\?"Enabled":"Disabled"/g,
        zh: '?"已启用":"已禁用"'
    },
    {
        // Hooks 设置分组标题带数量：`Configured Hooks (${count})`。
        regex: /`Configured\s+Hooks\s*\(\$\{([^}]+)\}\)`/g,
        zh: '`已配置的钩子 (${$1})`'
    },
    {
        // heading/title 三元表达式中的 "Recent"
        regex: /(heading|title):([a-zA-Z_$][\w$.]*(?:\s*[><!=]+\s*[^?]*?))\?"Recent":/g,
        zh: '$1:$2?"最近":',
    },
    {
        // 套餐用量重置倒计时：days left（单/复数模板）。
        regex: /`\$\{([^}]+)\}\s+day\$\{[^}]+===1\?"":"s"\}\s+left`/g,
        zh: '`${$1} 天后重置`'
    },
    {
        // 套餐用量重置倒计时：hours and minutes left（同时显示小时+分钟）。
        regex: /`\$\{([^}]+)\}\s+hour\$\{[^}]+===1\?"":"s"\}\s+and\s+\$\{([^}]+)\}\s+minute\$\{[^}]+===1\?"":"s"\}\s+left`/g,
        zh: '`${$1} 小时 ${$2} 分钟后重置`'
    },
    {
        // 套餐用量重置倒计时：hours left（仅小时）。
        regex: /`\$\{([^}]+)\}\s+hour\$\{[^}]+===1\?"":"s"\}\s+left`/g,
        zh: '`${$1} 小时后重置`'
    },
    {
        // 套餐用量重置倒计时：minutes left（仅分钟）。
        regex: /`\$\{([^}]+)\}\s+minute\$\{[^}]+===1\?"":"s"\}\s+left`/g,
        zh: '`${$1} 分钟后重置`'
    },
    {
        // 套餐用量重置倒计时：0 minutes left。
        regex: /"0 minutes left"/g,
        zh: '"已到期"'
    },
    {
        // API usage bar label: "your included API usage"。
        regex: /apiUsageBarLabel:"your included API usage"/g,
        zh: 'apiUsageBarLabel:"包含的 API 用量"'
    },
    {
        // Auto usage bar label: "your included total usage"。
        regex: /autoUsageBarLabel:"your included total usage"/g,
        zh: 'autoUsageBarLabel:"包含的总用量"'
    },
    {
        // Tab AI 统计 tooltip：`Tab AI Stats (Today): ${a}/${b} lines (${c}%)`。
        regex: /(`)Tab AI Stats \(Today\): (\$\{this\.todayStats\.tabAcceptedLines\})\/(\$\{this\.todayStats\.tabSuggestedLines\}) lines \((\$\{[^}]+\}%)\)(`)/g,
        zh: '$1Tab AI 统计（今日）：$2/$3 行（$4）$5'
    },
    {
        // Tab AI 统计状态栏文本：`$(tab) Tab Stats: ${a}/${b} (${c}%)`。
        regex: /(`)\$\(tab\) Tab Stats: (\$\{this\.todayStats\.tabAcceptedLines\})\/(\$\{this\.todayStats\.tabSuggestedLines\}) \((\$\{[^}]+\}%)\)(`)/g,
        zh: '$1$(tab) Tab 统计：$2/$3（$4）$5'
    },
    {
        // Tab AI ariaLabel：`Tab AI Stats: ${a} accepted out of ${b} suggested, ${c} percent acceptance rate`。
        regex: /(`)Tab AI Stats: (\$\{this\.todayStats\.tabAcceptedLines\}) accepted out of (\$\{this\.todayStats\.tabSuggestedLines\}) suggested, (\$\{[^}]+\}) percent acceptance rate(`)/g,
        zh: '$1Tab AI 统计：$2/$3 已接受，采纳率 $4%$5'
    },
    {
        // Agent AI 统计 tooltip：`Agent AI Stats (Today): ${a}/${b} lines (${c}%)`。
        regex: /(`)Agent AI Stats \(Today\): (\$\{this\.todayStats\.composerAcceptedLines\})\/(\$\{this\.todayStats\.composerSuggestedLines\}) lines \((\$\{[^}]+\}%)\)(`)/g,
        zh: '$1Agent AI 统计（今日）：$2/$3 行（$4）$5'
    },
    {
        // Agent AI 统计状态栏文本：`$(comment-discussion) Agent Stats: ${a}/${b} (${c}%)`。
        regex: /(`)\$\(comment-discussion\) Agent Stats: (\$\{this\.todayStats\.composerAcceptedLines\})\/(\$\{this\.todayStats\.composerSuggestedLines\}) \((\$\{[^}]+\}%)\)(`)/g,
        zh: '$1$(comment-discussion) Agent 统计：$2/$3（$4）$5'
    },
    {
        // Agent AI ariaLabel。
        regex: /(`)Agent AI Stats: (\$\{this\.todayStats\.composerAcceptedLines\}) accepted out of (\$\{this\.todayStats\.composerSuggestedLines\}) suggested, (\$\{[^}]+\}) percent acceptance rate(`)/g,
        zh: '$1Agent AI 统计：$2/$3 已接受，采纳率 $4%$5'
    },
    {
        // 按语言禁用：`Disable for ${lang}`。
        regex: /`Disable for \$\{([^}]+)\}`/g,
        zh: '`对 ${$1} 禁用`'
    },
    {
        // 暂停时长选项描述：`Snooze for ${c.label}`。
        regex: /`Snooze for \$\{([^}]+)\.label\}`/g,
        zh: '`暂停 ${$1.label}`'
    },
    {
        // 用量重置时间（带天数）：`Your usage resets on ${date} (${n} day/days).`。
        regex: /`Your usage resets on \$\{([^}]+)\} \(\$\{([^}]+)\} \$\{[^}]+===1\?"day":"days"\}\)\.`/g,
        zh: '`用量将在 ${$1} 重置（${$2} 天）。`'
    },
    {
        // 用量重置时间（仅日期）：`Your usage resets on ${date}.`。
        regex: /`Your usage resets on \$\{([^}]+)\}\.`/g,
        zh: '`用量将在 ${$1} 重置。`'
    },
    {
        // Changes 计数（含 scope）：`${n} ${e} ${n===1?"Change":"Changes"}` → `${n}处更改${e}`
        regex: /`\$\{(\w+)\} \$\{([^}]+)\} \$\{\1===1\?"Change":"Changes"\}`/g,
        zh: '`${$1}处更改${$2}`'
    },
    {
        // Changes 计数（无 scope）：`${n} ${n===1?"Change":"Changes"}` → `${n}处更改`
        regex: /`\$\{(\w+)\} \$\{\1===1\?"Change":"Changes"\}`/g,
        zh: '`${$1}处更改`'
    },
    {
        // Commits 计数：`${n} ${n===1?"Commit":"Commits"}` → `${n}次提交`
        regex: /`\$\{(\w+)\} \$\{\1===1\?"Commit":"Commits"\}`/g,
        zh: '`${$1}次提交`'
    },
    {
        // Uncommitted changes in 仓库：`Uncommitted changes in ${t.repoLabel}` → `${t.repoLabel} 中未提交的更改`
        regex: /`Uncommitted changes in \$\{([^}]+)\}`/g,
        zh: '`${$1} 中未提交的更改`'
    },
    {
        // Debug 模式描述（belt-and-suspenders，确保即使 safeMegaRegex 漏匹配也能命中）
        regex: /description:"Systematically diagnose and fix bugs using runtime traces"/g,
        zh: 'description:"使用运行时跟踪系统性地诊断和修复 Bug"'
    },
    {
        // 药丸开关 / 布尔参数显示：e.value?"On":"Off" / u==="true"?"On":"Off"
        regex: /\?"On":"Off"/g,
        zh: '?"开":"关"'
    },
    {
        // byw 函数：t===!0?"On":t===!1?"Off"
        regex: /===!0\?"On":(\w+)===!1\?"Off"/g,
        zh: '===!0?"开":$1===!1?"关"'
    },
    {
        // ariaLabel: `Open ${Rt} in Customize`
        regex: /`Open \$\{([^}]+)\} in Customize`/g,
        zh: '`在自定义中打开 ${$1}`'
    },
    {
        // Repos/Cloud 三元表达式：n?"Cloud":"Repos" 或 name:n?"Cloud":"Repos"
        regex: /\?"Cloud":"Repos"/g,
        zh: '?"云端":"仓库"'
    },
    {
        // Select 三元表达式：i?"Select one":"Select Multiple"
        regex: /\?"Select one":"Select Multiple"/g,
        zh: '?"选择一个":"选择多个"'
    },
    {
        // Describe the change 三元表达式：a.length>0?"Describe the change":`Describe the change or ...`
        regex: /\?"Describe the change"/g,
        zh: '?"描述更改"'
    },
    {
        // Expand All / Collapse All 三元表达式：nt?"Expand All":"Collapse All"
        regex: /\?"Expand All":"Collapse All"/g,
        zh: '?"全部展开":"全部折叠"'
    },
    {
        // Collapse All / Expand All 另一顺序：Y=Z?"Collapse All":"Expand All"
        regex: /\?"Collapse All":"Expand All"/g,
        zh: '?"全部折叠":"全部展开"'
    },
    {
        // Could not reach 模板：`Could not reach ${r}.`
        regex: /`Could not reach \$\{([^}]+)\}\.`/g,
        zh: '`无法连接 ${$1}.`'
    },
    {
        // Documentation 模板：case"docs":return`Documentation: ${n||e}`
        regex: /case"docs":return`Documentation: \$\{([^}]+)\}`/g,
        zh: 'case"docs":return`文档：${$1}`'
    },
    {
        // Discard 赋值：let r="Discard Changes" / const Bn="Discard Changes"（变量名为 minified，保留结构）
        regex: /(let|const)\s+(\w+)="Discard Changes"/g,
        zh: '$1 $2="放弃更改"'
    },
    {
        // Discard 三元链：t.isDirectory?r="Discard Folder Changes"
        regex: /="Discard Folder Changes"/g,
        zh: '="放弃文件夹更改"'
    },
    {
        // Discard 标题：title:"Discard Changes?"
        regex: /title:"Discard Changes\?"/g,
        zh: 'title:"放弃更改？"'
    },
    {
        // Discard 三元链：?r="Discard Untracked Changes"（若有）
        regex: /="Discard Untracked Changes"/g,
        zh: '="放弃未跟踪更改"'
    },
    {
        // AI Code Tracking 状态栏（图10）：Most Recent Commit Scored 模板
        regex: /Most Recent Commit Scored:\n/g,
        zh: '最近评分的提交：\n'
    },
    {
        regex: /AI-Generated: \$\{this\.recentCommit\.aiPercentage\}% \(\$\{n\} lines\)/g,
        zh: 'AI 生成：${this.recentCommit.aiPercentage}% (${n} 行)'
    },
    {
        regex: /  - Tab: \$\{i\} lines /g,
        zh: '  - Tab 补全：${i} 行 '
    },
    {
        regex: /  - Composer: \$\{r\} lines /g,
        zh: '  - Composer：${r} 行 '
    },
    {
        regex: /Total Changes: \$\{this\.recentCommit\.linesAdded\} added, \$\{this\.recentCommit\.linesDeleted\} deleted/g,
        zh: '总更改：新增 ${this.recentCommit.linesAdded}，删除 ${this.recentCommit.linesDeleted}'
    },
    {
        // AI Code Tracking 组件名
        regex: /name:"AI Code Tracking - Recent Commit"/g,
        zh: 'name:"AI 代码追踪 - 最近提交"'
    },
    {
        // AI-Generated Lines 变体
        regex: /AI-Generated Lines: \$\{a\} \(\$\{c\}%\)/g,
        zh: 'AI 生成行数：${a} (${c}%)'
    },
    {
        regex: /AI-Generated Lines: \$\{C\}/g,
        zh: 'AI 生成行数：${C}'
    },
    {
        regex: /AI-Generated: \$\{T\} \(\$\{C\.aiPercentage\|\|"/g,
        zh: 'AI 生成：${T} (${C.aiPercentage||"'
    },
];

/**
 * 新版 Cursor 会把 Agent / Glass 窗口拆到 workbench.glass.main.js。
 * 这里只处理可选附加 bundle，复用安全字典和短词保护，避免复制完整主流程。
 */
function translateAuxiliaryJsFile(filePath, productJsonPath) {
    if (!filePath || !fs.existsSync(filePath)) return { processed: false, hashFixed: false };

    const fileName = path.basename(filePath);
    console.log(`\n⚙️  正在处理附加窗口代码: ${fileName}`);

    let jsContent = fs.readFileSync(filePath, 'utf8');
    const progress = createProgress(5);
    const changes = createChangeTracker();

    progress.update('准备汉化附加窗口', fileName);

    let safeHitCount = 0;
    jsContent = jsContent.replace(safeMegaRegex, (match, quote, en) => {
        changes.record('安全长句', en, safeGlobalDict[en], 1);
        if (++safeHitCount % 100 === 0) progress.update('替换安全长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
        return `${quote}${safeGlobalDict[en]}${quote}`;
    });
    if (longMegaRegex) {
        let longHitCount = 0;
        jsContent = jsContent.replace(longMegaRegex, (match, en) => {
            changes.record('裸文本长句', en, safeGlobalDict[en], 1);
            if (++longHitCount % 100 === 0) progress.update('替换裸文本长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
            return safeGlobalDict[en];
        });
    }
    progress.step('安全文本处理完成');

    let auxInterfaceCount = 0;
    jsContent = jsContent.replace(auxInterfaceMegaRegex, (match) => {
        auxInterfaceCount++;
        return auxInterfaceLookup.get(match);
    });
    if (auxInterfaceCount > 0) {
        progress.update('替换附加界面片段', `${auxInterfaceCount} 处`);
        changes.record('附加界面片段', '<合并大正则>', '<中文>', auxInterfaceCount);
    }
    progress.step('界面片段处理完成');

    for (const { regex, zh } of trickyReplacements) {
        const result = replaceRegexWithCount(jsContent, regex, zh);
        jsContent = result.content;
        changes.record('附加动态模板', regex.source, zh, result.count);
        if (result.count > 0) {
            progress.update('替换附加动态模板', formatReplacementDetail(regex.source, zh, result.count));
        }
    }
    progress.step('动态模板处理完成');

    jsContent = applyRiskyShortWords(jsContent, changes, progress);
    jsContent = restoreComposerModeNames(jsContent);
    progress.step('短词处理完成');

    try {
        writeFileSafe(filePath, jsContent, 'utf8');
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(`无法写入 ${filePath}：权限不足。请关闭 Cursor 后以管理员身份运行本工具。`);
        }
        throw err;
    }

    const hashFixed = fixProductHash(jsContent, productJsonPath, fileName);
    progress.finish('附加窗口代码处理完成');
    changes.print();
    console.log(`✅ ${fileName} 智能汉化完成！`);

    return { processed: true, hashFixed };
}

function translateNlsMessagesFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return { processed: false };

    console.log('\n⚙️  正在处理原生提示文案: nls.messages.json');

    let messages;
    try {
        messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        throw new Error(`无法解析 ${filePath}: ${err.message}`);
    }

    if (!Array.isArray(messages)) {
        console.log('ℹ️  nls.messages.json 不是数组格式，已跳过。');
        return { processed: false };
    }

    const progress = createProgress(2);
    const changes = createChangeTracker();
    progress.update('准备汉化原生提示', '正在扫描 nls 消息');
    /**
     * NLS 词条查找策略（按优先级）：
     * 1. 精确匹配整个字符串
     * 2. 去除所有 &&（助记符标记）后匹配
     * 3. 去除 {0}/{1} 占位符后匹配基础模板
     */
    const lookupTranslation = (key) => {
        if (Object.prototype.hasOwnProperty.call(safeGlobalDict, key)) {
            return safeGlobalDict[key];
        }
        if (Object.prototype.hasOwnProperty.call(nativeNlsDict, key)) {
            return nativeNlsDict[key];
        }
        // 去除所有 && 后查找（如 "Give &&Feedback..." → "Give Feedback..."）
        const stripped = key.replace(/&&/g, '');
        if (stripped !== key) {
            if (Object.prototype.hasOwnProperty.call(safeGlobalDict, stripped)) {
                return safeGlobalDict[stripped];
            }
            if (Object.prototype.hasOwnProperty.call(nativeNlsDict, stripped)) {
                return nativeNlsDict[stripped];
            }
        }
        return null;
    };

    const translated = messages.map((value) => {
        if (typeof value !== 'string') return value;

        const directTranslation = lookupTranslation(value);
        if (directTranslation) {
            // 如果原文含 &&，翻译后在首字前加 && 以保留助记符快捷键
            let next = directTranslation;
            if (value.includes('&&') && !next.includes('&&')) {
                // 中文不需要字母助记符，去掉 && 避免乱码显示
                next = directTranslation;
            }
            changes.record('原生提示词条', value, next, 1);
            progress.update('替换原生提示', formatReplacementDetail(value, next, 1));
            return next;
        }

        return value;
    });

    progress.step('原生提示扫描完成');

    try {
        writeFileSafe(filePath, JSON.stringify(translated), 'utf8');
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(`无法写入 ${filePath}：权限不足。请关闭 Cursor 后以管理员身份运行本工具。`);
        }
        throw err;
    }

    progress.finish('原生提示处理完成');
    changes.print();
    console.log('✅ nls.messages.json 汉化完成！');

    return { processed: true };
}

// ═══════════════════════════════════════════════
// 主进程 main.js：系统托盘菜单等原生 UI
// ═══════════════════════════════════════════════

// 托盘菜单等主进程 UI 词条。用精确片段替换，避免 Settings/Quit 等常见词污染全局词典。
const mainProcessReplacements = [
    ['label:"Loading agents..."', 'label:"正在加载 Agent..."'],
    ['label:"Recent Agents"', 'label:"最近的 Agent"'],
    ['label:"No recent agents"', 'label:"暂无最近 Agent"'],
    ['label:"Clear All Notifications"', 'label:"清除所有通知"'],
    ['label:"New Agent"', 'label:"新建 Agent"'],
    ['label:"Open Cursor"', 'label:"打开 Cursor"'],
    ['label:"Settings"', 'label:"设置"'],
    ['label:"Quit"', 'label:"退出"'],
    ['label:`View More (${i.length})`', 'label:`查看更多 (${i.length})`'],
];

/**
 * 汉化 Electron 主进程文件（系统托盘菜单等原生 UI）。
 * main.js 没有 product.json 校验值，改完无需更新 checksum。
 */
function translateMainJsFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return { processed: false };

    console.log('\n⚙️  正在处理主进程文件: main.js（系统托盘菜单）');

    let jsContent = fs.readFileSync(filePath, 'utf8');
    const progress = createProgress(2);
    const changes = createChangeTracker();
    progress.update('处理主进程 UI', '系统托盘菜单');

    for (const [en, zh] of mainProcessReplacements) {
        const result = replaceStringWithCount(jsContent, en, zh);
        jsContent = result.content;
        changes.record('托盘菜单', en, zh, result.count);
        if (result.count > 0) {
            progress.update('替换托盘菜单', formatReplacementDetail(en, zh, result.count));
        }
    }
    progress.step('托盘菜单处理完成');

    try {
        writeFileSafe(filePath, jsContent, 'utf8');
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(`无法写入 ${filePath}：权限不足。请关闭 Cursor 后以管理员身份运行本工具。`);
        }
        throw err;
    }

    progress.finish('主进程文件处理完成');
    changes.print();
    console.log('✅ main.js 汉化完成！');

    return { processed: true };
}


// ═══════════════════════════════════════════════
// 用户扩展翻译（远程 SSH/WSL/容器命令面板）
// ═══════════════════════════════════════════════

const extensionCommandDict = {
    // Dev Containers
    "Open Folder in Container": "在容器中打开文件夹",
    "Show Dev Containers Log": "显示开发容器日志",
    "Attach to Running Container": "附加到正在运行的容器",
    "Open Container Configuration File": "打开容器配置文件",
    "Attach to Running Kubernetes Container...": "附加到正在运行的 Kubernetes 容器...",
    "Dev Containers": "开发容器",
    // Remote-SSH
    "Connect to Host...": "连接到主机...",
    "Connect Current Window to Host...": "将当前窗口连接到主机...",
    "Open SSH Configuration File...": "打开 SSH 配置文件...",
    "Connect to Host in New Window": "在新窗口中连接到主机",
    "Connect to Host in Current Window": "在当前窗口中连接到主机",
    "Remote-SSH": "远程 SSH",
    // WSL
    "Connect to WSL": "连接到 WSL",
    "Connect to WSL using Distro...": "使用指定发行版连接到 WSL...",
    "Connect to WSL in New Window": "在新窗口中连接到 WSL",
    "Connect to WSL using Distro in New Window...": "在新窗口中使用指定发行版连接到 WSL...",
    "Open Folder in WSL": "在 WSL 中打开文件夹",
};

function translateUserExtensions() {
    const homeDir = os.homedir();
    const extDir = path.join(homeDir, '.cursor', 'extensions');
    if (!fs.existsSync(extDir)) return { processed: 0 };

    console.log('\n⚙️  正在处理用户扩展: 远程开发命令面板');
    const remotePrefixes = ['anysphere.remote-containers', 'anysphere.remote-ssh', 'anysphere.remote-wsl'];
    let processed = 0;

    const entries = fs.readdirSync(extDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!remotePrefixes.some(p => entry.name.startsWith(p))) continue;

        const pkgPath = path.join(extDir, entry.name, 'package.json');
        if (!fs.existsSync(pkgPath)) continue;

        // 备份
        const backupMsg = backupFile(pkgPath);
        if (backupMsg) console.log(`  ${backupMsg}`);

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch {
            console.log(`  ⚠️  无法解析 ${entry.name}/package.json，已跳过`);
            continue;
        }

        let changed = false;
        const commands = pkg.contributes?.commands;
        if (Array.isArray(commands)) {
            for (const cmd of commands) {
                if (cmd.title && extensionCommandDict[cmd.title]) {
                    cmd.title = extensionCommandDict[cmd.title];
                    changed = true;
                }
                if (cmd.category && extensionCommandDict[cmd.category]) {
                    cmd.category = extensionCommandDict[cmd.category];
                    changed = true;
                }
            }
        }

        // viewsContainers/views 中的标题也可能包含英文
        const viewsContainers = pkg.contributes?.viewsContainers;
        if (viewsContainers) {
            for (const [, views] of Object.entries(viewsContainers)) {
                if (Array.isArray(views)) {
                    for (const v of views) {
                        if (v.title && extensionCommandDict[v.title]) {
                            v.title = extensionCommandDict[v.title];
                            changed = true;
                        }
                    }
                }
            }
        }

        if (changed) {
            writeFileSafe(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
            console.log(`  ✅ ${entry.name}: 已汉化命令面板条目`);
            processed++;
        }
    }

    if (processed === 0) {
        console.log('  ℹ️  未发现需要汉化的远程扩展（可能尚未安装）。');
    }
    return { processed };
}

function restoreUserExtensions() {
    const homeDir = os.homedir();
    const extDir = path.join(homeDir, '.cursor', 'extensions');
    if (!fs.existsSync(extDir)) return 0;

    let restored = 0;
    const entries = fs.readdirSync(extDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('anysphere.remote-')) continue;
        const pkgPath = path.join(extDir, entry.name, 'package.json');
        if (restoreFromBackup(pkgPath)) {
            console.log(`  ✅ 已还原: ${entry.name}/package.json`);
            restored++;
        }
    }
    return restored;
}


// ═══════════════════════════════════════════════
// 用户存储汉化 (state.vscdb → composerState.modes4)
// ═══════════════════════════════════════════════

/**
 * 通过 Cursor 内置 node 运行 storage.js，汉化 state.vscdb 中的 modes4 描述
 * @param {string} appPath Cursor app 路径（含 node_modules/@vscode/sqlite3）
 */
function translateUserStorage(appPath) {
    console.log('\n⚙️  正在处理用户存储 (state.vscdb)...');

    // 定位 Cursor 内置 node（仅 Windows/macOS 有）
    const nodeCandidates = process.platform === 'win32'
        ? [path.join(appPath, 'resources', 'helpers', 'node.exe')]
        : process.platform === 'darwin'
            ? [path.join(appPath, '..', 'Frameworks', 'Cursor Helper.app', 'Contents', 'MacOS', 'Cursor Helper')]
            : [];

    const nodeExe = nodeCandidates.find(p => fs.existsSync(p));
    if (!nodeExe) {
        console.log('  ℹ️  未找到 Cursor 内置 node，跳过用户存储汉化。');
        return;
    }

    const storageScript = path.join(__dirname, 'storage.js');
    if (!fs.existsSync(storageScript)) {
        console.log('  ℹ️  storage.js 不存在，跳过用户存储汉化。');
        return;
    }

    const { spawnSync } = require('child_process');
    const result = spawnSync(nodeExe, [storageScript, '--action=translate', `--app-path=${appPath}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 30000
    });

    if (result.error) {
        console.log('  ⚠️  用户存储汉化执行失败:', result.error.message);
    } else if (result.status !== 0) {
        console.log('  ⚠️  用户存储汉化异常退出（非致命）。');
    }
}

/**
 * 还原 state.vscdb（删除 modes4 翻译）
 */
function restoreUserStorage() {
    const storageScript = path.join(__dirname, 'storage.js');
    if (!fs.existsSync(storageScript)) {
        return;
    }

    // 还原不需要 node 版本匹配（仅文件复制），直接用 storage.js 的 restoreModes
    try {
        const { restoreModes } = require('./storage');
        if (restoreModes()) {
            console.log('  ✅ 已还原: state.vscdb');
        }
    } catch (e) {
        // 忽略
    }
}


// ═══════════════════════════════════════════════
// 核心汉化
// ═══════════════════════════════════════════════

/**
 * 执行汉化
 * @param {{ appPath: string, mainJsPath: string, glassJsPath?: string, nlsMessagesPath?: string, htmlPath: string, productJsonPath: string }} paths
 */
function translate(paths) {
    const { appPath, mainJsPath, glassJsPath, nlsMessagesPath, htmlPath, productJsonPath, mainProcessJsPath } = paths;

    // 1. 备份
    console.log('');
    const msgs = [
        backupFile(htmlPath, productJsonPath),
        backupFile(mainJsPath, productJsonPath),
        glassJsPath && fs.existsSync(glassJsPath) ? backupFile(glassJsPath, productJsonPath) : null,
        nlsMessagesPath && fs.existsSync(nlsMessagesPath) ? backupFile(nlsMessagesPath, productJsonPath) : null,
        mainProcessJsPath && fs.existsSync(mainProcessJsPath) ? backupFile(mainProcessJsPath, productJsonPath) : null,
        backupFile(productJsonPath, productJsonPath),
    ].filter(Boolean);
    msgs.forEach(m => console.log(`  ${m}`));

    // 2. 读取核心 JS
    console.log('\n⚙️  正在读取并处理核心代码...');
    let jsContent = fs.readFileSync(mainJsPath, 'utf8');
    const progress = createProgress(6);
    const changes = createChangeTracker();
    progress.update('准备汉化词库', '正在扫描可替换文本');

    // 3. 安全长句：单次大正则替换
    let safeHitCount = 0;
    jsContent = jsContent.replace(safeMegaRegex, (match, quote, en) => {
        changes.record('安全长句', en, safeGlobalDict[en], 1);
        if (++safeHitCount % 100 === 0) progress.update('替换安全长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
        return `${quote}${safeGlobalDict[en]}${quote}`;
    });
    progress.step('安全长句替换完成');

    // 4. 长句裸文本替换
    if (longMegaRegex) {
        let longHitCount = 0;
        jsContent = jsContent.replace(longMegaRegex, (match, en) => {
            changes.record('裸文本长句', en, safeGlobalDict[en], 1);
            if (++longHitCount % 100 === 0) progress.update('替换裸文本长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
            return safeGlobalDict[en];
        });
    }
    progress.step('裸文本长句处理完成');

    // 5. 暴力正则破译：处理带标点、特殊转义、单双引号混用的顽固长句
    progress.update('处理顽固词条', '包含特殊符号、动态模板和 Unicode 转义');

    trickyReplacements.forEach(({ regex, zh }) => {
        const before = jsContent;
        const result = replaceRegexWithCount(jsContent, regex, zh);
        jsContent = result.content;
        changes.record('顽固词条', regex.source, zh, result.count);
        if (result.count > 0) {
            progress.update('替换顽固词条', formatReplacementDetail(regex.source, zh, result.count));
        } else if (before !== jsContent) {
            progress.update('替换顽固词条', compactText(regex.source));
        }
    });
    progress.step('顽固词条处理完成');

    // 5.1 设置侧边栏映射与部分编译模板片段
    const scopedReplacements = [
        // ── 命令管理面板：筛选/排序下拉选项（desktop 同款）──
        ['label:"Filter By",ariaLabel:"Filter by options"', 'label:"筛选",ariaLabel:"筛选选项"'],
        ['{value:"scope",label:"Source",icon:"folder"}', '{value:"scope",label:"来源",icon:"folder"}'],
        ['{value:"author",label:"Author",icon:"person"}', '{value:"author",label:"作者",icon:"person"}'],
        ['{value:"name",label:"Name",icon:"text-aa"}', '{value:"name",label:"名称",icon:"text-aa"}'],
        ['?"Manage in Dashboard":"Open"', '?"在仪表盘中管理":"打开"'],
        ['prompt:"Enter Command Name",placeHolder:"Command name"', 'prompt:"输入命令名称",placeHolder:"命令名称"'],
        ['?"收起":"Show more"', '?"收起":"显示更多"'],
        ['prompt:"User Rules apply to all of your chats"', 'prompt:"用户规则适用于你的所有对话"'],
        // ── New User Skill/Subagent 创建对话框（desktop：oe/M 大写变量改中文供 title/prompt 用；skill/subagent 保持英文供占位符示例用）──
        ['te==="skill"?"Skill":"Subagent"', 'te==="skill"?"技能":"子代理"'],
        ['x==="skill"?"Skill":"Subagent"', 'x==="skill"?"技能":"子代理"'],
        ['title:`New User ${oe}`', 'title:`新建用户${oe}`'],
        ['prompt:`Enter a name for the new ${ee}`', 'prompt:`为新的${oe}输入名称`'],
        ['title:`New User ${M}`', 'title:`新建用户${M}`'],
        ['prompt:`Enter a name for the new ${I}`', 'prompt:`为新的${M}输入名称`'],
        // ── Git 面板加载状态 ──
        ['"Loading changes..."', '"正在加载更改..."'],
        ['"Loading changes"', '"正在加载更改"'],
        // ── Cycle 命令（desktop 状态栏）──
        ['title:{value:"Cycle model parameter",original:"Cycle model parameter"}', 'title:{value:"循环切换模型参数",original:"循环切换模型参数"}'],
        ['\\xB7 Cycle ${Jn} (${Lr})', '\\xB7 循环切换 ${Jn} (${Lr})'],
        // ── Done（完成）：状态文本 ──
        ['`Done \\u2022 ${s}`', '`完成 \\u2022 ${s}`'],
        ['"Agent complete"', '"智能体完成"'],
        // ── 欢迎页：Recent projects / Settings / Import / Show more ──
        ['<span>Recent projects</span>', '<span>最近项目</span>'],
        ['opacity-80">Settings\'', 'opacity-80">设置\''],
        ['?"Success!":', '?"成功!":'],
        ['?"Importing":"Import"', '?"导入中":"导入"'],
        ['`Show ${T} more`', '`显示 ${T} 更多`'],
        // ── Thinking intensity 持久翻译：mSg 注入参数名映射（服务端覆盖数据后仍显示中文）──
        ['function mSg(e){const t=ERs(e);return t.variants=t.variants??[],t.parameterDefinitions=t.parameterDefinitions??[],t}', 'function mSg(e){const t=ERs(e);return t.variants=t.variants??[],t.parameterDefinitions=(t.parameterDefinitions??[]).map(function(p){if(p&&p.name==="Thinking intensity")p.name="思考强度";return p}),t}'],
        // ── 文件树/资源管理器/终端/预览/删除状态 ──
        ['"New Folder"', '"新建文件夹"'],
        ['"New File"', '"新建文件"'],
        ['"Refresh Explorer"', '"刷新资源管理器"'],
        ['"Deleted"', '"已删除"'],
        ['"Terminal"', '"终端"'],
        ['"Preview"', '"预览"'],
        ['label:"Source",ariaLabel:"Source"', 'label:"源码",ariaLabel:"源码"'],
        // ── 审查/保留更改按钮 ──
        ['Keep all changes', '保留所有更改'],
        ['Review Next File', '审查下一个文件'],
        // ── 审查界面按钮：Stop/Review/Accept/Reject ──
        ['"Stop"', '"停止"'],
        ['"Review"', '"审查"'],
        ['"Accept"', '"接受"'],
        ['"Reject"', '"拒绝"'],
        // ── AI 统计面板：Repo/Branch 前缀 ──
        ['Repo: ', '仓库：'],
        ['Branch: ', '分支：'],
        // ── 附加文件命令 ──
        ['"Add Files to New Chat"', '"添加文件到新聊天"'],
        ['"Add Files to Chat"', '"添加文件到聊天"'],
        // ── 文件上下文菜单 / 搜索面板 ──
        ['Reveal in File Explorer', '在文件资源管理器中显示'],
        ['Copy Remote URL', '复制远程 URL'],
        ['Diff View', '差异视图'],
        ['More search options', '更多搜索选项'],
        ['Match Case', '匹配大小写'],
        ['Match Whole Word', '匹配整个单词'],
        // ── 审查操作 / AI 统计行 ──
        ['Accept all changes', '接受所有更改'],
        ['Keep All', '保留全部'],
        ['} added, ${', '} 新增, ${'],
        ['} deleted`', '} 删除`'],
        ['} deleted)', '} 删除)'],
        // ── 审查界面 Keep / 审查变更 ──
        ['"Keep"', '"保留"'],
        ['Review Changes', '审查更改'],
        // ── 浏览器连接错误 ──
        ['"Connection Failed"', '"连接失败"'],
        ['"Restart Browser"', '"重启浏览器"'],
        // ── Show N more / MCP 状态 / 私有设置 ──
        ['Show ${', '显示 ${'],
        ['} enabled`', '} 已启用`'],
        ['Add for Myself', '为我添加'],
        ['Add to Project', '添加到项目'],
        ['Show Output', '显示输出'],
        // ── MCP 状态 / 私有 / 个人 / 删除 ──
        ['"Private"', '"私有"'],
        ['"Disabled"', '"已禁用"'],
        ['"Personal"', '"个人"'],
        ['hintText:"Delete"', 'hintText:"删除"'],
        // ── MCP 空状态 ──
        ['No MCP Tools', '没有 MCP 工具'],
        ['Add a custom MCP tool here or configure project-specific tools in', '在此添加自定义 MCP 工具，或在项目专用工具中配置'],
        ['Add Custom MCP', '添加自定义 MCP'],
        // ── 文件上下文菜单 ──
        ['Open in Browser', '在浏览器中打开'],
        ['Add File to Cursor Chat', '添加文件到 Cursor 聊天'],
        ['Add File to New Cursor Chat', '添加文件到新 Cursor 聊天'],
        // ── 状态栏/命令面板 ──
        ['"AI Code Tracking Stats - Agent"', '"AI 代码追踪统计 - 智能体"'],
        ['"AI Code Tracking Stats - Tab"', '"AI 代码追踪统计 - Tab"'],
        // ── 更多操作 / 视图 / 关于窗口 ──
        ['More actions', '更多操作'],
        ['Render Whitespace', '显示空白'],
        ['Check for updates', '检查更新'],
        ['Copy version info', '复制版本信息'],
        // ── 命令面板 / 提示 / 网络日志 / 响应评价 ──
        ['Go to File', '转到文件'],
        ['Go to Symbol in Workspace', '转到工作区中的符号'],
        ['Hard reload (clears cache)', '硬重新加载(清除缓存)'],
        ['Auto-Review', '自动审查'],
        ['API requests', 'API 请求'],
        ['Agent requests', '智能体请求'],
        ['Codebase indexing', '代码库索引'],
        ['Authentication UI (login page)', '身份验证界面(登录页)'],
        ['Extension marketplace', '扩展市场'],
        ['Marketplace CDN', '市场 CDN'],
        ['Client updates', '客户端更新'],
        ['Good response', '良好回复'],
        ['Bad response', '不良回复'],
        ['Copy Message', '复制消息'],
        ['Show all (<!> more)', '显示全部(<!> 更多)'],
        // ── Git 状态 / 继续 / 总结提示 ──
        ['"Unstaged"', '"未暂存"'],
        ['"Staged"', '"已暂存"'],
        ['children:"Resume"', 'children:"继续"'],
        ['label:"Resume"', 'label:"继续"'],
        ['Summarizing chat context', '正在总结对话上下文'],
        ['general:"General"', 'general:"通用"'],
        ['profile:"Profile"', 'profile:"个人资料"'],
        ['appearance:"Appearance"', 'appearance:"外观"'],
        ['fun:"Fun"', 'fun:"趣味"'],
        ['"vscode-settings":"VS Code Settings"', '"vscode-settings":"VS Code 设置"'],
        ['"plan-usage":"Plan & Usage"', '"plan-usage":"套餐与用量"'],
        ['Open VS Code Settings', '打开 VS Code 设置'],
        ['children:"Manage View"', 'children:"管理视图"'],
        ['children:"Group By"', 'children:"分组方式"'],
        ['chat:"Agents"', 'chat:"智能体"'],
        ['browser:"Browser & Network"', 'browser:"浏览器与网络"'],
        ['tab:"Tab"', 'tab:"Tab 补全"'],
        ['models:"Models"', 'models:"模型"'],
        ['"git-prs":"Git & PRs"', '"git-prs":"Git 与 PR"'],
        ['mcp:"Tools & MCPs"', 'mcp:"工具与 MCP"'],
        ['hooks:"Hooks"', 'hooks:"钩子"'],
        ['beta:"Beta"', 'beta:"测试功能"'],
        ['network:"Network"', 'network:"网络"'],
        ['customize:"Customize"', 'customize:"自定义"'],
        ['"self-driving":"Self-driving PRs"', '"self-driving":"自动 PR"'],
        ['developer:"Developer"', 'developer:"开发者"'],
        ['worktrees:"Worktrees"', 'worktrees:"工作树"'],
        ['docs:"Docs"', 'docs:"官方文档"'],
        ['`Search settings ${ne()}`', '`搜索设置 ${ne()}`'],
        ['n.isGlass?"Indexing":"索引与文档"', 'n.isGlass?"索引":"索引与文档"'],
        ['title:"Conversation"', 'title:"对话"'],
        ['s===void 0?"Automations":s', 's===void 0?"自动化":s'],
        ['label:"Conversation"', 'label:"对话"'],
        ['"<div>Web Search Tool"', '"<div>网络搜索工具"'],
        ['>Resets on ', '>重置于 '],
        ['title:"Authentication"', 'title:"身份验证"'],
        ['"Authentication error"', '"身份验证错误"'],
        ["'Authentication error'", "'身份验证错误'"],
        ['`Authentication error`', '`身份验证错误`'],
        ['title:"Authentication error"', 'title:"身份验证错误"'],
        ['children:"Authentication error"', 'children:"身份验证错误"'],
        ['"If you are logged in, try logging out and back in."', '"如果您已登录，请尝试退出后重新登录。"'],
        ["'If you are logged in, try logging out and back in.'", "'如果您已登录，请尝试退出后重新登录。'"],
        ['`If you are logged in, try logging out and back in.`', '`如果您已登录，请尝试退出后重新登录。`'],
        ['children:"If you are logged in, try logging out and back in."', 'children:"如果您已登录，请尝试退出后重新登录。"'],
        ['"Copy Request"', '"复制请求"'],
        ["'Copy Request'", "'复制请求'"],
        ['`Copy Request`', '`复制请求`'],
        ['"Copy Request (', '"复制请求 ('],
        ["'Copy Request (", "'复制请求 ("],
        ['`Copy Request (${', '`复制请求 (${'],
        ['label:"Copy Request"', 'label:"复制请求"'],
        ['children:"Copy Request"', 'children:"复制请求"'],
        ['label:"Wait for MCP Authentication"', 'label:"等待 MCP 身份验证"'],
        ['description:"Wait indefinitely to authenticate when prompted. When off, skip authentication prompts after 30 seconds."', 'description:"出现身份验证提示时会一直等待。关闭后，30 秒后跳过身份验证提示。"'],
        ['<div>Browser Automation</div>', '<div>浏览器自动化</div>'],
        ['"Connected to Browser Tab"', '"已连接到浏览器标签页"'],
        ['"Checking status..."', '"正在检查状态..."'],
        ['<div class=mcp-server-item-main-content-name>New MCP Server</div>', '<div class=mcp-server-item-main-content-name>新建 MCP 服务器</div>'],
        ['return n.isBlocked?n.blockedMessage??"Blocked by admin":"Disabled"', 'return n.isBlocked?n.blockedMessage??"被管理员阻止":"已禁用"'],
        ['return"Needs authentication"', 'return"需要身份验证"'],
        ['return n.error===M0w?n.error:"Error - Show Output"', 'return n.error===M0w?n.error:"错误 - 显示输出"'],
        ['return"Loading tools"', 'return"正在加载工具"'],
        ['return"Disabled"', 'return"已禁用"'],
        ['hSE=et("<div class=mcp-tools-toggle-message>Show less")', 'hSE=et("<div class=mcp-tools-toggle-message>收起")'],
        ['"Exchanging token..."', '"正在交换令牌..."'],
        ['"Waiting for callback..."', '"正在等待回调..."'],
        ['"Authenticating..."', '"正在验证..."'],
        ['"Authenticate"', '"身份验证"'],
        ['label:"Edit MCP configuration"', 'label:"编辑 MCP 配置"'],
        ['label:"Delete MCP server"', 'label:"删除 MCP 服务器"'],
        ['"Reloading MCP server..."', '"正在重新加载 MCP 服务器..."'],
        ['"Reload MCP server"', '"重新加载 MCP 服务器"'],

        // API Keys / 模型供应商密钥设置。
        ['"API Keys"', '"API 密钥"'],
        ['<div class=settings-menu-hoverable><div></div><div>API Keys', '<div class=settings-menu-hoverable><div></div><div>API 密钥'],
        ['"OpenAI API Key"', '"OpenAI API 密钥"'],
        ['"Enter your OpenAI API Key"', '"请输入 OpenAI API 密钥"'],
        ['placeholder:"Enter your Azure OpenAI API Key"', 'placeholder:"请输入 Azure OpenAI API 密钥"'],
        ['"Override OpenAI Base URL"', '"覆盖 OpenAI 基础 URL"'],
        ['"Change the base URL for OpenAI API requests."', '"修改 OpenAI API 请求的基础 URL。"'],
        ['"Anthropic API Key"', '"Anthropic API 密钥"'],
        ['"Enter your Anthropic API Key"', '"请输入 Anthropic API 密钥"'],
        ['"Google API Key"', '"Google API 密钥"'],
        ['"Enter your Google AI Studio API Key"', '"请输入 Google AI Studio API 密钥"'],
        ['"Configure Azure OpenAI to use OpenAI models through your Azure account."', '"配置 Azure OpenAI，通过你的 Azure 账号使用 OpenAI 模型。"'],
        ['"Base URL"', '"基础 URL"'],
        ['label:"API Key"', 'label:"API 密钥"'],
        ['"You can put in "', '"你可以填写 "'],
        ['"You can put in"', '"你可以填写"'],
        ['"your OpenAI key"', '"你的 OpenAI 密钥"'],
        ['<span>your OpenAI key', '<span>你的 OpenAI 密钥'],
        ['"to use OpenAI models at cost."', '"以按成本使用 OpenAI 模型。"'],
        ['" to use OpenAI models at cost."', '"，以按成本使用 OpenAI 模型。"'],
        ['"your Anthropic key"', '"你的 Anthropic 密钥"'],
        ['<span>your Anthropic key', '<span>你的 Anthropic 密钥'],
        ['\'to use Claude at cost. When enabled, this key will be used for all models beginning with "claude-".\'', '\'以按成本使用 Claude。启用后，此密钥将用于所有以 "claude-" 开头的模型。\''],
        ['"to use Claude at cost. When enabled, this key will be used for all models beginning with \\"claude-\\"."', '"以按成本使用 Claude。启用后，此密钥将用于所有以 \\"claude-\\" 开头的模型。"'],
        ['" to use Claude at cost. When enabled, this key will be used for all models beginning with \\"claude-\\"."', '"，以按成本使用 Claude。启用后，此密钥将用于所有以 \\"claude-\\" 开头的模型。"'],
        ['"your Google AI Studio key"', '"你的 Google AI Studio 密钥"'],
        ['<span>your Google AI Studio key', '<span>你的 Google AI Studio 密钥'],
        ['"to use Google models at-cost."', '"以按成本使用 Google 模型。"'],
        ['" to use Google models at-cost."', '"，以按成本使用 Google 模型。"'],

        // 云端智能体不可用状态。
        ['"Cloud Agents Unavailable"', '"云端智能体不可用"'],
        ['title:"Loading"', 'title:"加载中"'],
        ['description:"Loading Cloud Agents settings..."', 'description:"正在加载云端智能体设置..."'],
        ['"Cloud Agents require data storage to function."', '"云端智能体需要数据存储才能运行。"'],
        ['"Privacy Mode Enabled"', '"隐私模式已启用"'],
        ['"Cloud Agents are not available when your privacy mode is set to disable data storage. To use Cloud Agents, please update your privacy settings to allow data storage."', '"当隐私模式设置为禁用数据存储时，云端智能体不可用。要使用云端智能体，请更新隐私设置以允许数据存储。"'],
        ['"Open Privacy Settings"', '"打开隐私设置"'],
        ['title:"Get Started"', 'title:"开始使用"'],
        ['title:"Open a Git repository"', 'title:"打开 Git 仓库"'],
        ['"Open a folder that contains a Git repository to configure Cloud Agents."', '"打开包含 Git 仓库的文件夹以配置云端智能体。"'],
        ['actionTitle:"Open Folder"', 'actionTitle:"打开文件夹"'],
        ['label:"Manage Settings"', 'label:"管理设置"'],

        // 插件页空状态和插件搜索菜单。
        ['"No Plugins"', '"暂无插件"'],
        ['"Browse the marketplace or import custom plugins to extend Cursor with Skills, Rules, Agents, Hooks, and MCPs."', '"浏览插件市场或导入自定义插件，用技能、规则、智能体、钩子和 MCP 扩展 Cursor。"'],
        ['children:"Browse the marketplace or import custom plugins to extend"', 'children:"浏览插件市场或导入自定义插件来扩展"'],
        ['children:"Cursor with Skills, Rules, Agents, Hooks, and MCPs."', 'children:"Cursor 的技能、规则、智能体、钩子和 MCP。"'],
        ['"Add Plugin"', '"添加插件"'],
        ['"Add Plugins"', '"添加插件"'],
        ['"aria-label":"Add Plugins"', '"aria-label":"添加插件"'],
        ['"Search the marketplace"', '"搜索插件市场"'],
        ['placeholder:"Search the marketplace"', 'placeholder:"搜索插件市场"'],
        ['"Loading plugins..."', '"正在加载插件..."'],
        ['<span>Loading plugins...', '<span>正在加载插件...'],
        ['"No result"', '"无结果"'],
        ['"No Result"', '"无结果"'],
        ['children:"No results"', 'children:"无结果"'],
        ['children:"No results found"', 'children:"未找到结果"'],
        ['children:"No Results"', 'children:"无结果"'],
        ['children:"No Results Found"', 'children:"未找到结果"'],
        ['children:"No files found"', 'children:"未找到文件"'],
        ['children:"No matches found"', 'children:"未找到匹配项"'],
        ['children:"No plugins found"', 'children:"未找到插件"'],
        ['children:"No plugins found in this repository."', 'children:"此仓库中未找到插件。"'],
        ['children:"No plugins match your search."', 'children:"没有插件匹配你的搜索。"'],
        ['children:"All plugins have been added."', 'children:"所有插件均已添加。"'],
        ['children:"All plugins from this repository have already been added."', 'children:"此仓库中的所有插件均已添加。"'],
        ['children:"Add plugins or import from GitHub to make them available for your team."', 'children:"添加插件或从 GitHub 导入，使团队可以使用它们。"'],
        ['"Try changing your search query"', '"请尝试修改搜索条件"'],
        ['children:"Try a different search term or browse by category"', 'children:"请尝试其他搜索词或按分类浏览"'],
        ['children:"Try different filters"', 'children:"请尝试不同筛选条件"'],
        ['"Import Marketplace..."', '"导入插件市场..."'],
        ['"Manage plugins"', '"管理插件"'],
        ['children:"Browse Marketplace"', 'children:"浏览插件市场"'],
        ['title:"Results"', 'title:"结果"'],
        ['title:"Suggested"', 'title:"推荐"'],
        ['title:It?"Results":"Suggested"', 'title:It?"结果":"推荐"'],
        ['children:"Suggested"', 'children:"推荐"'],
        ['<h3 class=cloud-mcp-marketplace-title>Browse MCPs</h3>', '<h3 class=cloud-mcp-marketplace-title>浏览 MCP</h3>'],
        ['placeholder="Search anything"', 'placeholder="搜索任何内容"'],
        ['placeholder:"Search"', 'placeholder:"搜索"'],
        ['placeholder:"Search or Paste Link"', 'placeholder:"搜索或粘贴链接"'],

        // Agent 执行错误弹窗。
        ['"Agent Execution Timed Out"', '"智能体执行超时"'],
        ['"The agent execution provider did not respond in time. This may indicate the extension host is not running or is unresponsive."', '"智能体执行提供程序未及时响应。这可能表示扩展主机未运行或无响应。"'],
        ['"Reload Window"', '"重新加载窗口"'],
        ['label:"Reload Window"', 'label:"重新加载窗口"'],
        ['children:"Reload Window"', 'children:"重新加载窗口"'],
        ['children:"An unexpected error occurred. Reload the window to try again."', 'children:"发生意外错误。请重新加载窗口后重试。"'],
        ['children:"Copy Error"', 'children:"复制错误"'],

        // 常见可见 UI 状态、菜单与按钮。
        ['children:"Rendering diagram..."', 'children:"正在渲染图表..."'],
        ['children:"Mermaid Syntax Error"', 'children:"Mermaid 语法错误"'],
        ['children:"View diagram source"', 'children:"查看图表源码"'],
        ['children:"Open in Terminal Pane"', 'children:"在终端面板中打开"'],
        ['children:"Copy Command"', 'children:"复制命令"'],
        ['children:"Add to Allowlist and Run"', 'children:"添加到白名单并运行"'],
        ['children:"Empty directory"', 'children:"空目录"'],
        ['children:"No diagnostics found"', 'children:"未发现诊断信息"'],
        ['children:"No MCP resources available"', 'children:"暂无可用 MCP 资源"'],
        ['children:"Waiting for upload..."', 'children:"正在等待上传..."'],
        ['children:"This agent was working on "', 'children:"此智能体正在处理 "'],
        ['children:"Don\'t ask again"', 'children:"不再询问"'],
        ['children:"Stay on Current Branch"', 'children:"留在当前分支"'],
        ['children:"Checkout"', 'children:"检出"'],
        ['children:"Agent disconnected"', 'children:"智能体已断开连接"'],
        ['children:"View Report"', 'children:"查看报告"'],
        ['label:"Context Usage"', 'label:"上下文用量"'],
        ['children:"Pasted Link"', 'children:"已粘贴链接"'],
        ['children:"Remote HTTPS"', 'children:"远程 HTTPS"'],
        ['label:"Command"', 'label:"命令"'],
        ['label:"Arguments"', 'label:"参数"'],
        ['label:"Secrets"', 'label:"密钥"'],
        ['label:"Server URL"', 'label:"服务器 URL"'],
        ['label:"HTTP headers"', 'label:"HTTP 请求头"'],
        ['label:"Client ID"', 'label:"客户端 ID"'],
        ['label:"Client Secret"', 'label:"客户端密钥"'],
        ['placeholder:"OAuth Client ID (optional)"', 'placeholder:"OAuth 客户端 ID（可选）"'],
        ['placeholder:"OAuth Client Secret (optional)"', 'placeholder:"OAuth 客户端密钥（可选）"'],
        ['children:"Add MCP Server"', 'children:"添加 MCP 服务器"'],
        ['children:"Clear variables"', 'children:"清除变量"'],
        ['title:"Team Access"', 'title:"团队访问权限"'],
        ['title:"Plugin Settings"', 'title:"插件设置"'],
        ['children:"All Members"', 'children:"所有成员"'],
        ['children:"Marketplace Settings"', 'children:"插件市场设置"'],
        ['label:"Marketplace Access"', 'label:"插件市场访问权限"'],
        ['description:"Select who can see and use plugins from this team marketplace"', 'description:"选择谁可以查看和使用此团队插件市场中的插件"'],
        ['label:"Enable Auto Refresh"', 'label:"启用自动刷新"'],
        ['description:"Automatically update plugins when changes are pushed to the repository"', 'description:"当变更推送到仓库时自动更新插件"'],
        ['label:"Plugin Repository"', 'label:"插件仓库"'],
        ['description:"Fetch marketplace plugins from the GitHub repository"', 'description:"从 GitHub 仓库获取插件市场插件"'],
        ['label:"Remove Marketplace"', 'label:"移除插件市场"'],
        ['title:"Remove marketplace?"', 'title:"移除插件市场？"'],
        ['children:"Delete Marketplace"', 'children:"删除插件市场"'],
        ['title:"Delete marketplace?"', 'title:"删除插件市场？"'],
        ['description:"This marketplace and its access settings will be removed. The source repository won\'t be affected."', 'description:"将移除此插件市场及其访问设置。源仓库不会受到影响。"'],
        ['description:"This marketplace and its access settings will be removed. The repository won\'t be affected."', 'description:"将移除此插件市场及其访问设置。仓库不会受到影响。"'],
        ['description:"This marketplace will be removed from your account. The source repository won\'t be affected."', 'description:"将从你的账号中移除此插件市场。源仓库不会受到影响。"'],
        ['children:"Configure"', 'children:"配置"'],
        ['children:"Remove"', 'children:"移除"'],
        ['children:"Plugin"', 'children:"插件"'],
        ['children:"MCP Server"', 'children:"MCP 服务器"'],
        ['children:"Available Marketplaces"', 'children:"可用插件市场"'],
        ['children:"Access Settings"', 'children:"访问设置"'],
        ['children:"Plugin Installation"', 'children:"插件安装"'],
        ['children:"Default Off"', 'children:"默认关闭"'],
        ['children:"Default On"', 'children:"默认开启"'],
        ['children:"Required"', 'children:"必需"'],
        ['children:"Uninstall"', 'children:"卸载"'],
        ['children:"Add for Myself"', 'children:"为自己添加"'],
        ['children:"Add to Project"', 'children:"添加到项目"'],
        ['children:"Add to Team"', 'children:"添加到团队"'],
        ['children:"Finishing setup\\u2026"', 'children:"正在完成设置..."'],
        ['children:"Imported"', 'children:"已导入"'],
        ['children:"Local"', 'children:"本地"'],
        ['children:"Extension"', 'children:"扩展"'],
        ['title:"Verified"', 'title:"已验证"'],
        ['title:"Open in Editor"', 'title:"在编辑器中打开"'],
        ['title:"Pinned"', 'title:"已固定"'],
        ['title:"Open debug logs"', 'title:"打开调试日志"'],
        ['title:"Previous"', 'title:"上一个"'],
        ['title:"Next"', 'title:"下一个"'],
        ['title:"Scopes"', 'title:"作用域"'],
        ['title:"Restore default parameters"', 'title:"恢复默认参数"'],
        ['title:"Options"', 'title:"选项"'],
        ['title:"Uncommitted Changes"', 'title:"未提交变更"'],
        ['title:"Moving..."', 'title:"正在移动..."'],
        ['title:"Complete"', 'title:"完成"'],
        ['title:"Failed"', 'title:"失败"'],
        ['title:"View plan"', 'title:"查看计划"'],
        ['title:"Mine"', 'title:"我的"'],
        ['title:"Shared"', 'title:"共享"'],
        ['title:"Modes, skills, MCPs and more"', 'title:"模式、技能、MCP 等"'],
        ['title:"Copy Code"', 'title:"复制代码"'],
        ['title:"Download file"', 'title:"下载文件"'],
        ['title:"Download image"', 'title:"下载图片"'],
        ['children:"Open external link?"', 'children:"打开外部链接？"'],
        ['children:"You\'re about to visit an external website."', 'children:"你即将访问外部网站。"'],
        ['children:"Copy link"', 'children:"复制链接"'],
        ['children:"Open link"', 'children:"打开链接"'],
        ['title:"Download diagram"', 'title:"下载图表"'],
        ['title:"Download diagram as SVG"', 'title:"下载 SVG 图表"'],
        ['title:"Download diagram as PNG"', 'title:"下载 PNG 图表"'],
        ['title:"Download diagram as MMD"', 'title:"下载 MMD 图表"'],
        ['title:"View fullscreen"', 'title:"全屏查看"'],
        ['title:"Exit fullscreen"', 'title:"退出全屏"'],
        ['title:"Copy table"', 'title:"复制表格"'],
        ['title:"Copy table as CSV"', 'title:"复制为 CSV 表格"'],
        ['title:"Copy table as TSV"', 'title:"复制为 TSV 表格"'],
        ['title:"Download table"', 'title:"下载表格"'],
        ['title:"Download table as CSV"', 'title:"下载 CSV 表格"'],
        ['title:"Download table as Markdown"', 'title:"下载 Markdown 表格"'],
        ['title:"Zoom in"', 'title:"放大"'],
        ['title:"Zoom out"', 'title:"缩小"'],
        ['title:"Reset zoom and pan"', 'title:"重置缩放和平移"'],
        ['children:"Loading diagram..."', 'children:"正在加载图表..."'],
        ['children:"Show Code"', 'children:"显示代码"'],
        ['currentLabel:"Run History"', 'currentLabel:"运行历史"'],
        ['breadcrumbLabel:"Run History"', 'breadcrumbLabel:"运行历史"'],
        ['title:"Run History"', 'title:"运行历史"'],
        ['children:["Run History"," "', 'children:["运行历史"," "'],
        ['children:"No Runs Yet"', 'children:"暂无运行记录"'],
        ['children:"No Automations Yet"', 'children:"暂无自动化"'],
        ['children:"New Automation"', 'children:"新建自动化"'],
        ['children:"Run agents on a schedule or automatically in response to events. Billed at plan rates."', 'children:"按计划运行智能体，或响应事件自动运行。按套餐费率计费。"'],

        // 第三轮扫描发现的常见界面文案。
        ['<div>No results found.', '<div>未找到结果。'],
        ['emptyStateText:"No results found"', 'emptyStateText:"未找到结果"'],
        ['children:"No results found."', 'children:"未找到结果。"'],
        ['placeholder:"Search channels or paste channel ID..."', 'placeholder:"搜索频道或粘贴频道 ID..."'],
        ['children:"Loading channels..."', 'children:"正在加载频道..."'],
        ['"No channels available"', '"暂无可用频道"'],
        ['"No results for \\""', '"没有结果匹配 \\""'],
        ['children:["Add channel ID "', 'children:["添加频道 ID "'],
        ['"Any channel"', '"任意频道"'],
        ['title:"Selected"', 'title:"已选择"'],
        ['title:"Manage Marketplace"', 'title:"管理插件市场"'],
        ['title:"Date range"', 'title:"日期范围"'],
        ['title:"Rows per page"', 'title:"每页行数"'],
        ['placeholder:"Search Plugins, Skills, Tools, Subagents, Commands..."', 'placeholder:"搜索插件、技能、工具、子智能体、命令..."'],
        ['title:"All Marketplaces"', 'title:"所有插件市场"'],
        ['title:"Debug Logs"', 'title:"调试日志"'],
        ['children:"Waiting for log entries..."', 'children:"正在等待日志条目..."'],
        ['children:"Clear Logs"', 'children:"清空日志"'],
        ['label:"Reproduction Steps"', 'label:"复现步骤"'],
        ['children:"Mark Fixed"', 'children:"标记为已修复"'],
        ['children:"Load Diff"', 'children:"加载差异"'],
        ['children:"Generated files are not rendered by default."', 'children:"默认不渲染生成文件。"'],
        ['children:"Large diffs are hidden by default."', 'children:"默认隐藏大型差异。"'],
        ['children:"Diff content not available"', 'children:"差异内容不可用"'],
        ['children:"This file changed, but a text diff could not be rendered."', 'children:"此文件已更改，但无法渲染文本差异。"'],
        ['label:"Agent blocked"', 'label:"智能体已被阻止"'],
        ['label:"Up to date"', 'label:"已是最新"'],
        ['label:"Ready to save"', 'label:"准备保存"'],
        ['label:"Setting up"', 'label:"正在设置"'],
        ['placeholder:"Anything else?"', 'placeholder:"还有其他问题吗？"'],
        ['children:"Add Models"', 'children:"添加模型"'],
        ['children:"Your admin has disabled this option."', 'children:"你的管理员已禁用此选项。"'],
        ['children:"Show all models..."', 'children:"显示所有模型..."'],
        ['label:"MAX Mode"', 'label:"MAX 模式"'],
        ['children:"MAX MODE"', 'children:"MAX 模式"'],
        ['label:"Use Multiple Models"', 'label:"使用多个模型"'],
        ['children:"Enable MAX Mode"', 'children:"启用 MAX 模式"'],
        ['placeholder:"Search models"', 'placeholder:"搜索模型"'],
        ['children:"No models found"', 'children:"未找到模型"'],
        ['label:"Move to Local"', 'label:"移动到本地"'],
        ['children:"Move to Local"', 'children:"移动到本地"'],
        ['label:"Checkout branch locally"', 'label:"在本地检出分支"'],
        ['label:"Checkout & Move to Local"', 'label:"检出并移动到本地"'],
        ['tooltip:"Checkout branch and convert agent to local mode"', 'tooltip:"检出分支并将智能体转换为本地模式"'],
        ['description:"You have uncommitted changes in your working tree. Choose an option, then continue."', 'description:"你的工作树中有未提交的更改。请选择一个选项，然后继续。"'],
        ['children:"Do not ask me again"', 'children:"不再询问我"'],
        ['children:"Paste as one line"', 'children:"粘贴为一行"'],
        ['children:"Add an agent to get started"', 'children:"添加一个智能体以开始使用"'],
        ['placeholder:"Todo description..."', 'placeholder:"待办描述..."'],
        ['children:"Build in New Agent"', 'children:"在新智能体中构建"'],
        ['children:"Add a to-do to get started"', 'children:"添加一个待办以开始使用"'],
        ['label:"Add to Chat"', 'label:"添加到聊天"'],
        ['placeholder:"Plan body..."', 'placeholder:"计划正文..."'],
        ['children:"Save to workspace"', 'children:"保存到工作区"'],
        ['children:"Build in Parallel"', 'children:"并行构建"'],
        ['children:"Copy as Markdown"', 'children:"复制为 Markdown"'],
        ['children:"Find in Plan"', 'children:"在计划中查找"'],
        ['children:"Save to Workspace"', 'children:"保存到工作区"'],
        ['children:"View Plan"', 'children:"查看计划"'],
        ['children:"Error loading plugin"', 'children:"加载插件出错"'],
        ['children:"Try in Chat"', 'children:"在聊天中试用"'],
        ['children:"Import from GitHub"', 'children:"从 GitHub 导入"'],
        ['placeholder:"Enter a GitHub repository URL containing a plugin marketplace"', 'placeholder:"输入包含插件市场的 GitHub 仓库 URL"'],
        ['label:"GitHub Repository URL"', 'label:"GitHub 仓库 URL"'],
        ['children:"Open in Chat"', 'children:"在聊天中打开"'],
        ['children:"View Details"', 'children:"查看详情"'],
        ['children:"Remove from Cursor"', 'children:"从 Cursor 中移除"'],
        ['label:"All files and folders"', 'label:"所有文件和文件夹"'],
        ['children:"Add Skills"', 'children:"添加技能"'],
        ['placeholder:"Search MCP servers..."', 'placeholder:"搜索 MCP 服务器..."'],
        ['children:"Loading MCP servers..."', 'children:"正在加载 MCP 服务器..."'],
        ['label:"No MCP servers"', 'label:"暂无 MCP 服务器"'],
        ['children:"No MCP servers available"', 'children:"暂无可用 MCP 服务器"'],
        ['children:"No MCP servers configured"', 'children:"未配置 MCP 服务器"'],
        ['"No servers match your search"', '"没有服务器匹配你的搜索"'],
        ['children:"Open MCP Settings"', 'children:"打开 MCP 设置"'],
        ['placeholder:"Add agents, context, tools..."', 'placeholder:"添加智能体、上下文、工具..."'],
        ['children:"Loading skills..."', 'children:"正在加载技能..."'],
        ['children:"No skills available"', 'children:"暂无可用技能"'],
        ['children:"Waiting for logs"', 'children:"正在等待日志"'],
        ['placeholder:"SSH Hostname"', 'placeholder:"SSH 主机名"'],
        ['children:"Type in a host like user@host or select from SSH config"', 'children:"输入 user@host 形式的主机，或从 SSH 配置中选择"'],
        ['children:"Rename tab"', 'children:"重命名标签页"'],
        ['children:"Close Others"', 'children:"关闭其他标签页"'],
        ['children:"Close to the Right"', 'children:"关闭右侧标签页"'],
        ['children:"Close All"', 'children:"全部关闭"'],
        ['label:"Commit changes"', 'label:"提交更改"'],
        ['description:"Create a checkpoint commit with your current changes"', 'description:"使用当前更改创建检查点提交"'],
        ['label:"Stash changes"', 'label:"暂存更改"'],
        ['description:"Save your changes to a stash and restore them later"', 'description:"将更改保存到 stash，稍后可恢复"'],
        ['label:"Discard changes"', 'label:"放弃更改"'],
        ['description:"Delete your current uncommitted changes before switching"', 'description:"切换前删除当前未提交的更改"'],
        ['description:"Temporarily save uncommitted work, then check out the cloud agent branch."', 'description:"临时保存未提交的工作，然后检出云端智能体分支。"'],
        ['description:"Create a checkpoint commit of your changes, then check out the branch."', 'description:"为你的更改创建检查点提交，然后检出该分支。"'],
        ['label:"Hidden from agent"', 'label:"对智能体隐藏"'],
        ['label:"Leak scanned before commit"', 'label:"提交前已扫描泄漏"'],
        ['label:"Available at runtime"', 'label:"运行时可用"'],
        ['label:"Available at build"', 'label:"构建时可用"'],
        ['children:"No files"', 'children:"无文件"'],
        ['label:"Most Used"', 'label:"最常用"'],
        ['"glass.agentMigrationService.failed.title","Failed to migrate agent"', '"glass.agentMigrationService.failed.title","迁移智能体失败"'],
        ['"glass.agentMigrationService.failed.copyError","Copy Error"', '"glass.agentMigrationService.failed.copyError","复制错误"'],

        // 模式、提及菜单和快捷动作。
        ['label:"Change run mode"', 'label:"更改运行模式"'],
        ['label:"Add to allowlist"', 'label:"添加到白名单"'],
        ['label:"MCP Servers"', 'label:"MCP 服务器"'],
        ['children:"MCP Servers"', 'children:"MCP 服务器"'],
        ['"aria-label":"MCP Servers"', '"aria-label":"MCP 服务器"'],
        ['title:"Cloud MCP Servers"', 'title:"云端 MCP 服务器"'],
        ['title:"User MCP Servers"', 'title:"用户 MCP 服务器"'],
        ['title:"Team MCP Servers"', 'title:"团队 MCP 服务器"'],
        ['title:"Home MCP Servers"', 'title:"Home MCP 服务器"'],
        ['title:"Sign In to View Cloud MCP Servers"', 'title:"登录以查看云端 MCP 服务器"'],
        ['title:"Could Not Load Cloud MCP Servers"', 'title:"无法加载云端 MCP 服务器"'],
        ['title:"No User MCP Servers"', 'title:"暂无用户 MCP 服务器"'],
        ['title:"No Team MCP Servers"', 'title:"暂无团队 MCP 服务器"'],
        ['description:"Servers available to cloud agents."', 'description:"可供云端智能体使用的服务器。"'],
        ['description:"Servers available in this workspace."', 'description:"此工作区可用的服务器。"'],
        ['description:"Servers available from Home."', 'description:"Home 中可用的服务器。"'],
        ['description:"Your personal cloud MCP servers."', 'description:"你的个人云端 MCP 服务器。"'],
        ['description:"Cloud MCP servers shared by your team."', 'description:"团队共享的云端 MCP 服务器。"'],
        ['description:"Add a personal cloud MCP server to make it available to your cloud agents."', 'description:"添加个人云端 MCP 服务器，使云端智能体可以使用它。"'],
        ['description:"Team admins can configure shared MCP servers in the dashboard."', 'description:"团队管理员可在控制台配置共享 MCP 服务器。"'],
        ['message:"Loading cloud MCP servers..."', 'message:"正在加载云端 MCP 服务器..."'],
        ['message:"Loading user MCP servers..."', 'message:"正在加载用户 MCP 服务器..."'],
        ['message:"Loading team MCP servers..."', 'message:"正在加载团队 MCP 服务器..."'],
        ['message:"Loading workspace MCP servers..."', 'message:"正在加载工作区 MCP 服务器..."'],
        ['"Failed to load cloud MCP servers."', '"加载云端 MCP 服务器失败。"'],
        ['"Failed to load workspace MCP servers."', '"加载工作区 MCP 服务器失败。"'],
        ['children:"Open Dashboard"', 'children:"打开控制台"'],
        ['actionTitle:"Add MCP"', 'actionTitle:"添加 MCP"'],
        ['children:"Add MCP"', 'children:"添加 MCP"'],
        ['`Workspace"} MCP Servers`', '`Workspace"} MCP 服务器`'],
        ['`Workspace"} MCP Tools`', '`Workspace"} MCP 工具`'],
        ['"aria-label":"Mermaid Diagram"', '"aria-label":"Mermaid 图表"'],
        ['<span class=context-pill-warning-text>Tree outline', '<span class=context-pill-warning-text>树形大纲'],
        ['children:"Tree outline"', 'children:"树形大纲"'],

        // Rules / Skills / Subagents / Commands 二级菜单空状态与表单。
        ['title:"Rules"', 'title:"规则"'],
        ['helpTooltipLabel:"Learn about Rules"', 'helpTooltipLabel:"了解规则"'],
        ['description:"Use Rules to guide agent behavior, like enforcing best practices or coding standards. Rules can be applied always, by file path, or manually."', 'description:"使用规则引导智能体行为，例如强制执行最佳实践或编码标准。规则可以始终应用、按文件路径应用或手动应用。"'],
        ['title:"No Rules Yet"', 'title:"暂无规则"'],
        ['description:"Create rules to guide Agent behavior"', 'description:"创建规则来引导智能体行为"'],
        ['actionTitle:"New User Rule"', 'actionTitle:"新建用户规则"'],
        ['actionTitle:"New Project Rule"', 'actionTitle:"新建项目规则"'],
        ['title:"Could Not Load Rules"', 'title:"无法加载规则"'],
        ['"Failed to load workspace rules."', '"加载工作区规则失败。"'],
        ['<div>Loading Rules...', '<div>正在加载规则...'],
        ['placeholder="Rule content..."', 'placeholder="规则内容..."'],
        ['placeholder="Style request, response language, tone..."', 'placeholder="风格要求、回复语言、语气..."'],
        ['"[Untitled]"', '"[未命名]"'],
        ['"User Generated Memory"', '"用户生成记忆"'],
        ['"Applied intelligently"', '"智能应用"'],
        ['"Content is required."', '"内容不能为空。"'],
        ['"File pattern is required when applying to specific files."', '"应用到指定文件时必须填写文件模式。"'],
        ['"Failed to save changes. Please try again."', '"保存失败，请重试。"'],
        ['"Incorrect format, <span>fix with agent"', '"格式不正确，<span>使用智能体修复"'],
        ['title:"Delete Rule"', 'title:"删除规则"'],
        ['deleteDisabledTooltip:"Cannot delete team rules"', 'deleteDisabledTooltip:"无法删除团队规则"'],
        ['<button class=show-all-rules-button>Show all (<!> more)', '<button class=show-all-rules-button>显示全部（<!> 个更多）'],
        ['<button class=show-all-rules-button>Show less', '<button class=show-all-rules-button>收起'],
        ['children:"New"', 'children:"新建"'],
        ['children:"Done"', 'children:"完成"'],
        ['children:"Save"', 'children:"保存"'],
        ['"Done"', '"完成"'],
        ['"Save"', '"保存"'],
        ['title:"Could Not Load Skills"', 'title:"无法加载技能"'],
        ['"Failed to load workspace skills."', '"加载工作区技能失败。"'],
        ['<div>Loading Skills...', '<div>正在加载技能...'],
        ['title:"Could Not Load Subagents"', 'title:"无法加载子智能体"'],
        ['"Failed to load workspace subagents."', '"加载工作区子智能体失败。"'],
        ['<div>Loading Subagents...', '<div>正在加载子智能体...'],
        ['title:"Could Not Load Commands"', 'title:"无法加载命令"'],
        ['"Failed to load workspace commands."', '"加载工作区命令失败。"'],
        ['<div>Loading Commands...', '<div>正在加载命令...'],
        ['label:"Always applied"', 'label:"始终应用"'],
        ['label:"Agent decides when to apply"', 'label:"由智能体决定何时应用"'],
        ['label:"Apply to Specific Files & Folders"', 'label:"应用到指定文件和文件夹"'],
        ['"Always applied"', '"始终应用"'],
        ['"Agent decides when to apply"', '"由智能体决定何时应用"'],
        ['"Apply to Specific Files & Folders"', '"应用到指定文件和文件夹"'],
        ['children:"Create with Agent"', 'children:"使用智能体创建"'],
        ['"Saving..."', '"正在保存..."'],
        ['placeholder:"Plan and design before coding..."', 'placeholder:"编码前先规划和设计..."'],
        ['description:"Plan and design before coding"', 'description:"编码前先规划和设计"'],
        ['placeholder:"Debug and troubleshoot issues..."', 'placeholder:"调试并排查问题..."'],
        ['description:"Debug and troubleshoot issues"', 'description:"调试并排查问题"'],
        ['placeholder:"Ask questions without making changes..."', 'placeholder:"提问但不修改..."'],
        ['description:"Ask questions without making changes"', 'description:"提问但不修改"'],
        ['"Ask questions without making changes..."', '"提问但不修改..."'],
        ["'Ask questions without making changes...'", "'提问但不修改...'"],
        ['`Ask questions without making changes...`', '`提问但不修改...`'],
        ['title:"Ask questions without making changes..."', 'title:"提问但不修改..."'],
        ['children:"Ask questions without making changes..."', 'children:"提问但不修改..."'],
        ['label:"Local"', 'label:"本地"'],
        ['title:"Local"', 'title:"本地"'],
        ['children:"Local"', 'children:"本地"'],
        ['currentLabel:"Local"', 'currentLabel:"本地"'],
        ['breadcrumbLabel:"Local"', 'breadcrumbLabel:"本地"'],
        ['"aria-label":"Local"', '"aria-label":"本地"'],
        ['label:"Cursor Local"', 'label:"Cursor 本地"'],
        ['title:"Cursor Local"', 'title:"Cursor 本地"'],
        ['children:"Cursor Local"', 'children:"Cursor 本地"'],
        ['"Cursor Local"', '"Cursor 本地"'],
        ["'Cursor Local'", "'Cursor 本地'"],
        ['`Cursor Local`', '`Cursor 本地`'],
        ['label:"Ultra Plan"', 'label:"Ultra 套餐"'],
        ['title:"Ultra Plan"', 'title:"Ultra 套餐"'],
        ['children:"Ultra Plan"', 'children:"Ultra 套餐"'],
        ['"Ultra Plan"', '"Ultra 套餐"'],
        ["'Ultra Plan'", "'Ultra 套餐'"],
        ['`Ultra Plan`', '`Ultra 套餐`'],
        ['return"Mentions"', 'return"提及项"'],
        ['return"Files & Folders"', 'return"文件和文件夹"'],
        ['return"Agent Stores"', 'return"智能体存储"'],
        ['return"Terminals"', 'return"终端"'],
        ['return"Past Chats"', 'return"历史聊天"'],
        ['return"Branch (Diff with Main)"', 'return"分支（与 Main 对比）"'],
        ['label:"Grep Search"', 'label:"Grep 搜索"'],
        ['label:"Search files"', 'label:"搜索文件"'],
        ['"Searching files"', '"正在搜索文件"'],
        ['"Searched files"', '"已搜索文件"'],
        ['"Search files attempted"', '"已尝试搜索文件"'],
        ['"Search files..."', '"搜索文件..."'],
        ['"Search actions..."', '"搜索操作..."'],
        ['"Search agents..."', '"搜索智能体..."'],
        ['"Search files, actions, agents..."', '"搜索文件、操作、智能体..."'],
        ['children:Q?"Files":Z?"Agents":"Actions"', 'children:Q?"文件":Z?"智能体":"操作"'],
        ['description:"Files in workspace"', 'description:"工作区文件"'],
        ['label:"Edit & Reapply"', 'label:"编辑并重新应用"'],
        ['label:"Delete file"', 'label:"删除文件"'],
        ['"Delete file with unsaved changes?"', '"删除包含未保存更改的文件？"'],

        // 自动运行、安全确认和连接错误。
        ['title:"Enable Run Everything?"', 'title:"启用“运行所有”？"'],
        ['label:"Enable Run Everything"', 'label:"启用运行所有"'],
        ['title:"Leave Ask Every Time?"', 'title:"离开“每次询问”？"'],
        ['label:"Use Sandbox instead"', 'label:"改用沙盒"'],
        ['label:"Use Allowlist instead"', 'label:"改用白名单"'],
        ['label:"Continue"', 'label:"继续"'],
        ['title:"Unsupported Model"', 'title:"不支持的模型"'],
        ['title:"Connection stalled"', 'title:"连接停滞"'],
        ['title:"Connection failed"', 'title:"连接失败"'],
        ['"Connection stalled repeatedly"', '"连接反复停滞"'],
        ['"Connection failed repeatedly"', '"连接反复失败"'],
        ['detail:"The connection stalled. Please try again."', 'detail:"连接停滞。请重试。"'],
        ['"Connection failed. Please try again, or contact support if the issue persists."', '"连接失败。请重试；如果问题持续存在，请联系支持。"'],
        ['detail:"Connection failed. If the problem persists, please check your internet connection or VPN"', 'detail:"连接失败。如果问题持续存在，请检查你的网络连接或 VPN"'],

        // 斜杠菜单动作。
        ['name:"Reset"', 'name:"重置"'],
        ['description:"Clear the conversation and start fresh"', 'description:"清空对话并重新开始"'],
        ['name:"Summarize"', 'name:"总结"'],
        ['description:"Summarize the conversation"', 'description:"总结对话"'],
        ['description:"Request an agent to review your code"', 'description:"请求智能体审查你的代码"'],
        ['name:"Open Browser"', 'name:"打开浏览器"'],
        ['description:"Open a browser for web interactions"', 'description:"打开浏览器进行网页交互"'],
        ['description:"Install a plugin from the marketplace"', 'description:"从插件市场安装插件"'],
        ['children:"Browse and install plugins from the Cursor marketplace. Type a search query after the command to find plugins."', 'children:"从 Cursor 插件市场浏览并安装插件。在命令后输入搜索词以查找插件。"'],
        ['description:"Uninstall an installed plugin"', 'description:"卸载已安装插件"'],
        ['children:"Remove an installed plugin. Type a search query after the command to find plugins to uninstall."', 'children:"移除已安装插件。在命令后输入搜索词以查找要卸载的插件。"'],

        ['get title(){return`Configured Hooks (${D()})`}', 'get title(){return`已配置的钩子 (${D()})`}'],
        ['get title(){return`Configured Hooks (${I()})`}', 'get title(){return`已配置的钩子 (${I()})`}'],
        ['get title(){return`Configured Hooks (${A()})`}', 'get title(){return`已配置的钩子 (${A()})`}'],
        ['label:"Configured Hooks"', 'label:"已配置的钩子"'],
        ['label:"Execution Log"', 'label:"执行日志"'],
        ['description:"Add a hooks.json file to your user, project, or enterprise config to start running custom scripts."', 'description:"在用户、项目或企业配置中添加 hooks.json 文件，即可开始运行自定义脚本。"'],
        ['helpTooltipLabel:"Learn about Hooks"', 'helpTooltipLabel:"了解钩子"'],
        ['title:"Configuration Errors"', 'title:"配置错误"'],
        ['children:"Open user config"', 'children:"打开用户配置"'],
        ['children:"Open project config"', 'children:"打开项目配置"'],
        ['children:"Open enterprise config"', 'children:"打开企业配置"'],
        ['children:"Open JSON"', 'children:"打开 JSON"'],
        ['"<span class=cursor-settings-new-badge>NEW"', '"<span class=cursor-settings-new-badge>新"'],
        ['"<div>New project"', '"<div>新建项目"'],
        ['"<div>Open project"', '"<div>打开项目"'],
        ['"<div>Clone repo"', '"<div>克隆仓库"'],
        ['"<div>Connect via SSH"', '"<div>通过 SSH 连接"'],
        ['"<div>New Window"', '"<div>新窗口"'],
        ['"<span>Recent projects"', '"<span>最近项目"'],
        ['"<div class=empty-screen-view-all>View all (<!>)"', '"<div class=empty-screen-view-all>查看全部 (<!>)"'],
        ['`Open project: ${n.projectName}`', '`打开项目：${n.projectName}`'],
        ['"Connect via WSL"', '"通过 WSL 连接"'],
        ['"Connect via SSH"', '"通过 SSH 连接"'],
        ['title:"PR Preferences"', 'title:"PR 偏好设置"'],
        ['label:"Preferred PR destination"', 'label:"首选 PR 打开位置"'],
        ['qbE="Choose where PR links open across web, the desktop app and IDE."', 'qbE="选择 PR 链接在网页、桌面应用和 IDE 中的打开位置。"'],
        ['title:"Pull Requests"', 'title:"拉取请求"'],
        ['label:"Review Provider"', 'label:"评审提供方"'],
        ['label:"PR Link Destination"', 'label:"PR 链接打开位置"'],
        ['"Open pull request links inside Cursor or in the default browser"', '"在 Cursor 内或默认浏览器中打开拉取请求链接"'],
        ['return`Choose ${D40(n)} for pull request links on web and desktop`', 'return`选择 ${D40(n)} 作为网页和桌面端 PR 链接打开方式`'],
        ['`${e[0]} or ${e[1]}`', '`${e[0]} 或 ${e[1]}`'],
        ['`${e.slice(0,-1).join(", ")}, or ${e[e.length-1]}`', '`${e.slice(0,-1).join("、")}，或 ${e[e.length-1]}`'],
        ['return n==="externalBrowser"?"Default browser":"Inside Cursor"', 'return n==="externalBrowser"?"默认浏览器":"Cursor 内打开"'],
        ['{id:"inApp",label:"Inside Cursor"},{id:"externalBrowser",label:"Default browser"}', '{id:"inApp",label:"Cursor 内打开"},{id:"externalBrowser",label:"默认浏览器"}'],
        ['label:"Team default"', 'label:"团队默认值"'],
        ['"Open chat as editor tabs is unavailable while non-chat content is placed in the Secondary Side Bar."', '"当辅助侧边栏中放置了非聊天内容时，无法以编辑器标签页打开聊天。"'],
        ['label:"Open chat as editor tabs"', 'label:"以编辑器标签页打开聊天"'],
        ['description:"Show chats as editor tabs inside the chat area instead of the legacy stacked view"', 'description:"在聊天区域内以编辑器标签页显示聊天，而不是旧版堆叠视图"'],
        ['label:"Ignored Files"', 'label:"忽略的文件"'],
        ['description:"Glob patterns for files where Cursor Tab will not suggest"', 'description:"Cursor Tab 不提供建议的文件 Glob 匹配模式"'],
        ['placeholder:"e.g., *.md, **/generated/**"', 'placeholder:"例如：*.md, **/generated/**"'],
        ['title:"Configure Ignored Files"', 'title:"配置忽略文件"'],
        ['<p class=cursor-settings-cell-label>Window Layout</p>', '<p class=cursor-settings-cell-label>窗口布局</p>'],
        ['<div class=cursor-settings-cell-description>Switch between Agent and Editor default layouts</div>', '<div class=cursor-settings-cell-description>在智能体和编辑器默认布局之间切换</div>'],
        ['aria-label="Window Layout"', 'aria-label="窗口布局"'],
        ['<span class=layout-picker-segmented__label>Agent</span>', '<span class=layout-picker-segmented__label>智能体</span>'],
        ['<span class=layout-picker-segmented__label>Editor</span>', '<span class=layout-picker-segmented__label>编辑器</span>'],
        ['{id:"agent",label:"Agent"},{id:"editor",label:"Editor"}', '{id:"agent",label:"智能体"},{id:"editor",label:"编辑器"}'],
        ['label:"Open Agents Window on startup"', 'label:"启动时打开 Agents Window"'],
        ['description:"When launching Cursor, open Agents Window by default"', 'description:"启动 Cursor 时默认打开 Agents Window"'],
        ['label:"Open Agents Window on Startup"', 'label:"启动时打开 Agents Window"'],
        ['description:"Open the Agents Window by default when Cursor launches"', 'description:"Cursor 启动时默认打开 Agents Window"'],
        ['label:"Code Block Word Wrap"', 'label:"代码块自动换行"'],
        ['description:"Wrap long lines in Agent conversation code blocks"', 'description:"在智能体对话代码块中自动换行长行"'],
        ['label:"Voice Submit Keywords"', 'label:"语音提交关键词"'],
        ['description:"Custom words that submit a voice prompt. Spaces and punctuation are ignored."', 'description:"用于提交语音提示的自定义词。会忽略空格和标点。"'],
        ['label:"Explore Subagent Model"', 'label:"探索子智能体模型"'],
        ['description:"Choose the model used by the Explore subagent for initial research"', 'description:"选择探索子智能体进行初始研究时使用的模型"'],
        ['description:"Choose the model used by Explore subagent for initial research"', 'description:"选择探索子智能体进行初始研究时使用的模型"'],
        ['label:"Deployment Name"', 'label:"部署名称"'],
        ['placeholder:"AWS Access Key ID"', 'placeholder:"AWS 访问密钥 ID"'],
        ['placeholder:"AWS Secret Access Key"', 'placeholder:"AWS 秘密访问密钥"'],
        ['label:"Access Key ID"', 'label:"访问密钥 ID"'],
        ['label:"Secret Access Key"', 'label:"秘密访问密钥"'],
        ['label:"Region"', 'label:"区域"'],
        ['label:"Test Model"', 'label:"测试模型"'],
        ['"Configure AWS Bedrock to use Anthropic Claude models through your AWS account."', '"配置 AWS Bedrock，通过你的 AWS 账号使用 Anthropic Claude 模型。"'],
        ['"Cursor Enterprise teams can configure IAM roles to access Bedrock without any Access Keys."', '"Cursor 企业团队可以配置 IAM 角色，无需访问密钥即可访问 Bedrock。"'],
        ['"Your team has configured AWS Bedrock access. You can use your teams Bedrock instance without any additional configuration."', '"你的团队已配置 AWS Bedrock 访问权限。无需额外配置即可使用团队的 Bedrock 实例。"'],
        ['title:"Ignore Files"', 'title:"忽略文件"'],
        ['label:"Hierarchical Cursor Ignore"', 'label:"分层 Cursor 忽略"'],
        ['label:"Ignore Symlinks in Cursor Ignore Search"', 'label:"在 Cursor 忽略搜索中忽略符号链接"'],
        ['return`Apply .cursorignore files to all subdirectories${n()?" (controlled by admin)":""}. Changing this setting requires restarting Cursor.`', 'return`将 .cursorignore 文件应用到所有子目录${n()?"（由管理员控制）":""}。更改此设置需要重启 Cursor。`'],
        ['return`Use with caution. Skip symlinks during .cursorignore file discovery. Enable only when all .cursorignore files are reachable without symlinks${i()?" (controlled by admin)":""}. Changing this setting requires restarting Cursor.`', 'return`谨慎使用。在查找 .cursorignore 文件时跳过符号链接。仅当无需符号链接即可访问所有 .cursorignore 文件时才启用${i()?"（由管理员控制）":""}。更改此设置需要重启 Cursor。`'],
        ['label:"Title Bar"', 'label:"标题栏"'],
        ['description:"Show title bar in agent layout"', 'description:"在智能体布局中显示标题栏"'],
        ['description:"Show status bar at the bottom of the window"', 'description:"在窗口底部显示状态栏"'],
        ['label:"Review Control Location"', 'label:"审查控件位置"'],
        ['description:"Show inline diff review controls in top level breadcrumbs or floating island"', 'description:"在顶部面包屑或浮动面板中显示内联差异审查控件"'],
        ['{id:"breadcrumb",label:"Breadcrumb"},{id:"island",label:"Island"}', '{id:"breadcrumb",label:"面包屑"},{id:"island",label:"浮动面板"}'],
        ['<div><div>Share Data</div>', '<div><div>共享数据</div>'],
        ['<div><div>Improve Cursor for everyone', '<div><div>帮助所有人改进 Cursor'],
        ['<div><div>Privacy Mode</div>', '<div><div>隐私模式</div>'],
        ['<div><div>No training. Code may be stored for Background Agent and other features.', '<div><div>不用于训练。代码可能会被存储，以支持后台智能体和其他功能。'],
        ['<div><div>隐私模式（旧版）</div><div>No training and no storage. Background Agent and other features that require code storage will be disabled.', '<div><div>隐私模式（旧版）</div><div>不用于训练，也不存储。后台智能体和其他需要代码存储的功能将被禁用。'],
        ['<span>More Options</span>', '<span>更多选项</span>'],
        ['n.server.enabled?i()&&!s()?"Connecting...":s()&&J?.phase==="needsAuth"?"正在等待回调...":J?.phase==="checking"?s()?"正在交换令牌...":"Checking server status":J?.phase==="needsAuth"?"Needs authentication":J?.phase==="error"?d():"Connected":"Disabled"', 'n.server.enabled?i()&&!s()?"正在连接...":s()&&J?.phase==="needsAuth"?"正在等待回调...":J?.phase==="checking"?s()?"正在交换令牌...":"正在检查服务器状态":J?.phase==="needsAuth"?"需要身份验证":J?.phase==="error"?d():"已连接":"已禁用"'],
        ['name:"Agent",actionId:"composerMode.agent"', 'name:"智能体",actionId:"composerMode.agent"'],
        ['name:"Triage",actionId:"composerMode.triage"', 'name:"分诊",actionId:"composerMode.triage"'],
        ['name:"Spec",actionId:"composerMode.spec"', 'name:"规格",actionId:"composerMode.spec"'],
        ['name:"Project",actionId:"composerMode.project"', 'name:"项目",actionId:"composerMode.project"'],
        ['<span>On-Demand Usage', '<span>按需用量'],
        ['"undo","Undo"', '"undo","撤销"'],
        ['"redo","Redo"', '"redo","重做"'],
        ['"cut","Cut"', '"cut","剪切"'],
        ['"copy","Copy"', '"copy","复制"'],
        ['"paste","Paste"', '"paste","粘贴"'],
        ['"selectAll","Select All"', '"selectAll","全选"'],
        // ── Agents 操作按钮动态文本（Undo/Copy 三元表达式，非 label 属性形式）──
        ['?"Undo Cell":"Undo"', '?"撤销单元格":"撤销"'],
        ['?"Undo Apply":"Undo"', '?"撤销应用":"撤销"'],
        ['?"Undo":"Undo All"', '?"撤销":"全部撤销"'],
        ['?"Undo All":"Undo"', '?"全部撤销":"撤销"'],
        ['?"Undo":"Accept"', '?"撤销":"接受"'],
        ['?"Copy Message":"Copy"', '?"复制消息":"复制"'],
        ['?"Copied":"Copy"', '?"已复制":"复制"'],
        ['reject:"Undo"', 'reject:"撤销"'],
        ['??"Undo"', '??"撤销"'],
        ['return"Undo All"', 'return"全部撤销"'],
        ['"glass.agentMetadataTooltip.copy","Copy"', '"glass.agentMetadataTooltip.copy","复制"'],
        ['"glassFileTreeCopyOp","Copy"', '"glassFileTreeCopyOp","复制"'],
        ['"glassFileTreeMove","Move"', '"glassFileTreeMove","移动"'],
        ['marketplace:"Marketplace"', 'marketplace:"插件市场"'],
        ['?"自定义":"Marketplace"', '?"自定义":"插件市场"'],
        ['% Auto used', '% 自动用量'],
        ['% Auto and', '% 自动用量，'],
        ['% API used', '% API 用量'],
        ['return()=>Ze()?`$${fe(ue()?.used??0)}`:"Disabled"', 'return()=>Ze()?`$${fe(ue()?.used??0)}`:"已禁用"'],
        ['?"Fixed":Q()==="unlimited"?"Unlimited":"Disabled"', '?"固定":Q()==="unlimited"?"无限制":"已禁用"'],
        ['<div><span>Subagents', '<div><span>子智能体'],
        ['<div><div title="Choose Explore subagent model"', '<div><div title="选择探索子智能体模型"'],
        ['<div><div title="Choose 探索子智能体模型"', '<div><div title="选择探索子智能体模型"'],
        ['aria-label="Max Mode required"', 'aria-label="需要 Max 模式"'],
        ['SAS="Subagent model overrides will only be used in Max Mode"', 'SAS="子智能体模型覆盖仅会在 Max 模式中使用"'],
        ['label:"Reset to default"', 'label:"重置为默认值"'],
        ['label:"Disable",labelOutsidePicker:"Disabled"', 'label:"禁用",labelOutsidePicker:"已禁用"'],
        ['label:"Inherit from parent"', 'label:"继承父级设置"'],
        ['label:"Auto-Run in Sandbox"', 'label:"在沙盒中自动运行"'],
        ['label:"Run Everything (Unsandboxed)"', 'label:"运行所有（非沙盒）"'],
        ['title:"Approvals & Execution for commands, MCP and more"', 'title:"命令、MCP 等审批与执行"'],
        ['children:"Approvals & Execution for commands, MCP and more"', 'children:"命令、MCP 等审批与执行"'],
        ['label:"Run Mode"', 'label:"运行模式"'],
        ['title:"Run Mode"', 'title:"运行模式"'],
        ['children:"Run Mode"', 'children:"运行模式"'],
        ['description:"Choose how Agents run tools like command execution, MCP, and file writes."', 'description:"选择智能体如何运行命令执行、MCP 和文件写入等工具。"'],
        ['children:"Commands that are allowlisted will run automatically."', 'children:"列入白名单的命令将自动运行。"'],
        ['label:"Allowlist"', 'label:"白名单"'],
        ['children:"Allowlist"', 'children:"白名单"'],
        ['title:"Learn more"', 'title:"了解更多"'],
        ['children:"Learn more"', 'children:"了解更多"'],
        ['return"Auto-Run in Sandbox"', 'return"在沙盒中自动运行"'],
        ['return"Run Everything (Unsandboxed)"', 'return"运行所有（非沙盒）"'],
        ['return"Ask for permission before running each operation"', 'return"每次操作前请求许可"'],
        ['return"Automatically run operations after you approve them once"', 'return"在您批准一次后自动运行操作"'],
        ['return"Automatically run all operations without asking for permission"', 'return"无需请求许可，自动运行所有操作"'],
        ['return e?"Tools will auto-run in a sandbox if possible, otherwise respect the allowlist or ask for approval"', 'return e?"工具会尽可能在沙盒中自动运行，否则遵循白名单或请求批准"'],
        ['label:"sandbox.json Only"', 'label:"仅 sandbox.json"'],
        ['label:"sandbox.json + Defaults"', 'label:"sandbox.json + 默认值"'],
        ['label:"Allow All"', 'label:"全部允许"'],
        ['return"sandbox.json + Defaults"', 'return"sandbox.json + 默认值"'],
        ['?"Sandboxed network access is disabled by your admin.":"Sandboxed network access is controlled by your admin. You can still edit allowed/denied domains in sandbox.json in your workspace, but admin policy takes precedence."', '?"沙盒网络访问已被管理员禁用。":"沙盒网络访问由管理员控制。您仍可在工作区的 sandbox.json 中编辑允许或拒绝的域名，但管理员策略优先。"'],
        ['label:"Smart Allowlist"', 'label:"智能白名单"'],
        ['description:"Use AI-powered command classification to intelligently match commands against allowlist patterns and suggest sandbox modes"', 'description:"使用 AI 命令分类智能匹配白名单模式并建议沙盒模式"'],
        ['<strong>Deprecated Feature:</strong> The command denylist is often bypassable, providing a false sense of security. Consider using the allowlist approach instead for better security.', '<strong>已弃用功能：</strong>命令拒绝列表经常可被绕过，会造成虚假的安全感。建议改用白名单方式以获得更好的安全性。'],
        ['"aria-label":"Select model count"', '"aria-label":"选择模型数量"'],

        // Agent 运行轨迹和认证错误。
        ['"Thought for "', '"思考了 "'],
        ["'Thought for '", "'思考了 '"],
        ['`Thought for ${', '`思考了 ${'],
        ['"Ran"', '"已运行"'],
        ["'Ran'", "'已运行'"],
        ['`Ran`', '`已运行`'],
        ['"Ran "', '"已运行 "'],
        ["'Ran '", "'已运行 '"],
        ['`Ran ${', '`已运行 ${'],
        ['label:"Ran"', 'label:"已运行"'],
        ['children:"Ran"', 'children:"已运行"'],
        ['"Check recent git history"', '"检查最近 Git 历史"'],
        ["'Check recent git history'", "'检查最近 Git 历史'"],
        ['`Check recent git history`', '`检查最近 Git 历史`'],
        ['label:"Check recent git history"', 'label:"检查最近 Git 历史"'],
        ['children:"Check recent git history"', 'children:"检查最近 Git 历史"'],
        ['"Check current git status"', '"检查当前 Git 状态"'],
        ["'Check current git status'", "'检查当前 Git 状态'"],
        ['`Check current git status`', '`检查当前 Git 状态`'],
        ['label:"Check current git status"', 'label:"检查当前 Git 状态"'],
        ['children:"Check current git status"', 'children:"检查当前 Git 状态"'],

        // Agent 布局侧边栏、窗口菜单和筛选菜单。
        ['"New Agent"', '"新建智能体"'],
        ["'New Agent'", "'新建智能体'"],
        ['`New Agent`', '`新建智能体`'],
        ['name:"New Agent"', 'name:"新建智能体"'],
        ['label:"New Agent"', 'label:"新建智能体"'],
        ['title:"New Agent"', 'title:"新建智能体"'],
        ['children:"New Agent"', 'children:"新建智能体"'],
        ['"aria-label":"New Agent"', '"aria-label":"新建智能体"'],
        ['value:"New Agent"', 'value:"新建智能体"'],
        ['original:"New Agent"', 'original:"新建智能体"'],
        ['title:{value:"New Agent",original:"New Agent"}', 'title:{value:"新建智能体",original:"新建智能体"}'],
        ['"Open New Agent Chat"', '"打开新智能体聊天"'],
        ['original:"Open New Agent Chat"', 'original:"打开新智能体聊天"'],
        ['name:"New Agent",get icon(){return ie(NTe,{name:"agent"', 'name:"新建智能体",get icon(){return ie(NTe,{name:"agent"'],
        ['name:"Automations",get icon(){return ie(NTe,{name:"robot"', 'name:"自动化",get icon(){return ie(NTe,{name:"robot"'],
        ['name:"Customize",get icon(){return ie(NTe,{name:"extensions"', 'name:"插件市场",get icon(){return ie(NTe,{name:"extensions"'],
        ['children:"Open Agents Window"', 'children:"打开 Agents Window"'],
        ['label:"Fork"', 'label:"分叉"'],
        ['label:"Copy"', 'label:"复制"'],
        ['label:"Share"', 'label:"分享"'],
        ['label:"Export"', 'label:"导出"'],
        ['label:"Open in Web"', 'label:"在网页中打开"'],
        ['label:"Open in New Window"', 'label:"在新窗口中打开"'],
        ['label:"Rename"', 'label:"重命名"'],
        ['label:s?"Unpin":"Pin"', 'label:s?"取消固定":"固定"'],
        ['label:ge?"Discard":"Archive"', 'label:ge?"丢弃":"归档"'],
        ['label:"Copy Transcript"', 'label:"复制对话记录"'],
        ['label:"Copy Web Link"', 'label:"复制网页链接"'],
        ['label:"Copy Deep Link"', 'label:"复制深层链接"'],
        ['label:"Copy Branch"', 'label:"复制分支"'],
        ['children:"Open in New Window"', 'children:"在新窗口中打开"'],
        ['children:"Fork"', 'children:"分叉"'],
        ['children:"Copy"', 'children:"复制"'],
        ['children:"Export"', 'children:"导出"'],
        ['children:"Pin"', 'children:"固定"'],
        ['children:"Rename"', 'children:"重命名"'],
        ['children:"Archive"', 'children:"归档"'],
        ['title:Je(4823,"New Agents Window")', 'title:Je(4823,"新建 Agents Window")'],
        ['title:Je(4824,"Developer: New Additional Agents Window")', 'title:Je(4824,"开发者：新建额外 Agents Window")'],
        ['title:Je(4825,"Switch to {0}",xNc)', 'title:Je(4825,"切换到 {0}",xNc)'],
        ['title:Je(4826,"Open or Focus {0}",xNc)', 'title:Je(4826,"打开或聚焦 {0}",xNc)'],
        ['title:Je(4827,"Open or Focus Editor Window")', 'title:Je(4827,"打开或聚焦编辑器窗口")'],
        ['title:Je(4829,"Open Glass and Change to Multitask")', 'title:Je(4829,"打开 Agents Window 并切换到多任务")'],
        ['xNc="Agents Window"', 'xNc="Agents Window"'],
        ['title:{...Je(3659,"New Empty Editor Window")', 'title:{...Je(3659,"新建空编辑器窗口")'],
        ['description:"New Agents Window (Glass)"', 'description:"新建 Agents Window"'],
        ['description:"Switch to Agents Window (Glass)"', 'description:"切换到 Agents Window"'],
        ['description:"Open or Focus Agents Window (Glass)"', 'description:"打开或聚焦 Agents Window"'],
        ['description:"Open or focus the editor (IDE) window from the Agents window."', 'description:"从 Agents Window 打开或聚焦编辑器（IDE）窗口。"'],
        ['description:"Opens or focuses the Glass window, then selects Multitask mode there."', 'description:"打开或聚焦 Agents Window，并在其中选择多任务模式。"'],
        ['"Plan, search, build anything"', '"规划、搜索、构建任何内容"'],
        ["'Plan, search, build anything'", "'规划、搜索、构建任何内容'"],
        ['`Plan, search, build anything`', '`规划、搜索、构建任何内容`'],
        ['placeholder:"Plan, search, build anything"', 'placeholder:"规划、搜索、构建任何内容"'],
        ['title:"Plan, search, build anything"', 'title:"规划、搜索、构建任何内容"'],
        ['"Search Agents..."', '"搜索智能体..."'],
        ["'Search Agents...'", "'搜索智能体...'"],
        ['`Search Agents...`', '`搜索智能体...`'],
        ['"Search Agents\\u2026"', '"搜索智能体\\u2026"'],
        ['"Search Agents…"', '"搜索智能体…"'],
        ['placeholder:"Search Agents..."', 'placeholder:"搜索智能体..."'],
        ['placeholder:"Search Agents\\u2026"', 'placeholder:"搜索智能体\\u2026"'],
        ['placeholder:"Search Agents…"', 'placeholder:"搜索智能体…"'],
        ['"No matching agents"', '"未找到匹配的智能体"'],
        ["'No matching agents'", "'未找到匹配的智能体'"],
        ['`No matching agents`', '`未找到匹配的智能体`'],
        ['children:"No matching agents"', 'children:"未找到匹配的智能体"'],
        ['"Archived"', '"已归档"'],
        ["'Archived'", "'已归档'"],
        ['`Archived`', '`已归档`'],
        ['label:"Archived"', 'label:"已归档"'],
        ['children:"Archived"', 'children:"已归档"'],
        ['title:"Archived"', 'title:"已归档"'],
        ['"aria-label":"Archived"', '"aria-label":"已归档"'],
        ['"Toggle Chat Pane"', '"切换聊天面板"'],
        ['"Maximize Chat"', '"最大化聊天"'],
        ['"Close Tab"', '"关闭标签页"'],
        ['"Close Other Tabs"', '"关闭其他标签页"'],
        ['"Close All Tabs"', '"关闭所有标签页"'],
        ['"Open Tab as Editor"', '"在编辑器中打开标签页"'],
        ['"Export Transcript"', '"导出对话记录"'],
        ['"Copy Request ID"', '"复制请求 ID"'],
        ['"Agent Settings"', '"智能体设置"'],
        ['label:"Toggle Chat Pane"', 'label:"切换聊天面板"'],
        ['label:"Maximize Chat"', 'label:"最大化聊天"'],
        ['label:"Close Tab"', 'label:"关闭标签页"'],
        ['label:"Close Other Tabs"', 'label:"关闭其他标签页"'],
        ['label:"Close All Tabs"', 'label:"关闭所有标签页"'],
        ['label:"Open Tab as Editor"', 'label:"在编辑器中打开标签页"'],
        ['label:"Export Transcript"', 'label:"导出对话记录"'],
        ['label:"Copy Request ID"', 'label:"复制请求 ID"'],
        ['label:"Agent Settings"', 'label:"智能体设置"'],
        ['name:"Search"', 'name:"搜索"'],
        ['label:"Search"', 'label:"搜索"'],
        ['title:"Search"', 'title:"搜索"'],
        ['children:"Search"', 'children:"搜索"'],
        ['"aria-label":"Search"', '"aria-label":"搜索"'],
        ['label:"Automations"', 'label:"自动化"'],
        ['title:"Automations"', 'title:"自动化"'],
        ['children:"Automations"', 'children:"自动化"'],
        ['rootLabel:s,rootHref:o,onRootClick:a,LinkComponent:l}=n;let c;e[0]!==i?(c=i===void 0?[]:i,e[0]=i,e[1]=c):c=e[1];const d=c,m=s===void 0?"Automations"', 'rootLabel:s,rootHref:o,onRootClick:a,LinkComponent:l}=n;let c;e[0]!==i?(c=i===void 0?[]:i,e[0]=i,e[1]=c):c=e[1];const d=c,m=s===void 0?"自动化"'],
        ['label:"Marketplace"', 'label:"插件市场"'],
        ['title:"Marketplace"', 'title:"插件市场"'],
        ['children:"Marketplace"', 'children:"插件市场"'],
        ['"aria-label":"Marketplace"', '"aria-label":"插件市场"'],
        ['"aria-label":"Marketplace scope"', '"aria-label":"插件市场范围"'],
        ['name:Je(9469,"Repositories")', 'name:Je(9469,"代码库")'],
        ['name:ot(9469,"Repositories")', 'name:ot(9469,"代码库")'],
        ['collectionLabel:"Repositories"', 'collectionLabel:"代码库"'],
        ['children:"Repositories"', 'children:"代码库"'],
        ['label:"Repositories"', 'label:"代码库"'],
        ['title:"Repositories"', 'title:"代码库"'],
        ['name:"Repositories"', 'name:"代码库"'],
        ['"aria-label":"Repositories"', '"aria-label":"代码库"'],
        ['children:"Editor Window"', 'children:"编辑器窗口"'],
        ['label:"Editor Window"', 'label:"编辑器窗口"'],
        ['title:"Editor Window"', 'title:"编辑器窗口"'],
        ['name:"Editor Window"', 'name:"编辑器窗口"'],
        ['"aria-label":"Editor Window"', '"aria-label":"编辑器窗口"'],
        ['label:"Open Editor Window"', 'label:"打开编辑器窗口"'],
        ['label:"Split Up"', 'label:"向上拆分"'],
        ['label:"Split Right"', 'label:"向右拆分"'],
        ['label:"Split Down"', 'label:"向下拆分"'],
        ['label:"Split Left"', 'label:"向左拆分"'],
        ['Je(3511,"Split Up")', 'Je(3511,"向上拆分")'],
        ['Je(3512,"Split Down")', 'Je(3512,"向下拆分")'],
        ['Je(3513,"Split Left")', 'Je(3513,"向左拆分")'],
        ['Je(3514,"Split Right")', 'Je(3514,"向右拆分")'],
        ['Je(3515,"Split in Group")', 'Je(3515,"在组内拆分")'],
        ['ot(3511,"Split Up")', 'ot(3511,"向上拆分")'],
        ['ot(3512,"Split Down")', 'ot(3512,"向下拆分")'],
        ['ot(3513,"Split Left")', 'ot(3513,"向左拆分")'],
        ['ot(3514,"Split Right")', 'ot(3514,"向右拆分")'],
        ['ot(3515,"Split in Group")', 'ot(3515,"在组内拆分")'],
        ['label:"Close",onSelect:r,disabled:s', 'label:"关闭",onSelect:r,disabled:s'],
        ['label:"Plan New Idea"', 'label:"规划新想法"'],
        ['title:"Plan New Idea"', 'title:"规划新想法"'],
        ['children:"Plan New Idea"', 'children:"规划新想法"'],
        ['"Plan New Idea"', '"规划新想法"'],
        ["'Plan New Idea'", "'规划新想法'"],
        ['`Plan New Idea`', '`规划新想法`'],
        ['label:"Run in Cloud"', 'label:"在云端运行"'],
        ['"Parallelize Build with Multitask Mode."', '"使用多任务模式并行构建。"'],
        ['"Coordinate parallel tasks..."', '"协调并行任务..."'],
        ['hint:"\\u21E7Tab"', 'hint:"\\u21E7Tab"'],
        ['"aria-label":"Group by options"', '"aria-label":"分组选项"'],
        ['"aria-label":"Sidebar filters"', '"aria-label":"侧边栏筛选器"'],
        ['label:"Group by",rightSection:ue,children:"Group by"', 'label:"分组方式",rightSection:ue,children:"分组方式"'],
        ['"aria-label":"Group by",maxWidth:uE', '"aria-label":"分组方式",maxWidth:uE'],
        ['label:"Display",children:"Display"', 'label:"显示",children:"显示"'],
        ['className:"automations-run-filter__heading",children:"Filter by"', 'className:"automations-run-filter__heading",children:"筛选条件"'],
        ['title:"Filter by",children:[ff,Bh,Dp]', 'title:"筛选条件",children:[ff,Bh,Dp]'],
        ['label:"Status",children:"Status"', 'label:"状态",children:"状态"'],
        ['"aria-label":"Show status filters"', '"aria-label":"显示状态筛选器"'],
        ['children:"Environment"}):null', 'children:"环境"}):null'],
        ['label:"Environment",children:"Environment"', 'label:"环境",children:"环境"'],
        ['"aria-label":"Show environment filters"', '"aria-label":"显示环境筛选器"'],
        ['label:"Source",children:"Source"', 'label:"来源",children:"来源"'],
        ['children:"Mark All as Read"', 'children:"全部标为已读"'],
        ['children:"Archive All"', 'children:"全部归档"'],
        ['?"Confirm":"Archive All"', '?"确认":"全部归档"'],
        ['children:"Remove from Sidebar"', 'children:"从侧边栏移除"'],
        ['"aria-label":"More actions"', '"aria-label":"更多操作"'],
        ['hintText:"More actions"', 'hintText:"更多操作"'],
        ['children:["Click or hold "', 'children:["点击或按住 "'],
        ['" to dictate"', '" 听写"'],
        ['a?.label??"Expand All"', 'a?.label??"全部展开"'],
        ['children:"Expand All"', 'children:"全部展开"'],
        ['children:"Collapse All"', 'children:"全部折叠"'],
        ['{value:"workspace",label:"Workspace",icon:"folder"},{value:"repository",label:"Repository",icon:"folder-library"},{value:"time",label:"Updated",icon:"clock"},{value:"status",label:"Status",icon:"circle-dashed"},{value:"environment",label:"Environment",icon:"server"}', '{value:"workspace",label:"工作区",icon:"folder"},{value:"repository",label:"代码库",icon:"folder-library"},{value:"time",label:"更新时间",icon:"clock"},{value:"status",label:"状态",icon:"circle-dashed"},{value:"environment",label:"环境",icon:"server"}'],
        ['{value:"needs_attention",label:"Needs Attention",icon:"exclamation-circle"},{value:"unread_only",label:"Unread",icon:"bell"},{value:"running",label:"Working",icon:"loading"},{value:"draft",label:"Draft",icon:"circle-dashed"},{value:"done",label:"Done",icon:"check-circle"}', '{value:"needs_attention",label:"需要处理",icon:"exclamation-circle"},{value:"unread_only",label:"未读",icon:"bell"},{value:"running",label:"进行中",icon:"loading"},{value:"draft",label:"草稿",icon:"circle-dashed"},{value:"done",label:"已完成",icon:"check-circle"}'],
        ['{value:"git:draft",label:"PR Draft",icon:"git-pull-request-draft"},{value:"git:open",label:"PR Open",icon:"git-pull-request"},{value:"git:merged",label:"PR Merged",icon:"git-merge"},{value:"git:closed",label:"PR Closed",icon:"git-pull-request-closed"},{value:"git:none",label:"No PR",icon:"slash-circle"}', '{value:"git:draft",label:"PR 草稿",icon:"git-pull-request-draft"},{value:"git:open",label:"PR 已打开",icon:"git-pull-request"},{value:"git:merged",label:"PR 已合并",icon:"git-merge"},{value:"git:closed",label:"PR 已关闭",icon:"git-pull-request-closed"},{value:"git:none",label:"无 PR",icon:"slash-circle"}'],
        ['{value:"workspace",label:"Workspace",icon:"folder"},{value:"branch",label:"Branch",icon:"git-branch"},{value:"updatedAt",label:"Updated",icon:"clock"},{value:"source",label:"Source",icon:"arrow-bracket-to-right"}', '{value:"workspace",label:"工作区",icon:"folder"},{value:"branch",label:"分支",icon:"git-branch"},{value:"updatedAt",label:"更新时间",icon:"clock"},{value:"source",label:"来源",icon:"arrow-bracket-to-right"}'],
        ['"source:desktop":{label:"Desktop",icon:"laptop"}', '"source:desktop":{label:"桌面端",icon:"laptop"}'],
        ['"source:web":{label:"Web",icon:"window"}', '"source:web":{label:"网页端",icon:"window"}'],
        ['"source:mobile":{label:"Mobile",icon:"device-mobile"}', '"source:mobile":{label:"移动端",icon:"device-mobile"}'],
        ['"source:slack":{label:"Slack"}', '"source:slack":{label:"Slack"}'],
        ['"source:linear":{label:"Linear"}', '"source:linear":{label:"Linear"}'],
        ['"source:scm":{label:"GitHub / GitLab",icon:"github"}', '"source:scm":{label:"GitHub / GitLab",icon:"github"}'],
        ['"source:cli":{label:"CLI",icon:"terminal"}', '"source:cli":{label:"命令行",icon:"terminal"}'],
        ['"source:setup":{label:"Setup",icon:"cog"}', '"source:setup":{label:"设置",icon:"cog"}'],
        ['"source:sdk":{label:"SDK",icon:"brackets-curly"}', '"source:sdk":{label:"SDK",icon:"brackets-curly"}'],
        ['"source:automations":{label:"Automations",icon:"robot"}', '"source:automations":{label:"自动化",icon:"robot"}'],
        ['"source:api":{label:"API",icon:"code"}', '"source:api":{label:"API",icon:"code"}'],
        ['"source:bugbot_autofix":{label:"Bugbot",icon:"bugbot"}', '"source:bugbot_autofix":{label:"Bugbot",icon:"bugbot"}'],
        ['"source:qabot_frontend":{label:"Frontend QA",icon:"robot"}', '"source:qabot_frontend":{label:"前端 QA",icon:"robot"}'],
        ['"source:local":{label:"Local",icon:"laptop"}', '"source:local":{label:"本地",icon:"laptop"}'],
        ['{value:"workspace",label:"Group by Workspace",icon:"folder"}', '{value:"workspace",label:"按工作区分组",icon:"folder"}'],
        ['{value:"repository",label:"Group by Repository",icon:"folder-library"}', '{value:"repository",label:"按代码库分组",icon:"folder-library"}'],
        ['{value:"time",label:"Group by Updated",icon:"clock"}', '{value:"time",label:"按更新时间分组",icon:"clock"}'],
        ['{value:"status",label:"Group by Status",icon:"circle-dashed"}', '{value:"status",label:"按状态分组",icon:"circle-dashed"}'],
        ['{value:"environment",label:"Group by Environment",icon:"server"}', '{value:"environment",label:"按环境分组",icon:"server"}'],

        // Agent 运行轨迹摘要：这些词都是高频英文，必须限定在工具状态对象或模板片段里替换。
        ['t??"Planning next moves"', 't??"正在规划下一步"'],
        ['"Planning next moves"', '"正在规划下一步"'],
        ['return{action:"Updating",details:"to-do list"}', 'return{action:"正在更新",details:"待办列表"}'],
        ['{action:"Cleared",details:"to-do list"}', '{action:"已清空",details:"待办列表"}'],
        ['{action:"Checked",details:"to-do list"}', '{action:"已检查",details:"待办列表"}'],
        ['{action:"Started to-do",details:r[0].content}', '{action:"开始待办",details:r[0].content}'],
        ['{action:`Started ${r.length} to-dos`,details:""}', '{action:`开始 ${r.length} 个待办`,details:""}'],
        ['{action:`Completed ${c} of ${e.length}`,details:s[0].content}', '{action:`已完成 ${c}/${e.length}`,details:s[0].content}'],
        ['{action:`Completed ${c} of ${e.length} to-dos`,details:""}', '{action:`已完成 ${c}/${e.length} 个待办`,details:""}'],
        ['{action:"Added to-do",details:o[0].content}', '{action:"新增待办",details:o[0].content}'],
        ['{action:`Added ${o.length} to-dos`,details:""}', '{action:`新增 ${o.length} 个待办`,details:""}'],
        ['{action:"Cancelled to-do",details:a[0].content}', '{action:"已取消待办",details:a[0].content}'],
        ['{action:`Cancelled ${a.length} to-dos`,details:""}', '{action:`已取消 ${a.length} 个待办`,details:""}'],
        ['return{action:"Read",details:""}', 'return{action:"读取",details:""}'],
        ['return{action:"Read",details:"tool output"}', 'return{action:"读取",details:"工具输出"}'],
        ['{action:"Read",details:`${r} L${s.startLine}-${s.endLine}`}', '{action:"读取",details:`${r} 第 ${s.startLine}-${s.endLine} 行`}'],
        ['{action:"Read",details:r}', '{action:"读取",details:r}'],
        ['return{action:"Read Todos",details:""}', 'return{action:"读取待办",details:""}'],
        ['return{action:"Explored",details:"available tools"}', 'return{action:"已探索",details:"可用工具"}'],
        ['return{action:e?"Exploring":"Explored",details:"available tools"}', 'return{action:e?"正在探索":"已探索",details:"可用工具"}'],
        ['getMcpToolsToolCall:{loading:"Exploring tools",completed:"Explored tools",error:"Explore tools"}', 'getMcpToolsToolCall:{loading:"正在探索工具",completed:"已探索工具",error:"探索工具"}'],

        // 新版 Agent Todo 摘要使用 verb 字段，字段名不同但最终展示位置相同。
        ['{verb:"Started to-do",primaryAction:"started",todoContent:i[0].content}', '{verb:"开始待办",primaryAction:"started",todoContent:i[0].content}'],
        ['{verb:`Started ${a} to-dos`,primaryAction:"started"}', '{verb:`开始 ${a} 个待办`,primaryAction:"started"}'],
        ['{verb:`Completed ${h} of ${e.length}`,primaryAction:"completed",todoContent:r[0].content}', '{verb:`已完成 ${h}/${e.length}`,primaryAction:"completed",todoContent:r[0].content}'],
        ['{verb:`Completed ${h} of ${e.length} to-dos`,primaryAction:"completed",todoContent:""}', '{verb:`已完成 ${h}/${e.length} 个待办`,primaryAction:"completed",todoContent:""}'],
        ['{verb:"Added to-do",primaryAction:"created",todoContent:o[0].content}', '{verb:"新增待办",primaryAction:"created",todoContent:o[0].content}'],
        ['{verb:`Added ${m} to-dos`,primaryAction:"created"}', '{verb:`新增 ${m} 个待办`,primaryAction:"created"}'],
        ['{verb:"Cancelled to-do",primaryAction:"cancelled",todoContent:s[0].content}', '{verb:"已取消待办",primaryAction:"cancelled",todoContent:s[0].content}'],
        ['{verb:`Cancelled ${d} to-dos`,primaryAction:"cancelled"}', '{verb:`已取消 ${d} 个待办`,primaryAction:"cancelled"}'],
        ['{verb:"Cleared to-do list"}', '{verb:"已清空待办列表"}'],
        ['{verb:"Checked to-do list"}', '{verb:"已检查待办列表"}'],

        // 新版工具详情格式化路径：只改工具详情返回值，避免误伤文档、日志或协议名。
        ['argument:"to-do list"', 'argument:"待办列表"'],
        ['case Kt.TODO_READ:case Kt.TODO_WRITE:return"to-do list"', 'case Kt.TODO_READ:case Kt.TODO_WRITE:return"待办列表"'],
        ['return"tool output"', 'return"工具输出"'],
        ['?`${r} L${t.startLineOneIndexed}-${t.endLineOneIndexedInclusive}`:r', '?`${r} 第 ${t.startLineOneIndexed}-${t.endLineOneIndexedInclusive} 行`:r'],
        ['?`${r} L${t.offset}-${t.offset+t.limit}`:r', '?`${r} 第 ${t.offset}-${t.offset+t.limit} 行`:r'],
        ['[Kt.READ_FILE_V2]:{label:"Read file",support:"rendered"}', '[Kt.READ_FILE_V2]:{label:"读取文件",support:"rendered"}'],
        ['return{loadingAction:"Editing",completedAction:"Edited",fileCount:e+t}', 'return{loadingAction:"正在编辑",completedAction:"已编辑",fileCount:e+t}'],
        ['return{loadingAction:"Deleting",completedAction:"Deleted",fileCount:t}', 'return{loadingAction:"正在删除",completedAction:"已删除",fileCount:t}'],
        ['loadingAction:i?.loadingAction??"Exploring"', 'loadingAction:i?.loadingAction??"正在探索"'],
        ['completedAction:i?.completedAction??"Explored"', 'completedAction:i?.completedAction??"已探索"'],
        ['`${e} file${e===1?"":"s"}`', '`${e} 个文件`'],

        // HTML 包裹导致词典无法直接命中的词条。
        ['"<div>Web Fetch Tool"', '"<div>网络抓取工具"'],
        ['"<div><span>Task Models"', '"<div><span>任务模型"'],
        ['automations:"Automations"', 'automations:"自动化"'],
        ['themeLabel:"Light"', 'themeLabel:"浅色"'],
        ['themeLabel:"Dark"', 'themeLabel:"深色"'],
        ['themeLabel:"High Contrast"', 'themeLabel:"高对比度"'],
        ['<span>On-Demand Usage', '<span>按需用量'],
        ['"undo","Undo"', '"undo","撤销"'],
        ['"redo","Redo"', '"redo","重做"'],
        ['"cut","Cut"', '"cut","剪切"'],
        ['"copy","Copy"', '"copy","复制"'],
        ['"paste","Paste"', '"paste","粘贴"'],
        ['"selectAll","Select All"', '"selectAll","全选"'],
        ['marketplace:"Marketplace"', 'marketplace:"插件市场"'],
        ['?"自定义":"Marketplace"', '?"自定义":"插件市场"'],
        ['rootLabel:"Marketplace"', 'rootLabel:"插件市场"'],
        ['[" ","Marketplace"]', '[" ","插件市场"]'],
        ['all:"All"', 'all:"全部"'],
        ['return"All"', 'return"全部"'],

        // ── 用户反馈的未翻译词条：正则无法覆盖的上下文 ──
        // Learn more 出现在 HTML 标签内（非引号包裹），safeMegaRegex 无法匹配
        ['>Learn more\'', '>了解更多\''],
        ['>Learn more"', '>了解更多"'],
        ['>Learn more<', '>了解更多<'],
        // "New" 作为独立 UI 文案（不加入 riskyShortWords 因为会误伤 trimNew 等代码）
        ['label:"New"', 'label:"新建"'],
        ['title:"New"', 'title:"新建"'],
        ['placeholder:"New"', 'placeholder:"新建"'],
        ['name:"New"', 'name:"新建"'],
        ['>"New"', '>"新建"'],
        // New Worktree 各上下文（safeGlobalDict 已有，但裸文本形式需要额外处理）
        ['children:"New Worktree"', 'children:"新建工作树"'],
        ['label:"New Worktree"', 'label:"新建工作树"'],
        ['title:"New Worktree"', 'title:"新建工作树"'],
        // Documentation 在 UI 属性中（safeGlobalDict 已有引号形式，这里补充属性上下文）
        ['children:"Documentation"', 'children:"文档"'],
        ['label:"Documentation"', 'label:"文档"'],
        ['title:"Documentation"', 'title:"文档"'],
        // Connected 在 UI 属性中（riskyShortWords 已有，补充特定上下文）
        ['children:"Connected"', 'children:"已连接"'],
        ['label:"Connected"', 'label:"已连接"'],
        ['title:"Connected"', 'title:"已连接"'],
        ['>"Connected"', '>"已连接"'],
        // Installed 在 UI 属性中
        ['children:"Installed"', 'children:"已安装"'],
        ['label:"Installed"', 'label:"已安装"'],
        ['title:"Installed"', 'title:"已安装"'],
        ['>"Installed"', '>"已安装"'],
        // Image 在 UI 属性中
        ['children:"Image"', 'children:"图片"'],
        ['label:"Image"', 'label:"图片"'],
        ['title:"Image"', 'title:"图片"'],
        ['QLt={image:"Image",attachments:"', 'QLt={image:"图片",attachments:"'],
        ['case"image":return"Image"', 'case"image":return"图片"'],
        ['"Image":"File"', '"图片":"文件"'],
        ['?"Move to Trash":"Discard"', '?"移到回收站":"丢弃"'],
        ['E("glassRecycle","Move to Recycle Bin")', 'E("glassRecycle","移到回收站")'],
        ['E("glassTrash","Move to Trash")', 'E("glassTrash","移到回收站")'],
        ['E("glassDelete","Delete")', 'E("glassDelete","删除")'],
        ['i?"Close Settings":"设置"', 'i?"关闭设置":"设置"'],
        ['"Close Settings"', '"关闭设置"'],
        // Cloud 在 UI 属性中
        ['children:"Cloud"', 'children:"云端"'],
        ['label:"Cloud"', 'label:"云端"'],
        ['title:"Cloud"', 'title:"云端"'],
        ['>"Cloud"', '>"云端"'],
        // Recents 在 UI 属性中
        ['children:"Recents"', 'children:"最近"'],
        ['label:"Recents"', 'label:"最近"'],
        ['title:"Recents"', 'title:"最近"'],
        ['>"Recents"', '>"最近"'],
        // Run on / This PC 组合
        ['children:"Run on"', 'children:"运行于"'],
        ['label:"Run on"', 'label:"运行于"'],
        ['children:"This PC"', 'children:"此电脑"'],
        ['label:"This PC"', 'label:"此电脑"'],
        ['"Run on This PC"', '"在此电脑上运行"'],
        ['"Run on Cloud"', '"在云端运行"'],
        // + Add 按钮
        ['children:"+ Add"', 'children:"+ 添加"'],
        ['label:"+ Add"', 'label:"+ 添加"'],
        ['>"+ Add"', '>"+ 添加"'],
        // User Config
        ['children:"User Config"', 'children:"用户配置"'],
        ['label:"User Config"', 'label:"用户配置"'],
        ['title:"User Config"', 'title:"用户配置"'],
        // From Marketplace / From Local Repo（safeGlobalDict 已有，补充 children 上下文确保命中）
        ['children:"From Marketplace"', 'children:"从插件市场"'],
        ['children:"From Local Repo"', 'children:"从本地仓库"'],
        // Give Feedback... 带省略号
        ['"Give Feedback..."', '"提供反馈..."'],
        ['children:"Give Feedback..."', 'children:"提供反馈..."'],
        ['label:"Give Feedback..."', 'label:"提供反馈..."'],
        // 模板字符串中的动态 tooltip（safeMegaRegex 无法匹配反引号）
        ['`Toggle Agents Side Bar (${', '`切换智能体侧边栏 (${'],
        ['`Toggle Agents (${', '`切换智能体 (${'],
        ['`Toggle Primary Side Bar (${', '`切换主侧边栏 (${'],
        ['`Show Agents Side Bar (${', '`显示智能体侧边栏 (${'],
        // title 属性直接赋值（非 Te()/ft() 包裹）
        ['title:"Show Terminal"', 'title:"显示终端"'],
        ['title:"Toggle Developer Tools"', 'title:"切换开发者工具"'],
        ['title:"Open Process Explorer"', 'title:"打开进程浏览器"'],
        ['title:"Report Issue"', 'title:"报告问题"'],
        // LABEL 直接赋值（Help菜单中的 Report Issue）
        ['.LABEL="Report Issue"', '.LABEL="报告问题"'],
        // ── 字体大小选项（Small/Default/Large/超大）──
        ['case .85:return"Small";case 1:return"Default";case 1.15:return"Large";case 1.3:return"超大"', 'case .85:return"小";case 1:return"默认";case 1.15:return"大";case 1.3:return"超大"'],
        // ── Show/Hide 切换按钮（title getter 三元表达式）──
        ['?"Hide":"Show"', '?"隐藏":"显示"'],
        // ── Import 按钮（Importing... 状态）──
        ['?"Importing\u2026":"Import"', '?"正在导入…":"导入"'],
        ['?"Importing...":"Import"', '?"正在导入...":"导入"'],
        // ── claude-code-import-indicator 状态标签 ──
        ['case"claude-code-import-indicator":return"Import"', 'case"claude-code-import-indicator":return"导入"'],
        // ── 模型列表刷新按钮（Refreshing.../Refresh model list 三元）──
        ['?"Refreshing...":"Refresh model list"', '?"正在刷新...":"刷新模型列表"'],
        // ── 模型选择器 Results/Suggested 标题（minified 变量名 ft）──
        ['title:ft?"Results":"Suggested"', 'title:ft?"结果":"推荐"'],
        // ── 模型选择器搜索框 placeholder ──
        ['placeholder:"Add or search model"', 'placeholder:"添加或搜索模型"'],
        // ── 更新渠道名称：switch case 返回值 ──
        ['case"prerelease":return"Early Access"', 'case"prerelease":return"抢先体验"'],
        ['case"dev":return"Nightly"', 'case"dev":return"每夜构建"'],
        ['case"dogfood":return"Dogfood"', 'case"dogfood":return"内部测试"'],
        ['case"candidate":return"Candidate"', 'case"candidate":return"候选版"'],
        // ── 版本号解析中的渠道名 ──
        ['case"9":return"Nightly"', 'case"9":return"每夜构建"'],
        // ── 更新渠道名称：选项列表 label ──
        ['label:"Dogfood",id:"dogfood"', 'label:"内部测试",id:"dogfood"'],
        ['label:"Candidate",id:"candidate"', 'label:"候选版",id:"candidate"'],
        // ── 命令面板/Agent 菜单 Suggested 分区标题 ──
        ['heading:"Suggested"', 'heading:"推荐"'],

        // ── 套餐与用量页：% used 标签保持英文（用户要求不翻译）──
        // 原规则已移除：['>% used<', '>已用 %<'] 等
        // ── 套餐与用量页：Adjust Plan 按钮 ──
        ['title:"Adjust Plan"', 'title:"调整套餐"'],
        // ── glass.js 远程窗口 SSH 命令 ──
        ['title:"Open SSH Configuration File"', 'title:"打开 SSH 配置文件"'],
        ['title:"Open Folder in Container"', 'title:"在容器中打开文件夹"'],
        ['title:"Attach to Running Container"', 'title:"附加到正在运行的容器"'],
        ['title:"Connect to Host..."', 'title:"连接到主机..."'],
        ['title:"Connect Current Window to Host..."', 'title:"将当前窗口连接到主机..."'],
        ['title:"Connect to Host in New Window"', 'title:"在新窗口中连接到主机"'],
        ['title:"Connect to Host in Current Window"', 'title:"在当前窗口中连接到主机"'],
        ['title:"Connect to WSL"', 'title:"连接到 WSL"'],
        ['title:"Connect to WSL using Distro..."', 'title:"使用指定发行版连接到 WSL..."'],
        ['title:"Connect to WSL in New Window"', 'title:"在新窗口中连接到 WSL"'],
        ['title:"Connect to WSL using Distro in New Window..."', 'title:"在新窗口中使用指定发行版连接到 WSL..."'],
        ['title:"Open Folder in WSL"', 'title:"在 WSL 中打开文件夹"'],
        ['title:"Show Dev Containers Log"', 'title:"显示 Dev Containers 日志"'],
        ['title:"Attach to Running Kubernetes Container..."', 'title:"附加到正在运行的 Kubernetes 容器..."'],
        ['title:"Open Container Configuration File"', 'title:"打开容器配置文件"'],
        ['label:"Dev Containers"', 'label:"开发容器"'],
        ['glassCategory:"Workspace"', 'glassCategory:"工作区"'],
        // ── 远程窗口入口（Clone/Connect）──
        ['title:"Clone Repository"', 'title:"克隆仓库"'],
        ['"aria-label":"Clone Repository"', '"aria-label":"克隆仓库"'],
        ['children:"Connect SSH"', 'children:"连接 SSH"'],
        ['children:"Connect WSL"', 'children:"连接 WSL"'],
        // ── primaryButton 中的 Import 按钮（导入设置/插件对话框）──
        ['primaryButton:{id:"import",label:"Import"}', 'primaryButton:{id:"import",label:"导入"}'],
        ['primaryButton:{label:"Import",id:"import"}', 'primaryButton:{label:"导入",id:"import"}'],
        ['label:"Import without extensions"', 'label:"导入（不含扩展）"'],
        ['label:"Cancel",id:"cancel"', 'label:"取消",id:"cancel"'],
        // ── Cursor Tab 通知/状态栏悬浮框 ──
        ['n.textContent="Model"', 'n.textContent="模型"'],
        ['o.textContent=n?"Unsnooze":"Snooze"', 'o.textContent=n?"取消暂停":"暂停"'],
        ['Sqn="auto (default)"', 'Sqn="自动（默认）"'],
        ['"Disable globally"', '"全局禁用"'],
        ['"No commit has been scored yet"', '"暂无已评分的提交"'],
        ['"$(git-commit) No commit scored"', '"$(git-commit) 无提交评分"'],
        ['"Select Cursor Tab snooze duration"', '"选择 Cursor Tab 暂停时长"'],
        ['"Temporarily disable Cursor Tab suggestions for a specified duration. You can unsnooze at any time."', '"临时禁用 Cursor Tab 建议一段指定时间，可随时取消暂停。"'],
        ['.LABEL="Snooze Cursor Tab"', '.LABEL="暂停 Cursor Tab"'],
        ['.LABEL="Unsnooze Cursor Tab"', '.LABEL="取消暂停 Cursor Tab"'],
        // ── 快速打开命令元数据 ──
        ['description:"Quick access"', 'description:"快速访问"'],
        // ── Agents 面板：分组/排序/筛选标签（main.js 中同样出现）──
        ['label:"Grouping"', 'label:"分组"'],
        ['children:"Grouping"', 'children:"分组"'],
        ['label:"Ordering"', 'label:"排序"'],
        ['children:"Ordering"', 'children:"排序"'],
        ['title:"Filters"', 'title:"筛选器"'],
        ['value:"repository",label:"Repository"', 'value:"repository",label:"仓库"'],
        ['value:"workspace",label:"Workspace"', 'value:"workspace",label:"工作区"'],
        ['value:"time",label:"Updated"', 'value:"time",label:"更新时间"'],
        ['value:"status",label:"Status"', 'value:"status",label:"状态"'],
        ['value:"environment",label:"Environment"', 'value:"environment",label:"环境"'],
        ['value:"updated",label:"Updated"', 'value:"updated",label:"更新时间"'],
        ['value:"created",label:"Created"', 'value:"created",label:"创建时间"'],
        ['value:"needs_attention",label:"Needs Attention"', 'value:"needs_attention",label:"需要关注"'],
        ['value:"unread_only",label:"Unread"', 'value:"unread_only",label:"未读"'],
        ['value:"running",label:"Working"', 'value:"running",label:"进行中"'],
        ['value:"draft",label:"Draft"', 'value:"draft",label:"草稿"'],
        ['value:"done",label:"Done"', 'value:"done",label:"已完成"'],
        ['value:"git:draft",label:"PR Draft"', 'value:"git:draft",label:"PR 草稿"'],
        ['value:"git:open",label:"PR Open"', 'value:"git:open",label:"PR 开放"'],
        ['value:"git:merged",label:"PR Merged"', 'value:"git:merged",label:"PR 已合并"'],
        ['value:"git:closed",label:"PR Closed"', 'value:"git:closed",label:"PR 已关闭"'],
        ['value:"git:none",label:"No PR"', 'value:"git:none",label:"无 PR"'],
        ['label:"Any time"', 'label:"任意时间"'],
        ['label:"Past day"', 'label:"过去一天"'],
        ['label:"Past week"', 'label:"过去一周"'],
        ['label:"Past month"', 'label:"过去一个月"'],
        ['value:"branch",label:"Branch"', 'value:"branch",label:"分支"'],
        ['value:"timestamp",label:"Updated"', 'value:"timestamp",label:"更新时间"'],
        ['value:"source",label:"Source"', 'value:"source",label:"来源"'],
        ['value:"cloud",label:"Cloud"', 'value:"cloud",label:"云端"'],
        ['value:"local",label:"Local"', 'value:"local",label:"本地"'],
        ['label:"Group by Workspace"', 'label:"按工作区分组"'],
        ['label:"Group by Repository"', 'label:"按仓库分组"'],
        ['label:"Group by Updated"', 'label:"按更新时间分组"'],
        ['label:"Group by Status"', 'label:"按状态分组"'],
        ['label:"Group by Environment"', 'label:"按环境分组"'],
        ['children:"Machine"', 'children:"机器"'],
        ['"collapse-all","Collapse All"', '"collapse-all","全部折叠"'],
        ['children:"Mark All as Read"', 'children:"全部标记为已读"'],
        // ── Changes 视图 ──
        ['lastTurn:"Last Turn",uncommitted:"Uncommitted",allChanges:"All",unstaged:"Unstaged",staged:"Staged",branch:"Branch"',
         'lastTurn:"最近一轮",uncommitted:"未提交",allChanges:"全部",unstaged:"未暂存",staged:"已暂存",branch:"分支"'],
        ['?"Branch Commits"', '?"分支提交"'],
        ['?"All Changes"', '?"所有更改"'],
        ['"Unstage All"', '"全部取消暂存"'],
        ['"Stage All Remaining Changes"', '"暂存所有剩余更改"'],
        ['"Stage All"', '"全部暂存"'],
        ['"Stage Remaining Changes"', '"暂存剩余更改"'],
        ['"Unstage File"', '"取消暂存文件"'],
        ['"Stage File"', '"暂存文件"'],
        ['children:"Find in Changes"', 'children:"在更改中查找"'],
        ['children:"Refresh Changes"', 'children:"刷新更改"'],
        ['content:"Discard All Changes"', 'content:"放弃所有更改"'],
        ['{value:"unified",label:"Unified"}', '{value:"unified",label:"统一视图"}'],
        ['{value:"split",label:"Split"}', '{value:"split",label:"拆分视图"}'],
        ['children:"Ignore Whitespace"', 'children:"忽略空白字符"'],
        ['children:"Word Wrap"', 'children:"自动换行"'],
        ['children:"Line Numbers"', 'children:"行号"'],
        ['children:"Auto Save"', 'children:"自动保存"'],
        ['children:"Format on Save"', 'children:"保存时格式化"'],
        // ── 全屏/终端/URL/书签 ──
        ['?"Exit Full Screen":"Enter Full Screen"', '?"退出全屏":"进入全屏"'],
        ['?"Hide Terminal List":"Show Terminal List"', '?"隐藏终端列表":"显示终端列表"'],
        ['"aria-label":"Search or enter URL"', '"aria-label":"搜索或输入 URL"'],
        ['children:"Show Bookmark Bar"', 'children:"显示书签栏"'],
        // ── Canvas ──
        ['"Create a Canvas from chat"', '"从聊天创建画布"'],
        ['?"Hide Canvas List":"Show Canvas List"', '?"隐藏画布列表":"显示画布列表"'],
        // ── 文件操作 ──
        ['"Open a file to get started"', '"打开一个文件即可开始"'],
        ['label:"New File"', 'label:"新建文件"'],
        ['children:"No workspace folder open"', 'children:"没有打开的工作区文件夹"'],
        ['children:"Save File"', 'children:"保存文件"'],
        ['label:"Discard Changes"', 'label:"放弃更改"'],
        ['title:"Search Files"', 'title:"搜索文件"'],
        ['title:"Browse Files"', 'title:"浏览文件"'],
        ['.LABEL="New Tab"', '.LABEL="新建标签页"'],
        // ── 模式（Plan/Agent/Ask/Debug/Multitask 全部保留英文）──
        ['title:"Toggle Git Blame"', 'title:"切换 Git Blame"'],
        // ── 命令面板 ──
        ['label:"Open Customize"', 'label:"打开自定义"'],
        ['label:"Open Skills"', 'label:"打开技能"'],
        ['label:"Open Subagents"', 'label:"打开子智能体"'],
        ['label:"Open Commands"', 'label:"打开命令"'],
        ['title:"Switch Theme"', 'title:"切换主题"'],
        ['title:"Switch to Cursor Light"', 'title:"切换到 Cursor 浅色"'],
        ['title:"Switch to Cursor Dark"', 'title:"切换到 Cursor 深色"'],
        ['title:"Switch to Cursor High Contrast"', 'title:"切换到 Cursor 高对比度"'],
        ['"Reset In-App Ad Views"', '"重置应用内广告视图"'],
        ['title:"Developer: Open Logs Folder"', 'title:"开发者：打开日志文件夹"'],
        ['title:"About Cursor"', 'title:"关于 Cursor"'],
        // ── 集成来源标签 ──
        ['desktop:"Desktop",sand:"Sand",web:"Web",mobile:"Mobile"', 'desktop:"桌面",sand:"沙盒",web:"网页",mobile:"移动端"'],
        ['scm:"Source Control"', 'scm:"源代码管理"'],
        ['setup:"Setup"', 'setup:"设置"'],
        ['automations:"Automations"', 'automations:"自动化"'],
        ['qabot_frontend:"Frontend QA"', 'qabot_frontend:"前端 QA"'],
        ['local:"Local",internal:"Subagent"', 'local:"本地",internal:"子智能体"'],
        ['text:"Desktop",title:"Open Desktop"', 'text:"桌面",title:"打开桌面"'],
        ['void 0?"Automations"', 'void 0?"自动化"'],
        // ── Canvas 空状态描述 ──
        ['"glass.canvasActivationEmptyState.descriptionPrefix","Type"', '"glass.canvasActivationEmptyState.descriptionPrefix","输入"'],
        ['"glass.canvasActivationEmptyState.descriptionSuffix","to create or open a Canvas."', '"glass.canvasActivationEmptyState.descriptionSuffix","来创建或打开画布。"'],
        // ── Open Customize 标题 ──
        ['title:"Open Customize"', 'title:"打开自定义"'],
        // ── Appearance 标题 ──
        ['title:"Appearance"', 'title:"外观"'],
        // ── Diff 标签页操作 ──
        ['action:"Create Branch"', 'action:"创建分支"'],
        ['action:"Commit"', 'action:"提交"'],
        ['action:"Push"', 'action:"推送"'],
        ['children:"Commit"', 'children:"提交"'],
        ['children:"Push"', 'children:"推送"'],
        // ── Debug 模式描述 ──
        ['description:"Systematically diagnose and fix bugs using runtime traces"', 'description:"使用运行时跟踪系统性地诊断和修复 Bug"'],
        // ── 日期分组 ──
        ['key:"today",label:"Today"', 'key:"today",label:"今天"'],
        ['key:"yesterday",label:"Yesterday"', 'key:"yesterday",label:"昨天"'],
        ['key:"last_7_days",label:"Last 7 Days"', 'key:"last_7_days",label:"过去 7 天"'],
        ['key:"last_30_days",label:"Last 30 Days"', 'key:"last_30_days",label:"过去 30 天"'],
        ['key:"older",label:"Older"', 'key:"older",label:"更早"'],
        ['["Today","Yesterday","This week","Older"]', '["今天","昨天","本周","更早"]'],
        ['?"Today":', '?"今天":'],
        ['?"Yesterday":', '?"昨天":'],
        ['?"This week":"Older"', '?"本周":"更早"'],
        ['"Previous 7 days"', '"过去 7 天"'],
        // ── "Changes" 标签 ──
        ['label:"Changes"', 'label:"更改"'],
        ['?"Change":"Changes"', '?"处更改":"处更改"'],
        // ── Canvas / Marketplace ──
        ['children:"Create new canvas"', 'children:"创建新画布"'],
        ['children:"Create New"', 'children:"新建"'],
        ['description:"Set up a team marketplace"', 'description:"设置团队市场"'],
        ['description:"Add a marketplace from a repository"', 'description:"从仓库添加市场"'],
        ['description:"Add a marketplace from your local computer"', 'description:"从本地计算机添加市场"'],
        ['children:"Import from Github"', 'children:"从 Github 导入"'],
        ['children:"Import from Disk"', 'children:"从磁盘导入"'],
        // ── 面板标签 ──
        ['children:"Actions"', 'children:"操作"'],
        ['label:"On"', 'label:"开"'],
        ['label:"Off"', 'label:"关"'],
        ['open_browser:"Open Browser"', 'open_browser:"打开浏览器"'],
        // ── 按钮/标签 ──
        ['title:"Previous",shortcut:', 'title:"上一个",shortcut:'],
        ['title:"Build"', 'title:"构建"'],
        ['title:"Open",type:"tertiary"', 'title:"打开",type:"tertiary"'],
        ['children:"Proceed"', 'children:"继续"'],
        ['label:"Proceed"', 'label:"继续"'],
        ['label:"Discard Changes"', 'label:"放弃更改"'],
        ['label:"Review Changes"', 'label:"审查更改"'],
        // ── 共享 UI 文案（title/label/children 三类）──
        ['title:"Close Settings"', 'title:"关闭设置"'],
        ['e[e.Expand=1]="Expand"', 'e[e.Expand=1]="展开"'],
        ['?"Expand":"Collapse"', '?"展开":"折叠"'],
        ['?"Collapse":"Expand"', '?"折叠":"展开"'],
        ['title:"Open Settings"', 'title:"打开设置"'],
        ['title:"Open Composer Settings"', 'title:"打开编写器设置"'],
        ['title:"Agent Settings"', 'title:"智能体设置"'],
        ['title:"Open Documentation"', 'title:"打开文档"'],
        ['title:"Open Source Control"', 'title:"打开源代码管理"'],
        ['title:"Open Usage Based Pricing"', 'title:"打开基于用量的定价"'],
        ['title:"Open Hooks"', 'title:"打开钩子"'],
        ['title:"Open Rules"', 'title:"打开规则"'],
        ['title:"Open Rule"', 'title:"打开规则"'],
        ['title:"Open Plugins"', 'title:"打开插件"'],
        ['title:"Open MCPs"', 'title:"打开 MCP"'],
        ['title:"Open Skills"', 'title:"打开技能"'],
        ['title:"Open Automations"', 'title:"打开自动化"'],
        ['title:"Open Build Menu"', 'title:"打开构建菜单"'],
        ['title:"Open Canvas"', 'title:"打开画布"'],
        ['title:"Open Gallery"', 'title:"打开画廊"'],
        ['title:"Open PR"', 'title:"打开 PR"'],
        ['title:"Open Plan"', 'title:"打开计划"'],
        ['title:"Open File"', 'title:"打开文件"'],
        ['title:"Open Link"', 'title:"打开链接"'],
        ['title:"About Cursor"', 'title:"关于 Cursor"'],
        ['title:"Access Settings"', 'title:"访问设置"'],
        ['title:"Agent Layout"', 'title:"智能体布局"'],
        ['title:"Agent Window"', 'title:"智能体窗口"'],
        ['title:"Agent Stores"', 'title:"智能体商店"'],
        ['title:"Agent Instructions"', 'title:"智能体指令"'],
        ['title:"Add Doc"', 'title:"添加文档"'],
        ['title:"Add MCP"', 'title:"添加 MCP"'],
        ['title:"Add Models"', 'title:"添加模型"'],
        ['title:"Add Skills"', 'title:"添加技能"'],
        ['title:"Add Folder"', 'title:"添加文件夹"'],
        ['title:"Add Link"', 'title:"添加链接"'],
        ['title:"Add Marketplace"', 'title:"添加市场"'],
        ['title:"Add to Chat"', 'title:"添加到聊天"'],
        ['title:"Add to Team"', 'title:"添加到团队"'],
        ['title:"Adjust Plan"', 'title:"调整套餐"'],
        ['title:"Archive All"', 'title:"全部归档"'],
        ['title:"Archive Prior Chats"', 'title:"归档之前的聊天"'],
        ['title:"Ask Agent"', 'title:"询问智能体"'],
        ['title:"Accept All"', 'title:"全部接受"'],
        ['title:"Accept Edits"', 'title:"接受编辑"'],
        ['title:"Apply Changes"', 'title:"应用更改"'],
        ['title:"Apply Manually"', 'title:"手动应用"'],
        ['title:"Abort Chat"', 'title:"中止聊天"'],
        ['title:"Browse Files"', 'title:"浏览文件"'],
        ['title:"Build Locally"', 'title:"本地构建"'],
        ['title:"Build in Cloud"', 'title:"在云端构建"'],
        ['title:"Build Plan"', 'title:"构建计划"'],
        ['title:"Discard Changes"', 'title:"放弃更改"'],
        ['title:"Discard All Changes"', 'title:"放弃所有更改"'],
        ['title:"Reject All Edits"', 'title:"拒绝所有编辑"'],
        ['title:"Undo Edits"', 'title:"撤销编辑"'],
        ['title:"Undo All"', 'title:"全部撤销"'],
        ['title:"Rename Chat"', 'title:"重命名聊天"'],
        ['title:"Reset All"', 'title:"全部重置"'],
        ['title:"Reset Position"', 'title:"重置位置"'],
        ['title:"Reset zoom"', 'title:"重置缩放"'],
        ['title:"Restore defaults"', 'title:"恢复默认值"'],
        ['title:"Run Now"', 'title:"立即运行"'],
        ['title:"Run Task"', 'title:"运行任务"'],
        ['title:"Run in Background"', 'title:"在后台运行"'],
        ['title:"Reopen PR"', 'title:"重新打开 PR"'],
        ['title:"Reopen conversation"', 'title:"重新打开对话"'],
        ['title:"Review Again"', 'title:"再次审查"'],
        ['title:"Review Code with Bugbot"', 'title:"用 Bugbot 审查代码"'],
        ['title:"Review Next File"', 'title:"审查下一个文件"'],
        ['title:"Review Plan"', 'title:"审查计划"'],
        ['title:"Review changes"', 'title:"审查更改"'],
        ['title:"Save Automation"', 'title:"保存自动化"'],
        ['title:"Save Image As..."', 'title:"另存图片为..."'],
        ['title:"Search Agents"', 'title:"搜索智能体"'],
        ['title:"Search Cursor Settings"', 'title:"搜索 Cursor 设置"'],
        ['title:"Search Extensions"', 'title:"搜索扩展"'],
        ['title:"Select Backend"', 'title:"选择后端"'],
        ['title:"Select Environment"', 'title:"选择环境"'],
        ['title:"Select Workspace"', 'title:"选择工作区"'],
        ['title:"Select Multiple"', 'title:"多选"'],
        ['title:"Send to Chat"', 'title:"发送到聊天"'],
        ['title:"Send to Cloud"', 'title:"发送到云端"'],
        ['title:"Send invite"', 'title:"发送邀请"'],
        ['title:"Share Transcript"', 'title:"分享记录"'],
        ['title:"Sign In"', 'title:"登录"'],
        ['title:"Sign Up"', 'title:"注册"'],
        ['title:"Skip For Now"', 'title:"暂时跳过"'],
        ['title:"Start New Chat"', 'title:"开始新聊天"'],
        ['title:"Stash Changes"', 'title:"暂存更改"'],
        ['title:"Suggest Changes"', 'title:"建议更改"'],
        ['title:"Switch mode"', 'title:"切换模式"'],
        ['title:"Take Control"', 'title:"接管控制"'],
        ['title:"Try Again"', 'title:"重试"'],
        ['title:"Try Cloud Agent"', 'title:"试试云智能体"'],
        ['title:"Trust & Continue"', 'title:"信任并继续"'],
        ['title:"Unfold All"', 'title:"全部展开"'],
        ['title:"Unlink PR"', 'title:"取消关联 PR"'],
        ['title:"Update Cursor"', 'title:"更新 Cursor"'],
        ['title:"Upgrade to Pro"', 'title:"升级到 Pro"'],
        ['title:"Upgrade to Pro+"', 'title:"升级到 Pro+"'],
        ['title:"Upgrade to Ultra"', 'title:"升级到 Ultra"'],
        ['title:"View Agent"', 'title:"查看智能体"'],
        ['title:"View All Changes"', 'title:"查看所有更改"'],
        ['title:"View Changes"', 'title:"查看更改"'],
        ['title:"View PR"', 'title:"查看 PR"'],
        ['title:"View Source"', 'title:"查看源代码"'],
        ['title:"View changelog"', 'title:"查看更新日志"'],
        ['title:"View on Web"', 'title:"在网页中查看"'],
        ['title:"View docs"', 'title:"查看文档"'],
        ['title:"Show History"', 'title:"显示历史记录"'],
        ['title:"Show Less"', 'title:"显示更少"'],
        ['title:"Show More"', 'title:"显示更多"'],
        ['title:"Show Chat"', 'title:"显示聊天"'],
        ['title:"Show Changes"', 'title:"显示更改"'],
        ['title:"Show Output"', 'title:"显示输出"'],
        ['title:"Show Options"', 'title:"显示选项"'],
        ['title:"Shut down"', 'title:"关闭"'],
        ['title:"Pause Indexing"', 'title:"暂停索引"'],
        ['title:"Replace all"', 'title:"全部替换"'],
        ['title:"Preserve Case"', 'title:"保留大小写"'],
        ['title:"Use Regular Expression"', 'title:"使用正则表达式"'],
        ['title:"Use Cursor Browser"', 'title:"使用 Cursor 浏览器"'],
        ['title:"Use External Browser"', 'title:"使用外部浏览器"'],
        ['title:"Use in IDE"', 'title:"在 IDE 中使用"'],
        ['title:"Use in Agents Window"', 'title:"在智能体窗口中使用"'],
        ['title:"Pin / Unpin Agent"', 'title:"固定/取消固定智能体"'],
        ['title:"Pin to workspace"', 'title:"固定到工作区"'],
        ['title:"Recent commits"', 'title:"最近提交"'],
        ['title:"Recently changed"', 'title:"最近更改"'],
        ['title:"Your Tasks"', 'title:"你的任务"'],
        ['title:"Your branches"', 'title:"你的分支"'],
        ['title:"Other Agents"', 'title:"其他智能体"'],
        ['title:"Other Marketplaces"', 'title:"其他市场"'],
        ['title:"Available Marketplaces"', 'title:"可用市场"'],
        ['title:"All Plugins"', 'title:"所有插件"'],
        ['title:"All Members"', 'title:"所有成员"'],
        ['title:"All Tasks"', 'title:"所有任务"'],
        ['title:"Team agents"', 'title:"团队智能体"'],
        ['title:"Team Default"', 'title:"团队默认"'],
        ['title:"Personal Usage"', 'title:"个人用量"'],
        ['title:"Usage Remaining"', 'title:"剩余用量"'],
        ['title:"Quick Question"', 'title:"快速提问"'],
        ['title:"Side Chat"', 'title:"侧边聊天"'],
        ['title:"Past Chat"', 'title:"历史聊天"'],
        ['title:"Previous Agent"', 'title:"上一个智能体"'],
        ['title:"Self-Driving Mode"', 'title:"自动驾驶模式"'],
        ['title:"Self-Driving PRs"', 'title:"自动驾驶 PR"'],
        ['title:"Self-driving Settings"', 'title:"自动驾驶设置"'],
        ['title:"Remote Control"', 'title:"远程控制"'],
        ['title:"Remote Host"', 'title:"远程主机"'],
        ['title:"Background agent"', 'title:"后台智能体"'],
        ['title:"Browser Menu"', 'title:"浏览器菜单"'],
        ['title:"Browser Tab"', 'title:"浏览器标签页"'],
        ['title:"Browser Tools"', 'title:"浏览器工具"'],
        ['title:"Source Action..."', 'title:"源代码操作..."'],
        ['title:"Ordered list"', 'title:"有序列表"'],
        ['title:"Bullet list"', 'title:"无序列表"'],
        ['title:"Server Status"', 'title:"服务器状态"'],
        ['title:"Operation Complete"', 'title:"操作完成"'],
        ['title:"Pending approval"', 'title:"待批准"'],
        ['title:"Action Needed"', 'title:"需要操作"'],
        ['title:"Review required"', 'title:"需要审查"'],
        ['title:"Sign-in restricted"', 'title:"登录受限"'],
        ['title:"Payment failed"', 'title:"付款失败"'],
        ['title:"Plan ending soon"', 'title:"套餐即将到期"'],
        ['title:"Update Required"', 'title:"需要更新"'],
        ['title:"Restart to Update"', 'title:"重启以更新"'],
        ['title:"Refer friends, earn usage credits"', 'title:"推荐好友，赚取用量额度"'],
        ['title:"Referral link"', 'title:"推荐链接"'],
        ['title:"Public Profile"', 'title:"公开资料"'],
        ['title:"Profile Image"', 'title:"头像"'],
        ['title:"API Key"', 'title:"API 密钥"'],
        ['title:"Base URL"', 'title:"基础 URL"'],
        ['title:"Slack Channel"', 'title:"Slack 频道"'],
        ['title:"Slack Token"', 'title:"Slack 令牌"'],
        ['title:"Anthropic API Key"', 'title:"Anthropic API 密钥"'],
        ['title:"Access Key ID"', 'title:"访问密钥 ID"'],
        ['title:"Active Connections"', 'title:"活动连接"'],
        ['title:"Scheduled Tasks"', 'title:"计划任务"'],
        ['title:"Binary file not shown"', 'title:"二进制文件未显示"'],
        ['title:"Only whitespace changes"', 'title:"仅有空白字符更改"'],
        ['title:"Squash & Merge"', 'title:"压缩并合并"'],
        ['title:"Rebase Merge"', 'title:"变基合并"'],
        ['title:"Stash Changes"', 'title:"暂存更改"'],
        ['title:"Search web"', 'title:"搜索网页"'],
        ['title:"Search with Google"', 'title:"用 Google 搜索"'],
        ['title:"Type to search actions"', 'title:"输入以搜索操作"'],
        ['title:"Report Bug"', 'title:"报告 Bug"'],
        ['title:"Report Good"', 'title:"报告良好"'],
        ['title:"Report Bad"', 'title:"报告问题"'],
        ['title:"Thumbs Up"', 'title:"点赞"'],
        ['title:"Thumbs Down"', 'title:"踩"'],
        ['title:"See Details"', 'title:"查看详情"'],
        ['title:"Reveal in File Explorer"', 'title:"在文件资源管理器中显示"'],
        ['title:"Select All in Diff"', 'title:"在差异中全选"'],
        ['title:"Select All in File"', 'title:"在文件中全选"'],
        ['title:"Select to End"', 'title:"选择到末尾"'],
        ['title:"Screen recording"', 'title:"屏幕录制"'],
        ['title:"Verified by Cursor"', 'title:"Cursor 已验证"'],
        ['title:"Teach Cursor New Skills"', 'title:"教 Cursor 新技能"'],
        ['title:"Automate with Hooks"', 'title:"用钩子自动化"'],
        ['title:"Scan and Triage Security Vulnerabilities"', 'title:"扫描和分类安全漏洞"'],
        ['title:"PR Routing & Approval"', 'title:"PR 路由与批准"'],
        ['title:"Score Commit for AI Content"', 'title:"为 AI 内容评分提交"'],
        // ── label 共享 ──
        ['label:"Close Settings"', 'label:"关闭设置"'],
        ['label:"Open Settings"', 'label:"打开设置"'],
        ['label:"Agent Mode"', 'label:"智能体模式"'],
        ['label:"Review Mode"', 'label:"审查模式"'],
        ['label:"Background Mode"', 'label:"后台模式"'],
        ['label:"Actions Palette"', 'label:"操作面板"'],
        ['label:"Personal Usage"', 'label:"个人用量"'],
        ['label:"Usage Remaining"', 'label:"剩余用量"'],
        ['label:"Quick Question"', 'label:"快速提问"'],
        ['label:"Side Chat"', 'label:"侧边聊天"'],
        ['label:"Other Agents"', 'label:"其他智能体"'],
        ['label:"All Tasks"', 'label:"所有任务"'],
        ['label:"Your Tasks"', 'label:"你的任务"'],
        ['label:"Team agents"', 'label:"团队智能体"'],
        ['label:"Available Marketplaces"', 'label:"可用市场"'],
        ['label:"Other Marketplaces"', 'label:"其他市场"'],
        ['label:"All Plugins"', 'label:"所有插件"'],
        ['label:"All Members"', 'label:"所有成员"'],
        ['label:"Recent commits"', 'label:"最近提交"'],
        ['label:"Recently changed"', 'label:"最近更改"'],
        ['label:"Your branches"', 'label:"你的分支"'],
        ['label:"Team Default"', 'label:"团队默认"'],
        ['label:"Remote Control"', 'label:"远程控制"'],
        ['label:"Remote Host"', 'label:"远程主机"'],
        ['label:"Browser Tab"', 'label:"浏览器标签页"'],
        ['label:"Browser Tools"', 'label:"浏览器工具"'],
        ['label:"Browser Menu"', 'label:"浏览器菜单"'],
        ['label:"Pending approval"', 'label:"待批准"'],
        ['label:"Action Needed"', 'label:"需要操作"'],
        ['label:"Review required"', 'label:"需要审查"'],
        ['label:"Sign In"', 'label:"登录"'],
        ['label:"Sign Up"', 'label:"注册"'],
        ['label:"Skip For Now"', 'label:"暂时跳过"'],
        ['label:"Trust & Continue"', 'label:"信任并继续"'],
        ['label:"Try Again"', 'label:"重试"'],
        ['label:"Try Cloud Agent"', 'label:"试试云智能体"'],
        ['label:"Upgrade to Pro"', 'label:"升级到 Pro"'],
        ['label:"Upgrade to Pro+"', 'label:"升级到 Pro+"'],
        ['label:"Upgrade to Ultra"', 'label:"升级到 Ultra"'],
        ['label:"Refer friends, earn usage credits"', 'label:"推荐好友，赚取用量额度"'],
        ['label:"Referral link"', 'label:"推荐链接"'],
        ['label:"Public Profile"', 'label:"公开资料"'],
        ['label:"Profile Image"', 'label:"头像"'],
        ['label:"API Key"', 'label:"API 密钥"'],
        ['label:"Base URL"', 'label:"基础 URL"'],
        ['label:"Slack Channel"', 'label:"Slack 频道"'],
        ['label:"Slack Token"', 'label:"Slack 令牌"'],
        ['label:"Anthropic API Key"', 'label:"Anthropic API 密钥"'],
        ['label:"Access Key ID"', 'label:"访问密钥 ID"'],
        ['label:"Active Connections"', 'label:"活动连接"'],
        ['label:"Scheduled Tasks"', 'label:"计划任务"'],
        ['label:"Server Status"', 'label:"服务器状态"'],
        ['label:"Operation Complete"', 'label:"操作完成"'],
        ['label:"Binary file not shown"', 'label:"二进制文件未显示"'],
        ['label:"Only whitespace changes"', 'label:"仅有空白字符更改"'],
        ['label:"Squash & Merge"', 'label:"压缩并合并"'],
        ['label:"Rebase Merge"', 'label:"变基合并"'],
        ['label:"Stash Changes"', 'label:"暂存更改"'],
        ['label:"Replace all"', 'label:"全部替换"'],
        ['label:"Preserve Case"', 'label:"保留大小写"'],
        ['label:"Use Regular Expression"', 'label:"使用正则表达式"'],
        ['label:"Ordered list"', 'label:"有序列表"'],
        ['label:"Bullet list"', 'label:"无序列表"'],
        ['label:"Select Multiple"', 'label:"多选"'],
        ['label:"Select Workspace"', 'label:"选择工作区"'],
        ['label:"Select Environment"', 'label:"选择环境"'],
        ['label:"Select Backend"', 'label:"选择后端"'],
        ['label:"Send to Chat"', 'label:"发送到聊天"'],
        ['label:"Send to Cloud"', 'label:"发送到云端"'],
        ['label:"Send invite"', 'label:"发送邀请"'],
        ['label:"Share Transcript"', 'label:"分享记录"'],
        ['label:"Pin / Unpin Agent"', 'label:"固定/取消固定智能体"'],
        ['label:"Pin to workspace"', 'label:"固定到工作区"'],
        ['label:"Previous Agent"', 'label:"上一个智能体"'],
        ['label:"Add Doc"', 'label:"添加文档"'],
        ['label:"Add MCP"', 'label:"添加 MCP"'],
        ['label:"Add Models"', 'label:"添加模型"'],
        ['label:"Add Skills"', 'label:"添加技能"'],
        ['label:"Add Folder"', 'label:"添加文件夹"'],
        ['label:"Add Link"', 'label:"添加链接"'],
        ['label:"Add Marketplace"', 'label:"添加市场"'],
        ['label:"Add to Chat"', 'label:"添加到聊天"'],
        ['label:"Add to Team"', 'label:"添加到团队"'],
        ['label:"Open Documentation"', 'label:"打开文档"'],
        ['label:"Open Source Control"', 'label:"打开源代码管理"'],
        ['label:"Open Plugins"', 'label:"打开插件"'],
        ['label:"Open MCPs"', 'label:"打开 MCP"'],
        ['label:"Open Skills"', 'label:"打开技能"'],
        ['label:"Open Hooks"', 'label:"打开钩子"'],
        ['label:"Open Rules"', 'label:"打开规则"'],
        ['label:"Open Automations"', 'label:"打开自动化"'],
        ['label:"Open Build Menu"', 'label:"打开构建菜单"'],
        ['label:"Open Canvas"', 'label:"打开画布"'],
        ['label:"Open Gallery"', 'label:"打开画廊"'],
        ['label:"About Cursor"', 'label:"关于 Cursor"'],
        ['label:"Access Settings"', 'label:"访问设置"'],
        ['label:"Agent Settings"', 'label:"智能体设置"'],
        ['label:"Agent Layout"', 'label:"智能体布局"'],
        ['label:"Agent Window"', 'label:"智能体窗口"'],
        ['label:"Agent Instructions"', 'label:"智能体指令"'],
        ['label:"Agent Stores"', 'label:"智能体商店"'],
        ['label:"Discard Changes"', 'label:"放弃更改"'],
        ['label:"Discard All Changes"', 'label:"放弃所有更改"'],
        ['label:"Reject All Edits"', 'label:"拒绝所有编辑"'],
        ['label:"Accept All"', 'label:"全部接受"'],
        ['label:"Accept Edits"', 'label:"接受编辑"'],
        ['label:"Undo Edits"', 'label:"撤销编辑"'],
        ['label:"Undo All"', 'label:"全部撤销"'],
        ['label:"Apply Changes"', 'label:"应用更改"'],
        ['label:"Apply Manually"', 'label:"手动应用"'],
        ['label:"Rename Chat"', 'label:"重命名聊天"'],
        ['label:"Remove folder"', 'label:"移除文件夹"'],
        ['label:"Remove model"', 'label:"移除模型"'],
        ['label:"Reset All"', 'label:"全部重置"'],
        ['label:"Reset Position"', 'label:"重置位置"'],
        ['label:"Reset zoom"', 'label:"重置缩放"'],
        ['label:"Restore defaults"', 'label:"恢复默认值"'],
        ['label:"View Agent"', 'label:"查看智能体"'],
        ['label:"View Changes"', 'label:"查看更改"'],
        ['label:"View All Changes"', 'label:"查看所有更改"'],
        ['label:"View PR"', 'label:"查看 PR"'],
        ['label:"View Source"', 'label:"查看源代码"'],
        ['label:"View changelog"', 'label:"查看更新日志"'],
        ['label:"View on Web"', 'label:"在网页中查看"'],
        ['label:"View docs"', 'label:"查看文档"'],
        ['label:"Show History"', 'label:"显示历史记录"'],
        ['label:"Show Less"', 'label:"显示更少"'],
        ['label:"Show More"', 'label:"显示更多"'],
        ['label:"Show Chat"', 'label:"显示聊天"'],
        ['label:"Show Changes"', 'label:"显示更改"'],
        ['label:"Show files"', 'label:"显示文件"'],
        ['label:"Show Output"', 'label:"显示输出"'],
        ['label:"Show Options"', 'label:"显示选项"'],
        ['label:"Shut down"', 'label:"关闭"'],
        ['label:"Take Control"', 'label:"接管控制"'],
        ['label:"Switch mode"', 'label:"切换模式"'],
        ['label:"Use Cursor Browser"', 'label:"使用 Cursor 浏览器"'],
        ['label:"Use External Browser"', 'label:"使用外部浏览器"'],
        ['label:"Use in IDE"', 'label:"在 IDE 中使用"'],
        ['label:"Use in Agents Window"', 'label:"在智能体窗口中使用"'],
        ['label:"Screen recording"', 'label:"屏幕录制"'],
        ['label:"Search web"', 'label:"搜索网页"'],
        ['label:"Search with Google"', 'label:"用 Google 搜索"'],
        ['label:"Type to search actions"', 'label:"输入以搜索操作"'],
        ['label:"Report Bug"', 'label:"报告 Bug"'],
        ['label:"Thumbs Up"', 'label:"点赞"'],
        ['label:"Thumbs Down"', 'label:"踩"'],
        ['label:"See Details"', 'label:"查看详情"'],
        ['label:"Reveal in File Explorer"', 'label:"在文件资源管理器中显示"'],
        ['label:"Select All in Diff"', 'label:"在差异中全选"'],
        ['label:"Select All in File"', 'label:"在文件中全选"'],
        ['label:"Source Action..."', 'label:"源代码操作..."'],
        ['label:"Self-Driving PRs"', 'label:"自动驾驶 PR"'],
        ['label:"Self-driving Settings"', 'label:"自动驾驶设置"'],
        ['label:"Branch Changes"', 'label:"分支更改"'],
        ['label:"Branch Pull Requests"', 'label:"分支拉取请求"'],
        ['label:"Branch Prefix"', 'label:"分支前缀"'],
        ['label:"PR Routing & Approval"', 'label:"PR 路由与批准"'],
        ['label:"Automate with Hooks"', 'label:"用钩子自动化"'],
        ['label:"Teach Cursor New Skills"', 'label:"教 Cursor 新技能"'],
        ['label:"Verified by Cursor"', 'label:"Cursor 已验证"'],
        ['label:"The best way to code with AI"', 'label:"使用 AI 编程的最佳方式"'],
        ['label:"Ship better code, faster"', 'label:"更快地交付更好的代码"'],
        ['label:"What should we build?"', 'label:"我们要构建什么？"'],
        ['label:"Save Image As..."', 'label:"另存图片为..."'],
        ['label:"Run command"', 'label:"运行命令"'],
        ['label:"Run in"', 'label:"运行于"'],
        ['label:"This workspace"', 'label:"此工作区"'],
        ['label:"Add an agent to get started"', 'label:"添加智能体即可开始"'],
        ['label:"Add a to-do to get started"', 'label:"添加待办事项即可开始"'],
        // ── children 共享 ──
        ['children:"Close Settings"', 'children:"关闭设置"'],
        ['children:"Open Settings"', 'children:"打开设置"'],
        ['children:"Agent Mode"', 'children:"智能体模式"'],
        ['children:"Review Mode"', 'children:"审查模式"'],
        ['children:"Background Mode"', 'children:"后台模式"'],
        ['children:"Accept All"', 'children:"全部接受"'],
        ['children:"Accept Edits"', 'children:"接受编辑"'],
        ['children:"Reject All Edits"', 'children:"拒绝所有编辑"'],
        ['children:"Undo Edits"', 'children:"撤销编辑"'],
        ['children:"Undo All"', 'children:"全部撤销"'],
        ['children:"Apply Changes"', 'children:"应用更改"'],
        ['children:"Apply Manually"', 'children:"手动应用"'],
        ['children:"Discard Changes"', 'children:"放弃更改"'],
        ['children:"Discard All Changes"', 'children:"放弃所有更改"'],
        ['children:"Rename Chat"', 'children:"重命名聊天"'],
        ['children:"Reset All"', 'children:"全部重置"'],
        ['children:"Restore defaults"', 'children:"恢复默认值"'],
        ['children:"View Agent"', 'children:"查看智能体"'],
        ['children:"View Changes"', 'children:"查看更改"'],
        ['children:"View All Changes"', 'children:"查看所有更改"'],
        ['children:"View PR"', 'children:"查看 PR"'],
        ['children:"View Source"', 'children:"查看源代码"'],
        ['children:"View changelog"', 'children:"查看更新日志"'],
        ['children:"View on Web"', 'children:"在网页中查看"'],
        ['children:"View docs"', 'children:"查看文档"'],
        ['children:"Show History"', 'children:"显示历史记录"'],
        ['children:"Show Less"', 'children:"显示更少"'],
        ['children:"Show More"', 'children:"显示更多"'],
        ['children:"Show Chat"', 'children:"显示聊天"'],
        ['children:"Show Changes"', 'children:"显示更改"'],
        ['children:"Show files"', 'children:"显示文件"'],
        ['children:"Show Output"', 'children:"显示输出"'],
        ['children:"Show Options"', 'children:"显示选项"'],
        ['children:"Shut down"', 'children:"关闭"'],
        ['children:"Take Control"', 'children:"接管控制"'],
        ['children:"Switch mode"', 'children:"切换模式"'],
        ['children:"Sign In"', 'children:"登录"'],
        ['children:"Sign Up"', 'children:"注册"'],
        ['children:"Skip For Now"', 'children:"暂时跳过"'],
        ['children:"Trust & Continue"', 'children:"信任并继续"'],
        ['children:"Try Again"', 'children:"重试"'],
        ['children:"Try Cloud Agent"', 'children:"试试云智能体"'],
        ['children:"Upgrade to Pro"', 'children:"升级到 Pro"'],
        ['children:"Upgrade to Pro+"', 'children:"升级到 Pro+"'],
        ['children:"Upgrade to Ultra"', 'children:"升级到 Ultra"'],
        ['children:"Refer friends, earn usage credits"', 'children:"推荐好友，赚取用量额度"'],
        ['children:"Pin / Unpin Agent"', 'children:"固定/取消固定智能体"'],
        ['children:"Pin to workspace"', 'children:"固定到工作区"'],
        ['children:"Run Now"', 'children:"立即运行"'],
        ['children:"Run Task"', 'children:"运行任务"'],
        ['children:"Run in Background"', 'children:"在后台运行"'],
        ['children:"Run command"', 'children:"运行命令"'],
        ['children:"Stash Changes"', 'children:"暂存更改"'],
        ['children:"Squash & Merge"', 'children:"压缩并合并"'],
        ['children:"Rebase Merge"', 'children:"变基合并"'],
        ['children:"Replace all"', 'children:"全部替换"'],
        ['children:"Preserve Case"', 'children:"保留大小写"'],
        ['children:"Use Regular Expression"', 'children:"使用正则表达式"'],
        ['children:"Use Cursor Browser"', 'children:"使用 Cursor 浏览器"'],
        ['children:"Use External Browser"', 'children:"使用外部浏览器"'],
        ['children:"Use in IDE"', 'children:"在 IDE 中使用"'],
        ['children:"Use in Agents Window"', 'children:"在智能体窗口中使用"'],
        ['children:"Ordered list"', 'children:"有序列表"'],
        ['children:"Bullet list"', 'children:"无序列表"'],
        ['children:"Select Multiple"', 'children:"多选"'],
        ['children:"Select Workspace"', 'children:"选择工作区"'],
        ['children:"Select Environment"', 'children:"选择环境"'],
        ['children:"Select Backend"', 'children:"选择后端"'],
        ['children:"Send to Chat"', 'children:"发送到聊天"'],
        ['children:"Send to Cloud"', 'children:"发送到云端"'],
        ['children:"Send invite"', 'children:"发送邀请"'],
        ['children:"Share Transcript"', 'children:"分享记录"'],
        ['children:"About Cursor"', 'children:"关于 Cursor"'],
        ['children:"Access Settings"', 'children:"访问设置"'],
        ['children:"Add Doc"', 'children:"添加文档"'],
        ['children:"Add MCP"', 'children:"添加 MCP"'],
        ['children:"Add Models"', 'children:"添加模型"'],
        ['children:"Add Skills"', 'children:"添加技能"'],
        ['children:"Add Folder"', 'children:"添加文件夹"'],
        ['children:"Add Link"', 'children:"添加链接"'],
        ['children:"Add Marketplace"', 'children:"添加市场"'],
        ['children:"Add to Chat"', 'children:"添加到聊天"'],
        ['children:"Add to Team"', 'children:"添加到团队"'],
        ['children:"Open Settings"', 'children:"打开设置"'],
        ['children:"Open Source Control"', 'children:"打开源代码管理"'],
        ['children:"Open Plugins"', 'children:"打开插件"'],
        ['children:"Open MCPs"', 'children:"打开 MCP"'],
        ['children:"Open Skills"', 'children:"打开技能"'],
        ['children:"Open Hooks"', 'children:"打开钩子"'],
        ['children:"Open Rules"', 'children:"打开规则"'],
        ['children:"Open Automations"', 'children:"打开自动化"'],
        ['children:"Open Build Menu"', 'children:"打开构建菜单"'],
        ['children:"Open Canvas"', 'children:"打开画布"'],
        ['children:"Open Gallery"', 'children:"打开画廊"'],
        ['children:"Open Documentation"', 'children:"打开文档"'],
        ['children:"Open File"', 'children:"打开文件"'],
        ['children:"Open PR"', 'children:"打开 PR"'],
        ['children:"Open Plan"', 'children:"打开计划"'],
        ['children:"Source Action..."', 'children:"源代码操作..."'],
        ['children:"Save Image As..."', 'children:"另存图片为..."'],
        ['children:"Browse Files"', 'children:"浏览文件"'],
        ['children:"Build Locally"', 'children:"本地构建"'],
        ['children:"Build in Cloud"', 'children:"在云端构建"'],
        ['children:"Search Agents"', 'children:"搜索智能体"'],
        ['children:"Search Cursor Settings"', 'children:"搜索 Cursor 设置"'],
        ['children:"Search Extensions"', 'children:"搜索扩展"'],
        ['children:"Search web"', 'children:"搜索网页"'],
        ['children:"Type to search actions"', 'children:"输入以搜索操作"'],
        ['children:"Report Bug"', 'children:"报告 Bug"'],
        ['children:"Thumbs Up"', 'children:"点赞"'],
        ['children:"Thumbs Down"', 'children:"踩"'],
        ['children:"See Details"', 'children:"查看详情"'],
        ['children:"Reveal in File Explorer"', 'children:"在文件资源管理器中显示"'],
        ['children:"Select All in Diff"', 'children:"在差异中全选"'],
        ['children:"Select All in File"', 'children:"在文件中全选"'],
        ['children:"Select to End"', 'children:"选择到末尾"'],
        ['children:"Reset zoom"', 'children:"重置缩放"'],
        ['children:"Pending approval"', 'children:"待批准"'],
        ['children:"Action Needed"', 'children:"需要操作"'],
        ['children:"Review required"', 'children:"需要审查"'],
        ['children:"Operation Complete"', 'children:"操作完成"'],
        ['children:"Binary file not shown"', 'children:"二进制文件未显示"'],
        ['children:"Only whitespace changes"', 'children:"仅有空白字符更改"'],
        ['children:"This workspace"', 'children:"此工作区"'],
        ['children:"Verified by Cursor"', 'children:"Cursor 已验证"'],
        ['children:"Teach Cursor New Skills"', 'children:"教 Cursor 新技能"'],
        ['children:"Automate with Hooks"', 'children:"用钩子自动化"'],
        ['children:"Scan and Triage Security Vulnerabilities"', 'children:"扫描和分类安全漏洞"'],
        ['children:"PR Routing & Approval"', 'children:"PR 路由与批准"'],
        ['children:"Save Automation"', 'children:"保存自动化"'],
        ['children:"Run in"', 'children:"运行于"'],
        ['children:"Screen recording"', 'children:"屏幕录制"'],
        ['children:"Pause Indexing"', 'children:"暂停索引"'],
        ['children:"Pause goal"', 'children:"暂停目标"'],
        ['children:"Resume goal"', 'children:"恢复目标"'],
        // ── 开发者/调试命令（main.js 的 original: 和 title: 形式）──
        ['original:"Start Extension Host CPU Profiler"', 'original:"启动扩展宿主 CPU 分析器"'],
        ['original:"Start Extension Host Heap Allocation Profiler"', 'original:"启动扩展宿主堆分配分析器"'],
        ['original:"Delete Old Chats..."', 'original:"删除旧聊天..."'],
        ['value:"Delete Old Chats..."', 'value:"删除旧聊天..."'],
        ['children:"Workspace Diagnostics"', 'children:"工作区诊断"'],
        // ── Agents 窗口缺失的编辑菜单/操作按钮构造函数形式（main.js 用 gr）──
        ['new gr("undo","Undo"', 'new gr("undo","撤销"'],
        ['new gr("redo","Redo"', 'new gr("redo","重做"'],
        ['new gr("cut","Cut"', 'new gr("cut","剪切"'],
        ['new gr("copy","Copy"', 'new gr("copy","复制"'],
        ['new gr("paste","Paste"', 'new gr("paste","粘贴"'],
        ['new gr("selectAll","Select All"', 'new gr("selectAll","全选"'],
        ['new gr("collapse-all","Collapse All"', 'new gr("collapse-all","全部折叠"'],
        // ── children/label 缺失的编辑菜单项 ──
        ['children:"Cut"', 'children:"剪切"'],
        ['children:"Paste"', 'children:"粘贴"'],
        ['children:"Select All"', 'children:"全选"'],
        ['children:"No projects"', 'children:"暂无项目"'],
        ['children:"Reload"', 'children:"重新加载"'],
        ['children:"Clone Repository"', 'children:"克隆仓库"'],
        ['label:"Cut"', 'label:"剪切"'],
        ['label:"Paste"', 'label:"粘贴"'],
        ['label:"Select All"', 'label:"全选"'],
        ['label:"Clone Repository"', 'label:"克隆仓库"'],
        ['label:"Reload"', 'label:"重新加载"'],
        // ── Repos / Docs / Reload 其他形式 ──
        ['groupLabel:"Repos"', 'groupLabel:"仓库"'],
        ['buttonLabel:"Reload"', 'buttonLabel:"重新加载"'],
        ['doc:"Docs"', 'doc:"文档"'],
        ['title:"Docs"', 'title:"文档"'],
        ['case"doc":return"Docs"', 'case"doc":return"文档"'],
        ['case"docs":return"Docs"', 'case"docs":return"文档"'],
        // ── 用户反馈缺失：Ask Agent（label/children 形式）──
        ['label:"Ask Agent"', 'label:"询问智能体"'],
        ['children:"Ask Agent"', 'children:"询问智能体"'],
        // ── 用户反馈缺失：Show/Hide Details（三元 + HTML + textContent）──
        ['?"Hide Details":"Show Details"', '?"隐藏详情":"显示详情"'],
        ['>Show Details</button>', '>显示详情</button>'],
        ['btn.textContent = \'Hide Details\'', 'btn.textContent = \'隐藏详情\''],
        ['btn.textContent = \'Show Details\'', 'btn.textContent = \'显示详情\''],
        // ── 用户反馈缺失：Home、（Collapse All 其余形式）──
        ['label:"Home",workspaceIdentifier', 'label:"主页",workspaceIdentifier'],
        ['title:Te(9500,"Collapse All")', 'title:Te(9500,"全部折叠")'],
        ["collapseAll: 'Collapse All'", "collapseAll: '全部折叠'"],
        // ── 用户反馈缺失：Docs（case"docs" 模板）──
        ['case"docs":return`Documentation: ${n||t}`', 'case"docs":return`文档：${n||t}`'],
        // ── 用户反馈缺失：Git 空状态 + AI Code Tracking（desktop）──
        ['"No uncommitted changes"', '"无未提交更改"'],
        ['hintText:"Add files"', 'hintText:"添加文件"'],
        ['name:"AI Code Tracking - Recent Commit"', 'name:"AI 代码追踪 - 最近提交"'],
        ['"Most Recent Commit Scored:"', '"最近评分的提交："'],
        ['"AI-Generated:"', '"AI 生成："'],
        ['"Total Changes:"', '"总更改："'],
    ];

    // 合并大正则：单次扫描替代逐条替换（~1803条 → 1次扫描）
    const scopedLookup = new Map(scopedReplacements.filter(([en]) => en));
    const scopedMegaRegex = new RegExp(
        scopedReplacements
            .filter(([en]) => en)
            .sort((a, b) => b[0].length - a[0].length)
            .map(([en]) => escapeRegExp(en))
            .join('|'),
        'g'
    );

    let scopedCount = 0;
    jsContent = jsContent.replace(scopedMegaRegex, (match) => {
        scopedCount++;
        return scopedLookup.get(match);
    });
    if (scopedCount > 0) {
        progress.update('替换界面片段', `${scopedCount} 处`);
        changes.record('界面片段', '<合并大正则>', '<中文>', scopedCount);
    }
    progress.step('界面片段处理完成');

    const worktreeCountResult = replaceRegexWithCount(
        jsContent,
        /`\$\{d\.length\} worktree\$\{d\.length===1\?"":"s"\}`/g,
        '`${d.length} 个工作树`'
    );
    jsContent = worktreeCountResult.content;
    changes.record('动态模板', '`${d.length} worktree${d.length===1?"":"s"}`', '`${d.length} 个工作树`', worktreeCountResult.count);
    // 6. 危险短词：精准 UI 属性替换（跳过键盘扫描表等键位元数据）
    progress.update('处理短词', '仅替换可见 UI 属性，跳过键盘扫描表');
    jsContent = applyRiskyShortWords(jsContent, changes, progress);
    jsContent = restoreComposerModeNames(jsContent);
    progress.step('短词处理完成');

    progress.finish('核心代码处理完成');
    changes.print();

    // 7. 写回（Program Files 等目录下避免写后立刻读盘失败）
    try {
        writeFileSafe(mainJsPath, jsContent, 'utf8');
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(
                `无法写入 ${mainJsPath}：权限不足。请关闭 Cursor 后以管理员身份运行本工具，或将 Cursor 安装到用户目录。`
            );
        }
        throw err;
    }
    console.log('✅ 核心 JS 文件智能汉化完成！');

    // 8. 修复 Hash（使用内存内容，不依赖写回后再次打开主 JS）
    console.log('\n🛠️  正在重新计算指纹并修复文件完整性...');
    const hashFixed = fixProductHash(jsContent, productJsonPath);
    if (hashFixed) {
        console.log('✅ 已更新 product.json 校验值，消除「安装已损坏」警告。');
    } else {
        console.log('⚠️  未找到对应的校验项，可能无需更新。');
    }

    const auxiliaryResult = translateAuxiliaryJsFile(glassJsPath, productJsonPath);
    if (auxiliaryResult.processed) {
        if (auxiliaryResult.hashFixed) {
            console.log('✅ 已更新附加窗口 JS 校验值。');
        } else {
            console.log('ℹ️  附加窗口 JS 未发现校验项，已跳过 product.json 更新。');
        }
    }

    translateNlsMessagesFile(nlsMessagesPath);

    // 8.5 主进程托盘菜单
    translateMainJsFile(mainProcessJsPath);

    // 9. Mac Gatekeeper 修复
    fixMacGatekeeper(appPath);

    // 10. 用户扩展（远程 SSH/WSL/容器命令面板）
    try {
        translateUserExtensions();
    } catch (e) {
        console.log(`  ⚠️  用户扩展汉化跳过: ${e.message}`);
    }

    // 11. 用户存储（state.vscdb 中的 modes4 描述，需 Cursor 已关闭）
    try {
        translateUserStorage(appPath);
    } catch (e) {
        console.log(`  ⚠️  用户存储汉化跳过: ${e.message}`);
    }

    console.log('\n🎉 汉化完成！请重启 Cursor 查看中文设置页。');
}


/**
 * 恢复英文原版
 * @param {{ mainJsPath: string, glassJsPath?: string, nlsMessagesPath?: string, htmlPath: string, productJsonPath: string }} paths
 */
function restore(paths) {
    const { mainJsPath, glassJsPath, nlsMessagesPath, htmlPath, productJsonPath, mainProcessJsPath } = paths;

    console.log('');
    let restored = 0;
    for (const filePath of [htmlPath, mainJsPath, glassJsPath, nlsMessagesPath, mainProcessJsPath, productJsonPath].filter(Boolean)) {
        if (restoreFromBackup(filePath)) {
            console.log(`  ✅ 已还原: ${path.basename(filePath)}`);
            restored++;
        }
    }

    // 还原用户扩展
    const extRestored = restoreUserExtensions();
    restored += extRestored;

    // 还原用户存储（state.vscdb）
    restoreUserStorage();

    if (restored > 0) {
        console.log('\n🎉 已恢复英文原版！请重启 Cursor 生效。');
    } else {
        console.log('\n⚠️  未找到备份文件，无法还原。请确认之前是否执行过汉化。');
    }
}

module.exports = { translate, restore };
