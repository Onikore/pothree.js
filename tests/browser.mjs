// Chromium flags of the browser tests.
//   SwiftShader (default): software WebGL, the same pixels on every machine - the reference, used in CI.
//   --gpu: the real GPU through ANGLE/Vulkan - several times faster locally, keeps the CPU cool;
//          screenshots need their own baselines (tests/visual/baseline-gpu).
export const gpu = process.argv.includes("--gpu");

export const chromiumArgs = gpu
	? ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"]
	: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
