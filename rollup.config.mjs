// Rollup 4 config. Two builds of the same code (docs/build.md):
// - build/potree/potree.module.js: ES module, `three` external - the page or bundler supplies the one
//   copy of three.js (import map / npm). Use this one. Minified copy: potree.module.min.js.
// - build/potree/potree.js: UMD with three.js bundled, for <script src="potree.js"> and the global `Potree`.
import {nodeResolve} from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";

const worker = (input, file) => ({
	input,
	plugins: [nodeResolve()],
	output: {file, format: "es", sourcemap: false},
});

export default [
	{
		input: "src/Potree.js",
		external: ["three", /^three\//],
		output: [
			{file: "build/potree/potree.module.js", format: "es", sourcemap: true},
			// keep_classnames: class names are user-visible (InputHandler logs, project files)
			{file: "build/potree/potree.module.min.js", format: "es", sourcemap: true,
				plugins: [terser({keep_classnames: true})]},
		],
	},
	{
		input: "src/umd.js",
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
