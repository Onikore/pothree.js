// Render-on-demand check (viewer.renderOnDemand = true), example lion:
//   1. after loading the loop goes idle: Potree.framenumber stops growing;
//   2. the idle frame equals what continuous rendering draws (nothing left half-loaded);
//   3. input (wheel) and a view change from code wake the loop up.
//   node tests/visual/ondemand.mjs        exit 1 on failure

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {PNG} from "pngjs";
import pixelmatch from "pixelmatch";
import {exposePotree} from "../potreeGlobal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml"};
const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => err ? res.writeHead(404).end()
		: res.writeHead(200, {"Content-Type": MIME[path.extname(file)] ?? "application/octet-stream"}).end(data));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await pw.chromium.launch({args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await page.goto(`http://127.0.0.1:${server.address().port}/examples/lion.html`);
await exposePotree(page);
await page.waitForFunction(() => window.viewer && viewer.scene.pointclouds.length > 0, null, {timeout: 120_000});
await page.evaluate(() => { viewer.renderOnDemand = true; });

const frame = () => page.evaluate(() => Potree.framenumber);
async function waitIdle() {
	let last = -1;
	for (let i = 0; i < 120; i++) {
		await page.waitForTimeout(1000);
		const f = await frame();
		if (f === last) return true;
		last = f;
	}
	return false;
}
const shot = async () => PNG.sync.read(await page.screenshot());

const failures = [];
const check = (ok, what) => { console.log(`${ok ? "passed" : "FAILED"}  ${what}`); if (!ok) failures.push(what); };

check(await waitIdle(), "loop goes idle after loading");
const f0 = await frame();
await page.waitForTimeout(2000);
check(await frame() === f0, "no frames while idle");

const idle = await shot();
await page.evaluate(() => { viewer.renderOnDemand = false; });
await page.waitForTimeout(5000);
const continuous = await shot();
const diff = pixelmatch(idle.data, continuous.data, null, idle.width, idle.height, {threshold: 0.1}) / (idle.width * idle.height);
check(diff < 0.001, `idle frame equals continuous rendering (diff ${(diff * 100).toFixed(2)}%)`);

await page.evaluate(() => { viewer.renderOnDemand = true; });
await waitIdle();
let f1 = await frame();
await page.mouse.move(640, 400);
await page.mouse.wheel(0, -200);
await page.waitForTimeout(1000);
check(await frame() > f1, "wheel input renders frames");

await waitIdle();
f1 = await frame();
await page.evaluate(() => { viewer.scene.view.position.x += 1; });
await page.waitForTimeout(1000);
check(await frame() > f1, "view change from code renders frames");

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
