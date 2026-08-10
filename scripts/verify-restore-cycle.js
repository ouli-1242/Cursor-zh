#!/usr/bin/env node
/**
 * restore 环形验证：在临时沙箱中测试「备份 → 篡改 → 还原」契约，不触碰真实安装。
 *
 * 验证项：
 *  1. backupFile  创建 .backup 且与原文件字节一致（翻译前备份的可靠性）
 *  2. restoreFromBackup 还原后与原始文件字节一致（restore 的完整性）
 *  3. fixProductHash 重算 product.json checksum 与翻译后内容一致
 *
 * 前置：需要 Cursor 安装（读其主 JS 作为测试样本），可用 argv[2] 覆盖安装路径。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { backupFile, restoreFromBackup, fixProductHash } = require(path.join(__dirname, '..', 'src', 'i18n-core.js'));

const APP_ROOT = process.argv[2] || 'D:/Program Files/cursor/resources/app';
const INSTALLED_MAIN = path.join(APP_ROOT, 'out/vs/workbench/workbench.desktop.main.js');
const INSTALLED_PRODUCT = path.join(APP_ROOT, 'product.json');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

function main() {
  if (!fs.existsSync(INSTALLED_MAIN)) {
    console.error(`❌ 找不到 Cursor 主 JS: ${INSTALLED_MAIN}`);
    process.exit(1);
  }

  // 沙箱：临时目录，测试结束清理
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-zh-restore-test-'));
  console.log(`沙箱: ${sandbox}`);
  try {
    const mainCopy = path.join(sandbox, 'workbench.desktop.main.js');
    const productCopy = path.join(sandbox, 'product.json');
    fs.copyFileSync(INSTALLED_MAIN, mainCopy);
    if (fs.existsSync(INSTALLED_PRODUCT)) fs.copyFileSync(INSTALLED_PRODUCT, productCopy);
    const originalContent = fs.readFileSync(mainCopy, 'utf8');
    const originalHash = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');

    // ── 1. backupFile：备份字节一致 + .meta 版本元数据 ──
    const bakMsg = backupFile(mainCopy, productCopy);
    const backupPath = mainCopy + '.backup';
    check('backupFile 创建 .backup', fs.existsSync(backupPath), bakMsg);
    check('备份与原文件字节一致',
      crypto.createHash('sha256').update(fs.readFileSync(backupPath, 'utf8'), 'utf8').digest('hex') === originalHash);
    const metaPath = backupPath + '.meta';
    if (fs.existsSync(productCopy) && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      check('backupFile 写版本元数据(.meta)', typeof meta.version === 'string' || typeof meta.version === 'number', JSON.stringify(meta).slice(0, 60));
    } else {
      check('backupFile 写版本元数据(.meta)', fs.existsSync(metaPath), 'product.json 存在时应有 .meta');
    }

    // ── 2. 篡改主文件（模拟翻译后的中文写入）──
    fs.writeFileSync(mainCopy, originalContent + '\n// 模拟翻译写入的标记', 'utf8');
    check('篡改后文件与原文不同', fs.readFileSync(mainCopy, 'utf8') !== originalContent);

    // ── 3. restoreFromBackup：还原字节一致 + 删除备份 ──
    const restored = restoreFromBackup(mainCopy);
    check('restoreFromBackup 返回 true', restored === true);
    const restoredHash = crypto.createHash('sha256').update(fs.readFileSync(mainCopy, 'utf8'), 'utf8').digest('hex');
    check('还原后与原始字节一致', restoredHash === originalHash);
    check('还原后删除 .backup 与 .meta', !fs.existsSync(backupPath) && !fs.existsSync(metaPath));

    // ── 4. 无备份时 restoreFromBackup 返回 false（不误删/不改动）──
    const noBackup = restoreFromBackup(mainCopy);
    check('无备份时返回 false', noBackup === false);

    // ── 5. fixProductHash：checksum 与内容匹配 ──
    if (fs.existsSync(INSTALLED_PRODUCT)) {
      fs.copyFileSync(INSTALLED_PRODUCT, productCopy);
      const product = JSON.parse(fs.readFileSync(productCopy, 'utf8'));
      const checksumKey = Object.keys(product.checksums || {}).find(k => k.endsWith('workbench.desktop.main.js'));
      if (checksumKey) {
        const oldHash = product.checksums[checksumKey];
        const algo = oldHash.length <= 24 ? 'md5' : oldHash.length <= 44 ? 'sha256' : 'sha512';
        const updated = fixProductHash('测试内容', productCopy, 'workbench.desktop.main.js');
        const product2 = JSON.parse(fs.readFileSync(productCopy, 'utf8'));
        const expected = crypto.createHash(algo).update('测试内容', 'utf8').digest('base64').replace(/=+$/, '');
        check('fixProductHash 更新 checksum', updated === true && product2.checksums[checksumKey] === expected);
      } else {
        console.log('ℹ️  product.json 无 workbench.desktop.main.js checksum 项，跳过 hash 测试');
      }
    } else {
      console.log('ℹ️  沙箱无 product.json，跳过 hash 测试');
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    console.log(`沙箱已清理: ${sandbox}`);
  }

  console.log(failures === 0 ? '\n🎉 restore 环形验证全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main();