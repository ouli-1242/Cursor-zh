const fs = require("fs");
const rules = [
  ['"aria-label":"Forward",disabled', '"aria-label":"前进",disabled'],
  ['title:"Forward"', 'title:"前进"'],
  ['"spin":void 0,"aria-hidden":!0}),"Reload"]', '"spin":void 0,"aria-hidden":!0}),"重新加载"]'],
  ['title:"Reload"', 'title:"重新加载"'],
  ['"aria-label":"Reload",disabled', '"aria-label":"重新加载",disabled'],
  ['children:"Close"', 'children:"关闭"'],
  ['title:"Close"', 'title:"关闭"'],
  ['label:"Close"', 'label:"关闭"'],
  ['tooltip:"Close"', 'tooltip:"关闭"'],
  ['"aria-label":"Close"', '"aria-label":"关闭"'],
];
const src = fs.readFileSync(__dirname + "/i18n-core.js", "utf8");
for (const [en] of rules) console.log("aux含规则? " + (src.indexOf("'" + en + "'") > -1 ? "是" : "否") + "  " + en);
let c = fs.readFileSync("D:/Program Files/cursor/resources/app/out/vs/workbench/workbench.glass.main.js", "utf8");
let hits = 0;
for (const [en, zh] of rules) {
  let n = 0;
  while (c.includes(en)) { c = c.replace(en, zh); n++; }
  if (n) { hits++; console.log("命中 " + n + " 处: " + en + " → " + zh); }
}