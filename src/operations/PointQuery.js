/**
 * PointQuery: which loaded points of a point cloud lie in a region (operations of kind "query",
 * and the input of selections and edits). See docs/operations.md.
 *
 * Works on the points that are in memory: the tree nodes of the octree (nodes that were drawn and
 * not unloaded yet). Each point of Potree 1.x / 2.0 / EPT / COPC data is stored in exactly one node,
 * so the result has no duplicates. Nodes whose bounding box misses the region are skipped before any
 * point is read. Point positions are tested in world space, with the node's matrixWorld - exactly
 * where the point is drawn.
 *
 * ponytail: main thread, synchronous - ~15M points/s. Workers and "load down to level N" when an
 * operation needs points that are not loaded or the UI stalls on large selections.
 */
import * as THREE from "three";

/**
 * Oriented box: the unit cube [-0.5, 0.5]^3 transformed by `matrixWorld`, like Potree's BoxVolume
 * (pass `volume.matrixWorld`).
 */
export class BoxRegion {
	constructor(matrixWorld) {
		this.matrixWorld = matrixWorld.clone();
		this.inverse = matrixWorld.clone().invert();
		this.boundingBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))
			.applyMatrix4(matrixWorld);
	}

	intersectsBox(worldBox) {
		return this.boundingBox.intersectsBox(worldBox);
	}

	/** (x, y, z) in node coordinates -> inside? */
	tester(nodeMatrixWorld) {
		const e = new THREE.Matrix4().multiplyMatrices(this.inverse, nodeMatrixWorld).elements;
		return (x, y, z) => {
			const bx = e[0] * x + e[4] * y + e[8] * z + e[12];
			const by = e[1] * x + e[5] * y + e[9] * z + e[13];
			const bz = e[2] * x + e[6] * y + e[10] * z + e[14];
			return bx >= -0.5 && bx <= 0.5 && by >= -0.5 && by <= 0.5 && bz >= -0.5 && bz <= 0.5;
		};
	}
}

export class SphereRegion {
	constructor(center, radius) {
		this.sphere = new THREE.Sphere(center.clone(), radius);
	}

	intersectsBox(worldBox) {
		return worldBox.intersectsSphere(this.sphere);
	}

	tester(nodeMatrixWorld) {
		const e = nodeMatrixWorld.elements;
		const c = this.sphere.center, r2 = this.sphere.radius * this.sphere.radius;
		return (x, y, z) => {
			const dx = e[0] * x + e[4] * y + e[8] * z + e[12] - c.x;
			const dy = e[1] * x + e[5] * y + e[9] * z + e[13] - c.y;
			const dz = e[2] * x + e[6] * y + e[10] * z + e[14] - c.z;
			return dx * dx + dy * dy + dz * dz <= r2;
		};
	}
}

/**
 * Screen polygon extruded along the view (lasso / polygon selection): points whose projection
 * with `camera` falls inside `polygon` ([[x, y], ...] in normalized device coordinates, -1..1)
 * and that are in front of the camera.
 */
export class ScreenPolygonRegion {
	constructor(camera, polygon) {
		camera.updateMatrixWorld();
		this.viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.polygon = polygon.map(([x, y]) => [x, y]);
		this.frustum = new THREE.Frustum().setFromProjectionMatrix(this.viewProjection);
	}

	intersectsBox(worldBox) {
		return this.frustum.intersectsBox(worldBox);
	}

	tester(nodeMatrixWorld) {
		const e = new THREE.Matrix4().multiplyMatrices(this.viewProjection, nodeMatrixWorld).elements;
		const poly = this.polygon;
		return (x, y, z) => {
			const w = e[3] * x + e[7] * y + e[11] * z + e[15];
			if (w <= 0) return false;
			const px = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
			const py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
			// even-odd rule
			let inside = false;
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const [xi, yi] = poly[i], [xj, yj] = poly[j];
				if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
					inside = !inside;
				}
			}
			return inside;
		};
	}
}

/** Tree nodes (loaded, in the scene graph) of a point cloud, depth first. */
export function* loadedNodes(pointcloud) {
	const stack = pointcloud.root ? [pointcloud.root] : [];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node.sceneNode || !node.geometryNode || !node.geometryNode.geometry) continue;
		yield node;
		for (const child of node.children) {
			if (child && child.sceneNode) stack.push(child);
		}
	}
}

/**
 * Loaded points of `pointclouds` (one or an array) inside `region` (BoxRegion, SphereRegion,
 * ScreenPolygonRegion or any object with intersectsBox(worldBox3) and tester(nodeMatrixWorld)).
 * `region` null = all loaded points.
 *
 * Returns chunks, one per node with hits: {pointcloud, node, name, indices: Uint32Array}.
 * `node.geometryNode.geometry.attributes` has the point attributes, `node.sceneNode.matrixWorld`
 * maps positions to world space (see worldPositions).
 */
export function queryPoints(pointclouds, region = null, {filter = null} = {}) {
	const chunks = [];
	const worldBox = new THREE.Box3();
	for (const pointcloud of [].concat(pointclouds)) {
		pointcloud.updateMatrixWorld(true);
		for (const node of loadedNodes(pointcloud)) {
			if (region) {
				worldBox.copy(node.getBoundingBox()).applyMatrix4(pointcloud.matrixWorld);
				if (!region.intersectsBox(worldBox)) continue;
			}
			const position = node.geometryNode.geometry.attributes.position;
			const count = node.geometryNode.geometry.drawRange.count === Infinity
				? position.count
				: Math.min(position.count, node.geometryNode.geometry.drawRange.count);
			const p = position.array;
			const test = region ? region.tester(node.sceneNode.matrixWorld) : null;
			const hits = new Uint32Array(count);
			let n = 0;
			for (let i = 0; i < count; i++) {
				if (test && !test(p[3 * i], p[3 * i + 1], p[3 * i + 2])) continue;
				if (filter && !filter(node, i)) continue;
				hits[n++] = i;
			}
			if (n > 0) {
				chunks.push({pointcloud, node, name: node.geometryNode.name, indices: hits.slice(0, n)});
			}
		}
	}
	return chunks;
}

/** World positions (Float64Array, xyz) of a chunk's points. */
export function worldPositions(chunk) {
	const p = chunk.node.geometryNode.geometry.attributes.position.array;
	const e = chunk.node.sceneNode.matrixWorld.elements;
	const out = new Float64Array(chunk.indices.length * 3);
	for (let k = 0; k < chunk.indices.length; k++) {
		const i = chunk.indices[k], x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
		out[3 * k] = e[0] * x + e[4] * y + e[8] * z + e[12];
		out[3 * k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
		out[3 * k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
	}
	return out;
}

/** Number of points in chunks. */
export function countPoints(chunks) {
	let n = 0;
	for (const c of chunks) n += c.indices.length;
	return n;
}
