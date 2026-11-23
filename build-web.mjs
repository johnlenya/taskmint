// Copies the static site into web/ for Qoder Sites packaging.
import fs from "node:fs";

const PAGES = ["index.html", "app.html", "payouts.html", "legal.html"];
const ASSETS = ["app.js", "styles.css"];

fs.rmSync("web", { recursive: true, force: true });
fs.mkdirSync("web/assets", { recursive: true });
for (const page of PAGES) fs.copyFileSync(page, "web/" + page);
for (const asset of ASSETS) fs.copyFileSync("assets/" + asset, "web/assets/" + asset);
console.log("web/ ready: " + [...PAGES, ...ASSETS.map((a) => "assets/" + a)].join(", "));
