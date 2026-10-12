import * as THREE from "three";
import {PointCloudTree} from "../PointCloudTree.js";
import {PointSizeType, ClipTask, ElevationGradientRepeat} from "../defines.js";

/**
 * Draws point clouds with three.js (THREE.Points + RawShaderMaterial) instead of raw WebGL.
 *
 * Drop-in replacement for the legacy `Renderer` in src/PotreeRenderer.js: same `render()` and
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

		/** node BufferGeometry -> geometry three draws (same BufferAttributes, shader names) */
		this.renderGeometries = new WeakMap();

		// render() and renderOctree() are not re-entrant; the node hook reads this state
		this.state = null;

		// three calls object.onBeforeRender(renderer, scene, camera, geometry, material, group)
		// as a method of the THREE.Points, so `this` is the scene node here
		const pointCloudRenderer = this;
		this.nodeHook = function (renderer, scene, camera, geometry) {
			pointCloudRenderer.onBeforeRenderNode(this.userData.potreeNode, geometry);
		};

		this.tmpMatrix = new THREE.Matrix4();
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
				visibilityTextureData = octree.computeVisibilityTextureData(vnNodes, camera);

				const vnt = material.visibleNodesTexture;
				const data = vnt.image.data;
				data.set(visibilityTextureData.data);
				vnt.needsUpdate = true;
			}
		}

		let rm = this.getRenderMaterial(material);

		this.updateShader(rm, material, octree, shadowMaps, params);
		this.updateBlending(rm, material, params);
		this.updateOctreeUniforms(rm, material, octree, camera, target, params, view, viewInv, proj, projInv, shadowMaps);

		// per-node state for onBeforeRenderNode
		let indices = new Map();
		for (let i = 0; i < nodes.length; i++) {
			indices.set(nodes[i], i);
		}
		this.state = {
			octree, material, rm, shadowMaps, visibilityTextureData, indices, view,
			clipPolygons: material.clipPolygons || [],
		};

		// Make exactly `nodes` visible, all drawn with the internal material and our hook.
		// Visible nodes always form a subtree from the root (a node's box contains its children's),
		// so three's traversal reaches every requested node.
		let touched = new Set([...octree.visibleNodes, ...nodes]);
		let saved = [];
		for (let node of touched) {
			let sceneNode = node.sceneNode;
			saved.push([sceneNode, sceneNode.visible, sceneNode.material, sceneNode.onBeforeRender, sceneNode.geometry]);
			sceneNode.visible = indices.has(node);
			sceneNode.material = rm;
			sceneNode.geometry = this.getRenderGeometry(sceneNode.geometry);
			sceneNode.onBeforeRender = this.nodeHook;
			sceneNode.userData.potreeNode = node;
		}

		let autoClear = renderer.autoClear;
		renderer.autoClear = false;

		renderer.render(octree, camera);

		renderer.autoClear = autoClear;
		for (let [sceneNode, visible, mat, hook, geometry] of saved) {
			sceneNode.visible = visible;
			sceneNode.material = mat;
			sceneNode.onBeforeRender = hook;
			sceneNode.geometry = geometry;
		}
		this.state = null;
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
			rm.premultipliedAlpha = false;
			this.renderMaterials.set(material, rm);
		}

		return rm;
	}

	/** Same source and #defines the legacy renderer built (src/PotreeRenderer.js renderOctree). */
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
	 * Called right before three draws a node (via nodeHook): per-node uniforms and attribute aliases.
	 * @param {PointCloudOctreeNode} node
	 * @param {THREE.BufferGeometry} geometry the node's geometry
	 */
	onBeforeRenderNode(node, geometry) {
		const s = this.state;
		const rm = s.rm;
		const u = rm.uniforms;
		let set = (name, value) => {
			if (u[name]) {
				u[name].value = value;
			} else {
				u[name] = {value: value};
			}
		};

		let world = node.sceneNode.matrixWorld;

		if (s.visibilityTextureData) {
			set("uVNStart", s.visibilityTextureData.offsets.get(node));
		}

		set("uDebug", node.debug ? true : false);
		set("uLevel", node.getLevel());
		set("uNodeSpacing", node.geometryNode.estimatedSpacing);
		set("uPCIndex", s.indices.get(node));

		if (s.clipPolygons.length > 0) {
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

			set("uClipPolygonVCount", clipPolygonVCount);
			set("uClipPolygonWVP", worldViewProj);
			set("uClipPolygonVertices", vertices);
		}

		if (s.shadowMaps.length > 0) {
			set("uShadowWorldView", s.shadowMaps.flatMap(sm =>
				this.tmpMatrix.multiplyMatrices(sm.camera.matrixWorldInverse, world).toArray()));
		}

		if (geometry.attributes["gps-time"]) {
			const attGPS = s.octree.getAttribute("gps-time");

			let initialRange = attGPS.initialRange;
			let initialRangeSize = initialRange[1] - initialRange[0];

			let globalRange = attGPS.range;
			let globalRangeSize = globalRange[1] - globalRange[0];

			let scale = initialRangeSize / globalRangeSize;
			let offset = -(globalRange[0] - initialRange[0]) / initialRangeSize;

			scale = Number.isNaN(scale) ? 1 : scale;
			offset = Number.isNaN(offset) ? 0 : offset;

			set("uGpsScale", scale);
			set("uGpsOffset", offset);

			let uFilterGPSTimeClipRange = s.material.uniforms.uFilterGPSTimeClipRange.value;
			set("uFilterGPSTimeClipRange", [
				(uFilterGPSTimeClipRange[0] - globalRange[0]) / globalRangeSize,
				(uFilterGPSTimeClipRange[1] - globalRange[0]) / globalRangeSize,
			]);
		}

		this.updateAttributeAliases(geometry, s.octree, s.material, set);

		// three uploads material uniforms only when the program or material changes; all nodes
		// share one material, so force the upload (three skips GL calls for unchanged values)
		rm.uniformsNeedUpdate = true;
	}

	/**
	 * The geometry three draws for a node: a BufferGeometry that shares the node's BufferAttribute
	 * objects under the names the shader uses (`rgba` -> `color`, `return number` -> `returnNumber`,
	 * ...; legacy mapping: attributeLocations of the removed src/PotreeRenderer.js). three uploads
	 * buffers per attribute object, so nothing is uploaded twice. The node's own geometry is not
	 * changed: Potree code (profile, exporters, point queries) iterates its attributes.
	 */
	getRenderGeometry(geometry) {
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

			rg = new THREE.BufferGeometry();
			for (let name of names) {
				rg.setAttribute(name, geometry.attributes[name]);
			}
			for (let [from, to] of ATTRIBUTE_ALIASES) {
				if (geometry.attributes[from] && !geometry.attributes[to]) {
					rg.setAttribute(to, geometry.attributes[from]);
				}
			}
			rg.userData.sourceAttributeCount = names.length;
			rg.userData.source = geometry;
			this.renderGeometries.set(geometry, rg);
		}

		rg.drawRange = geometry.drawRange; // profile batches grow their draw range

		return rg;
	}

	/**
	 * Points `aExtra` of the render geometry at the active "extra" attribute (one without a fixed
	 * shader name) and sets its scale/offset uniforms, as the legacy renderer did per node.
	 */
	updateAttributeAliases(geometry, octree, material, set) {
		let a = geometry.attributes;

		let name = material.activeAttributeName;
		let isExtraAttribute = SHADER_ATTRIBUTE_NAMES[name] === undefined && a[name] !== undefined;

		if (isExtraAttribute) {
			if (a.aExtra !== a[name]) {
				geometry.setAttribute("aExtra", a[name]);
			}

			const attExtra = octree.pcoGeometry.pointAttributes.attributes.find(at => at.name === name);

			let range = material.getRange(name);
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

			set("uExtraScale", scale);
			set("uExtraOffset", offset);
		} else if (a.aExtra) {
			geometry.deleteAttribute("aExtra");
		}
	}
}

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

/**
 * Point cloud renderer for a WebGLRenderer. Temporary switch while both renderers exist (step 5 of
 * MIGRATION_PLAN.md): set `Potree.pointCloudRenderer = "legacy"` before creating the viewer to use the
 * old raw-WebGL renderer for comparison. Default: "three".
 */
export function createPointCloudRenderer(threeRenderer, LegacyRenderer) {
	let type = (typeof Potree !== "undefined" && Potree.pointCloudRenderer)
		|| globalThis.POTREE_POINT_CLOUD_RENDERER // set by tests/visual/run.mjs --legacy-renderer
		|| "three";
	return type === "legacy" ? new LegacyRenderer(threeRenderer) : new PointCloudRenderer(threeRenderer);
}
