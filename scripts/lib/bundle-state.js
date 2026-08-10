/**
 * 检测 bundle 是否已被汉化（verify 脚本守卫）。
 *
 * 原理：minified 英文原包的非 ASCII 全是 \uXXXX 转义（无字面 CJK）；
 * 汉化后 translate() 直接写入字面中文字符。因此包内含大量字面 CJK
 * 即可判定已汉化——此时 verify 覆盖率类脚本 0 命中属预期，不是回归。
 */
const fs = require('fs');

function isTranslated(content, threshold = 50) {
  return (content.match(/[一-鿿]/g) || []).length > threshold;
}

/**
 * 检查一个 bundle 文件，若已汉化则打印警告。
 * @param {string} filePath  bundle 路径
 * @param {string} label     展示名（如 "glass" / "desk"）
 * @param {() => void} [onHit] 已汉化回调（可选，比如作为硬失败）
 * @returns {boolean} 是否已汉化
 */
function checkBundle(filePath, label) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  if (isTranslated(content)) {
    console.log(`⚠️  ${label} bundle 已包含中文（可能已汉化）——覆盖率类脚本 0 命中属预期，请先"恢复英文"再跑`);
    return true;
  }
  return false;
}

module.exports = { isTranslated, checkBundle };