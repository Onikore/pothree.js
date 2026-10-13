// Disk cache for remote example data in the browser tests.
//
// Many examples load their point clouds from the Potree demo server (http://5.9.65.151/mschuetz/...).
// Without a cache every test run downloads the same nodes again: slow, traffic, and the tests depend
// on a server we do not control. cacheRemote(contextOrPage) keeps responses of these hosts in
// tests/.cache/remote/ (not in git): the browser downloads a file once, later runs are served from disk.
// Key = URL + Range header. Only successful GET responses (200, 206) are stored.
//
//   NO_CACHE=1 node tests/...      bypass the cache (real network)
//   rm -rf tests/.cache            drop it
//
// Not used by tests/perf/load.mjs, which measures loading over the network.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".cache", "remote");
const HOSTS = ["5.9.65.151"];
// headers worth replaying; the body is stored decoded, so no content-encoding / length
const KEEP = ["content-type", "content-range", "accept-ranges", "last-modified", "etag",
	"access-control-allow-origin", "access-control-allow-headers", "access-control-expose-headers"];

export async function cacheRemote(target) {
	if (process.env.NO_CACHE === "1") return;
	fs.mkdirSync(DIR, {recursive: true});
	const keyOf = request => crypto.createHash("sha1").update(request.url() + "|" + (request.headers()["range"] ?? "")).digest("hex");

	// hits: served from disk; misses: the browser downloads them as usual (its network stack, proxy
	// settings included - Node's fetch / route.fetch() would not use them)
	await target.route(url => HOSTS.includes(url.hostname), async route => {
		const request = route.request();
		if (request.method() === "GET") {
			const file = path.join(DIR, keyOf(request));
			try {
				const meta = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
				return await route.fulfill({status: meta.status, headers: meta.headers, body: fs.readFileSync(file)});
			} catch (e) {
				// not cached yet
			}
		}
		return route.continue();
	});

	// store what the browser downloaded
	target.on("response", async response => {
		const request = response.request();
		if (request.method() !== "GET" || !HOSTS.includes(new URL(request.url()).hostname)) return;
		if (response.status() !== 200 && response.status() !== 206) return;
		const file = path.join(DIR, keyOf(request));
		if (fs.existsSync(file + ".json")) return; // served from the cache
		let body;
		try {
			body = await response.body();
		} catch (e) {
			return; // page closed or body not available
		}
		const headers = Object.fromEntries(Object.entries(await response.allHeaders()).filter(([k]) => KEEP.includes(k)));
		headers["access-control-allow-origin"] ??= "*";
		// temp files + rename: parallel test jobs may store the same URL
		const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
		fs.writeFileSync(tmp, body);
		fs.writeFileSync(tmp + ".json", JSON.stringify({url: request.url(), status: response.status(), headers}));
		fs.renameSync(tmp, file);
		fs.renameSync(tmp + ".json", file + ".json");
	});
}
