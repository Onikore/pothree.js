// Whole-frame profile while the camera orbits: frame times and the hottest JS functions.
//
//   node tests/perf/frame.mjs [example] [seconds]          default: ca13 20
//   env: BUDGET (default 3M), GL=nvidia (real GPU via Vulkan; default SwiftShader), UNCAPPED=1 (no vsync)
//
// Waits until loading settles, then rotates the view by a fixed angle per frame (so LOD selection,
// node loading and rendering all run), records rAF frame times and a CPU profile (CDP sampling),
// and prints frame time stats and the top self-time JS functions grouped by source file.
// Run on the original code too to compare. Results: PERFORMANCE.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] ?? "ca13";
const seconds = Number(process.argv[3] ?? 20);
const budget = Number(process.env.BUDGET ?? 3_000_000);

const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm"};
const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
		const type = MIME[path.extname(file)] ?? "application/octet-stream";
		if (range) {
			const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
			res.writeHead(206, {"Content-Type": type, "Content-Range": `bytes ${start}-${end}/${data.length}`}).end(data.subarray(start, end + 1));
			return;
		}
		res.writeHead(200, {"Content-Type": type}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));

const glArgs = process.env.GL === "nvidia"
	? ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"]
	: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// UNCAPPED=1: no vsync / frame rate limit, so FPS shows the real headroom instead of 60
if (process.env.UNCAPPED === "1") glArgs.push("--disable-gpu-vsync", "--disable-frame-rate-limit");
const browser = await pw.chromium.launch({args: glArgs});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
await page.waitForFunction(() => window.viewer || window.potreeViewer);
await page.evaluate((budget) => (window.viewer || window.potreeViewer).setPointBudget(budget), budget);

let last = "", since = Date.now();
for (const start = Date.now(); Date.now() - start < 180_000;) {
	const s = await page.evaluate(() => {
		const v = window.viewer || window.potreeViewer;
		return JSON.stringify([Potree.numNodesLoading, v.scene.pointclouds.map(pc => pc.visibleNodes.length)]);
	});
	if (s !== last) { last = s; since = Date.now(); }
	if (JSON.parse(s)[0] === 0 && Date.now() - since > 5000) break;
	await page.waitForTimeout(500);
}

// orbit: rotate the view each frame, record frame intervals
await page.evaluate(() => {
	const v = window.viewer || window.potreeViewer;
	window.__frames = [];
	window.__busy = [];
	let prev = performance.now(), start = 0;
	v.addEventListener("update_start", () => {
		v.scene.view.yaw += 0.01;
		const now = performance.now();
		window.__frames.push(now - prev);
		prev = now;
		start = now;
	});
	// busy time of a frame: update + render (rAF is capped at 60 Hz, so frame intervals alone can hide differences)
	v.addEventListener("render.pass.end", () => {
		if (start) { window.__busy.push(performance.now() - start); start = 0; }
	});
});

const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", {interval: 100});
await cdp.send("Profiler.start");
await page.waitForTimeout(seconds * 1000);
const {profile} = await cdp.send("Profiler.stop");

const frames = await page.evaluate(() => window.__frames.slice(2));
const busy = (await page.evaluate(() => window.__busy.slice(2))).sort((a, b) => a - b);
const sorted = [...frames].sort((a, b) => a - b);
const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const worst1 = sorted.slice(Math.floor(0.99 * sorted.length));
const frameStats = {
	frames: frames.length,
	fps: +(1000 / (frames.reduce((s, x) => s + x, 0) / frames.length)).toFixed(1),
	low1pctFps: +(1000 / (worst1.reduce((s, x) => s + x, 0) / worst1.length)).toFixed(1),
	medianMs: +q(0.5).toFixed(2),
	p99Ms: +q(0.99).toFixed(2),
	busyMedianMs: +busy[Math.floor(0.5 * busy.length)].toFixed(2),
	busyMeanMs: +(busy.reduce((s, x) => s + x, 0) / busy.length).toFixed(2),
	busyP99Ms: +busy[Math.min(busy.length - 1, Math.floor(0.99 * busy.length))].toFixed(2),
};

const byId = new Map(profile.nodes.map(n => [n.id, n]));
const total = profile.samples.length;
const self = new Map(), files = new Map();
for (const id of profile.samples) {
	const n = byId.get(id), f = n.callFrame;
	const file = f.url ? f.url.split("/").pop() : `(${f.functionName || "native"})`;
	const key = `${f.functionName || "(anonymous)"} ${file}:${f.lineNumber + 1}`;
	self.set(key, (self.get(key) || 0) + 1);
	files.set(file, (files.get(file) || 0) + 1);
}
const pct = c => +(100 * c / total).toFixed(1);
const info = await page.evaluate(() => {
	const v = window.viewer || window.potreeViewer, gl = v.renderer.getContext();
	const e = gl.getExtension("WEBGL_debug_renderer_info");
	return {renderer: v.pRenderer.constructor.name, gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null,
		nodes: v.scene.pointclouds.reduce((s, pc) => s + pc.visibleNodes.length, 0)};
});

console.log(JSON.stringify({
	example: name, seconds, budget, ...info, frameStats,
	byFile: Object.fromEntries([...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, c]) => [k, pct(c)])),
	topFunctions: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, c]) => `${pct(c)}%  ${k}`),
}, null, 1));

await browser.close();
server.close();
