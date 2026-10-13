import * as THREE from "three";
import {PointCloudTree} from "../PointCloudTree.js";
import {PointSizeType, ClipTask, ElevationGradientRepeat} from "../defines.js";

/**
 * Draws point clouds with three.js (THREE.Points + RawShaderMaterial) instead of raw WebGL.
 *
 * Replaced Potree's own raw-WebGL `Renderer` (src/PotreeRenderer.js, removed) with the same `render()` and
 * `renderOctree()` signatures and the same parameters, so the frame renderers (default, EDL, HQ),
 * the profile window, picking and shadow maps keep calling it unchanged. What the legacy renderer
 * did and how each part maps to three.js is described in docs/rendering.md.
 *
 * How it works:
 * - Each PointCloudMaterial (a settings object) gets its own internal RawShaderMaterial (the GPU
 *   material). Only the uniforms the legacy renderer set are given to it, so every other uniform
 *   of the shader keeps its default value exactly as before.
 * - The shader source is the PointCloudMaterial's source plus the per-render `#define`s
 *   (number of clip volumes, shadow maps, ...); three caches compiled programs by source.
 * - Per-node uniforms (level, node spacing, visibility texture offset, node index for picking,
 *   clip polygon and shadow matrices) are written in `onBeforeRender` of the node's THREE.Points.
 * - three draws the octree object; only the requested nodes are visible during the call.
 *
 * No private three.js API is used.
 */
export class PointCloudRenderer {

	/** @param {THREE.WebGLRenderer} threeRenderer */
	constructor(threeRenderer) {
		this.threeRenderer = threeRenderer;

		/** PointCloudMaterial -> internal RawShaderMaterial */
		this.renderMaterials = new WeakMap();

		/** PointCloudMaterial -> last visibility texture input/result, see renderOctree */
		this.visibilityCache = new WeakMap();

		/** node BufferGeometry -> geometry three draws (same BufferAttributes, shader names) */
		this.renderGeometries = new WeakMap();

		// render() and renderOctree() are not re-entrant; the node hook reads this state
		this.state = null;

		// three calls object.onBeforeRender(renderer, scene, camera, geometry, material, group)
		// as a method of the THREE.Points, so `this` is the scene node here
		const pointCloudRenderer = this;
		this.nodeHook = function (renderer, scene, camera, geometry) {
			pointCloudRenderer.onBeforeRenderNode(this.userData.potreeNode, geometry, camera);
		};

		this.tmpMatrix = new THREE.Matrix4();

		// node data texture capacity in nodes, shared by all render materials so that a node's slot
		// stays valid in every pass (see assignSlots)
		this.nodeCapacity = 0;
		this.slotUsed = new Uint8Array(0);
	}

	/** Point cloud trees below `scene` that are visible (same as the legacy renderer). */
	traverse(scene) {
		let octrees = [];

		let stack = [scene];
		while (stack.length > 0) {
			let node = stack.pop();

			if (node instanceof PointCloudTree) {
				octrees.push(node);
				continue;
			}

			let visibleChildren = node.children.filter(c => c.visible);
			stack.push(...visibleChildren);
		}

		return {octrees: octrees};
	}

	/**
	 * Draws all visible point clouds below `scene`.
	 * @param {THREE.Object3D} scene usually viewer.scene.scenePointCloud
	 * @param {THREE.Camera} camera
	 * @param {THREE.WebGLRenderTarget|null} target if given, becomes (and stays) the current render target, as before
	 * @param {object} params see docs/rendering.md (material, shadowMaps, clipSpheres, transparent, blendFunc, depthTest, depthWrite)
	 */
	render(scene, camera, target = null, params = {}) {
		if (target != null) {
			this.threeRenderer.setRenderTarget(target);
		}

		const traversalResult = this.traverse(scene);

		for (const octree of traversalResult.octrees) {
			let nodes = octree.visibleNodes;
			this.renderOctree(octree, nodes, camera, target, params);
		}
	}

	/**
	 * Draws the given nodes of one octree. `nodes` order defines uPCIndex (picking reads it back).
	 */
	renderOctree(octree, nodes, camera, target, params = {}) {
		const renderer = this.threeRenderer;

		let material = params.material ? params.material : octree.material;
		let shadowMaps = params.shadowMaps == null ? [] : params.shadowMaps;

		let view = camera.matrixWorldInverse;
		let viewInv = camera.matrixWorld;
		let proj = camera.projectionMatrix;
		let projInv = proj.clone().invert();

		let visibilityTextureData = null;
		if (material.pointSizeType >= 0) {
			if (material.pointSizeType === PointSizeType.ADAPTIVE ||
				material.activeAttributeName === "level of detail") {

				let vnNodes = (params.vnTextureNodes != null) ? params.vnTextureNodes : nodes;

				// The texture only depends on the node set: recompute and re-upload it only when that
				// changed (not every frame while the camera rests, nor for each pass of a frame).
				let cached = this.visibilityCache.get(material);
				if (cached && cached.octree === octree && sameNodes(cached.nodes, vnNodes)) {
					visibilityTextureData = cached.result;
				} else {
					visibilityTextureData = octree.computeVisibilityTextureData(vnNodes, camera);

					let vnt = material.visibleNodesTexture;
					if (visibilityTextureData.data.length > vnt.image.data.length) {
						vnt = this.growVisibilityTexture(material, visibilityTextureData.data.length / 4);
					}
					vnt.image.data.set(visibilityTextureData.data);
					vnt.needsUpdate = true;

					this.visibilityCache.set(material, {octree, nodes: vnNodes.slice(), result: visibilityTextureData});
				}
			}
		}

		let rm = this.getRenderMaterial(material);

		this.updateShader(rm, material, octree, shadowMaps, params);
		this.updateBlending(rm, material, params);
		this.updateOctreeUniforms(rm, material, octree, camera, target, params, view, viewInv, proj, projInv, shadowMaps);

		if (!rm.uniforms.uNodeTexture) {
			rm.uniforms.uOctreeWorld = {value: new THREE.Matrix4()};
			rm.uniforms.uOctreeModelView = {value: new THREE.Matrix4()};
			rm.uniforms.uNodeTexture = {value: null};
		}
		if (nodes.length > this.nodeCapacity) {
			// 3 texels per node, rows of 2048; headroom so it is not re-created every few nodes
			this.nodeCapacity = Math.floor(Math.ceil(nodes.length * 3 / 2048) * 2 * 2048 / 3);
		}
		let nodeTexture = rm.uniforms.uNodeTexture.value;
		if (!nodeTexture || nodeTexture.userData.capacity < this.nodeCapacity) {
			this.createNodeTexture(rm);
		}
		if (shadowMaps.length > 0) {
			let size = 16 * shadowMaps.length;
			if (!rm.uniforms.uShadowWorldView || rm.uniforms.uShadowWorldView.value.length !== size) {
				rm.uniforms.uShadowWorldView = {value: new Float32Array(size)};
			}
		}

		// edits of the cloud (src/operations/EditLayer.js): uniform switch, see pointcloud.vs
		let edits = octree.editLayer && octree.editLayer.active ? octree.editLayer : null;
		(rm.uniforms.uUseEdits ??= {value: false}).value = edits !== null;
		(rm.uniforms.uSelectionColor ??= {value: null}).value = edits ? edits.selectionColor : DEFAULT_SELECTION_COLOR;

		this.state = {
			octree, nodes, material, rm, shadowMaps, visibilityTextureData, view,
			uniforms: rm.uniforms,
			clipPolygons: material.clipPolygons || [],
			perOctreeDone: false,
			extraAttributeName: null,
			nodesDrawn: 0,
		};

		// Each drawn node uses the internal material, its render geometry and our hook. They stay
		// assigned between calls (nothing else reads them), so a frame only re-assigns what changed.
		// uPCIndex = position in `nodes` (picking reads it back), kept in userData for the hook.
		for (let i = 0; i < nodes.length; i++) {
			let node = nodes[i];
			let sceneNode = node.sceneNode;
			let data = sceneNode.userData;

			if (sceneNode.material !== rm) {
				sceneNode.material = rm;
			}
			if (sceneNode.onBeforeRender !== this.nodeHook) {
				// first draw by this renderer (several PointCloudRenderers may draw the same nodes)
				data.potreeNode = node;
				sceneNode.onBeforeRender = this.nodeHook;
				sceneNode.geometry = this.getRenderGeometry(sceneNode.geometry);
			}
			data.pcIndex = i;
			if (edits) {
				edits.attachNode(node, sceneNode.geometry);
			}
		}
		this.assignSlots(nodes);

		// Normally `nodes` are the octree's visible nodes, which are exactly the visible scene nodes.
		// For a subset (picking: nodes on a ray) hide the others during the call. Visible nodes form a
		// subtree from the root (a node's box contains its children's), so three reaches all of them.
		let hidden = null;
		if (nodes !== octree.visibleNodes) {
			let requested = new Set(nodes);
			hidden = [];
			for (let node of octree.visibleNodes) {
				if (!requested.has(node) && node.sceneNode.visible) {
					node.sceneNode.visible = false;
					hidden.push(node.sceneNode);
				}
			}
			for (let node of nodes) {
				node.sceneNode.visible = true;
			}
		}

		// Octree-level uniforms are uploaded with the first node only; afterwards three uploads just the
		// per-node ones. three skips a uniform whose `needsUpdate === false` (WebGLUniforms.upload; not
		// in the docs, but stable since r1xx - checked in r152 and r186). This is the only reliance on
		// undocumented three behaviour in Potree; without it every node re-uploads ~60 uniforms.
		for (let name in rm.uniforms) {
			if (!PER_NODE_UNIFORMS.has(name)) {
				rm.uniforms[name].needsUpdate = true;
			}
		}

		let autoClear = renderer.autoClear;
		renderer.autoClear = false;

		renderer.render(octree, camera);

		renderer.autoClear = autoClear;

		if (hidden) {
			for (let sceneNode of hidden) {
				sceneNode.visible = true;
			}
		}

		this.state = null;
	}

	/**
	 * Replaces the material's visibility texture with a larger one (2048 x rows, see visibleNodeAt in
	 * pointcloud.vs). The original 2048 x 1 texture limited Potree to 2048 visible nodes; large point
	 * budgets (e.g. 50M points with small nodes) exceed that and the frame threw a RangeError.
	 * A texture's size cannot change after first use in three.js, so a new one is created.
	 */
	/**
	 * Node data texture of a render material (see pointcloud.vs): RGBA32F, 2048 texels per row,
	 * 3 texels per node slot, this.nodeCapacity slots.
	 */
	createNodeTexture(rm) {
		const width = 2048;
		const rows = Math.ceil(this.nodeCapacity * 3 / width);
		const texture = new THREE.DataTexture(new Float32Array(width * rows * 4), width, rows, THREE.RGBAFormat, THREE.FloatType);
		texture.magFilter = THREE.NearestFilter;
		texture.minFilter = THREE.NearestFilter;
		texture.userData.capacity = this.nodeCapacity;

		if (rm.uniforms.uNodeTexture.value) {
			rm.uniforms.uNodeTexture.value.dispose();
		}
		rm.uniforms.uNodeTexture.value = texture;
	}

	/**
	 * Gives each node of a draw call a distinct slot < nodeCapacity in the node data texture. A node
	 * keeps its slot while it stays valid, so its aSlot attribute (and three's buffer for it) changes
	 * only when the node is first drawn or its slot was taken over by another node meanwhile.
	 */
	assignSlots(nodes) {
		const capacity = this.nodeCapacity;
		if (this.slotUsed.length < capacity) {
			this.slotUsed = new Uint8Array(capacity);
		} else {
			this.slotUsed.fill(0, 0, capacity);
		}
		const used = this.slotUsed;

		let pending = null;
		for (let node of nodes) {
			let attribute = node.sceneNode.geometry.attributes.aSlot;
			let slot = attribute.array[0];
			if (slot >= 0 && slot < capacity && !used[slot]) {
				used[slot] = 1;
			} else {
				(pending ??= []).push(attribute);
			}
		}

		if (pending) {
			let next = 0;
			for (let attribute of pending) {
				while (used[next]) next++;
				used[next] = 1;
				attribute.array[0] = next;
				attribute.needsUpdate = true;
			}
		}
	}

	/**
	 * Writes the per-node values of all nodes of the current call into the node data texture (three
	 * uploads it with the first node's uniforms). Called from the first node's hook, where three has
	 * updated the node and camera matrices for this render call.
	 */
	fillNodeTexture(s, camera) {
		const u = s.uniforms;
		const texture = u.uNodeTexture.value;
		const d = texture.image.data;
		const v = camera.matrixWorldInverse.elements;
		const offsets = s.visibilityTextureData ? s.visibilityTextureData.offsets : null;

		for (let i = 0; i < s.nodes.length; i++) {
			const node = s.nodes[i];
			const sceneNode = node.sceneNode;
			const o = sceneNode.geometry.attributes.aSlot.array[0] * 12;
			const w = sceneNode.matrixWorld.elements;
			const wx = w[12], wy = w[13], wz = w[14];

			d[o] = node.getLevel();
			d[o + 1] = offsets ? offsets.get(node) : 0;
			d[o + 2] = i; // pcIndex: position in the call's node list, read back by picking
			d[o + 3] = node.geometryNode.estimatedSpacing;
			d[o + 4] = wx; d[o + 5] = wy; d[o + 6] = wz;
			// view translation = (view * world) translation, in double like three's modelViewMatrix
			d[o + 8] = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
			d[o + 9] = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
			d[o + 10] = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
		}
		texture.needsUpdate = true;
	}

	growVisibilityTexture(material, nodeCount) {
		const width = 2048;
		const rows = Math.ceil(nodeCount / width) * 2; // headroom: avoid re-creating it every few nodes
		const texture = new THREE.DataTexture(new Uint8Array(width * rows * 4), width, rows, THREE.RGBAFormat);
		texture.magFilter = THREE.NearestFilter;
		texture.minFilter = THREE.NearestFilter;

		material.visibleNodesTexture.dispose();
		material.visibleNodesTexture = texture;
		if (material.uniforms.visibleNodes) {
			material.uniforms.visibleNodes.value = texture;
		}

		return texture;
	}

	/** Internal GPU material for a PointCloudMaterial (created once, reused). */
	getRenderMaterial(material) {
		let rm = this.renderMaterials.get(material);

		if (!rm) {
			rm = new THREE.RawShaderMaterial({
				uniforms: {},
				vertexShader: "",
				fragmentShader: "",
			});
			rm.name = "PointCloudRenderer";
			rm.glslVersion = THREE.GLSL3; // src/materials/shaders/pointcloud.* are GLSL ES 3.0
			rm.premultipliedAlpha = false;
			this.renderMaterials.set(material, rm);
		}

		return rm;
	}

	/** Same source and #defines the legacy renderer built (renderOctree in the removed src/PotreeRenderer.js, see git history and docs/rendering.md). */
	updateShader(rm, material, octree, shadowMaps, params) {
		let [vs, fs] = [material.vertexShader, material.fragmentShader];

		let numSnapshots = material.snapEnabled ? material.numSnapshots : 0;
		let numClipBoxes = (material.clipBoxes && material.clipBoxes.length) ? material.clipBoxes.length : 0;
		let numClipSpheres = (params.clipSpheres && params.clipSpheres.length) ? params.clipSpheres.length : 0;
		let numClipPolygons = (material.clipPolygons && material.clipPolygons.length) ? material.clipPolygons.length : 0;

		let defines = [
			`#define num_shadowmaps ${shadowMaps.length}`,
			`#define num_snapshots ${numSnapshots}`,
			`#define num_clipboxes ${numClipBoxes}`,
			`#define num_clipspheres ${numClipSpheres}`,
			`#define num_clippolygons ${numClipPolygons}`,
		];

		if (octree.pcoGeometry.root.isLoaded()) {
			let attributes = octree.pcoGeometry.root.geometry.attributes;

			if (attributes["gps-time"]) {
				defines.push("#define clip_gps_enabled");
			}
			if (attributes["return number"]) {
				defines.push("#define clip_return_number_enabled");
			}
			if (attributes["number of returns"]) {
				defines.push("#define clip_number_of_returns_enabled");
			}
			if (attributes["source id"] || attributes["point source id"]) {
				defines.push("#define clip_point_source_id_enabled");
			}
		}

		let definesString = defines.join("\n");

		// The shader source is ~40 KB: only rebuild/compare it when its inputs changed
		if (rm.userData.sourceVS === vs && rm.userData.sourceFS === fs && rm.userData.defines === definesString) {
			return;
		}
		rm.userData.sourceVS = vs;
		rm.userData.sourceFS = fs;
		rm.userData.defines = definesString;

		let insert = (src) => src.indexOf("#version ") >= 0
			? src.replace(/(#version .*)/, `$1\n${definesString}`)
			: `${definesString}\n${src}`;

		vs = insert(vs);
		fs = insert(fs);

		if (rm.vertexShader !== vs || rm.fragmentShader !== fs) {
			rm.vertexShader = vs;
			rm.fragmentShader = fs;
			rm.needsUpdate = true; // three looks up (or compiles) the program for the new source
		}
	}

	/** Blending and depth state, as the legacy renderer set it with raw GL calls. */
	updateBlending(rm, material, params) {
		let transparent = false;
		if (params.transparent !== undefined) {
			transparent = params.transparent && material.opacity < 1;
		} else {
			transparent = material.opacity < 1;
		}

		if (transparent) {
			rm.blending = THREE.CustomBlending;
			rm.blendEquation = THREE.AddEquation;
			rm.blendSrc = THREE.SrcAlphaFactor;
			rm.blendDst = THREE.OneFactor;
			rm.depthWrite = false;
			rm.depthTest = false;
		} else {
			rm.blending = THREE.NoBlending;
			rm.depthWrite = true;
			rm.depthTest = true;
		}

		if (params.blendFunc !== undefined) {
			rm.blending = THREE.CustomBlending;
			rm.blendEquation = THREE.AddEquation;
			rm.blendSrc = glBlendFactorToThree(params.blendFunc[0]);
			rm.blendDst = glBlendFactorToThree(params.blendFunc[1]);
		}

		if (params.depthTest !== undefined) {
			rm.depthTest = params.depthTest === true;
		}

		if (params.depthWrite !== undefined) {
			rm.depthWrite = params.depthWrite === true;
		}

		rm.depthFunc = THREE.LessEqualDepth;
		rm.transparent = false; // keep nodes in the opaque list, drawn in scene order
	}

	/** Per-octree uniforms (legacy: "UPDATE UNIFORMS" in renderOctree). */
	updateOctreeUniforms(rm, material, octree, camera, target, params, view, viewInv, proj, projInv, shadowMaps) {
		let set = (name, value) => {
			let uniform = rm.uniforms[name];
			if (uniform) {
				uniform.value = value;
			} else {
				rm.uniforms[name] = {value: value};
			}
		};

		// projectionMatrix, viewMatrix, modelMatrix, modelViewMatrix are set by three
		set("uViewInv", viewInv);
		set("uProjInv", projInv);

		let screenWidth = target ? target.width : material.screenWidth;
		let screenHeight = target ? target.height : material.screenHeight;

		set("uScreenWidth", screenWidth);
		set("uScreenHeight", screenHeight);
		set("fov", Math.PI * camera.fov / 180);
		set("near", camera.near);
		set("far", camera.far);

		if (camera instanceof THREE.OrthographicCamera) {
			set("uUseOrthographicCamera", true);
			set("uOrthoWidth", camera.right - camera.left);
			set("uOrthoHeight", camera.top - camera.bottom);
		} else {
			set("uUseOrthographicCamera", false);
		}

		if (material.clipBoxes.length + material.clipPolygons.length === 0) {
			set("clipTask", ClipTask.NONE);
		} else {
			set("clipTask", material.clipTask);
		}

		set("clipMethod", material.clipMethod);

		if (material.clipBoxes && material.clipBoxes.length > 0) {
			set("clipBoxes", material.uniforms.clipBoxes.value);
		}

		if (params.clipSpheres && params.clipSpheres.length > 0) {
			let matrices = [];
			for (let clipSphere of params.clipSpheres) {
				let clipToWorld = clipSphere.matrixWorld;
				let viewToWorld = camera.matrixWorld;
				let worldToClip = clipToWorld.clone().invert();

				let viewToClip = new THREE.Matrix4().multiplyMatrices(worldToClip, viewToWorld);

				matrices.push(viewToClip);
			}

			set("uClipSpheres", matrices.flatMap(matrix => matrix.elements));
		}

		set("size", material.size);
		set("maxSize", material.uniforms.maxSize.value);
		set("minSize", material.uniforms.minSize.value);

		set("uOctreeSpacing", material.spacing);
		set("uOctreeSize", material.uniforms.octreeSize.value);

		set("uColor", material.color.toArray());
		set("uOpacity", material.opacity);

		set("elevationRange", material.elevationRange);
		set("intensityRange", material.intensityRange);

		set("uIntensity_gbc", [
			material.intensityGamma,
			material.intensityBrightness,
			material.intensityContrast
		]);

		set("uRGB_gbc", [
			material.rgbGamma,
			material.rgbBrightness,
			material.rgbContrast
		]);

		set("uTransition", material.transition);
		set("wRGB", material.weightRGB);
		set("wIntensity", material.weightIntensity);
		set("wElevation", material.weightElevation);
		set("wClassification", material.weightClassification);
		set("wReturnNumber", material.weightReturnNumber);
		set("wSourceID", material.weightSourceID);

		set("backfaceCulling", material.uniforms.backfaceCulling.value);

		// The shader's sampler is `visibleNodes`. The legacy renderer set a uniform named
		// "visibleNodesTexture" (not in the shader) and bound the texture to unit 0, which the unset
		// sampler happened to read. Here it is set under its real name.
		set("visibleNodes", material.visibleNodesTexture);

		{ // gradient texture; its wrap mode follows elevationGradientRepeat
			let gradientTexture = material.gradientTexture;
			let repeat = material.elevationGradientRepeat;
			let wrap = THREE.ClampToEdgeWrapping;
			if (repeat === ElevationGradientRepeat.REPEAT) {
				wrap = THREE.RepeatWrapping;
			} else if (repeat === ElevationGradientRepeat.MIRRORED_REPEAT) {
				wrap = THREE.MirroredRepeatWrapping;
			}
			if (gradientTexture.wrapS !== wrap || gradientTexture.wrapT !== wrap) {
				gradientTexture.wrapS = wrap;
				gradientTexture.wrapT = wrap;
				gradientTexture.needsUpdate = true;
			}
			set("gradient", gradientTexture);
		}

		set("classificationLUT", material.classificationTexture);
		set("matcapTextureUniform", material.matcapTexture);

		if (material.snapEnabled === true) {
			let snapshots = material.uniforms.uSnapshot.value;
			let snapshotDepths = material.uniforms.uSnapshotDepth.value;
			set("uSnapshot", snapshots.slice(0, 5));
			set("uSnapshotDepth", snapshotDepths.slice(0, 5));
			set("uSnapView", material.uniforms.uSnapView.value.flatMap(m => m.elements));
			set("uSnapProj", material.uniforms.uSnapProj.value.flatMap(m => m.elements));
			set("uSnapProjInv", material.uniforms.uSnapProjInv.value.flatMap(m => m.elements));
			set("uSnapViewInv", material.uniforms.uSnapViewInv.value.flatMap(m => m.elements));
		}

		if (shadowMaps.length > 0) {
			set("uShadowColor", material.uniforms.uShadowColor.value);
			set("uShadowMap", shadowMaps.map(sm => sm.target.texture));
			set("uShadowProj", shadowMaps.flatMap(sm => sm.camera.projectionMatrix.elements));
		}

		// filters
		set("uFilterReturnNumberRange", material.uniforms.uFilterReturnNumberRange.value);
		set("uFilterNumberOfReturnsRange", material.uniforms.uFilterNumberOfReturnsRange.value);
		set("uFilterPointSourceIDClipRange", material.uniforms.uFilterPointSourceIDClipRange.value);
	}

	/**
	 * Called right before three draws a node (via nodeHook): per-node uniforms.
	 * Runs once per node and frame, so it avoids allocations and lookups by name: values that are
	 * the same for every node of the octree (GPS time and extra attribute scale/offset) are computed
	 * once per renderOctree call (`perOctreeDone`).
	 * @param {PointCloudOctreeNode} node
	 * @param {THREE.BufferGeometry} geometry the node's render geometry (see getRenderGeometry)
	 */
	onBeforeRenderNode(node, geometry, camera) {
		const s = this.state;
		const u = s.uniforms;

		if (s.nodesDrawn === 1) {
			// the first node has uploaded the octree-level uniforms (see renderOctree)
			for (let name in u) {
				if (!PER_NODE_UNIFORMS.has(name)) {
					u[name].needsUpdate = false;
				}
			}
		}

		// Matrices here are current: three updated the scene and camera before calling the hook.
		let world = node.sceneNode.matrixWorld;
		if (s.nodesDrawn === 0) {
			// rotation/scale shared by all nodes (they are only translated against each other); the
			// translation columns are ignored by the shader
			u.uOctreeWorld.value.copy(world);
			u.uOctreeModelView.value.multiplyMatrices(camera.matrixWorldInverse, world);
			this.fillNodeTexture(s, camera);
		}
		s.nodesDrawn++;

		if (s.clipPolygons.length > 0) {
			this.setClipPolygonUniforms(s, world);
		}

		if (s.shadowMaps.length > 0) {
			let elements = u.uShadowWorldView.value;
			for (let i = 0; i < s.shadowMaps.length; i++) {
				this.tmpMatrix.multiplyMatrices(s.shadowMaps[i].camera.matrixWorldInverse, world);
				elements.set(this.tmpMatrix.elements, 16 * i);
			}
		}

		if (!s.perOctreeDone) {
			// legacy: set per node if the node has the attribute; identical for all nodes of an octree
			if (geometry.attributes["gps-time"]) {
				this.setGpsUniforms(s);
			}
			this.setExtraAttributeUniforms(s);
			s.perOctreeDone = true;
		}

		if (s.extraAttributeName !== null) {
			let attribute = geometry.userData.source.attributes[s.extraAttributeName];
			if (geometry.attributes.aExtra !== attribute) {
				geometry.setAttribute("aExtra", attribute);
			}
		} else if (geometry.attributes.aExtra) {
			geometry.deleteAttribute("aExtra");
		}

		// three uploads material uniforms only when the program or material changes; all nodes share
		// one material. Per-node uniforms are left only for clip polygons and shadow maps; force the
		// upload just then: a uniform change between draws is expensive (see pointcloud.vs)
		if (s.clipPolygons.length > 0 || s.shadowMaps.length > 0) {
			s.rm.uniformsNeedUpdate = true;
		}
	}

	setClipPolygonUniforms(s, world) {
		const u = s.uniforms;
		let clipPolygonVCount = [];
		let worldViewProj = [];
		let vertices = new Array(8 * 3 * s.clipPolygons.length);

		for (let i = 0; i < s.clipPolygons.length; i++) {
			let clipPolygon = s.clipPolygons[i];
			let wvp = clipPolygon.projMatrix.clone().multiply(clipPolygon.viewMatrix).multiply(world);

			clipPolygonVCount.push(clipPolygon.markers.length);
			worldViewProj.push(...wvp.elements);

			for (let j = 0; j < clipPolygon.markers.length; j++) {
				let p = clipPolygon.markers[j].position;
				vertices[i * 24 + (j * 3 + 0)] = p.x;
				vertices[i * 24 + (j * 3 + 1)] = p.y;
				vertices[i * 24 + (j * 3 + 2)] = p.z;
			}
		}

		setUniform(u, "uClipPolygonVCount", clipPolygonVCount);
		setUniform(u, "uClipPolygonWVP", worldViewProj);
		setUniform(u, "uClipPolygonVertices", vertices);
	}

	setGpsUniforms(s) {
		const attGPS = s.octree.getAttribute("gps-time");

		let initialRange = attGPS.initialRange;
		let initialRangeSize = initialRange[1] - initialRange[0];

		let globalRange = attGPS.range;
		let globalRangeSize = globalRange[1] - globalRange[0];

		let scale = initialRangeSize / globalRangeSize;
		let offset = -(globalRange[0] - initialRange[0]) / initialRangeSize;

		scale = Number.isNaN(scale) ? 1 : scale;
		offset = Number.isNaN(offset) ? 0 : offset;

		setUniform(s.uniforms, "uGpsScale", scale);
		setUniform(s.uniforms, "uGpsOffset", offset);

		let uFilterGPSTimeClipRange = s.material.uniforms.uFilterGPSTimeClipRange.value;
		setUniform(s.uniforms, "uFilterGPSTimeClipRange", [
			(uFilterGPSTimeClipRange[0] - globalRange[0]) / globalRangeSize,
			(uFilterGPSTimeClipRange[1] - globalRange[0]) / globalRangeSize,
		]);
	}

	/**
	 * The geometry three draws for a node: a BufferGeometry that shares the node's BufferAttribute
	 * objects under the names the shader uses (`rgba` -> `color`, `return number` -> `returnNumber`,
	 * ...; legacy mapping: attributeLocations of the removed src/PotreeRenderer.js). three uploads
	 * buffers per attribute object, so nothing is uploaded twice. The node's own geometry is not
	 * changed: Potree code (profile, exporters, point queries) iterates its attributes; it must use
	 * node.geometryNode.geometry, not sceneNode.geometry (which is this render geometry).
	 */
	getRenderGeometry(geometry) {
		if (geometry.userData.source) {
			geometry = geometry.userData.source; // already a render geometry
		}
		let rg = this.renderGeometries.get(geometry);
		let names = Object.keys(geometry.attributes);

		if (!rg || rg.userData.sourceAttributeCount !== names.length) {
			if (rg) {
				rg.dispose();
			} else {
				// free three's per-geometry state (VAOs) together with the node's geometry
				geometry.addEventListener("dispose", () => {
					let r = this.renderGeometries.get(geometry);
					if (r) {
						r.dispose();
						this.renderGeometries.delete(geometry);
					}
				});
			}

			// only the names the shader declares: fewer attributes for three to check per draw
			rg = new THREE.BufferGeometry();
			for (let name of names) {
				if (SHADER_ATTRIBUTES.has(name)) {
					rg.setAttribute(name, geometry.attributes[name]);
				}
			}
			for (let [from, to] of ATTRIBUTE_ALIASES) {
				if (geometry.attributes[from] && !rg.attributes[to]) {
					rg.setAttribute(to, geometry.attributes[from]);
				}
			}
			// node data slot, see assignSlots / pointcloud.vs; kept with the node's geometry so it
			// survives re-creating the render geometry
			geometry.userData.slotAttribute ??= new THREE.InstancedBufferAttribute(new Float32Array([-1]), 1);
			rg.setAttribute("aSlot", geometry.userData.slotAttribute);
			rg.userData.sourceAttributeCount = names.length;
			rg.userData.source = geometry;
			this.renderGeometries.set(geometry, rg);
		}

		rg.drawRange = geometry.drawRange; // profile batches grow their draw range

		return rg;
	}

	/**
	 * Active "extra" attribute (one without a fixed shader name, bound as `aExtra`): remembers its
	 * name for the node hook and sets its scale/offset uniforms, as the legacy renderer did per node.
	 */
	setExtraAttributeUniforms(s) {
		let name = s.material.activeAttributeName;
		let root = s.octree.pcoGeometry.root;
		let attributes = root && root.geometry ? root.geometry.attributes : {};
		let isExtraAttribute = SHADER_ATTRIBUTE_NAMES[name] === undefined && attributes[name] !== undefined;

		s.extraAttributeName = isExtraAttribute ? name : null;

		if (!isExtraAttribute) {
			return;
		}

		const attExtra = s.octree.pcoGeometry.pointAttributes.attributes.find(at => at.name === name);

		let range = s.material.getRange(name);
		if (!range) {
			range = attExtra.range;
		}
		if (!range) {
			range = [0, 1];
		}

		let initialRange = attExtra.initialRange;
		let initialRangeSize = initialRange[1] - initialRange[0];

		let globalRange = range;
		let globalRangeSize = globalRange[1] - globalRange[0];

		let scale = initialRangeSize / globalRangeSize;
		let offset = -(globalRange[0] - initialRange[0]) / initialRangeSize;

		scale = Number.isNaN(scale) ? 1 : scale;
		offset = Number.isNaN(offset) ? 0 : offset;

		setUniform(s.uniforms, "uExtraScale", scale);
		setUniform(s.uniforms, "uExtraOffset", offset);
	}
}

/** uSelectionColor of clouds without edits (unused while uUseEdits is off). */
const DEFAULT_SELECTION_COLOR = new THREE.Color(1, 0.6, 0);

/** Attributes declared in src/materials/shaders/pointcloud.vs. */
const SHADER_ATTRIBUTES = new Set([
	"position", "color", "intensity", "classification", "returnNumber", "numberOfReturns",
	"pointSourceID", "indices", "spacing", "gpsTime", "normal", "aExtra", "aEdit",
]);

/** Uniforms that change from node to node (see onBeforeRenderNode); all others are per octree. */
const PER_NODE_UNIFORMS = new Set([
	"uClipPolygonVCount", "uClipPolygonWVP", "uClipPolygonVertices", "uShadowWorldView",
]);

/** Geometry attribute name -> shader attribute name (legacy `attributeLocations`). */
const ATTRIBUTE_ALIASES = [
	["rgba", "color"],
	["return number", "returnNumber"],
	["returns", "returnNumber"],
	["number of returns", "numberOfReturns"],
	["source id", "pointSourceID"],
	["point source id", "pointSourceID"],
	["gps-time", "gpsTime"],
];

/** Names the legacy renderer bound to a fixed shader attribute (everything else is "extra"). */
const SHADER_ATTRIBUTE_NAMES = {
	"position": 1, "color": 1, "rgba": 1, "intensity": 1, "classification": 1,
	"returnNumber": 1, "return number": 1, "returns": 1,
	"numberOfReturns": 1, "number of returns": 1,
	"pointSourceID": 1, "source id": 1, "point source id": 1,
	"indices": 1, "normal": 1, "spacing": 1, "gps-time": 1, "aExtra": 1,
};

/** WebGL blend factor enum (as passed in params.blendFunc) -> three.js constant. */
function glBlendFactorToThree(glFactor) {
	const map = {
		0: THREE.ZeroFactor,
		1: THREE.OneFactor,
		0x0300: THREE.SrcColorFactor,
		0x0301: THREE.OneMinusSrcColorFactor,
		0x0302: THREE.SrcAlphaFactor,
		0x0303: THREE.OneMinusSrcAlphaFactor,
		0x0304: THREE.DstAlphaFactor,
		0x0305: THREE.OneMinusDstAlphaFactor,
		0x0306: THREE.DstColorFactor,
		0x0307: THREE.OneMinusDstColorFactor,
		0x0308: THREE.SrcAlphaSaturateFactor,
	};
	let factor = map[glFactor];
	if (factor === undefined) {
		throw new Error(`PointCloudRenderer: unsupported blend factor ${glFactor}`);
	}
	return factor;
}

function setUniform(uniforms, name, value) {
	let uniform = uniforms[name];
	if (uniform) {
		uniform.value = value;
	} else {
		uniforms[name] = {value: value};
	}
}

/** Same nodes in the same order (element identity). */
function sameNodes(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}
