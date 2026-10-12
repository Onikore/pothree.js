/**
 * Mutable global state of Potree.
 *
 * In the original these were properties of the global `Potree` object (the UMD bundle's exports),
 * read and written all over the code base as `Potree.pointBudget`, `Potree.numNodesLoading`, ...
 * That only works in the UMD build. Here they live in one module that the code imports, so the ES
 * module build works too. The UMD build keeps `Potree.pointBudget` etc. working for pages and user
 * code by exposing these fields as accessors on the global object (src/umdCompat.js).
 */
import {LRU} from "./LRU.js";
import {WorkerPool} from "./WorkerPool.js";

function computeScriptPath() {
	// UMD (<script src=".../potree.js">): the script's own URL; ES module: import.meta.url
	let url = null;
	if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
		url = document.currentScript.src;
	} else if (import.meta && import.meta.url) {
		url = import.meta.url;
	}

	if (url === null) {
		console.error('Potree was unable to find its script path using document.currentScript. Is Potree included with a script tag? Does your browser support this function?');
		return "";
	}

	let scriptPath = new URL(url + "/..").href;
	if (scriptPath.slice(-1) === '/') {
		scriptPath = scriptPath.slice(0, -1);
	}
	return scriptPath;
}

const scriptPath = computeScriptPath(); // e.g. .../build/potree

export const state = {
	version: {major: 1, minor: 8, suffix: '.0'},

	/** points drawn per frame, all point clouds together */
	pointBudget: 1_000_000,
	/** points kept loaded (LRU), set to 2 x pointBudget by the viewer each frame */
	pointLoadLimit: 2_000_000,
	/** nodes being loaded right now */
	numNodesLoading: 0,
	/** nodes loaded in parallel. Was 4; 8 loads CA13 33% faster (PERFORMANCE.md). Above 8 no gain over HTTP/1.1 (6 connections per host). */
	maxNodesLoading: 8,
	framenumber: 0,

	lru: new LRU(),
	workerPool: new WorkerPool(),

	/** URL of the directory with potree.js / potree.module.js; workers are loaded relative to it */
	scriptPath: scriptPath,
	resourcePath: scriptPath + '/resources',

	/** performance.mark/measure around update, render, ... */
	measureTimings: false,
	debug: {},

	/** internal: point cloud -> {number, transform}, see Potree_update_visibility.js */
	_pointcloudTransformVersion: undefined,
};
