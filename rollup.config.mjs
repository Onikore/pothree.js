// Rollup 4 config. Bundles three.js from npm (node_modules/three) into the UMD build so that
// <script src="potree.js"> keeps working with the global `Potree`. See docs/build.md.
import {nodeResolve} from "@rollup/plugin-node-resolve";

const worker = (input, file) => ({
	input,
	plugins: [nodeResolve()],
	output: {file, format: "es", sourcemap: false},
});

export default [
	{
		input: "src/Potree.js",
		treeshake: false,
		plugins: [nodeResolve()],
		output: {
			file: "build/potree/potree.js",
			format: "umd",
			name: "Potree",
			sourcemap: true,
		},
	},
	worker("src/workers/BinaryDecoderWorker.js", "build/potree/workers/BinaryDecoderWorker.js"),
	worker("src/modules/loader/2.0/DecoderWorker.js", "build/potree/workers/2.0/DecoderWorker.js"),
	worker("src/modules/loader/2.0/DecoderWorker_brotli.js", "build/potree/workers/2.0/DecoderWorker_brotli.js"),
];
