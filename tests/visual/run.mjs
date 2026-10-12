// Visual regression and smoke test for every page in examples/.
//
// For each example: open it in a headless browser, wait until point cloud loading has settled,
// put the camera at the position recorded in the baseline, take a screenshot and compare it
// with the baseline. Console errors/warnings and page errors are collected per example.
//
//   node tests/visual/run.mjs --update              record baseline (run on the reference code)
//   node tests/visual/run.mjs                       compare against baseline, exit 1 on failure
//   options: --only a,b  --browser chromium|firefox|webkit  --group formats  --jobs N (default 4)
//
// Baseline: tests/visual/baseline/<name>.png + baseline.json (camera, visible points, console).
// Results:  tests/visual/output/<name>.png, <name>.diff.png, report.json.
// Per-example tolerances and skips: tests/visual/config.json. See docs/testing.md.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import pixelmatch from "pixelmatch";
import {PNG} from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const baselineDir = path.join(here, "baseline");
const outputDir = path.join(here, "output");
const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const update = args.includes("--update");
const browserName = arg("--browser") ?? "chromium";
const jobs = Number(arg("--jobs") ?? 4);
const only = arg("--only")?.split(",") ?? (arg("--group") ? config.groups[arg("--group")] : null);

const VIEWPORT = {width: 1280, height: 800};
const SETTLE_MS = 2000;     // loading must stay idle this long
const TIMEOUT_MS = 90_000;  // per example

// ponytail: minimal static server, enough for examples (no ranges, no caching)
const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
	".wasm": "application/wasm"};
function serve() {
	const server = http.createServer((req, res) => {
		const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
		if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404).end(); return; }
			res.writeHead(200, {"Content-Type": MIME[path.extname(file)] ?? "application/octet-stream"}).end(data);
		});
	});
	return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Runs in the page: finds the Potree viewer in the page or in a child iframe.
const FIND_VIEWER = `(() => {
	const wins = [window, ...Array.from(document.querySelectorAll("iframe")).map(f => f.contentWindow)];
	for (const w of wins) {
		try { const v = w.viewer || w.potreeViewer; if (v && v.scene) return {w, v}; } catch (e) {}
	}
	return null;
})()`;

// Runs in the page: loading state. "settled" = no nodes loading and visible point count unchanged.
const STATE = `(() => {
	const f = ${FIND_VIEWER};
	if (!f) return null;
	const pcs = f.v.scene.pointclouds;
	return {
		loading: f.w.Potree.numNodesLoading,
		pointclouds: pcs.length,
		points: pcs.reduce((s, pc) => s + (pc.numVisiblePoints || 0), 0),
	};
})()`;

async function waitSettled(page, expectPointclouds) {
	const start = Date.now();
	let last = null, stableSince = Date.now();
	while (Date.now() - start < TIMEOUT_MS) {
		const s = await page.evaluate(STATE).catch(() => null);
		const key = s && JSON.stringify(s);
		if (key !== last) { last = key; stableSince = Date.now(); }
		const ready = s ? (s.loading === 0 && (!expectPointclouds || s.pointclouds > 0)) : !expectPointclouds;
		if (ready && Date.now() - stableSince >= SETTLE_MS) return s;
		await page.waitForTimeout(250);
	}
	throw new Error(`not settled after ${TIMEOUT_MS} ms, last state ${last}`);
}

async function getView(page) {
	return page.evaluate(`(() => {
		const f = ${FIND_VIEWER};
		if (!f) return null;
		const v = f.v.scene.view, p = v.getPivot();
		return {position: v.position.toArray(), target: [p.x, p.y, p.z]};
	})()`);
}

async function setView(page, view) {
	await page.evaluate(`(() => {
		const f = ${FIND_VIEWER};
		const v = f.v.scene.view;
		v.position.set(...${JSON.stringify(view.position)});
		v.lookAt(...${JSON.stringify(view.target)});
	})()`);
}

function compare(name, actualPng) {
	const expected = PNG.sync.read(fs.readFileSync(path.join(baselineDir, `${name}.png`)));
	const actual = PNG.sync.read(actualPng);
	if (expected.width !== actual.width || expected.height !== actual.height) return {ratio: 1, reason: "size differs"};
	const diff = new PNG({width: actual.width, height: actual.height});
	const n = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {threshold: 0.1});
	fs.writeFileSync(path.join(outputDir, `${name}.diff.png`), PNG.sync.write(diff));
	return {ratio: n / (actual.width * actual.height)};
}

async function runExample(browser, baseUrl, name, baseline) {
	const cfg = {...config.defaults, ...config.examples[name]};
	const result = {name, console: [], errors: []};
	if (cfg.skip) return {...result, status: "skipped", reason: cfg.skip};

	const context = await browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 1});
	const page = await context.newPage();
	page.on("console", m => { if (m.type() === "error" || m.type() === "warning") result.console.push(`${m.type()}: ${m.text()}`); });
	page.on("pageerror", e => result.errors.push(String(e)));
	try {
		await page.goto(`${baseUrl}/examples/${name}.html`, {waitUntil: "load", timeout: TIMEOUT_MS});
		let state = await waitSettled(page, cfg.pointclouds);
		const view = update ? await getView(page) : baseline?.view;
		if (view && !update) {
			await setView(page, view);
			state = await waitSettled(page, cfg.pointclouds);
		}
		const png = await page.screenshot();
		Object.assign(result, {state, view});

		if (update) {
			fs.writeFileSync(path.join(baselineDir, `${name}.png`), png);
			result.status = "recorded";
		} else {
			fs.writeFileSync(path.join(outputDir, `${name}.png`), png);
			const {ratio, reason} = compare(name, png);
			result.diff = ratio;
			const problems = [];
			if (reason) problems.push(reason);
			if (ratio > cfg.maxDiff) problems.push(`diff ${(ratio * 100).toFixed(2)}% > ${(cfg.maxDiff * 100).toFixed(2)}%`);
			if (cfg.pointclouds && !(state.points > 0)) problems.push("no visible points");
			const newErrors = result.errors.filter(e => !(baseline?.errors ?? []).includes(e));
			if (newErrors.length) problems.push(`new page errors: ${newErrors.join(" | ")}`);
			result.status = problems.length ? "failed" : "passed";
			result.problems = problems;
		}
	} catch (e) {
		Object.assign(result, {status: "failed", problems: [String(e.message ?? e)]});
	} finally {
		await context.close();
	}
	return result;
}

const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await pw[browserName].launch({
	args: browserName === "chromium" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [],
});

fs.mkdirSync(update ? baselineDir : outputDir, {recursive: true});
const baselineFile = path.join(baselineDir, "baseline.json");
const baselines = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
const names = fs.readdirSync(path.join(root, "examples"))
	.filter(f => f.endsWith(".html")).map(f => f.slice(0, -5))
	.filter(n => !only || only.includes(n)).sort();

// Examples run in parallel, each in its own browser context. Rendering is deterministic
// (SwiftShader), so parallelism only changes timing, not screenshots.
const results = [];
const queue = [...names];
await Promise.all(Array.from({length: jobs}, async () => {
	for (let name; (name = queue.shift()) !== undefined;) {
		const r = await runExample(browser, baseUrl, name, baselines[name]);
		results.push(r);
		console.log(`${r.status.padEnd(8)} ${name}${r.diff !== undefined ? ` diff=${(r.diff * 100).toFixed(2)}%` : ""}${r.problems?.length ? "  " + r.problems.join("; ") : ""}${r.reason ? "  " + r.reason : ""}`);
	}
}));
results.sort((a, b) => a.name.localeCompare(b.name));

if (update) {
	for (const r of results) if (r.status === "recorded") baselines[r.name] = {view: r.view, state: r.state, console: r.console, errors: r.errors, browser: browserName};
	fs.writeFileSync(baselineFile, JSON.stringify(baselines, null, "\t"));
} else {
	fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(results, null, "\t"));
}

await browser.close();
server.close();
const failed = results.filter(r => r.status === "failed");
console.log(`\n${results.length} examples: ${results.filter(r => r.status === "passed" || r.status === "recorded").length} ok, ${failed.length} failed, ${results.filter(r => r.status === "skipped").length} skipped`);
process.exit(failed.length && !update ? 1 : 0);
