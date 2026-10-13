// WebGL vs WebGPU (three) on the same point data, to decide whether a WebGPURenderer port pays off.
//
//   node tests/perf/webgpu.mjs                 env: BUDGET (default 15M), OUT (screenshot dir)
//
// Loads ca13 with Potree (WebGL), freezes its visible nodes, stops the viewer, then draws the same
// node buffers with plain three renderers on a fresh canvas, 6 x 3 s each, no vsync, real GPU
// (WebGPU needs the Vulkan flags below; without them Chromium gives a SwiftShader adapter):
//   webgl points 1px / size2   THREE.Points + RawShaderMaterial (what Potree does)
//   webgpu points 1px          THREE.Points + PointsNodeMaterial (WebGPU points are 1 px only)
//   webgpu quads size2         one instanced quad per point (how sized points would be done)
// Result 2026-10-13 (r186, RTX 4050): no sustained gain, see PERFORMANCE.md.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import {fileURLToPath} from "node:url";
import pw from "playwright";
import {exposePotree} from "../potreeGlobal.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIME = {".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml"};
const server = http.createServer((req, res) => { const f = path.join(root, decodeURIComponent(new URL(req.url,"http://x").pathname));
  fs.readFile(f, (e, d) => e ? res.writeHead(404).end() : res.writeHead(200, {"Content-Type": MIME[path.extname(f)] ?? "application/octet-stream"}).end(d)); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await pw.chromium.launch({args: ["--enable-unsafe-webgpu","--enable-gpu","--ignore-gpu-blocklist","--use-angle=vulkan",
  "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan","--use-vulkan=native","--disable-gpu-vsync","--disable-frame-rate-limit"]});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
page.on("pageerror", e => console.log("pageerror", e.message));
page.on("console", m => m.type() === "error" && console.log("console", m.text().slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/examples/ca13.html`);
await exposePotree(page);
await page.waitForFunction(() => window.viewer && viewer.scene.pointclouds.length > 0, null, {timeout: 120000});
await page.evaluate((b) => { viewer.setPointBudget(b); viewer.setMinNodeSize(0); }, Number(process.env.BUDGET ?? 15e6));
let last = "", since = Date.now();
while (Date.now() - since < 8000) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => JSON.stringify([Potree.numNodesLoading, viewer.scene.pointclouds[0].visibleNodes.length]));
  if (s !== last) { last = s; since = Date.now(); }
}
console.log(await page.evaluate(() => {
  viewer.setFreeze(true);
  viewer.renderer.setAnimationLoop(null);
  viewer.renderer.domElement.style.display = "none";
  const cam = viewer.scene.getActiveCamera();
  window.__nodes = viewer.scene.pointclouds[0].visibleNodes.map(n => ({
    position: n.sceneNode.geometry.attributes.position, color: n.sceneNode.geometry.attributes.color, matrix: n.sceneNode.matrixWorld.clone()}));
  window.__cam = cam;
  const pts = window.__nodes.reduce((s, n) => s + n.position.count, 0);
  return JSON.stringify({nodes: window.__nodes.length, points: pts, colorType: window.__nodes[0].color?.array.constructor.name, normalized: window.__nodes[0].color?.normalized});
}));

const setups = {
  "webgl points 1px": async () => {
    const THREE = await import("three");
    const canvas = document.createElement("canvas"); canvas.style = "position:fixed;left:0;top:0;width:1280px;height:800px"; document.body.appendChild(canvas);
    const r = new THREE.WebGLRenderer({canvas, antialias: false}); r.setSize(1280, 800, false);
    const mat = new THREE.RawShaderMaterial({glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float; in vec3 position; in vec4 color; out vec3 vColor; uniform mat4 modelViewMatrix, projectionMatrix;
        void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 1.0; vColor = color.rgb; }`,
      fragmentShader: `precision highp float; in vec3 vColor; out vec4 c; void main(){ c = vec4(vColor, 1.0); }`});
    const scene = new THREE.Scene();
    for (const n of __nodes) { const g = new THREE.BufferGeometry(); g.setAttribute("position", n.position); g.setAttribute("color", n.color);
      const o = new THREE.Points(g, mat); o.matrixAutoUpdate = false; o.matrix.copy(n.matrix); o.frustumCulled = false; scene.add(o); }
    r.setAnimationLoop(() => r.render(scene, __cam));
    window.__stop = () => { r.setAnimationLoop(null); r.dispose(); canvas.remove(); };
  },
  "webgl points size2": async () => {
    const THREE = await import("three");
    const canvas = document.createElement("canvas"); canvas.style = "position:fixed;left:0;top:0;width:1280px;height:800px"; document.body.appendChild(canvas);
    const r = new THREE.WebGLRenderer({canvas, antialias: false}); r.setSize(1280, 800, false);
    const mat = new THREE.RawShaderMaterial({glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float; in vec3 position; in vec4 color; out vec3 vColor; uniform mat4 modelViewMatrix, projectionMatrix;
        void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 2.0; vColor = color.rgb; }`,
      fragmentShader: `precision highp float; in vec3 vColor; out vec4 c; void main(){ c = vec4(vColor, 1.0); }`});
    const scene = new THREE.Scene();
    for (const n of __nodes) { const g = new THREE.BufferGeometry(); g.setAttribute("position", n.position); g.setAttribute("color", n.color);
      const o = new THREE.Points(g, mat); o.matrixAutoUpdate = false; o.matrix.copy(n.matrix); o.frustumCulled = false; scene.add(o); }
    r.setAnimationLoop(() => r.render(scene, __cam));
    window.__stop = () => { r.setAnimationLoop(null); r.dispose(); canvas.remove(); };
  },
  "webgpu points 1px": async () => {
    const THREE = await import("/node_modules/three/build/three.webgpu.js");
    const canvas = document.createElement("canvas"); canvas.style = "position:fixed;left:0;top:0;width:1280px;height:800px"; document.body.appendChild(canvas);
    const r = new THREE.WebGPURenderer({canvas, antialias: false}); r.setSize(1280, 800, false); await r.init();
    if (!r.backend.isWebGPUBackend) throw new Error("not WebGPU backend");
    const mat = new THREE.PointsNodeMaterial({vertexColors: true});
    const scene = new THREE.Scene();
    for (const n of __nodes) { const g = new THREE.BufferGeometry(); g.setAttribute("position", n.position); g.setAttribute("color", n.color);
      const o = new THREE.Points(g, mat); o.matrixAutoUpdate = false; o.matrix.copy(n.matrix); o.frustumCulled = false; scene.add(o); }
    await r.compileAsync(scene, __cam);
    r.setAnimationLoop(() => r.render(scene, __cam));
    window.__stop = () => { r.setAnimationLoop(null); r.dispose(); canvas.remove(); };
  },
  "webgpu quads size2": async () => {
    const THREE = await import("/node_modules/three/build/three.webgpu.js");
    const T = THREE.TSL;
    const canvas = document.createElement("canvas"); canvas.style = "position:fixed;left:0;top:0;width:1280px;height:800px"; document.body.appendChild(canvas);
    const r = new THREE.WebGPURenderer({canvas, antialias: false}); r.setSize(1280, 800, false); await r.init();
    // one quad per point (instancing): clip position of the point + corner offset of 2 px
    const mat = new THREE.MeshBasicNodeMaterial();
    const center = T.attribute("instPos", "vec3");
    const clip = T.cameraProjectionMatrix.mul(T.modelViewMatrix.mul(T.vec4(center, 1.0)));
    const px = T.vec2(2.0 / 1280, 2.0 / 800).mul(2.0);
    mat.vertexNode = clip.add(T.vec4(T.positionGeometry.xy.mul(px).mul(clip.w), 0.0, 0.0));
    mat.colorNode = T.attribute("instColor", "vec4").rgb;
    const quad = new THREE.PlaneGeometry(1, 1);
    const scene = new THREE.Scene();
    for (const n of __nodes) {
      const g = new THREE.InstancedBufferGeometry(); g.index = quad.index; g.setAttribute("position", quad.attributes.position);
      g.setAttribute("instPos", new THREE.InstancedBufferAttribute(n.position.array, 3));
      g.setAttribute("instColor", new THREE.InstancedBufferAttribute(n.color.array, n.color.itemSize, n.color.normalized));
      g.instanceCount = n.position.count;
      const o = new THREE.Mesh(g, mat); o.matrixAutoUpdate = false; o.matrix.copy(n.matrix); o.frustumCulled = false; scene.add(o); }
    await r.compileAsync(scene, __cam);
    r.setAnimationLoop(() => r.render(scene, __cam));
    window.__stop = () => { r.setAnimationLoop(null); r.dispose(); canvas.remove(); };
  },
};
const measure = () => page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(n / (performance.now() - t0) * 1000); }; requestAnimationFrame(f); }));
for (const [name, fn] of Object.entries(setups)) {
  try {
    await page.evaluate(`(${fn})()`);
    await page.waitForTimeout(2000);
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await measure());
    if (process.env.OUT) await page.screenshot({path: `${process.env.OUT}/${name.replace(/ /g, "_")}.png`});
    console.log(name.padEnd(20), runs.map(f => (1000 / f).toFixed(2) + " ms").join("  "));
    await page.evaluate(() => window.__stop());
  } catch (e) { console.log(name, "ERR", e.message.split("\n")[0]); }
}
await browser.close(); server.close();
