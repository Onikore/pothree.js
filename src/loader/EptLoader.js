import {PointCloudCopcGeometry, PointCloudCopcGeometryNode, PointCloudEptGeometry} from "../PointCloudEptGeometry.js";
/**
 * @author Connor Manning
 */

export class EptLoader {
	static async load(file, callback) {

		let response = await fetch(file);
		let json = await response.json();

		let url = file.substr(0, file.lastIndexOf('/ept.json'));
		let geometry = new PointCloudEptGeometry(url, json);
		let root = new PointCloudCopcGeometryNode(geometry);

		geometry.root = root;
		geometry.root.load();

		callback(geometry);
	}
};

export class CopcLoader {
	static async load(file, callback) {
		const { Copc, Getter } = window.Copc

		const url = file;
		const getter = Getter.http(url);
		const copc = await Copc.create(getter);

		let geometry = new PointCloudCopcGeometry(getter, copc);
		let root = new PointCloudCopcGeometryNode(geometry);

		geometry.root = root;
		geometry.root.load();

		callback(geometry);
	}
}
