// Loading speed: time until a point cloud is loaded to the full point budget.
//
//   node tests/perf/load.mjs [example] [maxNodesLoading]     default: ca13 (build default)
//   env: BUDGET (default 10M), GL=nvidia
//
// Starts timing at page navigation, polls every 100 ms and reports: time to the first visible points,
// time until 50% / 90% / 100% of the finally visible points are visible, total nodes and the time
// when loading settled (nothing loading, node set unchanged for 3 s; the 3 s are not included).
// Remote data: run several times, network jitter matters. Results: PERFORMANCE.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {exposePotree} from "../potreeGlobal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] ?? "ca13";
const maxNodesLoading = process.argv[3] ? Number(process.argv[3]) : null;
const budget = Number(process.env.BUDGET ?? 10_000_000);

const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm"};
const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		res.writeHead(200, {"Content-Type": MIME[path.extname(file)] ?? "application/octet-stream"}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));

const glArgs = process.env.GL === "nvidia"
	? ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"]
	: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await pw.chromium.launch({args: glArgs});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
await exposePotree(page);
await page.waitForFunction(() => window.viewer || window.potreeViewer);
await page.evaluate(({budget, maxNodesLoading}) => {
	(window.viewer || window.potreeViewer).setPointBudget(budget);
	if (maxNodesLoading) Potree.maxNodesLoading = maxNodesLoading;
}, {budget, maxNodesLoading});

const samples = [];
let last = "", since = Date.now();
while (Date.now() - t0 < 300_000) {
	const s = await page.evaluate(() => {
		const v = window.viewer || window.potreeViewer;
		const pcs = v.scene.pointclouds;
		return {
			loading: Potree.numNodesLoading,
			nodes: pcs.reduce((a, pc) => a + pc.visibleNodes.length, 0),
			points: pcs.reduce((a, pc) => a + (pc.numVisiblePoints || 0), 0),
		};
	});
	samples.push({t: Date.now() - t0, ...s});
	const key = `${s.loading}/${s.nodes}`;
	if (key !== last) { last = key; since = Date.now(); }
	if (s.loading === 0 && s.nodes > 0 && Date.now() - since > 3000) break;
	await page.waitForTimeout(100);
}

// numVisiblePoints counts selected nodes even before they are loaded; use visible tree nodes'
// loaded points instead: the last sample's node count is the target
const final = samples[samples.length - 1];
const firstAt = (pred) => (samples.find(pred) ?? {t: null}).t;
const settledAt = samples.findLast(s => s.nodes !== final.nodes || s.loading !== 0)?.t ?? 0;
console.log(JSON.stringify({
	example: name, budget,
	maxNodesLoading: maxNodesLoading ?? await page.evaluate(() => Potree.maxNodesLoading),
	finalNodes: final.nodes,
	finalPoints: final.points,
	firstNodesMs: firstAt(s => s.nodes > 0),
	nodes50pctMs: firstAt(s => s.nodes >= 0.5 * final.nodes),
	nodes90pctMs: firstAt(s => s.nodes >= 0.9 * final.nodes),
	settledMs: settledAt,
}));

await browser.close();
server.close();
