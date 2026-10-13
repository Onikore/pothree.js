/**
 * Operations registry: `viewer.operations`. One place where operations on point clouds are
 * registered and run, so the sidebar, hotkeys and external code use the same entry points.
 * See docs/operations.md.
 *
 *   viewer.operations.register({id, kind, label, run(ctx, params)})
 *   await viewer.operations.run("selection.region", {region: new BoxRegion(volume.matrixWorld)})
 *
 * kind: "view" (display only, shader), "query" (reads points), "edit" (changes points through the
 * EditLayer, undoable), "compute" (derives new data). ctx = {viewer, pointclouds, query, queryAsync, edits}:
 *   pointclouds  params.pointclouds or all visible point clouds of the scene
 *   query        queryPoints (src/operations/PointQuery.js)
 *   queryAsync   queryPointsAsync: same, without freezing the page on large clouds
 *   edits(pc)    the EditLayer of a point cloud
 */
import * as THREE from "three";
import {queryPoints, queryPointsAsync, countPoints, worldPositions} from "./PointQuery.js";
import {editLayerOf, EditFlags} from "./EditLayer.js";

export const OperationKinds = Object.freeze(["view", "query", "edit", "compute"]);

export class Operations extends THREE.EventDispatcher {
	constructor(viewer) {
		super();
		this.viewer = viewer;
		this.registry = new Map();
		for (const operation of builtInOperations) {
			this.register(operation);
		}
	}

	register(operation) {
		const {id, kind, run} = operation;
		if (typeof id !== "string" || !id) throw new Error("operation needs an id");
		if (!OperationKinds.includes(kind)) throw new Error(`operation ${id}: kind must be one of ${OperationKinds.join(", ")}`);
		if (typeof run !== "function") throw new Error(`operation ${id}: run(ctx, params) missing`);
		this.registry.set(id, {label: id, ...operation});
		this.dispatchEvent({type: "registered", operation: this.registry.get(id)});
		return this.registry.get(id);
	}

	get(id) {
		return this.registry.get(id);
	}

	list(kind = null) {
		return [...this.registry.values()].filter(o => kind === null || o.kind === kind);
	}

	context(params) {
		const viewer = this.viewer;
		return {
			viewer,
			pointclouds: params.pointclouds ?? viewer.scene.pointclouds.filter(pc => pc.visible),
			query: queryPoints,
			queryAsync: queryPointsAsync,
			edits: editLayerOf,
		};
	}

	/** Runs operation `id`; always returns a promise (operations may be async). */
	async run(id, params = {}) {
		const operation = this.registry.get(id);
		if (!operation) throw new Error(`unknown operation ${id}`);
		const result = await operation.run(this.context(params), params);
		if (operation.kind === "edit") this.viewer.requestRender?.();
		this.dispatchEvent({type: "ran", operation, params, result});
		return result;
	}
}

/** One undoable step per point cloud: commands of several clouds are executed per layer. */
function executePerCloud(ctx, makeCommand) {
	let changed = 0;
	for (const pointcloud of ctx.pointclouds) {
		const layer = ctx.edits(pointcloud);
		const command = makeCommand(layer, pointcloud);
		if (command.changes.length === 0) continue;
		layer.execute(command);
		for (const c of command.changes) changed += c.indices.length;
	}
	return {changed};
}

const builtInOperations = [
	{
		id: "selection.region",
		kind: "edit",
		label: "Select points in a region",
		// params: region (BoxRegion | SphereRegion | ScreenPolygonRegion), mode "replace" | "add" | "remove"
		async run(ctx, {region, mode = "replace"}) {
			// query without freezing the page (queryPointsAsync), then one undoable step per cloud
			const hitsPerCloud = [];
			for (const pointcloud of ctx.pointclouds) hitsPerCloud.push(await ctx.queryAsync(pointcloud, region));
			let i = 0;
			return executePerCloud(ctx, (layer) => {
				const hits = hitsPerCloud[i++];
				const command = layer.flagCommand(hits, EditFlags.SELECTED, mode !== "remove");
				if (mode === "replace") {
					// clear the selection outside the region, in the same undo step
					command.changes.push(...layer.flagCommand(layer.flagged(EditFlags.SELECTED, hits), EditFlags.SELECTED, false).changes);
				}
				command.label = `select (${mode})`;
				return command;
			});
		},
	},
	{
		id: "selection.clear",
		kind: "edit",
		label: "Clear selection",
		run(ctx) {
			return executePerCloud(ctx, layer => layer.flagCommand(layer.flagged(EditFlags.SELECTED), EditFlags.SELECTED, false));
		},
	},
	{
		id: "selection.hide",
		kind: "edit",
		label: "Hide selected points",
		run(ctx) {
			return executePerCloud(ctx, layer => {
				const command = layer.flagsCommand(layer.flagged(EditFlags.SELECTED), EditFlags.HIDDEN, EditFlags.SELECTED);
				command.label = "hide selected";
				return command;
			});
		},
	},
	{
		id: "edits.showAll",
		kind: "edit",
		label: "Show hidden points",
		run(ctx) {
			return executePerCloud(ctx, layer => layer.flagCommand(layer.flagged(EditFlags.HIDDEN), EditFlags.HIDDEN, false));
		},
	},
	{
		id: "selection.setAttribute",
		kind: "edit",
		label: "Set attribute of selected points",
		// params: attribute (e.g. "classification"), value. Only loaded nodes are changed.
		run(ctx, {attribute = "classification", value}) {
			if (typeof value !== "number") throw new Error("selection.setAttribute: numeric value required");
			return executePerCloud(ctx, layer => layer.attributeCommand(layer.flagged(EditFlags.SELECTED), attribute, value));
		},
	},
	{
		id: "selection.stats",
		kind: "query",
		label: "Selection statistics",
		// count and world bounding box of the selected points (loaded nodes)
		run(ctx) {
			let count = 0;
			const box = new THREE.Box3();
			for (const pointcloud of ctx.pointclouds) {
				const layer = pointcloud.editLayer;
				if (!layer) continue;
				for (const chunk of layer.flagged(EditFlags.SELECTED)) {
					count += chunk.indices.length;
					const e = layer.nodes.get(chunk.name);
					const node = treeNodeOf(pointcloud, e.geometryNode);
					if (!node) continue;
					const p = worldPositions({...chunk, node});
					for (let k = 0; k < p.length; k += 3) box.expandByPoint(new THREE.Vector3(p[k], p[k + 1], p[k + 2]));
				}
			}
			return {count, boundingBox: count > 0 ? box : null};
		},
	},
	{
		id: "query.count",
		kind: "query",
		label: "Count points in a region",
		run(ctx, {region}) {
			return {count: countPoints(ctx.query(ctx.pointclouds, region))};
		},
	},
	{
		id: "edits.undo",
		kind: "edit",
		label: "Undo",
		run(ctx) {
			return {undone: ctx.pointclouds.map(pc => pc.editLayer?.undo() ?? false).some(Boolean)};
		},
	},
	{
		id: "edits.redo",
		kind: "edit",
		label: "Redo",
		run(ctx) {
			return {redone: ctx.pointclouds.map(pc => pc.editLayer?.redo() ?? false).some(Boolean)};
		},
	},
];

/** The loaded tree node of a geometry node (null if not loaded into the scene). */
function treeNodeOf(pointcloud, geometryNode) {
	if (!geometryNode || !geometryNode.geometry) return null;
	const stack = pointcloud.root ? [pointcloud.root] : [];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node.geometryNode === geometryNode) return node.sceneNode ? node : null;
		for (const child of node.children ?? []) if (child && child.sceneNode) stack.push(child);
	}
	return null;
}
