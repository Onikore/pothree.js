/**
 * Libraries the viewer loads only when they are needed (decision L, docs/build.md):
 *   d3          profile window - loaded together with the GUI (loadGUI)
 *   OpenLayers  mini map       - loaded when the map is opened for the first time
 * They are copied to build/potree/lazylibs/ (gulp task "lazylibs"). If the page already loaded one
 * with a <script> tag (old pages), its global is used and nothing is fetched.
 */
import {state} from "./state.js";

const scripts = new Map(); // url -> promise, so concurrent calls share one <script>

/** Loads a classic script once; resolves when it has run. */
export function loadScript(url) {
	let promise = scripts.get(url);
	if (!promise) {
		promise = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = url;
			script.onload = () => resolve();
			script.onerror = () => {
				scripts.delete(url);
				reject(new Error(`failed to load ${url}`));
			};
			document.head.appendChild(script);
		});
		scripts.set(url, promise);
	}
	return promise;
}

async function loadGlobal(name, file) {
	if (globalThis[name] === undefined) {
		await loadScript(`${state.scriptPath}/lazylibs/${file}`);
	}
	return globalThis[name];
}

export const loadD3 = () => loadGlobal("d3", "d3/d3.min.js");
export const loadOpenLayers = () => loadGlobal("ol", "openlayers3/ol.js");
