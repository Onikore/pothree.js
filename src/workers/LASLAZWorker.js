/* global onmessage:true postMessage:false Copc */
/* exported onmessage */
// LAZ decoder worker for Potree 1.x LAZ nodes (libs/plasio/js/laslaz.js, LAZLoader).
//
// Built by gulp as libs/copc/index.js + this file (build/potree/workers/LASLAZWorker.js). Decompresses
// with laz-perf compiled to WebAssembly (the one COPC/EPT use, workers/laz-perf.wasm) instead of the
// 2016 asm.js build of laz-perf (libs/plasio/workers/laz-perf.js, 1.6 MB, removed): decoding the 200
// lion_laz nodes takes 272 ms instead of 510 ms, and the worker script is 93 KB instead of 1.6 MB.
//
// Same message protocol as the old worker: open -> header -> read* -> close; one request at a time
// (laslaz.js waits for each answer). The node file is decompressed once, on the first read.

let file = null; // {arraybuffer, header, points (Uint8Array, decompressed), readOffset}

function parseLASHeader(arraybuffer) {
	const view = new DataView(arraybuffer);
	const o = {};

	o.pointsOffset = view.getUint32(32 * 3, true);
	o.pointsFormatId = view.getUint8(32 * 3 + 8) & 0b111111;
	o.pointsStructSize = view.getUint16(32 * 3 + 8 + 1, true);

	o.extraBytes = 0;
	switch (o.pointsFormatId) {
		case 0: o.extraBytes = o.pointsStructSize - 20; break;
		case 1: o.extraBytes = o.pointsStructSize - 28; break;
		case 2: o.extraBytes = o.pointsStructSize - 26; break;
		case 3: o.extraBytes = o.pointsStructSize - 34; break;
	}

	o.pointsCount = view.getUint32(32 * 3 + 11, true);

	let start = 32 * 3 + 35;
	const f64 = (n) => { const r = []; for (let i = 0; i < n; i++, start += 8) r.push(view.getFloat64(start, true)); return r; };
	o.scale = f64(3);
	o.offset = f64(3);
	const bounds = f64(6);
	o.maxs = [bounds[0], bounds[2], bounds[4]];
	o.mins = [bounds[1], bounds[3], bounds[5]];

	return o;
}

async function handleEvent(msg) {
	switch (msg.type) {
		case "open":
			file = {arraybuffer: msg.arraybuffer, header: null, points: null, readOffset: 0};
			postMessage({type: "open", status: 1});
			break;

		case "header":
			if (!file) throw new Error("You need to open the file before reading the header");
			file.header = parseLASHeader(file.arraybuffer);
			postMessage({type: "header", status: 1, header: file.header});
			break;

		case "read": {
			if (!file || !file.header) throw new Error("You need to open the file and query the header before reading");
			const h = file.header;
			if (!file.points) {
				file.points = await Copc.Las.PointData.decompressFile(new Uint8Array(file.arraybuffer));
			}

			const {count, skip} = msg;
			const pointsToRead = Math.min(count * skip, h.pointsCount - file.readOffset);
			const size = h.pointsStructSize;
			let buffer;
			let pointsRead;
			if (skip === 1) {
				pointsRead = pointsToRead;
				buffer = file.points.slice(file.readOffset * size, (file.readOffset + pointsRead) * size).buffer;
			} else {
				pointsRead = Math.ceil(pointsToRead / skip);
				const out = new Uint8Array(pointsRead * size);
				for (let k = 0; k < pointsRead; k++) {
					const i = file.readOffset + k * skip;
					out.set(file.points.subarray(i * size, (i + 1) * size), k * size);
				}
				buffer = out.buffer;
			}
			file.readOffset += pointsToRead;

			postMessage({
				type: "header",
				status: 1,
				buffer: buffer,
				count: pointsRead,
				hasMoreData: file.readOffset < h.pointsCount,
			}, [buffer]);
			break;
		}

		case "close":
			file = null;
			postMessage({type: "close", status: 1});
			break;
	}
}

onmessage = async function (event) {
	try {
		await handleEvent(event.data);
	} catch (e) {
		postMessage({type: event.data.type, status: 0, details: String(e)});
	}
};
