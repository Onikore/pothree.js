// Entry of the UMD build (build/potree/potree.js, global `Potree`): everything from src/Potree.js
// plus the global-object compatibility of src/umdCompat.js. The ES module build uses src/Potree.js.
export * from "./Potree.js";
import "./umdCompat.js";
