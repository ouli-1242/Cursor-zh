const fs = require("fs");
const src = fs.readFileSync(__dirname + "/i18n-core.js", "utf8");
const mod = new Function("require", "__dirname", "module", src + ";\nmodule.exports={translate, restore, __aux:auxiliaryInterfaceReplacements, __scoped:scopedReplacements}");
const g = mod(require, __dirname, {});
const aux = g.__aux;
const scoped = g.__scoped;
const files = [
  ["glass", "D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js"],
  ["desk", "D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js"],
];
const check = [
  '"aria-label":"Forward"', 'title:"Forward"',
  '"aria-label":"Reload"', 'title:"Reload"',
  ',"Reload"]', 'children:"Close"', 'title:"Close"', 'label:"Close"', 'tooltip:"Close"', '"aria-label":"Close"',
];
for (const [name, fp] of files) {
  let c = fs.readFileSync(fp, "utf8");
  const rules = name === "glass" ? aux : scoped;
  let hits = 0;
  for (const [en, zh] of rules) {
    let n = 0;
    while (c.includes(en)) { c = c.replace(en, zh); n++; }
    if (n) hits++;
  }
  console.log("==== " + name + " 命中规则数: " + hits);
  for (const t of check) {
    if (c.includes(t)) console.log("  残留! " + t + " ctx:" + JSON.stringify(c.slice(c.indexOf(t) - 25, c.indexOf(t) + 25)).slice(0, 110));
  }
  console.log("  未列出即无残留(desk 无 Forward 属预期)");
}