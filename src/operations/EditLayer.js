/**
 * EditLayer: edits of one point cloud (operations of kind "edit"). See docs/operations.md.
 *
 * Stored sparsely by node name: each point lives in exactly one node, so (node name, point index)
 * identifies it in Potree 1.x / 2.0 / EPT / COPC data. Per edited node:
 *   - flags: Uint8Array, one byte per point (EditFlags: selected, hidden). The same array is the
 *     node's `aEdit` vertex attribute (normalized: native R8_UNORM vertex format; unnormalized bytes
 *     made ANGLE convert the buffer on every change), so a change is one buffer upload of that node.
 *   - attribute overrides: attribute name -> Map(point index -> value), written into the node's
 *     geometry (e.g. classification) and re-applied when the node is loaded again.
 * The source data is never changed; the edits are saved as their own JSON (toJSON / fromJSON).
 *
 * Every change is a command on an undo stack (undo / redo). Selection is a flag too, so any
 * operation can take "the current selection" as input.
 *
 * GPU: while the layer has edits (`active`), PointCloudRenderer turns on uUseEdits in the point shader
 * and gives every drawn node of the cloud an aEdit attribute (zeros for nodes without
 * edits) - see attachNode. Hidden points are moved out of the clip volume, selected ones are tinted
 * with `selectionColor`. Clouds without edits pay nothing.
 */
import * as THREE from "three";

export const EditFlags = Object.freeze({
	SELECTED: 1,
	HIDDEN: 2,
});

export class EditLayer extends THREE.EventDispatcher {
	constructor(pointcloud) {
		super();
		this.pointcloud = pointcloud;
		/** node name -> {flags, attribute, overrides, geometryNode} */
		this.nodes = new Map();
		this.undoStack = [];
		this.redoStack = [];
		/** tint of selected points (linear RGB, as all Potree colors) */
		this.selectionColor = new THREE.Color(1.0, 0.6, 0.0);
		/** bumped on every change; PointCloudRenderer re-attaches nodes when it changes */
		this.version = 0;
	}

	/** True once any edit exists: the renderer then draws the cloud with edits. */
	get active() {
		return this.nodes.size > 0;
	}

	/** Edits of node `name`, created on first use; pointCount from a query chunk or the loaded geometry. */
	entry(name, geometryNode = null, pointCount = null) {
		let e = this.nodes.get(name);
		if (!e) {
			const count = pointCount ?? (geometryNode && geometryNode.geometry ? geometryNode.geometry.attributes.position.count : 0);
			const flags = new Uint8Array(count);
			// originals: attribute name -> Map(point index -> value in the source data)
			e = {flags, attribute: new THREE.BufferAttribute(flags, 1, true), overrides: new Map(), originals: new Map(), geometryNode};
			this.nodes.set(name, e);
		}
		if (geometryNode) e.geometryNode = geometryNode;
		return e;
	}

	/**
	 * Gives a drawn tree node its aEdit attribute (stored flags or zeros) and re-applies attribute
	 * overrides to a freshly loaded geometry. Called by PointCloudRenderer for each drawn node while
	 * the layer is active; cheap when nothing changed.
	 */
	attachNode(node, renderGeometry) {
		const geometry = node.geometryNode.geometry;
		if (renderGeometry.attributes.aEdit && geometry.userData.editVersion === this.version) return;

		const name = node.geometryNode.name;
		const e = this.nodes.get(name);
		let attribute;
		if (e) {
			e.geometryNode = node.geometryNode;
			attribute = e.attribute;
			for (const [attributeName, values] of e.overrides) {
				const target = geometry.attributes[attributeName];
				if (!target) continue;
				const originals = this.originalsOf(e, attributeName);
				for (const [i, value] of values) {
					if (!originals.has(i)) originals.set(i, target.array[i]);
					target.array[i] = value;
				}
				target.needsUpdate = true;
			}
		} else {
			// no edits in this node: shared zero flags of the right length
			attribute = geometry.userData.zeroEdit ??= new THREE.BufferAttribute(new Uint8Array(geometry.attributes.position.count), 1, true);
		}
		geometry.setAttribute("aEdit", attribute);
		renderGeometry.setAttribute("aEdit", attribute);
		geometry.userData.editVersion = this.version;
	}

	/** Runs a command and makes it undoable. */
	execute(command) {
		this.apply(command, "after");
		this.undoStack.push(command);
		this.redoStack.length = 0;
		this.changed();
		return command;
	}

	undo() {
		const command = this.undoStack.pop();
		if (!command) return false;
		this.apply(command, "before");
		this.redoStack.push(command);
		this.changed();
		return true;
	}

	redo() {
		const command = this.redoStack.pop();
		if (!command) return false;
		this.apply(command, "after");
		this.undoStack.push(command);
		this.changed();
		return true;
	}

	changed() {
		this.version++;
		this.dispatchEvent({type: "changed", layer: this});
	}

	apply(command, which) {
		for (const change of command.changes) {
			const e = this.entry(change.name);
			const values = change[which];
			if (change.flags) {
				for (let k = 0; k < change.indices.length; k++) e.flags[change.indices[k]] = values[k];
				e.attribute.needsUpdate = true;
			} else {
				let overrides = e.overrides.get(change.attribute);
				if (!overrides) e.overrides.set(change.attribute, overrides = new Map());
				const originals = this.originalsOf(e, change.attribute);
				const target = e.geometryNode && e.geometryNode.geometry ? e.geometryNode.geometry.attributes[change.attribute] : null;
				for (let k = 0; k < change.indices.length; k++) {
					const i = change.indices[k];
					if (values[k] === originals.get(i)) overrides.delete(i); else overrides.set(i, values[k]);
					if (target) target.array[i] = values[k];
				}
				if (target) target.needsUpdate = true;
			}
		}
	}

	originalsOf(e, attributeName) {
		let originals = e.originals.get(attributeName);
		if (!originals) e.originals.set(attributeName, originals = new Map());
		return originals;
	}

	/**
	 * Command that sets (`on` true) or clears `flag` for the points of `chunks` (from queryPoints).
	 * Only points whose flags actually change are recorded.
	 */
	flagCommand(chunks, flag, on) {
		return this.flagsCommand(chunks, on ? flag : 0, on ? 0 : flag);
	}

	/** Command: flags = (flags | set) & ~clear for the points of `chunks`. */
	flagsCommand(chunks, set, clear) {
		const changes = [];
		for (const chunk of chunks) {
			const e = this.entry(chunk.name, chunk.node ? chunk.node.geometryNode : null, chunk.pointCount);
			const source = chunk.indices, flags = e.flags;
			// typed arrays: a selection can be millions of points
			const indices = new Uint32Array(source.length), before = new Uint8Array(source.length), after = new Uint8Array(source.length);
			let n = 0;
			for (let j = 0; j < source.length; j++) {
				const i = source[j], old = flags[i], now = (old | set) & ~clear;
				if (now !== old) {
					indices[n] = i; before[n] = old; after[n] = now; n++;
				}
			}
			if (n > 0) {
				const all = n === source.length; // no copies for the common "whole node" case
				changes.push({name: chunk.name, flags: true, indices: all ? indices : indices.slice(0, n),
					before: all ? before : before.slice(0, n), after: all ? after : after.slice(0, n)});
			}
		}
		return {label: `flags +${set} -${clear}`, changes};
	}

	/**
	 * Chunks of all points of this layer that have `flag` (loaded or not); with `except` (chunks from
	 * queryPoints), points listed there are left out.
	 */
	flagged(flag, except = null) {
		const exceptByName = except ? new Map(except.map(c => [c.name, c.indices])) : null;
		const chunks = [];
		for (const [name, e] of this.nodes) {
			const flags = e.flags;
			let skip = null;
			const excluded = exceptByName && exceptByName.get(name);
			if (excluded) {
				skip = new Uint8Array(flags.length);
				for (let j = 0; j < excluded.length; j++) skip[excluded[j]] = 1;
			}
			let n = 0;
			for (let i = 0; i < flags.length; i++) if ((flags[i] & flag) && !(skip && skip[i])) n++;
			if (n === 0) continue;
			const indices = new Uint32Array(n);
			for (let i = 0, k = 0; i < flags.length; i++) if ((flags[i] & flag) && !(skip && skip[i])) indices[k++] = i;
			chunks.push({pointcloud: this.pointcloud, node: null, name, indices});
		}
		return chunks;
	}

	count(flag) {
		let n = 0;
		for (const e of this.nodes.values()) for (let i = 0; i < e.flags.length; i++) if (e.flags[i] & flag) n++;
		return n;
	}

	/**
	 * Command that writes `value` into attribute `attributeName` (e.g. "classification") for the
	 * points of `chunks`. Needs the nodes loaded (current values are read from the geometry).
	 */
	attributeCommand(chunks, attributeName, value) {
		const changes = [];
		for (const chunk of chunks) {
			const geometryNode = chunk.node ? chunk.node.geometryNode : this.nodes.get(chunk.name)?.geometryNode;
			const target = geometryNode && geometryNode.geometry ? geometryNode.geometry.attributes[attributeName] : null;
			if (!target || target.itemSize !== 1) continue;
			const e = this.entry(chunk.name, geometryNode);
			const originals = this.originalsOf(e, attributeName);
			const indices = [], before = [], after = [];
			for (const i of chunk.indices) {
				const old = target.array[i];
				if (old === value) continue;
				if (!originals.has(i)) originals.set(i, old);
				indices.push(i); before.push(old); after.push(value);
			}
			if (indices.length > 0) {
				changes.push({name: chunk.name, attribute: attributeName, indices: Uint32Array.from(indices), before, after});
			}
		}
		return {label: `set ${attributeName} = ${value}`, changes};
	}

	/** Edits as JSON (flags as sparse index lists per flag value, overrides as [index, value] pairs). */
	toJSON() {
		const nodes = {};
		for (const [name, e] of this.nodes) {
			const flags = {};
			for (let i = 0; i < e.flags.length; i++) {
				if (e.flags[i]) (flags[e.flags[i]] ??= []).push(i);
			}
			const overrides = {};
			for (const [attributeName, values] of e.overrides) {
				if (values.size > 0) overrides[attributeName] = [...values];
			}
			if (Object.keys(flags).length || Object.keys(overrides).length) {
				nodes[name] = {count: e.flags.length, flags, overrides};
			}
		}
		return {type: "potree-edits", version: 1, nodes};
	}

	/** Replaces all edits by `json` (from toJSON). Not undoable; clears the undo stack. */
	fromJSON(json) {
		if (json.type !== "potree-edits" || json.version !== 1) {
			throw new Error("not a potree-edits v1 file");
		}
		this.nodes.clear();
		for (const [name, n] of Object.entries(json.nodes)) {
			const e = this.entry(name);
			e.flags = new Uint8Array(n.count);
			e.attribute = new THREE.BufferAttribute(e.flags, 1, true);
			for (const [value, indices] of Object.entries(n.flags)) for (const i of indices) e.flags[i] = Number(value);
			for (const [attributeName, pairs] of Object.entries(n.overrides)) e.overrides.set(attributeName, new Map(pairs));
		}
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.changed();
	}
}

/** The edit layer of a point cloud, created on first use. */
export function editLayerOf(pointcloud) {
	return pointcloud.editLayer ??= new EditLayer(pointcloud);
}
