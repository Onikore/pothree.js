// Memory leak check during long navigation.
//
//   node tests/perf/leak.mjs [example] [minutes]          default: ca13 10
//   env: BUDGET (default 3M), GL=nvidia
//
// Orbits and zooms in and out continuously (time based), so nodes keep being loaded and evicted by
// the LRU. Every 15 s, after a forced garbage collection: JS heap, three.js GPU objects
// (renderer.info.memory geometries/textures), points held by the LRU, visible nodes.
// A leak shows up as steady growth of geometries / heap while the LRU stays within its budget.
// Results: PERFORMANCE.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {exposePotree} from "../potreeGlobal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] ?? "ca13";
const minutes = Number(process.argv[3] ?? 10);
const budget = Number(process.env.BUDGET ?? 3_000_000);

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
const browser = await pw.chromium.launch({args: [...glArgs, "--js-flags=--expose-gc"]});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
await exposePotree(page);
await page.waitForFunction(() => (window.viewer || window.potreeViewer) && (window.viewer || window.potreeViewer).scene.pointclouds.length);

await page.evaluate((budget) => {
	const v = window.viewer || window.potreeViewer;
	v.setPointBudget(budget);
	const view = v.scene.view;
	const radius0 = view.radius;
	const pivot = view.getPivot();
	const t0 = performance.now();
	v.addEventListener("update_start", () => {
		const t = (performance.now() - t0) / 1000;
		view.yaw = 0.15 * t;                                         // one turn in ~40 s
		view.radius = radius0 * (0.35 + 0.65 * (0.5 + 0.5 * Math.cos(t / 7))); // zoom in/out
		view.position.copy(pivot).sub(view.direction.multiplyScalar(view.radius));
	});
}, budget);

const sample = () => page.evaluate(() => {
	window.gc();
	const v = window.viewer || window.potreeViewer;
	const mem = v.renderer.info.memory;
	return {
		heapMB: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1),
		geometries: mem.geometries,
		textures: mem.textures,
		lruPoints: Potree.lru.numPoints,
		visibleNodes: v.scene.pointclouds.reduce((s, pc) => s + pc.visibleNodes.length, 0),
	};
});

const samples = [];
const start = Date.now();
while (Date.now() - start < minutes * 60_000) {
	await page.waitForTimeout(15_000);
	const s = {minute: +((Date.now() - start) / 60_000).toFixed(2), ...(await sample())};
	samples.push(s);
	console.log(JSON.stringify(s));
}

const half = samples.slice(Math.floor(samples.length / 2));
const max = (k, a) => Math.max(...a.map(s => s[k]));
const min = (k, a) => Math.min(...a.map(s => s[k]));
console.log(JSON.stringify({
	summary: true,
	renderer: await page.evaluate(() => (window.viewer || window.potreeViewer).pRenderer.constructor.name),
	secondHalf: {
		heapMB: [min("heapMB", half), max("heapMB", half)],
		geometries: [min("geometries", half), max("geometries", half)],
		lruPoints: [min("lruPoints", half), max("lruPoints", half)],
	},
	first: samples[0], last: samples[samples.length - 1],
}));

await browser.close();
server.close();
