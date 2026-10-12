
import * as THREE from "three";
import {XHRFactory} from "../../XHRFactory.js";
import {state} from "../../state.js";

export class EptBinaryLoader {
	extension() {
		return '.bin';
	}

	workerPath() {
		return state.scriptPath + '/workers/EptBinaryDecoderWorker.js';
	}

	load(node) {
		if (node.loaded) return;

		// EPT nodes are addressed by key since COPC support (f7ac011b); node.url() no longer exists.
		const { Key } = window.Copc;
		let url = `${node.owner.base}/ept-data/${Key.toString(node.key)}${this.extension()}`;

		let xhr = XHRFactory.createXMLHttpRequest();
		xhr.open('GET', url, true);
		xhr.responseType = 'arraybuffer';
		xhr.overrideMimeType('text/plain; charset=x-user-defined');
		xhr.onreadystatechange = () => {
			if (xhr.readyState === 4) {
				if (xhr.status === 200) {
					let buffer = xhr.response;
					this.parse(node, buffer);
				} else {
					console.log('Failed ' + url + ': ' + xhr.status);
				}
			}
		};

		try {
			xhr.send(null);
		}
		catch (e) {
			console.log('Failed request: ' + e);
		}
	}

	parse(node, buffer) {
		let workerPath = this.workerPath();
		let worker = state.workerPool.getWorker(workerPath);

		worker.onmessage = function(e) {
			let g = new THREE.BufferGeometry();
			let numPoints = e.data.numPoints;

			let position = new Float32Array(e.data.position);
			g.setAttribute('position', new THREE.BufferAttribute(position, 3));

			let indices = new Uint8Array(e.data.indices);
			g.setAttribute('indices', new THREE.BufferAttribute(indices, 4));

			if (e.data.color) {
				let color = new Uint8Array(e.data.color);
				g.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
			}
			if (e.data.intensity) {
				let intensity = new Float32Array(e.data.intensity);
				g.setAttribute('intensity',
						new THREE.BufferAttribute(intensity, 1));
			}
			if (e.data.classification) {
				let classification = new Uint8Array(e.data.classification);
				g.setAttribute('classification',
						new THREE.BufferAttribute(classification, 1));
			}
			if (e.data.returnNumber) {
				let returnNumber = new Uint8Array(e.data.returnNumber);
				g.setAttribute('return number',
						new THREE.BufferAttribute(returnNumber, 1));
			}
			if (e.data.numberOfReturns) {
				let numberOfReturns = new Uint8Array(e.data.numberOfReturns);
				g.setAttribute('number of returns',
						new THREE.BufferAttribute(numberOfReturns, 1));
			}
			if (e.data.pointSourceId) {
				let pointSourceId = new Uint16Array(e.data.pointSourceId);
				g.setAttribute('source id',
						new THREE.BufferAttribute(pointSourceId, 1));
			}

			g.attributes.indices.normalized = true;

			let tightBoundingBox = new THREE.Box3(
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.min),
				new THREE.Vector3().fromArray(e.data.tightBoundingBox.max)
			);

			node.doneLoading(
					g,
					tightBoundingBox,
					numPoints,
					new THREE.Vector3(...e.data.mean));

			state.workerPool.returnWorker(workerPath, worker);
		};

		// Same values the pre-COPC code passed (node.ept.eptScale/eptOffset, node.key.b.min):
		// scale/offset of the X, Y, Z dimensions from the EPT schema and the node's minimum corner.
		let schema = node.owner.ept.schema;
		let xyz = ['X', 'Y', 'Z'].map(name => schema.find(dim => dim.name === name));
		let message = {
			buffer: buffer,
			schema: schema,
			scale: {x: xyz[0].scale || 1, y: xyz[1].scale || 1, z: xyz[2].scale || 1},
			offset: {x: xyz[0].offset || 0, y: xyz[1].offset || 0, z: xyz[2].offset || 0},
			mins: node.bounds.slice(0, 3)
		};

		worker.postMessage(message, [message.buffer]);
	}
};

