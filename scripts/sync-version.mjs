import { readFileSync, writeFileSync } from "node:fs";

const bot = readFileSync("bot.js", "utf8");
const m = bot.match(/const BOT_VERSION = "([^"]+)";/);
if (!m) {
  console.error("bot.js 里没找到 BOT_VERSION，已中止");
  process.exit(1);
}
const v = m[1];

const readme = readFileSync("README.md", "utf8");
const next = readme
  .replace(/(%E7%89%88%E6%9C%AC-)v[0-9.]+/g, `$1v${v}`)  // 版本徽章
  .replace(/(Bot )v[0-9.]+/g, `$1v${v}`);                   // 教程正文

if (next === readme) {
  console.log("README 无需修改");
} else {
  writeFileSync("README.md", next);
  console.log("README 已同步到 v" + v);
}
