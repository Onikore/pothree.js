
precision highp float;
precision highp int;

out highp vec4 out_FragColor;

in vec3	vColor;

void main() {

	vec3 color = vColor;

	out_FragColor = vec4(color, 1.0);
}


