
precision mediump float;
precision mediump int;

out highp vec4 out_FragColor;

in vec3 vColor;
in float vLinearDepth;

void main() {

	//out_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
	//out_FragColor = vec4(vColor, 1.0);
	//out_FragColor = vec4(vLinearDepth, pow(vLinearDepth, 2.0), 0.0, 1.0);
	out_FragColor = vec4(vLinearDepth, vLinearDepth / 30.0, vLinearDepth / 30.0, 1.0);
	
}


