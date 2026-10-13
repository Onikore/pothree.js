// Operations check (step 8: PointQuery, EditLayer, viewer.operations), examples lion (Potree 1.x),
// potree2 (Potree 2.0), ept (Entwine) and copc (COPC):
//   - query: points in a box = brute force over all loaded points (world positions)
//   - selection.region highlights, selection.hide hides, undo restores the original image exactly
//   - selection.setAttribute writes classification, undo restores the values
//   - toJSON / fromJSON round trip; edits survive unloading and reloading the nodes
//   node tests/visual/operations.mjs [--only lion]        exit 1 on failure

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {PNG} from "pngjs";
import pixelmatch from "pixelmatch";
import {exposePotree} from "../potreeGlobal.mjs";
import {cacheRemote} from "../remoteCache.mjs"; // remote example data from disk after the first run

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const EXAMPLES = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : ["lion", "potree2", "ept", "copc"];
const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
	".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm"};
const server = http.createServer((req, res) => {
	const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404).end(); return; }
		const type = MIME[path.extname(file)] ?? "application/octet-stream";
		// Range: Potree 2.0 and COPC read nodes as byte ranges of one file
		const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
		if (range) {
			const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
			res.writeHead(206, {"Content-Type": type, "Content-Range": `bytes ${start}-${end}/${data.length}`}).end(data.subarray(start, end + 1));
			return;
		}
		res.writeHead(200, {"Content-Type": type}).end(data);
	});
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await pw.chromium.launch({args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});

const failures = [];
const check = (name, ok, what) => { console.log(`${ok ? "passed" : "FAILED"}  ${name}: ${what}`); if (!ok) failures.push(`${name}: ${what}`); };

for (const name of EXAMPLES) {
	const page = await browser.newPage({viewport: {width: 1280, height: 800}});
	await cacheRemote(page);
	page.on("pageerror", e => check(name, false, "page error " + e.message));
	await page.goto(`http://127.0.0.1:${server.address().port}/examples/${name}.html`);
	await exposePotree(page);
	await page.evaluate(async () => { window.THREE_ = await import("three"); });
	await page.waitForFunction(() => window.viewer && viewer.scene.pointclouds.length > 0, null, {timeout: 120_000});

	const settle = async () => {
		let last = "", since = Date.now();
		for (const start = Date.now(); Date.now() - start < 120_000 && Date.now() - since < 3000;) {
			await page.waitForTimeout(500);
			const s = await page.evaluate(() => JSON.stringify([Potree.numNodesLoading, viewer.scene.pointclouds.map(pc => pc.visibleNodes.length)]));
			if (s !== last) { last = s; since = Date.now(); }
		}
		await page.waitForTimeout(1000);
	};
	const shot = async () => PNG.sync.read(await page.screenshot());
	const diff = (a, b) => pixelmatch(a.data, b.data, null, a.width, a.height, {threshold: 0.05}) / (a.width * a.height);
	const run = (id, params) => page.evaluate(([id, params]) => viewer.operations.run(id, params).then(r => JSON.parse(JSON.stringify(r))), [id, params]);

	await settle();
	await page.evaluate(() => viewer.setFreeze(true));
	const original = await shot();

	// box = middle third of the cloud's world bounding box; brute force over all loaded points
	const q = await page.evaluate(() => {
		const pc = viewer.scene.pointclouds[0];
		const box = pc.getBoundingBoxWorld();
		const size = box.getSize(new THREE_.Vector3()), center = box.getCenter(new THREE_.Vector3());
		const m = new THREE_.Matrix4().compose(center, new THREE_.Quaternion(), size.clone().multiplyScalar(1 / 3));
		window.__region = new Potree.BoxRegion(m);
		const inv = m.clone().invert();
		let all = 0, inside = 0, outsideNodeBox = 0;
		for (const chunk of Potree.queryPoints(pc, null)) {
			const p = Potree.worldPositions(chunk);
			const nodeBox = chunk.node.getBoundingBox().clone().applyMatrix4(pc.matrixWorld).expandByScalar(1e-3 * size.length());
			const v = new THREE_.Vector3();
			for (let k = 0; k < p.length; k += 3) {
				v.set(p[k], p[k + 1], p[k + 2]);
				all++;
				if (!nodeBox.containsPoint(v)) outsideNodeBox++;
				v.applyMatrix4(inv);
				if (Math.abs(v.x) <= 0.5 && Math.abs(v.y) <= 0.5 && Math.abs(v.z) <= 0.5) inside++;
			}
		}
		const fast = Potree.countPoints(Potree.queryPoints(pc, __region));
		return {all, inside, fast, outsideNodeBox};
	}).catch(e => ({error: e.message}));
	if (q.error) { check(name, false, q.error); await page.close(); continue; }
	check(name, q.outsideNodeBox === 0, `world positions inside their node boxes (${q.outsideNodeBox} of ${q.all} outside)`);
	check(name, q.fast === q.inside && q.inside > 0 && q.inside < q.all, `query box = brute force (${q.fast} / ${q.inside} of ${q.all})`);

	await page.evaluate(() => viewer.operations.run("selection.region", {region: __region}));
	await page.waitForTimeout(1500);
	const stats = await run("selection.stats");
	check(name, stats.count === q.inside, `selection count ${stats.count}`);
	const selected = await shot();
	check(name, diff(original, selected) > 0.001, `selection is highlighted (diff ${(diff(original, selected) * 100).toFixed(2)}%)`);

	await run("selection.hide");
	await page.waitForTimeout(1500);
	const hidden = await shot();
	const hiddenCount = await page.evaluate(() => viewer.scene.pointclouds[0].editLayer.count(Potree.EditFlags.HIDDEN));
	check(name, hiddenCount === q.inside && (await run("selection.stats")).count === 0, `hide: ${hiddenCount} hidden, selection empty`);
	check(name, diff(selected, hidden) > 0.001, "hidden points are not drawn");

	await run("edits.undo");
	await run("edits.undo");
	await page.waitForTimeout(1500);
	const undone = await shot();
	check(name, diff(original, undone) === 0, `undo x2 restores the image (diff ${(diff(original, undone) * 100).toFixed(3)}%)`);

	await run("edits.redo");
	await run("edits.redo");
	await page.waitForTimeout(1500);
	check(name, diff(hidden, await shot()) === 0, "redo x2 = hidden image");

	// classification of the selected points
	await run("edits.showAll");
	await page.evaluate(() => viewer.operations.run("selection.region", {region: __region}));
	const cls = await page.evaluate(async () => {
		const pc = viewer.scene.pointclouds[0];
		const read = () => {
			const values = [];
			for (const chunk of Potree.queryPoints(pc, __region)) {
				const a = chunk.node.geometryNode.geometry.attributes.classification;
				if (!a) return null;
				for (const i of chunk.indices) values.push(a.array[i]);
			}
			return values;
		};
		const before = read();
		if (!before) return {skipped: true};
		await viewer.operations.run("selection.setAttribute", {attribute: "classification", value: 17});
		const after = read();
		await viewer.operations.run("edits.undo");
		const restored = read();
		return {n: before.length, set: after.every(v => v === 17), restored: restored.every((v, i) => v === before[i])};
	});
	if (cls.skipped) console.log(`skipped  ${name}: no classification attribute`);
	else check(name, cls.set && cls.restored, `classification set on ${cls.n} points and restored by undo`);

	// save / load
	const roundTrip = await page.evaluate(() => {
		const layer = viewer.scene.pointclouds[0].editLayer;
		const json = JSON.parse(JSON.stringify(layer.toJSON()));
		const before = layer.count(Potree.EditFlags.SELECTED);
		layer.fromJSON({type: "potree-edits", version: 1, nodes: {}});
		const cleared = layer.count(Potree.EditFlags.SELECTED);
		layer.fromJSON(json);
		return {before, cleared, after: layer.count(Potree.EditFlags.SELECTED)};
	});
	check(name, roundTrip.before === q.inside && roundTrip.cleared === 0 && roundTrip.after === q.inside, `toJSON/fromJSON (${JSON.stringify(roundTrip)})`);

	// unload and reload all nodes: the edits come back
	await run("selection.hide");
	await page.waitForTimeout(1500);
	const hidden2 = await shot();
	await page.evaluate(() => { viewer.setFreeze(false); window.__budget = viewer.getPointBudget(); viewer.setPointBudget(1000); });
	await page.waitForTimeout(4000);
	const unloaded = await page.evaluate(() => { Potree.state.lru.freeMemory(); return Potree.state.lru.numPoints; });
	await page.evaluate(() => viewer.setPointBudget(__budget));
	await settle();
	await page.evaluate(() => viewer.setFreeze(true));
	await page.waitForTimeout(1500);
	const reloaded = await shot();
	check(name, diff(hidden2, reloaded) < 0.002, `edits after unload (${unloaded} points left loaded) and reload (diff ${(diff(hidden2, reloaded) * 100).toFixed(3)}%)`);

	// sidebar: "Select in volumes" with a box volume = the query region, counter, Ctrl+Z
	if (await page.$("#selection_in_volumes")) {
		const ui = await page.evaluate(async () => {
			const pc = viewer.scene.pointclouds[0];
			pc.editLayer.fromJSON({type: "potree-edits", version: 1, nodes: {}});
			const volume = new Potree.BoxVolume();
			__region.matrixWorld.decompose(volume.position, volume.quaternion, volume.scale);
			viewer.scene.addVolume(volume);
			const ran = new Promise(r => { const f = () => { viewer.operations.removeEventListener("ran", f); r(); }; viewer.operations.addEventListener("ran", f); });
			$("#selection_in_volumes").trigger("click");
			await ran;
			const count = Number($("#selection_count").text().replace(/\D/g, ""));
			window.dispatchEvent(new KeyboardEvent("keydown", {key: "z", ctrlKey: true}));
			await new Promise(r => setTimeout(r, 200));
			return {count, afterUndo: pc.editLayer.count(Potree.EditFlags.SELECTED)};
		});
		check(name, ui.count === q.inside && ui.afterUndo === 0, `sidebar Select in volumes (${ui.count}) and Ctrl+Z (${ui.afterUndo} left)`);
	}

	await page.close();
}

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
