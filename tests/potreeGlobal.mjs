// The tests read and write `Potree.numNodesLoading`, `Potree.maxNodesLoading`, `Potree.Utils`, ... in
// the page. The original code (UMD) has a global Potree; the fork's examples import the ES module
// build (build/potree/potree.module.js) and have none. This makes `window.Potree` in such a page:
// module exports for API names, `state` (src/state.js) for state fields.
export async function exposePotree(page) {
	await page.evaluate(async () => {
		if (window.Potree) return;
		const m = await import("potree");
		window.Potree = new Proxy(m, {
			get: (t, k) => (k in t ? t[k] : t.state[k]),
			set: (t, k, v) => { t.state[k] = v; return true; },
		});
	});
}
