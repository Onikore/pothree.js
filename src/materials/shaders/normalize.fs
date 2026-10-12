precision mediump float;
precision mediump int;

out highp vec4 out_FragColor;

uniform sampler2D uWeightMap;
uniform sampler2D uDepthMap;

in vec2 vUv;

void main() {
	float depth = texture(uDepthMap, vUv).r;
	
	if(depth >= 1.0){
		discard;
	}

	out_FragColor = vec4(depth, 1.0, 0.0, 1.0);

	vec4 color = texture(uWeightMap, vUv); 
	color = color / color.w;
	
	out_FragColor = vec4(color.xyz, 1.0); 
	
	gl_FragDepth = depth;


}