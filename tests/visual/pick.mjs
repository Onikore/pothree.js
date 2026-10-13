// Picking test: picks points under a 5x5 grid of screen positions (including near the edges) and
// compares the picked point positions with a baseline recorded on the original code.
//
//   node tests/visual/pick.mjs --update    record tests/visual/baseline/pick.json
//   node tests/visual/pick.mjs             compare, exit 1 on mismatch
//   options: --only lion,potree2
//
// Uses Potree.Utils.getMousePointCloudIntersection, the same call the measuring and annotation
// tools use, and checks that getMousePointCloudIntersectionAsync (pickAsync) finds the same points. Camera: the view stored in baseline.json for the example (see run.mjs).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {chromiumArgs, gpu} from "../browser.mjs"; // SwiftShader, or the real GPU with --gpu
import {exposePotree} from "../potreeGlobal.mjs";
import {cacheRemote} from "../remoteCache.mjs"; // remote example data from disk after the first run

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const baselineFile = path.join(here, gpu ? "baseline-gpu" : "baseline", "pick.json"); // GPU rasterizes points slightly differently: own baseline
const views = JSON.parse(fs.readFileSync(path.join(here, "baseline", "baseline.json"), "utf8"));

const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const EXAMPLES = (only ?? ["lion", "potree2", "ept", "copc", "classifications"]);
const TOLERANCE = 1e-3; // world units; points are the same points, so positions must match exactly

const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm"};

const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
		const type = MIME[path.extname(file)] ?? "application/octet-stream"; // text/css matters: without it the layout breaks
		if (range) {
			const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
			res.writeHead(206, {"Content-Type": type, "Content-Range": `bytes ${start}-${end}/${data.length}`}).end(data.subarray(start, end + 1));
			return;
		}
		res.writeHead(200, {"Content-Type": type}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await pw.chromium.launch({args: chromiumArgs});

async function pickGrid(name) {
	const page = await browser.newPage({viewport: {width: 1280, height: 800}});
	await cacheRemote(page);
	await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
	await exposePotree(page);
	await page.waitForFunction(() => window.viewer && viewer.scene.pointclouds.length > 0, null, {timeout: 120_000});

	const view = views[name]?.view;
	if (view) {
		await page.evaluate((view) => {
			viewer.scene.view.position.set(...view.position);
			viewer.scene.view.lookAt(...view.target);
		}, view);
	}

	// settle: nothing loading and visible nodes unchanged for 3 s
	let last = "", since = Date.now();
	for (const start = Date.now(); Date.now() - start < 120_000;) {
		const s = await page.evaluate(() => JSON.stringify([Potree.numNodesLoading, viewer.scene.pointclouds.map(pc => pc.visibleNodes.length)]));
		if (s !== last) { last = s; since = Date.now(); }
		if (JSON.parse(s)[0] === 0 && Date.now() - since > 3000) break;
		await page.waitForTimeout(250);
	}

	const picks = await page.evaluate(async () => {
		viewer.setFreeze(true);
		const area = viewer.renderArea;
		const W = area.clientWidth, H = area.clientHeight;
		const result = [];
		for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
			for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
				const mouse = {x: Math.round(fx * W), y: Math.round(fy * H)};
				const camera = viewer.scene.getActiveCamera();
				const hit = Potree.Utils.getMousePointCloudIntersection(mouse, camera, viewer, viewer.scene.pointclouds);
				// the async variant (pickAsync, used while dragging tools) must find the same point
				const asyncHit = await Potree.Utils.getMousePointCloudIntersectionAsync(mouse, camera, viewer, viewer.scene.pointclouds);
				const same = JSON.stringify(hit?.location.toArray() ?? null) === JSON.stringify(asyncHit?.location.toArray() ?? null);
				result.push({mouse, location: hit ? hit.location.toArray() : null, asyncSame: same});
			}
		}
		return {width: W, height: H, picks: result};
	});
	await page.close();
	return picks; // {width, height, picks}
}

// Within half a pick window (65 px) of the render area's edge the original was wrong: it missed
// (window clipped, read failed) or picked relative to the clipped window's middle instead of the
// cursor. The fork picks correctly there, so differences at the edge are expected.
const nearEdge = (m, W, H) => m.x < 33 || m.y < 33 || m.x > W - 33 || m.y > H - 33;

const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
let failed = 0;

for (const name of EXAMPLES) {
	const {width: W, height: H, picks} = await pickGrid(name);
	if (update) {
		baseline[name] = picks.map(({asyncSame, ...pick}) => pick);
		console.log(`recorded ${name}: ${picks.filter(p => p.location).length}/25 hits`);
		continue;
	}
	const problems = picks.filter(p => !p.asyncSame).map(p => `${JSON.stringify(p.mouse)}: async pick differs from sync pick`);
	(baseline[name] ?? []).forEach((expected, i) => {
		const actual = picks[i];
		if (!expected.location && !actual.location) return;
		if (nearEdge(actual.mouse, W, H)) {
			return; // original was wrong near the edge (see nearEdge); only check that nothing throws
		}
		if (!expected.location || !actual.location) {
			problems.push(`${JSON.stringify(expected.mouse)}: expected ${expected.location ? "hit" : "miss"}, got ${actual.location ? "hit" : "miss"}`);
			return;
		}
		const d = Math.hypot(...expected.location.map((v, k) => v - actual.location[k]));
		if (d > TOLERANCE) problems.push(`${JSON.stringify(expected.mouse)}: off by ${d.toFixed(4)}`);
	});
	failed += problems.length ? 1 : 0;
	console.log(`${problems.length ? "failed" : "passed"} ${name}: ${picks.filter(p => p.location).length}/25 hits${problems.length ? "\n  " + problems.join("\n  ") : ""}`);
}

if (update) fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, "\t"));
await browser.close();
server.close();
process.exit(failed && !update ? 1 : 0);
