/**
 * UMD build only (build/potree/potree.js, global `Potree`): exposes the fields of `state`
 * (src/state.js) as accessor properties of the global Potree object, so pages and user code that
 * read or write `Potree.pointBudget`, `Potree.numNodesLoading`, `Potree.maxNodesLoading`, ... keep
 * working as in the original, where these were plain properties of that object.
 *
 * In the UMD bundle the global Potree object exists before any module code runs (it is the bundle's
 * exports object), so the accessors are installed here, at import time.
 */
import {state} from "./state.js";

const potreeGlobal = globalThis.Potree;

if (potreeGlobal && typeof potreeGlobal === "object") {
	for (const key of Object.keys(state)) {
		Object.defineProperty(potreeGlobal, key, {
			get: () => state[key],
			set: (value) => { state[key] = value; },
			enumerable: true,
			configurable: true,
		});
	}
}
