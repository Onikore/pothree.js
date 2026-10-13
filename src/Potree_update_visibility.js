
import * as THREE from "three";
import {ClipTask, ClipMethod} from "./defines.js";
import {Box3Helper} from "./utils/Box3Helper.js";
import {state} from "./state.js";

export function updatePointClouds(pointclouds, camera, renderer){

	for (let pointcloud of pointclouds) {
		let start = performance.now();

		for (let profileRequest of pointcloud.profileRequests) {
			profileRequest.update();

			let duration = performance.now() - start;
			if(duration > 5){
				break;
			}
		}

		let duration = performance.now() - start;
	}

	let result = updateVisibility(pointclouds, camera, renderer);

	for (let pointcloud of pointclouds) {
		pointcloud.updateMaterial(pointcloud.material, pointcloud.visibleNodes, camera, renderer);
		pointcloud.updateVisibleBounds();
	}

	state.lru.freeMemory();

	return result;
};



export function updateVisibilityStructures(pointclouds, camera, renderer) {
	let frustums = [];
	let camObjPositions = [];
	let priorityQueue = new BinaryHeap(function (x) { return 1 / x.weight; });

	for (let i = 0; i < pointclouds.length; i++) {
		let pointcloud = pointclouds[i];

		if (!pointcloud.initialized()) {
			continue;
		}

		pointcloud.numVisibleNodes = 0;
		pointcloud.numVisiblePoints = 0;
		pointcloud.deepestVisibleLevel = 0;
		pointcloud.visibleNodes = [];
		pointcloud.visibleGeometry = [];

		// frustum in object space
		camera.updateMatrixWorld();
		let frustum = new THREE.Frustum();
		let viewI = camera.matrixWorldInverse;
		let world = pointcloud.matrixWorld;
		
		// use close near plane for frustum intersection
		let proj = camera.projectionMatrix;

		let fm = new THREE.Matrix4().multiply(proj).multiply(viewI).multiply(world);
		frustum.setFromProjectionMatrix(fm);
		frustums.push(frustum);

		// camera position in object space
		let view = camera.matrixWorld;
		let worldI = world.clone().invert();
		let camMatrixObject = new THREE.Matrix4().multiply(worldI).multiply(view);
		let camObjPos = new THREE.Vector3().setFromMatrixPosition(camMatrixObject);
		camObjPositions.push(camObjPos);

		if (pointcloud.visible && pointcloud.root !== null) {
			priorityQueue.push({pointcloud: i, node: pointcloud.root, weight: Number.MAX_VALUE});
		}

		// hide all previously visible nodes
		// if(pointcloud.root instanceof PointCloudOctreeNode){
		//	pointcloud.hideDescendants(pointcloud.root.sceneNode);
		// }
		if (pointcloud.root.isTreeNode()) {
			pointcloud.hideDescendants(pointcloud.root.sceneNode);
		}

		for (let j = 0; j < pointcloud.boundingBoxNodes.length; j++) {
			pointcloud.boundingBoxNodes[j].visible = false;
		}
	}

	return {
		'frustums': frustums,
		'camObjPositions': camObjPositions,
		'priorityQueue': priorityQueue
	};
};


/**
 * Clip box as a frustum (6 planes) in the point cloud's object space, used to skip octree nodes
 * outside the clip boxes. Same math as before; it used to run for every node and every clip box
 * each frame and is now computed once per clip box per frame (see updateVisibility).
 */
function computeClipBoxFrustum(pointcloud, clipBox){
	let pcWorldInverse = pointcloud.matrixWorld.clone().invert();
	// note: multiply() mutates pcWorldInverse, so the points below are transformed by
	// pcWorldInverse * clipBox.matrixWorld (clip box space -> point cloud object space)
	let toPCObject = pcWorldInverse.multiply(clipBox.box.matrixWorld);

	let px = new THREE.Vector3(+0.5, 0, 0).applyMatrix4(pcWorldInverse);
	let nx = new THREE.Vector3(-0.5, 0, 0).applyMatrix4(pcWorldInverse);
	let py = new THREE.Vector3(0, +0.5, 0).applyMatrix4(pcWorldInverse);
	let ny = new THREE.Vector3(0, -0.5, 0).applyMatrix4(pcWorldInverse);
	let pz = new THREE.Vector3(0, 0, +0.5).applyMatrix4(pcWorldInverse);
	let nz = new THREE.Vector3(0, 0, -0.5).applyMatrix4(pcWorldInverse);

	let pxN = new THREE.Vector3().subVectors(nx, px).normalize();
	let nxN = pxN.clone().multiplyScalar(-1);
	let pyN = new THREE.Vector3().subVectors(ny, py).normalize();
	let nyN = pyN.clone().multiplyScalar(-1);
	let pzN = new THREE.Vector3().subVectors(nz, pz).normalize();
	let nzN = pzN.clone().multiplyScalar(-1);

	let pxPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(pxN, px);
	let nxPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(nxN, nx);
	let pyPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(pyN, py);
	let nyPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(nyN, ny);
	let pzPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(pzN, pz);
	let nzPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(nzN, nz);

	return new THREE.Frustum(pxPlane, nxPlane, pyPlane, nyPlane, pzPlane, nzPlane);
}

export function updateVisibility(pointclouds, camera, renderer){

	let numVisibleNodes = 0;
	let numVisiblePoints = 0;
	// adaptive point budget (viewer.setAdaptivePointBudget): fewer points while the camera moves
	const pointBudget = state.pointBudget * state.pointBudgetFactor;

	let numVisiblePointsInPointclouds = new Map(pointclouds.map(pc => [pc, 0]));

	let visibleNodes = [];
	let visibleGeometry = [];
	let unloadedGeometry = [];

	let lowestSpacing = Infinity;

	// calculate object space frustum and cam pos and setup priority queue
	let s = updateVisibilityStructures(pointclouds, camera, renderer);
	let frustums = s.frustums;
	let camObjPositions = s.camObjPositions;
	let priorityQueue = s.priorityQueue;

	let loadedToGPUThisFrame = 0;
	
	let domWidth = renderer.domElement.clientWidth;
	let domHeight = renderer.domElement.clientHeight;

	// check if pointcloud has been transformed
	// some code will only be executed if changes have been detected
	if(!state._pointcloudTransformVersion){
		state._pointcloudTransformVersion = new Map();
	}
	let pointcloudTransformVersion = state._pointcloudTransformVersion;
	for(let pointcloud of pointclouds){

		if(!pointcloud.visible){
			continue;
		}

		pointcloud.updateMatrixWorld();

		if(!pointcloudTransformVersion.has(pointcloud)){
			pointcloudTransformVersion.set(pointcloud, {number: 0, transform: pointcloud.matrixWorld.clone()});
		}else{
			let version = pointcloudTransformVersion.get(pointcloud);

			if(!version.transform.equals(pointcloud.matrixWorld)){
				version.number++;
				version.transform.copy(pointcloud.matrixWorld);

				pointcloud.dispatchEvent({
					type: "transformation_changed",
					target: pointcloud
				});
			}
		}
	}

	// clip box frustums, once per frame. Keyed by point cloud, then clip box: the same clip box is
	// usually shared by all point clouds, but the frustum is in each point cloud's object space.
	let clipBoxFrustumsByPointcloud = new Map();
	for(let pointcloud of pointclouds){
		let frustums = new Map();
		for(let clipBox of pointcloud.material.clipBoxes){
			frustums.set(clipBox, computeClipBoxFrustum(pointcloud, clipBox));
		}
		clipBoxFrustumsByPointcloud.set(pointcloud, frustums);
	}

	while (priorityQueue.size() > 0) {
		let element = priorityQueue.pop();
		let node = element.node;
		let parent = element.parent;
		let pointcloud = pointclouds[element.pointcloud];

		// { // restrict to certain nodes for debugging
		//	let allowedNodes = ["r", "r0", "r4"];
		//	if(!allowedNodes.includes(node.name)){
		//		continue;
		//	}
		// }

		let box = node.getBoundingBox();
		let frustum = frustums[element.pointcloud];
		let camObjPos = camObjPositions[element.pointcloud];

		let insideFrustum = frustum.intersectsBox(box);
		let maxLevel = pointcloud.maxLevel || Infinity;
		let level = node.getLevel();
		let visible = insideFrustum;
		visible = visible && !(numVisiblePoints + node.getNumPoints() > pointBudget);
		visible = visible && !(numVisiblePointsInPointclouds.get(pointcloud) + node.getNumPoints() > pointcloud.pointBudget);
		visible = visible && level < maxLevel;
		visible = visible || node.getLevel() <= 2;

		let clipBoxes = pointcloud.material.clipBoxes;
		if(true && clipBoxes.length > 0){

			//node.debug = false;

			let numIntersecting = 0;
			let numIntersectionVolumes = 0;

			//if(node.name === "r60"){
			//	var a = 10;
			//}

			for(let clipBox of clipBoxes){

				let frustum = clipBoxFrustumsByPointcloud.get(pointcloud).get(clipBox);
				let intersects = frustum.intersectsBox(box);

				if(intersects){
					numIntersecting++;
				}
				numIntersectionVolumes++;
			}

			let insideAny = numIntersecting > 0;
			let insideAll = numIntersecting === numIntersectionVolumes;

			if(pointcloud.material.clipTask === ClipTask.SHOW_INSIDE){
				if(pointcloud.material.clipMethod === ClipMethod.INSIDE_ANY && insideAny){
					//node.debug = true
				}else if(pointcloud.material.clipMethod === ClipMethod.INSIDE_ALL && insideAll){
					//node.debug = true;
				}else{
					visible = false;
				}
			} else if(pointcloud.material.clipTask === ClipTask.SHOW_OUTSIDE){
				//if(pointcloud.material.clipMethod === ClipMethod.INSIDE_ANY && !insideAny){
				//	//visible = true;
				//	let a = 10;
				//}else if(pointcloud.material.clipMethod === ClipMethod.INSIDE_ALL && !insideAll){
				//	//visible = true;
				//	let a = 20;
				//}else{
				//	visible = false;
				//}
			}
			

		}

		// visible = ["r", "r0", "r06", "r060"].includes(node.name);
		// visible = ["r"].includes(node.name);

		if (node.spacing) {
			lowestSpacing = Math.min(lowestSpacing, node.spacing);
		} else if (node.geometryNode && node.geometryNode.spacing) {
			lowestSpacing = Math.min(lowestSpacing, node.geometryNode.spacing);
		}

		if (numVisiblePoints + node.getNumPoints() > pointBudget) {
			break;
		}

		if (!visible) {
			continue;
		}

		// TODO: not used, same as the declaration?
		// numVisibleNodes++;
		numVisiblePoints += node.getNumPoints();
		let numVisiblePointsInPointcloud = numVisiblePointsInPointclouds.get(pointcloud);
		numVisiblePointsInPointclouds.set(pointcloud, numVisiblePointsInPointcloud + node.getNumPoints());

		pointcloud.numVisibleNodes++;
		pointcloud.numVisiblePoints += node.getNumPoints();

		if (node.isGeometryNode() && (!parent || parent.isTreeNode())) {
			if (node.isLoaded() && loadedToGPUThisFrame < 2) {
				node = pointcloud.toTreeNode(node, parent);
				loadedToGPUThisFrame++;
			} else {
				unloadedGeometry.push(node);
				visibleGeometry.push(node);
			}
		}

		if (node.isTreeNode()) {
			state.lru.touch(node.geometryNode);
			node.sceneNode.visible = true;

			visibleNodes.push(node);
			pointcloud.visibleNodes.push(node);

			if(node._transformVersion === undefined){
				node._transformVersion = -1;
			}
			let transformVersion = pointcloudTransformVersion.get(pointcloud);
			if(node._transformVersion !== transformVersion.number){
				node.sceneNode.updateMatrix();
				node.sceneNode.matrixWorld.multiplyMatrices(pointcloud.matrixWorld, node.sceneNode.matrix);	
				node._transformVersion = transformVersion.number;
			}

			if (pointcloud.showBoundingBox && !node.boundingBoxNode && node.getBoundingBox) {
				let boxHelper = new Box3Helper(node.getBoundingBox());
				boxHelper.matrixAutoUpdate = false;
				pointcloud.boundingBoxNodes.push(boxHelper);
				node.boundingBoxNode = boxHelper;
				node.boundingBoxNode.matrix.copy(pointcloud.matrixWorld);
			} else if (pointcloud.showBoundingBox) {
				node.boundingBoxNode.visible = true;
				node.boundingBoxNode.matrix.copy(pointcloud.matrixWorld);
			} else if (!pointcloud.showBoundingBox && node.boundingBoxNode) {
				node.boundingBoxNode.visible = false;
			}

			// if(node.boundingBoxNode !== undefined && state.debug.allowedNodes !== undefined){
			// 	if(!state.debug.allowedNodes.includes(node.name)){
			// 		node.boundingBoxNode.visible = false;
			// 	}
			// }
		}

		// add child nodes to priorityQueue
		let children = node.getChildren();
		for (let i = 0; i < children.length; i++) {
			let child = children[i];

			let weight = 0; 
			if(camera.isPerspectiveCamera){
				let sphere = child.getBoundingSphere();
				let center = sphere.center;
				//let distance = sphere.center.distanceTo(camObjPos);
				
				let dx = camObjPos.x - center.x;
				let dy = camObjPos.y - center.y;
				let dz = camObjPos.z - center.z;
				
				let dd = dx * dx + dy * dy + dz * dz;
				let distance = Math.sqrt(dd);
				
				
				let radius = sphere.radius;
				
				let fov = (camera.fov * Math.PI) / 180;
				let slope = Math.tan(fov / 2);
				let projFactor = (0.5 * domHeight) / (slope * distance);
				let screenPixelRadius = radius * projFactor;
				
				if(screenPixelRadius < pointcloud.minimumNodePixelSize){
					continue;
				}
			
				weight = screenPixelRadius;

				if(distance - radius < 0){
					weight = Number.MAX_VALUE;
				}
			} else {
				// TODO ortho visibility
				let bb = child.getBoundingBox();				
				let distance = child.getBoundingSphere().center.distanceTo(camObjPos);
				let diagonal = bb.max.clone().sub(bb.min).length();
				//weight = diagonal / distance;

				weight = diagonal;
			}

			priorityQueue.push({pointcloud: element.pointcloud, node: child, parent: node, weight: weight});
		}
	}// end priority queue loop

	// The original updated a DEM here (`p.dem instanceof Potree.DEM`), but no DEM class exists in
	// this code base; with generateDEM enabled it threw. Removed in the fork (DEM support never shipped).

	for (let i = 0; i < Math.min(state.maxNodesLoading, unloadedGeometry.length); i++) {
		unloadedGeometry[i].load();
	}

	return {
		visibleNodes: visibleNodes,
		numVisiblePoints: numVisiblePoints,
		lowestSpacing: lowestSpacing
	};
};

