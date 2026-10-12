
import "./threeSetup.js"; // must stay the first import, see the file

export * from "./Actions.js";
export * from "./AnimationPath.js";
export * from "./Annotation.js";
export * from "./defines.js";
export * from "./Enum.js";
export * from "./EventDispatcher.js";
export * from "./Features.js";
export * from "./KeyCodes.js";
export * from "./LRU.js";
export * from "./PointCloudEptGeometry.js";
export * from "./PointCloudOctree.js";
export * from "./PointCloudOctreeGeometry.js";
export * from "./PointCloudTree.js";
export * from "./Points.js";
export * from "./Potree_update_visibility.js";
export * from "./rendering/PointCloudRenderer.js";
export * from "./ProfileRequest.js";
export * from "./TextSprite.js";
export * from "./utils.js";
export * from "./Version.js";
export * from "./WorkerPool.js";
export * from "./XHRFactory.js";
export * from "./viewer/SaveProject.js";
export * from "./viewer/LoadProject.js";

export * from "./materials/ClassificationScheme.js";
export * from "./materials/EyeDomeLightingMaterial.js";
export * from "./materials/Gradients.js";
export * from "./materials/NormalizationEDLMaterial.js";
export * from "./materials/NormalizationMaterial.js";
export * from "./materials/PointCloudMaterial.js";

export * from "./loader/POCLoader.js";
export * from "./modules/loader/2.0/OctreeLoader.js";
export * from "./loader/EptLoader.js";
export * from "./loader/ept/BinaryLoader.js";
export * from "./loader/ept/LaszipLoader.js";
export * from "./loader/ept/ZstandardLoader.js";
export * from "./loader/PointAttributes.js";
export * from "./loader/ShapefileLoader.js";
export * from "./loader/GeoPackageLoader.js";

export * from "./utils/Box3Helper.js";
export * from "./utils/ClippingTool.js";
export * from "./utils/ClipVolume.js";
export * from "./utils/GeoTIFF.js";
export * from "./utils/Measure.js";
export * from "./utils/MeasuringTool.js";
export * from "./utils/Message.js";
export * from "./utils/PointCloudSM.js";
export * from "./utils/PolygonClipVolume.js";
export * from "./utils/Profile.js";
export * from "./utils/ProfileTool.js";
export * from "./utils/ScreenBoxSelectTool.js";
export * from "./utils/SpotLightHelper.js";
export * from "./utils/TransformationTool.js";
export * from "./utils/Volume.js";
export * from "./utils/VolumeTool.js";
export * from "./utils/Compass.js";

export * from "./viewer/viewer.js";
export * from "./viewer/Scene.js";
export * from "./viewer/HierarchicalSlider.js";

export * from "./modules/OrientedImages/OrientedImages.js";
export * from "./modules/Images360/Images360.js";
export * from "./modules/CameraAnimation/CameraAnimation.js";

export * from "./modules/loader/2.0/OctreeLoader.js";

export {OrbitControls} from "./navigation/OrbitControls.js";
export {FirstPersonControls} from "./navigation/FirstPersonControls.js";
export {EarthControls} from "./navigation/EarthControls.js";

import "./extensions/OrthographicCamera.js";
import "./extensions/PerspectiveCamera.js";
import "./extensions/Ray.js";

import {OctreeLoader} from "./modules/loader/2.0/OctreeLoader.js";
import {POCLoader} from "./loader/POCLoader.js";
import {CopcLoader, EptLoader} from "./loader/EptLoader.js";
import {PointCloudOctree} from "./PointCloudOctree.js";

export {state} from "./state.js";
import {state} from "./state.js";

console.log('Potree ' + state.version.major + '.' + state.version.minor + state.version.suffix);

export function loadPointCloud(path, name, callback){
	let loaded = function(e){
		e.pointcloud.name = name;
		callback(e);
	};

	let promise = new Promise( resolve => {

		// load pointcloud
		if (!path){
			// TODO: callback? comment? Hello? Bueller? Anyone?
		} else if (path.includes('ept.json')) {
			EptLoader.load(path, function(geometry) {
				if (!geometry) {
					console.error(new Error(`failed to load point cloud from URL: ${path}`));
				}
				else {
					let pointcloud = new PointCloudOctree(geometry);
					resolve({type: 'pointcloud_loaded', pointcloud: pointcloud});
				}
			});
		} else if (path.includes('.copc.laz')) {
			CopcLoader.load(path, function(geometry) {
				if (!geometry) {
					console.error(new Error(`failed to load point cloud from URL: ${path}`));
				}
				else {
					let pointcloud = new PointCloudOctree(geometry);
					resolve({type: 'pointcloud_loaded', pointcloud: pointcloud});
				}
			});
		} else if (path.indexOf('cloud.js') > 0) {
			POCLoader.load(path, function (geometry) {
				if (!geometry) {
					//callback({type: 'loading_failed'});
					console.error(new Error(`failed to load point cloud from URL: ${path}`));
				} else {
					let pointcloud = new PointCloudOctree(geometry);
					// loaded(pointcloud);
					resolve({type: 'pointcloud_loaded', pointcloud: pointcloud});
				}
			});
		} else if (path.indexOf('metadata.json') > 0) {
			OctreeLoader.load(path).then(e => {
				let geometry = e.geometry;

				if(!geometry){
					console.error(new Error(`failed to load point cloud from URL: ${path}`));
				}else{
					let pointcloud = new PointCloudOctree(geometry);

					let aPosition = pointcloud.getAttribute("position");

					let material = pointcloud.material;
					material.elevationRange = [
						aPosition.range[0][2],
						aPosition.range[1][2],
					];

					// loaded(pointcloud);
					resolve({type: 'pointcloud_loaded', pointcloud: pointcloud});
				}
			});

		} else {
			//callback({'type': 'loading_failed'});
			console.error(new Error(`failed to load point cloud from URL: ${path}`));
		}
	});

	if(callback){
		promise.then(pointcloud => {
			loaded(pointcloud);
		});
	}else{
		return promise;
	}
};
