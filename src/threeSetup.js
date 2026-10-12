/**
 * Global three.js settings Potree relies on. Imported first in src/Potree.js so that it runs
 * before any other Potree module creates colors or textures at import time.
 *
 * Colors: three.js r152 turned color management on by default (sRGB hex colors are converted
 * to linear, output is converted back to sRGB). Potree was written for r124, which did none of
 * that, and its point cloud shaders do not take part in it. To keep the original picture,
 * color management is switched off here and every Potree renderer uses a linear output color
 * space (see Viewer.initThree and ProfileWindow). Decision D in MIGRATION_PLAN.md.
 *
 * Note: this changes the three.js module Potree is bundled with. A page that imports its own
 * copy of three (all examples/) must switch it off there as well.
 */
import * as THREE from "three";

THREE.ColorManagement.enabled = false;
