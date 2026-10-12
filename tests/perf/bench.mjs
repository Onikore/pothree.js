// CPU-side cost of drawing the point clouds: legacy raw-WebGL renderer vs three.js renderer.
//
//   node tests/perf/bench.mjs [example] [iterations]      default: ca13 300
//
// Opens the example, waits until loading settles, then in the same page and the same frame state
// calls pRenderer.render(scenePointCloud, camera) `iterations` times for each renderer, alternating
// in blocks, and reports per-call times. gl.finish() after each call makes the GPU work part of the
// measurement as well; under SwiftShader (software GL, used for determinism) absolute numbers are
// CPU raster times, so compare the two renderers with each other, not with real hardware.
// Results and method: PERFORMANCE.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const name = process.argv[2] ?? "ca13";
const iterations = Number(process.argv[3] ?? 300);

const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
		res.writeHead(200, {"Content-Type": type}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));

const browser = await pw.chromium.launch({args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
const budget = Number(process.env.BUDGET ?? 3_000_000);
await page.waitForFunction(() => window.viewer || window.potreeViewer);
await page.evaluate((budget) => {
	const v = window.viewer || window.potreeViewer;
	v.setPointBudget(budget);
	v.setMinNodeSize(0); // many small nodes: per-node overhead is what differs between the renderers
}, budget);

// settle: nothing loading and visible nodes unchanged for 5 s
let last = "", since = Date.now();
for (const start = Date.now(); Date.now() - start < 180_000;) {
	const s = await page.evaluate(() => {
		const v = window.viewer || window.potreeViewer;
		return v && JSON.stringify([Potree.numNodesLoading, v.scene.pointclouds.map(pc => pc.visibleNodes.length)]);
	});
	if (s !== last) { last = s; since = Date.now(); }
	if (s && JSON.parse(s)[0] === 0 && Date.now() - since > 10000) break;
	await page.waitForTimeout(500);
}

const result = await page.evaluate((iterations) => {
	const v = window.viewer || window.potreeViewer;
	v.setFreeze?.(true); // keep the node set fixed while measuring
	const r = v.renderer, gl = r.getContext();
	const camera = v.scene.getActiveCamera();
	const renderers = {legacy: new Potree.Renderer(r), three: new Potree.PointCloudRenderer(r)};
	// cpu: time of the render() calls themselves (JS + three.js + GL command submission) - the cost
	// three.js adds per node shows up here. total: until the GPU (here SwiftShader) has finished.
	// Timed per block of 10 calls (browser timers are coarse, ~0.1 ms) and divided by 10.
	const times = {legacy: {cpu: [], total: []}, three: {cpu: [], total: []}};

	const block = (key) => {
		gl.finish();
		const t0 = performance.now();
		for (let i = 0; i < 10; i++) {
			renderers[key].render(v.scene.scenePointCloud, camera, null, {});
		}
		const t1 = performance.now();
		gl.finish();
		const t2 = performance.now();
		times[key].cpu.push((t1 - t0) / 10);
		times[key].total.push((t2 - t0) / 10);
	};

	for (let k of ["legacy", "three"]) for (let i = 0; i < 3; i++) block(k); // warm up, compile
	for (let k of ["legacy", "three"]) { times[k].cpu.length = 0; times[k].total.length = 0; }

	for (let b = 0; b < iterations / 10; b++) {
		for (let k of (b % 2 ? ["legacy", "three"] : ["three", "legacy"])) {
			block(k);
		}
	}

	const stats = (a) => {
		a = [...a].sort((x, y) => x - y);
		const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
		return {median: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), max: +a[a.length - 1].toFixed(3), mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)};
	};
	const pcs = v.scene.pointclouds;
	return {
		nodes: pcs.reduce((s, pc) => s + pc.visibleNodes.length, 0),
		points: pcs.reduce((s, pc) => s + pc.numVisiblePoints, 0),
		cpu: {legacy: stats(times.legacy.cpu), three: stats(times.three.cpu)},
		total: {legacy: stats(times.legacy.total), three: stats(times.three.total)},
	};
}, iterations);

const ratio = (m) => +(result[m].three.median / result[m].legacy.median).toFixed(3);
console.log(JSON.stringify({example: name, iterations, ...result, threeVsLegacy: {cpu: ratio("cpu"), total: ratio("total")}}, null, 2));

await browser.close();
server.close();
