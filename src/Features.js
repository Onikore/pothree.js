/**
 * What the browser's WebGL supports, for features that need more than the WebGL2 baseline.
 *
 * Potree requires WebGL2 (see src/viewer/viewer.js). In WebGL2 frag depth and enough varyings are
 * core; eye-dome lighting and high-quality splats additionally render into float textures, which
 * needs EXT_color_buffer_float. The WebGL1 version of this file checked EXT_frag_depth and
 * OES_texture_float instead.
 */
let ftCanvas = document.createElement('canvas');

export const Features = (function () {

	let gl = ftCanvas.getContext('webgl2');
	if (gl === null){
		return null;
	}

	let highpAvailable = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT).precision > 0
		&& gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0;
	let mediumpAvailable = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT).precision > 0
		&& gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT).precision > 0;

	let precision = highpAvailable ? 'highp' : (mediumpAvailable ? 'mediump' : 'lowp');

	let floatRenderTargets = () => gl.getExtension('EXT_color_buffer_float') !== null;

	return {
		SHADER_INTERPOLATION: {
			isSupported: () => true,
		},
		SHADER_SPLATS: {
			isSupported: floatRenderTargets,
		},
		SHADER_EDL: {
			isSupported: floatRenderTargets,
		},
		precision: precision
	};
}());
