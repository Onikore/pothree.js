// Cost of drawing the point clouds with the build's own point renderer (viewer.pRenderer).
// Run it on the original code and on the fork to compare them (PERFORMANCE.md).
//
//   node tests/perf/bench.mjs [example] [iterations]      default: ca13 300
//   env: BUDGET (points, default 3M), SCISSOR=1 (draw into 1x1 px), GL=nvidia (real GPU via Vulkan),
//        UNCAPPED=1 (no vsync), LOAD_TIMEOUT (seconds, default 180)
//
// Opens the example (point budget BUDGET, default 3M; min node size 0 = many nodes), waits until
// loading settles, freezes the node set and calls pRenderer.render(scenePointCloud, camera)
// `iterations` times, reporting per-call times. gl.finish() after each call makes the GPU work part of the
// measurement as well; under SwiftShader (software GL, used for determinism) absolute numbers are
// CPU raster times, so compare the two renderers with each other, not with real hardware.
// Results and method: PERFORMANCE.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {exposePotree} from "../potreeGlobal.mjs";
import {cacheRemote} from "../remoteCache.mjs"; // remote example data from disk after the first run

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] ?? "ca13";
const iterations = Number(process.argv[3] ?? 300);

const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm"};

const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		const type = MIME[path.extname(file)] ?? "application/octet-stream"; // text/css matters: without it the layout breaks
		res.writeHead(200, {"Content-Type": type}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));

// GL=nvidia: real GPU through ANGLE/Vulkan (this machine: RTX 4050); default: SwiftShader (CPU)
const glArgs = process.env.GL === "nvidia"
	? ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"]
	: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// UNCAPPED=1: no vsync, so the frame rate shows the real headroom
if (process.env.UNCAPPED === "1") glArgs.push("--disable-gpu-vsync", "--disable-frame-rate-limit");
const loadTimeout = Number(process.env.LOAD_TIMEOUT ?? 180) * 1000; // s, large budgets need minutes
const browser = await pw.chromium.launch({args: glArgs});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await cacheRemote(page);
await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
await exposePotree(page);
const budget = Number(process.env.BUDGET ?? 3_000_000);
await page.waitForFunction(() => window.viewer || window.potreeViewer);
await page.evaluate((budget) => {
	const v = window.viewer || window.potreeViewer;
	v.setPointBudget(budget);
	v.setMinNodeSize(0); // many small nodes: per-node overhead is what differs between the renderers
}, budget);

// settle: nothing loading and visible nodes unchanged for 5 s
const loadStart = Date.now();
let last = "", since = Date.now();
for (const start = Date.now(); Date.now() - start < loadTimeout;) {
	const s = await page.evaluate(() => {
		const v = window.viewer || window.potreeViewer;
		return v && JSON.stringify([Potree.numNodesLoading, v.scene.pointclouds.map(pc => pc.visibleNodes.length)]);
	});
	if (s !== last) { last = s; since = Date.now(); }
	if (s && JSON.parse(s)[0] === 0 && Date.now() - since > 10000) break;
	await page.waitForTimeout(500);
}
const loadSeconds = +((since - loadStart) / 1000).toFixed(1); // until the node set stopped changing

const scissor = process.env.SCISSOR === "1";
const result = await page.evaluate(({iterations, scissor}) => {
	const v = window.viewer || window.potreeViewer;
	v.setFreeze?.(true); // keep the node set fixed while measuring
	const r = v.renderer, gl = r.getContext();
	const camera = v.scene.getActiveCamera();
	const pointRenderer = v.pRenderer; // the build's own point cloud renderer (original: Renderer, fork: PointCloudRenderer)
	if (scissor) {
		// 1x1 px scissor: (almost) no rasterization, so only the CPU cost of issuing the draws is left.
		// Without it SwiftShader rasterizes on the CPU and its back-pressure dominates the timings.
		r.setScissor(0, 0, 1, 1);
		r.setScissorTest(true);
	}

	// cpu: time of the render() calls themselves (JS + three.js + GL command submission) - this is
	// where per-node overhead shows. total: until the GPU (here SwiftShader) has finished.
	// Timed per block of 10 calls (browser timers are coarse, ~0.1 ms) and divided by 10.
	const times = {cpu: [], total: []};
	const block = () => {
		gl.finish();
		const t0 = performance.now();
		for (let i = 0; i < 10; i++) {
			pointRenderer.render(v.scene.scenePointCloud, camera, null, {});
		}
		const t1 = performance.now();
		gl.finish();
		const t2 = performance.now();
		times.cpu.push((t1 - t0) / 10);
		times.total.push((t2 - t0) / 10);
	};

	for (let i = 0; i < 3; i++) block(); // warm up, compile
	times.cpu.length = 0; times.total.length = 0;
	for (let b = 0; b < iterations / 10; b++) block();

	const stats = (a) => {
		a = [...a].sort((x, y) => x - y);
		const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
		return {median: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +a[a.length - 1].toFixed(3), mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)};
	};
	const pcs = v.scene.pointclouds;
	return {
		renderer: pointRenderer.constructor.name,
		three: (window.__THREE__ || null),
		canvas: [r.domElement.width, r.domElement.height],
		nodes: pcs.reduce((s, pc) => s + pc.visibleNodes.length, 0),
		points: pcs.reduce((s, pc) => s + pc.numVisiblePoints, 0),
		gpu: (() => { const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; })(),
		jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
		cpu: stats(times.cpu),
		total: stats(times.total),
	};
}, {iterations, scissor});

// whole frames of the running viewer (node set frozen above): frame rate and busy time, 10 s
const frames = await page.evaluate(() => new Promise(resolve => {
	const v = window.viewer || window.potreeViewer;
	const intervals = [], busy = [];
	let prev = performance.now(), start = 0;
	const onStart = () => { const now = performance.now(); intervals.push(now - prev); prev = now; start = now; };
	const onEnd = () => { if (start) { busy.push(performance.now() - start); start = 0; } };
	v.addEventListener("update_start", onStart);
	v.addEventListener("render.pass.end", onEnd);
	setTimeout(() => {
		v.removeEventListener("update_start", onStart);
		v.removeEventListener("render.pass.end", onEnd);
		const sorted = intervals.slice(2).sort((a, b) => a - b), b = busy.slice(2).sort((a, b) => a - b);
		const worst = sorted.slice(Math.floor(0.99 * sorted.length));
		resolve({
			fps: +(1000 / (sorted.reduce((s, x) => s + x, 0) / sorted.length)).toFixed(1),
			low1pctFps: +(1000 / (worst.reduce((s, x) => s + x, 0) / worst.length)).toFixed(1),
			frameMedianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
			busyMedianMs: +b[Math.floor(b.length / 2)].toFixed(2),
		});
	}, 10000);
}));

console.log(JSON.stringify({example: name, iterations, budget, scissor, loadSeconds, ...result, frames}, null, 2));

await browser.close();
server.close();
