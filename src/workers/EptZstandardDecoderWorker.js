/* global onmessage:true fzstd parseEpt */
// EPT zstandard decoder worker. Built by gulp as fzstd (node_modules/fzstd/umd/index.js) +
// libs/ept/ParseBuffer.js + this file. fzstd is a small (~25 KB) pure JS zstd decompressor; it
// replaced zstd-codec (libs/zstd-codec, a 3 MB emscripten build, removed): worker 3.1 MB -> 15 KB,
// decompression of lion_takanawa_ept_zst 124 -> 80 ms.

onmessage = function(event) {
	const decompressed = fzstd.decompress(new Uint8Array(event.data.buffer));
	// parseEpt reads event.data.buffer as an ArrayBuffer of exactly the point data
	event.data.buffer = decompressed.byteOffset === 0 && decompressed.byteLength === decompressed.buffer.byteLength
		? decompressed.buffer
		: decompressed.slice().buffer;
	parseEpt(event);
};
