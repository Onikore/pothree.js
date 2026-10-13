// Size budget of the builds (gzip -9). Fails when a build grows past its budget, so size regressions
// show up in CI. Raise a budget deliberately, with the reason in the commit message.
//   node tests/size.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {fileURLToPath} from "node:url";

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../build/potree");
const BUDGETS_KB = {
	"potree.module.min.js": 135,   // 2026-10-13: 126.8
	"potree.module.js": 205,       // 2026-10-13: 190.8
	"potree.js": 650,              // 2026-10-13: 606.4 (UMD with three.js inside)
};

let failed = false;
for (const [file, budget] of Object.entries(BUDGETS_KB)) {
	const data = fs.readFileSync(path.join(build, file));
	const kb = zlib.gzipSync(data, {level: 9}).length / 1024;
	const ok = kb <= budget;
	failed ||= !ok;
	console.log(`${ok ? "ok    " : "FAILED"} ${file.padEnd(22)} ${(data.length / 1024).toFixed(0).padStart(5)} KB, gzip ${kb.toFixed(1)} KB (budget ${budget} KB)`);
}
process.exit(failed ? 1 : 0);
