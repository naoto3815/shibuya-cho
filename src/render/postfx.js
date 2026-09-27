// [render] EffectComposer chain (§9).
//   ScenePass (MSAA, HalfFloat, own DepthTexture; NO blit — the haze reads that target directly)
//   → normals-from-depth G-buffer at AO res
//   → GTAO contact (r 0.9, OUTPUT.Off) → HBAO-form obscurance (two range-weighted rings, 0.30 res) + box blur
//   → haze+exposure (composites BOTH AO buffers — the big one bilaterally upsampled — behind a two-part
//   direct-light guard, aerial perspective, inscatter, hemisphere sodium→plum sky glow, linear, pre-bloom;
//   the exposure carries the night trim that separates emitters from surfaces)
//   → near-CoC mask (half res, dilated + coverage) → far-field bokeh gather (half res, CoC-area weights)
//   → cinematic composite (bilateral bokeh upsample + near-field scatter-as-gather + radial)
//   → [BLOOM-layer gate, off by default and allocated lazily: see setSelectiveBloom] → UnrealBloom (one tier,
//     0.75-scale pyramid, peak-channel knee'd high-pass, mips 3-4 truly disabled, sky-killed and chroma-
//     guarded composite — see patchBloomComposite)
//   → grade (ACES + sRGB encode folded in from OutputPass, then: neutral-weighted split tone, power contrast,
//     chroma-knee'd saturation, exponential shoulder, multiplicative toe + black floor, CA, wet lens,
//     combat look + heat vignette, flash, vignette, grain, slope-scaled dither)
//   → SMAA/FXAA (LAST: the grade does the CA fetch, and SMAA's edge detector wants gamma-space luma).
// DoF runs BEFORE bloom on purpose: the halo then follows the circle of confusion instead of being smeared by it.
// The engine loop calls postfx.render() instead of renderer.render when this module is present.
//   postfx.setDOF(on, {focus, range, strength})   postfx.setCamera(cam)   postfx.setSize(w, h)
// Events in:  lighting:exposure, lighting:changed, postfx:bloom, postfx:ao, postfx:haze, postfx:grade,
//             weather:changed, combat:hit, combat:ko, heat:action, combat:start/end. Polled: combat.finale (the final
//             blow: radial blur on the contact, desaturation with the warm light kept, contrast / vignette / CA on
//             its real-time clock — numbers in combat/finalBlow.js).
// Debug URL params (all optional): ?postfx=ao|normal|near|far|mask|selective|noao|nobloom|nograde|q1|q0|off
//   ?aotune=r,thick,scale,samples,bigRadius,sigma,power,bias,gtaoExp,bigExp
//   ?bloomtune=strength,f0,f1,f2,f3,f4   ?doftune=focus,range,strength
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { PRESETS } from '../debug/shots.js';
import { FINAL_BLOW, fbLook, fbBlur } from '../combat/finalBlow.js';

// The composer renders at the renderer's pixel ratio, which engine.js now owns (start 1.25 on Retina, the adaptive
// governor moves it between 1.0 and 2.0, ?res= fixes it). The canvas is the same size, so there is no longer a
// full-Retina last pass upscaling a 1.25 image. 2.0 is only a safety cap.
const MAX_PR = 2.0;
// engine.renderRatio() is the governed render ratio; the canvas (renderer pixel ratio) is fixed and may be larger
const renderPR = (engine) => Math.min(MAX_PR, engine && typeof engine.renderRatio === 'function' ? engine.renderRatio() : engine.renderer.getPixelRatio());
const MSAA = 4;              // geometry edges; SMAA cleans the alpha-tested sign edges afterwards
// 2880x1620 x HalfFloat x 4 samples is ~150 MB for the scene target alone. Above 1.2 pr the extra samples buy
// nothing SMAA is not already doing, so halve them and keep the allocation off an 8 GB integrated GPU's back.
// ?msaa=<n> overrides it. On Metal/ANGLE a multisampled HalfFloat colour target with a depth-texture
// attachment can fall off the fast path entirely, so this is the first thing to try when the SCENE pass
// (not the chain) is what the GPU timer blames — see docs/reports/perf.md.
// Keyed on the DEVICE, not the current ratio: the governor moves the ratio at run time, and 4 samples at 1.125
// would cost more than 2 samples at 1.25 — a step down that makes the frame dearer.
const msaaFor = (pr) => {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('msaa') : null;
  if (q !== null && isFinite(Number(q))) return Math.max(0, Number(q) | 0);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return pr > 1.2 || dpr > 1.2 ? 2 : MSAA;
};
// 0.75, not 0.5: at half res the 5th mip of a 1080p frame is ~30x17 px — a frame average, i.e. a veil. The
// pyramid has to start close enough to native that its top mip is still a local neighbourhood.
const BLOOM_SCALE = 0.75;
// per-mip weights for the tight tier. three's default [1, .8, .6, .4, .2] is a low-pass of the whole frame;
// this pyramid has to be a HALO — mip 0 and 1 carry it, the top mips are a whisper. MONOTONIC is not a style
// choice: the old [1, .30, .60, 0, 0] weighted mip 2 twice as hard as mip 1, and at BLOOM_SCALE 0.75 one mip-2
// texel is 5.3 screen px with a ~70 px kernel — that 70 px pillow is what sat on the SHIBUYA SKY glyphs and
// erased MAGNET. A pyramid whose weights rise with mip radius is a veil generator by construction.
// [1, .42, .16, .05, 0] went too far the other way: with mip 1 at 0.42 and mip 2 at 0.16 a neon tube's halo
// died inside 6 px, i.e. inside its own bezel, and the whole pass moved 2.5% of the frame. A 20-30 px glow on
// a 18 px tube needs mips 1-2 back — still monotonic, still no frame-average mip 4.
// ...and mips 3-4 have to be EXACTLY zero, not a whisper. Measured A/B against ?postfx=nobloom with
// [1, .72, .38, .12, .03]: the halo right of the SHIBUYA SKY bezel fell to +5.9 LSB at 24 px and then sat on a
// FLAT +3.1 LSB pedestal out past 256 px and all the way to the frame edge, i.e. mips 3-4 were a frame
// average added to every pixel. That pedestal is why the DARKEST 15% of the frame gained +9.3 while the
// brightest gained +0.7 — the pyramid was pumping energy into the shadows. The halo energy moves onto mips
// 0-1 instead (see the base strength in applyBloom).
const BLOOM_FACTORS = [1.0, 0.68, 0.22, 0.0, 0.0];
// true while the game is actually being played (not a cutscene / not frozen for a screenshot)
const engineIsPlaying = (e) => !!e && !(e.state && (e.state.mode === 'cutscene' || e.state.frozen));
// resolution of the normal G-buffer and of the GTAO contact tier. 0.40 put a pedestrian's shoe at 10-40 m under
// two AO texels and made the 0.9 m contact radius sub-texel — i.e. no shoe pools anywhere on the crosswalk.
const CONTACT_SCALE = 0.60;
// the BLOOM-layer gate is a mask, not an image: 0.35 res is plenty and the slight dilation from the upsample
// is wanted (a sign's halo should start at its bezel, not one texel inside it)
const MASK_SCALE = 0.35;
// the large-scale obscurance is a low-frequency signal; 0.30 res upsampled with a tent is free and smooth
const BIG_SCALE = 0.30;
// Objects that cost the prepass its draw calls and give it nothing: far impostors, additive glare quads,
// ground decals, and every crowd LOD part that is not the body silhouette making the contact pool.

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------------------------------------------------------------- scene pass (owns depth for GTAO/haze/DoF)
class ScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene; this.camera = camera; this.target = target;
    this.needsSwap = false;
    this.timer = null;              // optional GpuTimer: postfx subtracts the scene from the composer total
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      name: 'postfx:blit', uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.quad.material.uniforms.opacity.value = 1;
  }
  // NO BLIT on the shipping path. Copying sceneRT into the composer's read buffer was 16.6 MB read + 16.6 MB
  // written every frame at 1920x1080 HalfFloat — ~2 GB/s of bandwidth for a copy — and it bought nothing: the
  // first consumer is the haze pass, which now reads this.target.texture directly (see SourceShaderPass).
  // The quad survives for the ?postfx=normal|near|far|mask debug views, which DO have to put a foreign texture
  // into the chain, and for the degenerate case where this pass is the last enabled one.
  render(renderer, writeBuffer, readBuffer) {
    if (this.timer) this.timer.begin();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    if (this.debugTex || this.renderToScreen) {
      this.quad.material.uniforms.tDiffuse.value = this.debugTex || this.target.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      this.quad.render(renderer);
    }
    if (this.timer) this.timer.end();
  }
  setSize() {}                       // postfx resizes this.target itself (keeps samples + depth texture)
  dispose() { this.quad.dispose(); }
}

// ---------------------------------------------------------------- view-space normal G-buffer (from depth)
// This was a second geometry pass with MeshNormalMaterial. Measured, it cost 186 draw calls and 1.23 M
// triangles a frame — 25% of the heaviest preset's geometry — and no cull could bring that down, because
// city.js merges a whole block into one mesh and a merged mesh is one draw whose bounding sphere spans the
// district. The naive cross product it replaced genuinely does fail here (on a road receding to the horizon
// two adjacent depth texels are metres apart in view Z, so the plane through them is noise), but the
// four-neighbour BEST-FIT does not: it extrapolates each side linearly and keeps whichever side is the better
// fit, so a silhouette edge is rejected instead of averaged in. Side benefit: the coverage mask is now
// "not sky" rather than "inside the prepass's far plane", so AO reaches the whole frame.
const NormalFromDepthShader = {
  name: 'postfx:normal',
  uniforms: {
    tDepth: { value: null }, projInv: { value: new THREE.Matrix4() },
    texel: { value: new THREE.Vector2(1 / 768, 1 / 432) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDepth;
    uniform mat4 projInv;
    uniform vec2 texel;
    varying vec2 vUv;
    vec3 vp(vec2 uv) {
      vec4 c = vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
      vec4 v = projInv * c;
      return v.xyz / v.w;
    }
    void main() {
      float d = texture2D(tDepth, vUv).x;
      if (d >= 0.999999) { gl_FragColor = vec4(0.5, 0.5, 1.0, 0.0); return; }   // sky: alpha 0 = no normal
      vec3 c = vp(vUv);
      vec2 tx = vec2(texel.x, 0.0), ty = vec2(0.0, texel.y);
      vec3 l1 = vp(vUv - tx), l2 = vp(vUv - tx * 2.0);
      vec3 r1 = vp(vUv + tx), r2 = vp(vUv + tx * 2.0);
      vec3 d1 = vp(vUv - ty), d2 = vp(vUv - ty * 2.0);
      vec3 u1 = vp(vUv + ty), u2 = vp(vUv + ty * 2.0);
      vec3 dx = abs(l1.z * 2.0 - l2.z - c.z) < abs(r1.z * 2.0 - r2.z - c.z) ? (c - l1) : (r1 - c);
      vec3 dy = abs(d1.z * 2.0 - d2.z - c.z) < abs(u1.z * 2.0 - u2.z - c.z) ? (c - d1) : (u1 - c);
      vec3 n = cross(dx, dy);
      float len = length(n);
      if (len < 1e-9) { gl_FragColor = vec4(0.5, 0.5, 1.0, 1.0); return; }
      n /= len;
      // face the camera along the VIEW RAY, not along +z. With the camera pitched up 8 deg the scramble's
      // own normal has view z = -0.145, so an n.z < 0 test inverted every road pixel in the frame.
      if (dot(n, -c) < 0.0) n = -n;
      gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
    }`,
};

const noop = () => {};

// ---------------------------------------------------------------- GPU timer (EXT_disjoint_timer_query_webgl2)
// The auto-degrade ladder used to gate on engine.stats.ms, which is `performance.now()` around the update +
// submit loop: it is CPU submission time and provably does NOT contain this chain (measured, combat frame:
// ?postfx=off reported 6.4 ms, the same frame with all 14 passes reported 6.0). A ladder keyed on a number
// that excludes the passes it degrades is dead code. Only one TIME_ELAPSED query may be in flight per context,
// so the two timers take alternate frames (see `busy`) and the chain cost is composer total minus scene.
// The query objects are POOLED. createQuery/deleteQuery on alternate frames is ~30 WebGL objects built and
// destroyed a second for a number the ladder may then discard; three pre-allocated queries cycle forever.
class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pool = []; this.free = [];
    if (this.ext) for (let i = 0; i < 3; i++) { const q = gl.createQuery(); this.pool.push(q); this.free.push(q); }
    this.q = null; this.ms = 0; this.active = false; this.samples = 0;
  }
  begin() {
    if (!this.ext || this.q || !this.free.length || GpuTimer.busy) return;
    this.q = this.free.pop();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.q);
    this.active = true; GpuTimer.busy = true;
  }
  end() { if (this.active) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.active = false; } }
  poll() {
    const gl = this.gl;
    if (!this.q || this.active) return;
    if (!gl.getQueryParameter(this.q, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      const ms = gl.getQueryParameter(this.q, gl.QUERY_RESULT) / 1e6;
      this.ms = this.samples++ ? this.ms * 0.85 + ms * 0.15 : ms;
    }
    this.free.push(this.q); this.q = null; GpuTimer.busy = false;
  }
  dispose() {
    if (this.active) this.end();
    for (const q of this.pool) this.gl.deleteQuery(q);
    this.pool.length = 0; this.free.length = 0; this.q = null; GpuTimer.busy = false;
  }
}
GpuTimer.busy = false;

// ---------------------------------------------------------------- BLOOM-layer mask (§3 engine.layers.BLOOM)
// The brief's "selective bloom": the pyramid may only be SEEDED where a layer-1 object (sign, LED board, neon
// tube, lamp head, headlight, taxi roof light) actually projects. A luminance threshold alone cannot tell a
// 袖看板 from a white shirt under a streetlight or from a specular on wet asphalt, and those are exactly the
// things that smear. The HDR colour still comes from the real frame — this buffer is only a gate — so a sign
// hidden behind a building contributes nothing without any depth comparison: the frame there shows the
// building, which is under threshold.
class BloomMaskPass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.scene = scene; this.camera = camera; this.target = target;
    this.needsSwap = false;
    this._c = new THREE.Color();
  }
  render(renderer) {
    const scene = this.scene, cam = this.camera;
    const prevRT = renderer.getRenderTarget();
    const layers = cam.layers.mask, bg = scene.background, auto = renderer.shadowMap.autoUpdate;
    // weather.js mirrors the BLOOM layer from scene.onBeforeRender; without this the wet-ground reflection
    // would be rendered a second time every frame for a buffer that never looks at it.
    const before = scene.onBeforeRender;
    renderer.getClearColor(this._c);
    const alpha = renderer.getClearAlpha();
    renderer.shadowMap.autoUpdate = false;    // every renderer.render() otherwise re-renders every shadow map
    scene.onBeforeRender = noop;
    scene.background = null;
    cam.layers.set(1);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    cam.layers.mask = layers;
    scene.background = bg;
    scene.onBeforeRender = before;
    renderer.shadowMap.autoUpdate = auto;
    renderer.setClearColor(this._c, alpha);
    renderer.setRenderTarget(prevRT);
  }
  setSize() {}
}

// the high-pass three ships gates on luminance only. Same uniforms (UnrealBloomPass writes tDiffuse and
// luminosityThreshold into them by name), plus the layer gate and a sky kill.
const MaskedHighPassShader = {
  name: 'postfx:bloommask',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tMask, tDepth;
    uniform vec3 defaultColor;
    uniform float defaultOpacity, luminosityThreshold, smoothWidth, maskMix, maskLo, maskHi;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      // ENERGY CAP, before anything else. A headlight core is 20-60x white and a neon tube is 1.5-3x, so an
      // uncapped pyramid is 95% headlight: measured +260% on a 70x60 headlight box against +0.1% on a 109 neon
      // tube, with the headlight's saturation collapsing 0.294 -> 0.057 because five mips of clipped white
      // swamped its tungsten chroma. Capping the SOURCE at 4x threshold bounds what any one emitter can put
      // into the pyramid; scaling by the max channel (never per-channel min) keeps the cap hue-preserving.
      float peak = max(texel.r, max(texel.g, texel.b));
      float cap = luminosityThreshold * 2.0;
      texel.rgb *= peak > cap ? cap / peak : 1.0;
      // Key on the PEAK CHANNEL, not on Rec.709 luma. A luma gate is a WHITE-emitter gate by construction:
      // the blue field of the SHIBUYA SKY board arrives at linear 0.31 in its blue channel but luma 0.11
      // (blue carries 7% of luma), so a 6x4 m saturated blue LED wall could never clear a threshold that a
      // grey shirt at 0.34 cleared. Measured consequence: only the white glyph cores bloomed, the coloured
      // panel fields and the green STARBEANS screen threw no halo at all, and the halo the pyramid did build
      // averaged white sources only — which is exactly the achromatic halo the critic measured at chroma 13.
      float v = mix(dot(texel.rgb, LUMA), min(peak, cap), 0.8);
      // soft KNEE, not three's 0.01-wide step. smoothWidth is driven from applyBloom so that FULL contribution
      // lands at ~0.9x display white whatever the exposure: a real sign core seeds the halo, a lit shirt does
      // not, and the glyph interior still keeps its contrast against its own bezel.
      float alpha = smoothstep(luminosityThreshold, luminosityThreshold * 1.35 + smoothWidth, v);
      // the sky is on layer 1 (lighting's dome carries the moon and the sodium band) but it must never SEED a
      // halo — at the day exposure the whole dome sits above the threshold and the pyramid becomes a veil again.
      // This term is unconditional: with maskMix 0 (selective bloom off, the shipping path) it used to be
      // multiplied into m and therefore dead, which is why the night sky beside the 109 block washed +55%.
      float sky = step(0.999999, texture2D(tDepth, vUv).x);
      float m = smoothstep(maskLo, maskHi, dot(texture2D(tMask, vUv).rgb, LUMA));
      gl_FragColor = mix(vec4(defaultColor.rgb, defaultOpacity), texel, alpha * (1.0 - sky) * mix(1.0, m, maskMix));
    }`,
};

// ---------------------------------------------------------------- a ShaderPass that reads a FIXED source
// The head of the chain has no ping-pong content to read — ScenePass owns its own MSAA target and no longer
// blits it into the composer's read buffer. This pass substitutes that target for the read buffer, writes to
// the write buffer as usual and swaps, so everything downstream is unchanged. `source` may be swapped at
// runtime (the debug views put a foreign texture in front of it).
class SourceShaderPass extends ShaderPass {
  constructor(shader, source) { super(shader); this.source = source; }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    super.render(renderer, writeBuffer, this.source || readBuffer, deltaTime, maskActive);
  }
}

// ---------------------------------------------------------------- a shader pass that writes its OWN target
// (the composer's ping-pong buffers are full-res colour; the near-CoC mask is half-res and must survive into
// the next pass, so it cannot use them)
class OffscreenShaderPass extends Pass {
  constructor(shader, target, srcUniform) {
    super();
    this.target = target;
    this.srcUniform = srcUniform || null;   // bind the composer's live read buffer into this uniform, if named
    this.needsSwap = false;
    this.uniforms = THREE.UniformsUtils.clone(shader.uniforms);
    this.material = new THREE.ShaderMaterial({
      name: shader.name, uniforms: this.uniforms,
      vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    if (this.srcUniform && readBuffer) this.uniforms[this.srcUniform].value = readBuffer.texture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }
  setSize() {}
  dispose() { this.quad.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- large-scale obscurance (Alchemy/HBAO form)
// Why this exists instead of a second GTAO tier: three's GTAO integrates `nx*nxb + ny*nyb`, which for a ground
// plane at grazing incidence evaluates to ~1.49 when the hemisphere is fully OPEN and is then clamped to 1.
// A third of the hemisphere has to be occluded before the buffer moves at all, so the result is white surfaces
// with a 2 px stroke in the creases — measured: 87% of the buffer at exactly display white, p50 226 in every
// crop, including the corner where a 34 m facade meets the pavement. The Alchemy estimator has no such dead
// zone: it is linear in the obscurance integral, so a road approaching a wall darkens as a gradient.
const BigAOShader = {
  name: 'postfx:bigao',
  uniforms: {
    tDepth: { value: null }, tNormal: { value: null },
    projInv: { value: new THREE.Matrix4() }, proj: { value: new THREE.Vector2(1, 1) },
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    radiusW: { value: 6.0 }, sigma: { value: 2.0 }, power: { value: 1.0 }, bias: { value: 0.06 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDepth, tNormal;
    uniform mat4 projInv;
    uniform vec2 proj, texel;
    uniform float radiusW, sigma, power, bias;
    varying vec2 vUv;
    vec3 viewPosAt(vec2 uv) {
      vec4 c = vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
      vec4 v = projInv * c;
      return v.xyz / v.w;
    }
    float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    void main() {
      vec4 nrm = texture2D(tNormal, vUv);
      if (nrm.a < 0.35) { gl_FragColor = vec4(1.0); return; }   // no G-buffer here: the haze owns this depth
      vec3 P = viewPosAt(vUv);
      vec3 N = normalize(nrm.xyz * 2.0 - 1.0);
      float z = max(-P.z, 0.5);
      vec2 rs = proj * 0.5 / z;
      float RA = radiusW * 0.35, RB = radiusW * 1.60;
      // two rings, one at street-furniture scale and one at canyon scale, multiplied. A single radius either
      // misses the 15 m facade-to-facade obscurance or saturates every kerb; the product covers both octaves
      // for the same 16 taps. The screen clamp is a cost bound only — what keeps a near subject from being
      // occluded by the crowd behind it is the world-space RANGE WEIGHT below, not the clamp.
      vec2 rA = clamp(vec2(RA) * rs, texel * 2.0, vec2(0.055));
      vec2 rB = clamp(vec2(RB) * rs, texel * 6.0, vec2(0.16));
      // hash rotation, resolved by the box blur that follows. An interleaved 2x2 grid is cheaper in theory
      // but leaves a visible chequer wherever the upsample taps land on one phase, which they do at 0.30 res.
      float rot = hash12(floor(vUv / texel)) * 6.2831853;
      float occA = 0.0, occB = 0.0;
      for (int i = 0; i < 8; i++) {
        float fi = float(i) + 0.5, sp = sqrt(fi / 8.0);
        float a = fi * 2.39996 + rot;
        vec2 dir = vec2(cos(a), sin(a)) * sp;
        // HBAO's elevation SINE, not Alchemy's radius*dot/d^2. dot(v,N)/|v| is bounded in [0,1] by
        // construction, so one sigma means the same thing at a 2 m kerb and a 10 m canyon and no tap can
        // ever dominate the ring. The Alchemy form it replaces is unbounded as |v| -> 0 and, worse, was
        // scale-free: a background 20 m BEHIND a close-up subject scored the same 0.26/tap as a real facade
        // 13 m beside a road, which is the literal source of the blotches on the hero's face and suit.
        vec3 vA = viewPosAt(clamp(vUv + dir * rA, vec2(0.001), vec2(0.999))) - P;
        float lA = length(vA) + 1e-4;
        // range weight: an occluder past the ring's own world radius is unrelated geometry, not shade.
        occA += (1.0 - smoothstep(RA, RA * 2.0, lA)) * clamp(dot(vA, N) / lA - bias, 0.0, 1.0);
        vec3 vB = viewPosAt(clamp(vUv + dir * rB, vec2(0.001), vec2(0.999))) - P;
        float lB = length(vB) + 1e-4;
        occB += (1.0 - smoothstep(RB, RB * 2.0, lB)) * clamp(dot(vB, N) / lB - bias, 0.0, 1.0);
      }
      float a = max(0.0, 1.0 - sigma / 8.0 * occA) * max(0.0, 1.0 - sigma / 8.0 * occB);
      gl_FragColor = vec4(pow(a, power), 0.0, 0.0, 1.0);
    }`,
};

// 13-tap box at the obscurance buffer's own resolution: the estimator is 16 hashed taps, which is grain, and
// a large-scale term has to be smooth or it crawls. At 0.30 res this costs nothing.
const BigBlurShader = {
  name: 'postfx:bigblur',
  uniforms: { tDiffuse: { value: null }, texel: { value: new THREE.Vector2(1 / 576, 1 / 324) } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec2 vUv;
    void main() {
      float a = texture2D(tDiffuse, vUv).r;
      for (int i = 0; i < 12; i++) {
        float fi = float(i) + 0.5;
        float ang = fi * 2.39996;
        vec2 o = vec2(cos(ang), sin(ang)) * sqrt(fi / 12.0) * 2.2;
        a += texture2D(tDiffuse, vUv + o * texel).r;
      }
      gl_FragColor = vec4(a / 13.0, 0.0, 0.0, 1.0);
    }`,
};

// ---------------------------------------------------------------- aerial perspective + exposure (linear, pre-bloom)
const HazeShader = {
  name: 'postfx:haze',
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, tNormal: { value: null },
    tAO1: { value: null }, tAO2: { value: null },
    aoI1: { value: 0 }, aoI2: { value: 0 }, aoDebug: { value: 0 },
    aoTexel: { value: new THREE.Vector2(1 / 576, 1 / 324) }, aoFloor: { value: 0.26 },
    cameraNear: { value: 0.1 }, cameraFar: { value: 1500 },
    projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
    hazeColor: { value: new THREE.Color(0.16, 0.098, 0.085) },
    skyGlowColor: { value: new THREE.Color(0.30, 0.16, 0.07) }, skyGlow: { value: 0.45 },
    // light pollution is sodium at the rooflines and plum/magenta by the time it reaches the zenith (the
    // short wavelengths are what Rayleigh-scatter back down). A single hue over the whole dome reads as dust.
    skyGlowTop: { value: new THREE.Vector3(0.85, 0.78, 4.2) },
    arrivalClarity: { value: 0 },
    density: { value: 0.0045 }, skyAmount: { value: 0.12 }, heightFall: { value: 2.2 },
    maxDist: { value: 1200 }, exposure: { value: 0.85 }, inscatter: { value: 0.28 },
    night: { value: 1 }, skyDark: { value: new THREE.Vector3(0.30, 0.27, 0.33) },
    glowBand: { value: 0.85 }, skyDesat: { value: 0.45 },
    fillNear: { value: 3.4 },      // a GAIN on near, dark, unoccluded pixels — see the fill block below
    fillTint: { value: new THREE.Vector3(1.0, 0.98, 1.02) },   // near-neutral: see FILL_NIGHT
    // the shop windows open into real rooms (city interiors.js): their boxes, shared by reference (setInteriorCuts).
    // A pixel whose depth lands inside an open window gets no AO — the obscurance estimators see a closed box (or
    // the flat glass) there and painted soft blotches over every lit room
    uCutA: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uCutB: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uCutC: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
    uCutS: { value: new THREE.Vector4(0, 0, 0, -1) }, uCutY: { value: new THREE.Vector2(0, -1) }, uCutN: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform vec4 uCutA[12]; uniform vec4 uCutB[12]; uniform vec4 uCutC[12]; uniform vec4 uCutS; uniform vec2 uCutY; uniform int uCutN;
    uniform sampler2D tDiffuse, tDepth, tNormal, tAO1, tAO2;
    uniform float arrivalClarity;
    uniform float cameraNear, cameraFar, density, skyAmount, heightFall, maxDist, exposure, inscatter, skyGlow;
    uniform float aoI1, aoI2, aoDebug, aoFloor, night, glowBand, skyDesat, fillNear;
    uniform vec2 aoTexel;
    uniform mat4 projInv, camWorld;
    uniform vec3 hazeColor, skyGlowColor, skyDark, fillTint, skyGlowTop;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    // depth-aware upsample of the 0.30-res obscurance. A plain bilinear tap bleeds a wall's occlusion across
    // the silhouette in front of it — at a 2.5 m portrait framing that is a ~3 px dark fringe around every
    // finger and a smear over the jaw, which is most of what reads as "blotches" on the hero.
    float upAO(sampler2D tex, float zc) {
      vec2 o = aoTexel;
      float s = 0.0, w = 0.0;
      for (int j = 0; j < 4; j++) {
        vec2 d = vec2(j == 1 || j == 3 ? 1.0 : -1.0, j < 2 ? -1.0 : 1.0) * o * 0.5;
        vec2 uv = vUv + d;
        float zs = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
        float k = 1.0 / (1e-3 + abs(zs - zc) / max(zc, 1.0));   // relative depth: works at 2 m and at 200 m
        s += texture2D(tex, uv).r * k; w += k;
      }
      return w > 0.0 ? s / w : texture2D(tex, vUv).r;
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = min(max(c.rgb, 0.0), 64.0);       // AO/GTAO can emit NaN on degenerate samples; bloom would spread it
      // GTAO runs OUTPUT.Off and both AO buffers are composited here instead of by blend blits — that buys
      // the direct-light guard below, and saves four full-screen passes. Alpha of the normal G-buffer is the
      // coverage mask: it is 0 on sky, where a reconstructed normal belongs to no surface and the AO estimators
      // would invent occlusion out of the far plane. Those pixels get no AO; the haze owns them.
      float cover = smoothstep(0.35, 0.75, texture2D(tNormal, vUv).a);
      float zc = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).x, cameraNear, cameraFar);
      float ao = 1.0;
      // intensity as an EXPONENT, not GTAOBlendShader's 1 - i*(1 - ao): the linear form goes negative as soon
      // as i*(1-ao) > 1 and clips to a hole (12.7% of the buffer at pure black when it was tuned for the
      // facade junction). pow is bounded below by 0 by construction and compresses instead of clipping.
      // The two exponents MULTIPLY, so 1.80 x 1.75 was an effective 3.55: a mild 0.8 obscurance landed at
      // 0.44 and the frame went muddy. They are ~1.1 each now; the estimators do the work, not the curve.
      if (aoI1 > 0.0) ao *= mix(1.0, pow(max(texture2D(tAO1, vUv).r, 0.0), aoI1), cover);
      if (aoI2 > 0.0) ao *= mix(1.0, pow(max(upAO(tAO2, zc), 0.0), aoI2), cover);
      // an open street never reaches zero bounce light; a floor keeps a deep crease dark instead of a hole.
      // Kamurocho at night is lit by hundreds of signs from every direction — the bounce floor is high.
      ao = max(ao, aoFloor);
      if (uCutN > 0) {                                  // inside an open shop window: no AO (see uCutA)
        vec4 cq = vec4(vUv * 2.0 - 1.0, texture2D(tDepth, vUv).x * 2.0 - 1.0, 1.0);
        vec4 vq = projInv * cq; vq /= vq.w;
        vec3 wq = (camWorld * vec4(vq.xyz, 1.0)).xyz, sq = wq - uCutS.xyz;
        if (wq.y > uCutY.x - 0.05 && wq.y < uCutY.y + 0.05 && dot(sq, sq) < uCutS.w) for (int i = 0; i < 12; i++) {
          if (i >= uCutN) break;
          vec3 d = wq - uCutA[i].xyz; vec4 B = uCutB[i]; vec4 C = uCutC[i];
          float lx = d.x * B.x + d.z * B.y, ln = d.x * B.z + d.z * B.w;
          if (abs(lx) < C.x + 0.03 && abs(d.y) < C.y + 0.03 && ln > -C.z && ln < C.w + 0.06) { ao = 1.0; break; }
        }
      }
      if (aoDebug > 0.5) { gl_FragColor = vec4(vec3(pow(ao, 1.0 / 2.2)), 1.0); return; }
      float sceneL = dot(c.rgb, LUMA);
      // AO scales the AMBIENT term; a forward renderer hands us direct + ambient already summed, so the guard
      // is the only place that distinction can be made. Two parts, because one threshold cannot do both jobs:
      // a PARTIAL release across the directly-lit range (a pedestrian under a streetlight keeps his shading
      // instead of going to silhouette) and a FULL release for genuine emitters. Keyed at 0.85 as before, the
      // full release also caught the wet crosswalk paint — the brightest non-emitter in a night frame — and
      // took every shoe contact pool with it.
      float lit = 0.45 * smoothstep(0.35, 2.0, sceneL) + 0.55 * smoothstep(3.0, 9.0, sceneL);
      c.rgb *= mix(ao, 1.0, lit);
      // NEAR-FIELD BOUNCE FILL (night only). Measured with ?postfx=nograde, the lead's suit arrives at this
      // pass at ~0.005 linear and his trousers at ~0.008: 89% of the chest and 82% of the thigh are below L8
      // BEFORE any grade touches them, so no tone curve can recover a lapel edge that is not in the signal.
      // A street this dense bounces light from every direction — the forward renderer's single ambient term
      // does not model any of it — so this adds a small, bounded, AO-modulated and depth-limited bounce to
      // what is within ~10 m of the camera. It is a stopgap: the real fix is a fill/rim rig on the character
      // in lighting.js, filed in docs/reports/render.md.
      // It is a GAIN, not an additive pedestal: adding 0.018 of warm white read as fog over the near crowd and
      // took a pedestrian's brown coat and the lead's gold jacket to grey (measured sat 0.347 -> 0.20 on the
      // near crowd band). A multiplier is hue- and contrast-preserving by construction — a lapel edge at 1.3x
      // its neighbour is still at 1.3x afterwards — and it cannot lift a pixel that is genuinely black.
      if (fillNear > 0.0) {
        float nearK = 1.0 - smoothstep(4.0, 12.0, zc);
        float dark = 1.0 - smoothstep(0.003, 0.05, sceneL);
        c.rgb *= 1.0 + fillTint * (fillNear * nearK * dark * ao * cover);
      }
      // Knee at 8, asymptote at 56. At 1.5/7.5 a 20x neon and a 60x LED core landed 15% apart, so every
      // emitter bloomed identically (the uniform veil) and the wide tier's 1.8 threshold caught the whole city.
      vec3 over = max(c.rgb - 8.0, 0.0);
      c.rgb = min(c.rgb, vec3(8.0)) + over / (1.0 + over / 48.0);
      // emissive proxy for the haze: a lit window at 150 m must reach the bloom threshold, not be lerped to
      // 0.16 before the pyramid ever sees it. The additive inscatter still applies to it — only the mix does not.
      float emis = smoothstep(2.0, 8.0, dot(c.rgb, LUMA));
      float dRaw = texture2D(tDepth, vUv).x;
      vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec4 vpos = projInv * clip; vpos /= vpos.w;
      vec3 dirW = normalize((camWorld * vec4(vpos.xyz, 0.0)).xyz);
      float dist = min(-perspectiveDepthToViewZ(dRaw, cameraNear, cameraFar), maxDist);
      float sky = step(0.999999, dRaw);
      // A near-vertical arrival crosses less low-level haze than a horizontal skyline view.
      float airDist = dist * mix(1.0, 0.15, arrivalClarity);
      float w = (1.0 - exp(-airDist * density)) * exp(-max(dirW.y, 0.0) * heightFall);
      w = mix(w, w * skyAmount, sky);
      w = clamp(w, 0.0, 1.0);
      // the sky needs its own term, not a scaled-down copy of the ground haze: sodium light pollution is a
      // BAND above the skyline that dies toward the zenith. skyAmount alone put ~0.003 into a sky pixel.
      // pow(1 - y, 3) is not a band — it is still 0.22 at 24 deg. But glowBand 0.26 with a squared falloff
      // was the opposite error: it reached EXACTLY ZERO above ~15 deg, so the whole upper third of the
      // flagship preset got no pollution glow at all and read as a black hole with a razor horizon. Light
      // pollution over a megacity is a hemisphere-wide warm dome that merely CONCENTRATES toward the
      // rooflines — glowBand 0.85 with a 1.3 exponent still puts most of the energy on the skyline and
      // leaves a real sodium cast at the zenith. The daytime falloff is unchanged.
      float up = clamp(dirW.y, 0.0, 1.0);
      float band = pow(1.0 - clamp(up / glowBand, 0.0, 1.0), 1.3);
      vec3 glowCol = mix(skyGlowColor, skyGlowColor * skyGlowTop, night * smoothstep(0.0, 0.55, up));
      vec3 glow = glowCol * (skyGlow * sky * mix(pow(1.0 - up, 3.0), band, night));
      // lerp + inscatter: sodium/LED spill scatters upward, so far blocks must go BRIGHTER, never dirty-lens dark
      float wm = w * (1.0 - emis);
      vec3 outc = mix(c.rgb, hazeColor, wm) + hazeColor * w * inscatter;
      // 21:30 CEILING. The sky dome arrives from lighting as a full sunset — measured mean L63, rgb(90,55,59),
      // sat 0.39, the brightest large area in the top half of crossing_night, i.e. a ~19:00 value. Shibuya at
      // 21:30 has a near-black, near-neutral ceiling and the warm light lives in the pollution band above the
      // rooflines. Depth == far is the only thing touched here, so no facade, roofline or sign moves, and the
      // band is re-added afterwards so the horizon keeps its sodium. (The underlying gradient is lighting's.)
      // ...but the ceiling is not a BLEACH. Desaturating 85% toward luma and then crushing 5.5x gave a pure
      // sky patch mean chroma 3.66 — neutral grey-black, and against mauve rooftops that is a hard horizon
      // step with nothing to dissolve into. 0.45 desaturation over a 3.3x crush keeps the dome's magenta.
      vec3 dim = mix(outc, vec3(dot(outc, LUMA)), skyDesat) * skyDark;
      outc = mix(outc, dim, sky * night) + glow;
      gl_FragColor = vec4(outc * exposure, c.a);
    }`,
};

// ---------------------------------------------------------------- near-field CoC mask (half res, dilated)
// Scatter-as-gather can only ever pull a blurred foreground INTO itself, never over what is behind it — so a
// pylon 1.5 m from a 5 m focal plane came back with a razor silhouette. The near field needs its own mask,
// max-filtered so it spills past the silhouette by the radius the occluder's own CoC earns.
//   .x = dilated CoC (the gather radius)   .y = raw CoC (the centre weight)   .z = foreground COVERAGE (the alpha)
// The coverage channel is the fix for the razor edge: a hard `step(rad, s*maxRadius)` over a 10-tap spiral is a
// ten-pointed star, not a disc, so most directions got no dilation at all and the mask died 2-4 px out. Here
// every tap contributes, faded over its own disc, and the third channel is the convolution of the silhouette
// with that disc — which is exactly the alpha a scattering foreground should composite with (~0.5 at the edge,
// 0 at the full CoC).
const NearCoCShader = {
  name: 'postfx:nearcoc',
  uniforms: {
    tDepth: { value: null }, cameraNear: { value: 0.1 }, cameraFar: { value: 1500 },
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    focus: { value: 4 }, focusRange: { value: 9 }, dof: { value: 0 }, maxRadius: { value: 10 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, focus, focusRange, dof, maxRadius;
    uniform vec2 texel;
    varying vec2 vUv;
    // DEAD ZONE first. The focus distance is measured to the player's chest, but a fighting figure still owns
    // ~0.8 m of depth either side of it (lead fist to back shoulder), and the old 0.22 divisor turned that into
    // a full 26 px near blur ON THE LEAD. Nothing within 0.8 m of the focal plane may carry near CoC at all.
    // Measured on ?shot=combat: the traffic pole that reads as "foreground" sits at 4.0-4.5 m, i.e. level with
    // the hero — the near field there is correctly empty, and postfx_dof is the preset that exercises it.
    float nearCoc(vec2 uv) {
      float d = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
      float dd = focus - d - 0.8;
      return dof * clamp(dd / max(1.2, focusRange * 0.38), 0.0, 1.0);
    }
    void main() {
      float raw = nearCoc(vUv), m = raw, cov = step(0.001, raw), cw = 1.0;
      for (int i = 0; i < 16; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996;
        float rad = sqrt(fi / 16.0) * maxRadius;
        vec2 suv = vUv + vec2(cos(a), sin(a)) * rad * texel;
        float s = nearCoc(suv);
        float reach = smoothstep(1.02, 0.42, rad / max(s * maxRadius, 1e-3));
        m = max(m, s * reach);
        cov += step(0.001, s) * reach; cw += 1.0;
      }
      gl_FragColor = vec4(m, raw, cov / cw, 1.0);
    }`,
};

// ---------------------------------------------------------------- far-field bokeh gather (HALF RES)
// A 36-tap spiral over a 26 px disc at full res is one sample per 59 px² — 17x undersampled — and the result
// is monte-carlo chroma speckle, not bokeh (measured |R-G| 9.4 levels in the blurred crowd band against 0.7 on
// the sharp hero). At half res the same 36 taps cover a quarter of the pixels, so the budget buys 48 taps AND
// the 2x2 upsample averages four independent spirals: ~5x the effective density for less cost than before.
// The other half of the fix is the weight. A binary box weight (`w = 0 or 1`) makes a bright sign a flat-topped
// cotton-wool blob with a clipped core and no disc edge. A scattering source with circle of confusion R spreads
// its energy over pi*R², so its contribution per gathered pixel goes as 1/R² — tighter, brighter samples then
// hold their shape and a real bokeh edge appears.
const FarFieldShader = {
  name: 'postfx:farfield',
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null },
    cameraNear: { value: 0.1 }, cameraFar: { value: 1500 },
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },   // FULL-res texel: the disc is sized in final px
    focus: { value: 4 }, dof: { value: 0 },
    farSoften: { value: 0 }, maxRadius: { value: 10 }, farSoftenRadius: { value: 4 }, lowQ: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform float cameraNear, cameraFar, focus, dof, farSoften, maxRadius, farSoftenRadius, lowQ;
    uniform vec2 texel;
    varying vec2 vUv;
    float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float viewDist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    // far side only (the near side is its own field). 0.9 m of dead zone past the focal plane, so the pavement
    // just behind the lead's heels is as sharp as his face instead of already breaking up.
    // The denominator is max(16, focus*5.5), not max(6, focus*3): at a 4.5 m chest focus the old form reached
    // FULL defocus by 15 m, which is exactly where the ring of bystanders stands in a brawl. Full defocus now
    // lands past ~45 m, so an enemy at 12 m still has arms and a head.
    float farCoc(float dist) {
      return dof * smoothstep(0.0, 1.0, (dist - focus - 0.9) / max(16.0, focus * 5.5)) * step(focus + 0.9, dist);
    }
    // the sub-pixel-shimmer soften, on its own so the composite can ramp it separately from the lens
    float softenRadius(float dist) {
      return clamp(farSoften * smoothstep(60.0, 200.0, dist), 0.0, 1.0) * farSoftenRadius;
    }
    // RADIUS IN PIXELS, and the exploration soften carries its OWN cap. Sharing maxRadius with the combat lens
    // meant the 0.10 soften term was 0.10 x 26 px = a permanent 2.6 px veil over every mid-distance facade —
    // ABC-MART and a whole stack of 袖看板 dissolved into colour smear in the flagship preset. farSoftenRadius
    // is clamped to ~4 px outside combat, so distance softening can only ever kill sub-pixel shimmer past 60 m.
    float farRadius(float dist) {
      float rd = min(farCoc(dist), 1.0) * maxRadius;
      return max(rd, softenRadius(dist));
    }
    void main() {
      float dc = viewDist(vUv);
      float r = farRadius(dc);
      // DILATED gather radius. A gather sized by the centre pixel's own CoC can never see an occluder whose
      // CoC reaches it from further away than that, which is exactly why every defocused object came back a
      // sharp-edged cutout filled with mush: outside its silhouette the centre was sharp, so nothing was
      // gathered at all and the boundary stepped 25 luminance levels in 2 px.
      float rg = r;
      for (int j = 0; j < 4; j++) {
        vec2 o = vec2(j == 1 || j == 3 ? 1.0 : -1.0, j < 2 ? -1.0 : 1.0) * maxRadius * 0.62 * texel;
        rg = max(rg, farRadius(viewDist(vUv + o)));
      }
      vec3 centre = texture2D(tDiffuse, vUv).rgb;
      float r0 = max(1.0, r);
      float wsum = 1.0 / (r0 * r0);
      vec3 col = centre * wsum;
      if (rg > 0.35) {
        float rot = hash12(vUv / texel) * 6.2831853;
        int N = rg < 4.0 ? 12 : (lowQ > 0.5 ? 16 : (rg > 13.0 ? 48 : 28));
        for (int i = 0; i < 48; i++) {
          if (i >= N) break;
          float fi = float(i) + 0.5;
          float a = fi * 2.39996 + rot;
          float rad = sqrt(fi / float(N)) * rg;
          vec2 suv = vUv + vec2(cos(a), sin(a)) * rad * texel;
          float ds = viewDist(suv);
          float rs = farRadius(ds);
          float rr = max(1.0, rs);
          // SCATTER-AS-GATHER reach test: a sample lands here only if its own circle of confusion covers this
          // pixel. The old step(coc * 0.6, sc) asked the opposite question — a sign 10 m out is LESS blurred
          // than the street behind it, so its samples were rejected at its own silhouette and it could not
          // spread one pixel past it. The second term keeps the ordering honest: something BEHIND a sharp
          // surface still may not bleed over it.
          float w = smoothstep(rad - 1.5, rad + 1.5, rs) / (rr * rr);
          w *= 1.0 - step(dc + 0.5, ds) * (1.0 - smoothstep(0.5, 3.0, r));
          col += texture2D(tDiffuse, suv).rgb * w;
          wsum += w;
        }
      }
      // alpha carries the normalised radius for the bilateral upsample (and for the dilated composite mix)
      gl_FragColor = vec4(col / wsum, rg / max(maxRadius, 1.0));
    }`,
};

// ---------------------------------------------------------------- cinematic composite: DoF + radial impact blur
const CineShader = {
  name: 'postfx:cine',
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, tNear: { value: null }, tFar: { value: null },
    cameraNear: { value: 0.1 }, cameraFar: { value: 1500 },
    texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    focus: { value: 4 }, focusRange: { value: 9 }, dof: { value: 0 },
    farSoften: { value: 0 }, maxRadius: { value: 10 }, farSoftenRadius: { value: 4 },
    lowQ: { value: 0 }, nearOn: { value: 0 }, farOn: { value: 0 },
    radial: { value: 0 }, radialCenter: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth, tNear, tFar;
    uniform float cameraNear, cameraFar, focus, focusRange, dof, farSoften, maxRadius, farSoftenRadius, radial, lowQ, nearOn, farOn;
    uniform vec2 texel, radialCenter;
    varying vec2 vUv;
    float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float viewDist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    float farCoc(float dist) {
      return dof * smoothstep(0.0, 1.0, (dist - focus - 0.9) / max(16.0, focus * 5.5)) * step(focus + 0.9, dist);
    }
    float softenRadius(float dist) {
      return clamp(farSoften * smoothstep(60.0, 200.0, dist), 0.0, 1.0) * farSoftenRadius;
    }
    float farRadius(float dist) {
      float rd = min(farCoc(dist), 1.0) * maxRadius;
      return max(rd, softenRadius(dist));
    }
    void main() {
      vec3 sharp = texture2D(tDiffuse, vUv).rgb;
      vec3 col = sharp;
      float rot = hash12(vUv / texel) * 6.2831853;
      if (farOn > 0.5) {
        // the mix follows the DILATED CoC, not the centre tap's. Driven by the centre tap, the sharp/blurred
        // decision cuts exactly at a defocused object's silhouette — a razor border around total porridge —
        // because the pixel one step outside it is in focus and keeps 100% of the sharp buffer. Taking the
        // max over the neighbourhood lets the boundary ramp over the object's own circle of confusion.
        float r = farRadius(viewDist(vUv));
        for (int j = 0; j < 4; j++) {
          vec2 o = vec2(j == 1 || j == 3 ? 1.0 : -1.0, j < 2 ? -1.0 : 1.0) * maxRadius * 0.62 * texel;
          r = max(r, farRadius(viewDist(vUv + o)));
        }
        float coc = r / max(maxRadius, 1.0);
        // TWO ramps, because one cannot serve both jobs. The lens ramp was smoothstep(0.6, 2.2, r), which is
        // already 1.0 at a 2.2 px CoC — so the half-res bokeh buffer REPLACED the sharp frame as soon as the
        // CoC exceeded a single half-res texel, and capping maxRadius at 10 px never helped because the MIX
        // saturated long before the radius did. smoothstep(1.5, 7.0, r) makes 2.2 px a ~10% blend. The soften
        // ramp is separate and tops out below 1 (it is an anti-shimmer filter past 60 m, not a lens).
        float rs = softenRadius(viewDist(vUv));
        float blend = max(smoothstep(1.5, 7.0, r), 0.80 * smoothstep(0.35, 1.05, rs));
        if (r > 0.4) {
          // 4-tap CoC-aware bilateral fill. Weighting by |CoC difference| is what stops the half-res buffer
          // leaking a 26 px blur across the silhouette of something sharp in front of it; the sharp centre tap
          // is kept outright below ~1 px of CoC, so the focal plane never softens by resolution alone.
          vec2 ht = texel * 2.0;
          vec3 acc = vec3(0.0); float ws = 0.0;
          for (int j = 0; j < 4; j++) {
            vec2 o = vec2(j == 1 || j == 3 ? 1.0 : -1.0, j < 2 ? -1.0 : 1.0) * ht * 0.5;
            vec4 s = texture2D(tFar, vUv + o);
            float w = 1.0 / (0.02 + abs(s.a - coc));
            acc += s.rgb * w; ws += w;
          }
          col = mix(sharp, acc / max(ws, 1e-4), blend);
        }
      }
      // near field: gather from the DILATED mask with no depth rejection, so the foreground genuinely spills
      // over the background, and composite with the mask's own coverage channel as alpha.
      if (nearOn > 0.5) {
        vec3 nc = texture2D(tNear, vUv).xyz;
        float rn = nc.x * maxRadius;
        if (rn > 0.5) {
          float w0 = smoothstep(0.0, 2.0, nc.y * maxRadius);
          vec3 acc = sharp * w0;
          float ws = w0;
          int M = lowQ > 0.5 ? 8 : (rn > 13.0 ? 28 : 16);
          for (int i = 0; i < 28; i++) {
            if (i >= M) break;
            float fi = float(i) + 0.5;
            float a = fi * 2.39996 + rot;
            float rad = sqrt(fi / float(M)) * rn;
            vec2 suv = vUv + vec2(cos(a), sin(a)) * rad * texel;
            // the DILATED channel, not the raw one. Read raw, every background tap scored exactly 0 and the
            // occluder could only ever average itself — which is the 1 px stair-step the critic measured.
            float sc = texture2D(tNear, suv).x * maxRadius;
            float w = smoothstep(rad - 2.0, rad + 2.0, sc);
            acc += texture2D(tDiffuse, suv).rgb * w;
            ws += w;
          }
          if (ws > 0.001) col = mix(col, acc / ws, clamp(nc.z * 1.35, 0.0, 1.0));
        }
      }
      if (radial > 0.001) {
        vec2 dir = (radialCenter - vUv) * radial * 0.14;
        // the taps are jittered per pixel (interleaved gradient noise), so a long streak reads as one smear rather
        // than six stacked copies of the frame
        float jr = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        vec3 acc = col;
        for (int i = 1; i < 6; i++) acc += texture2D(tDiffuse, vUv + dir * (float(i) - jr) / 5.0).rgb;
        col = mix(col, acc / 6.0, clamp(radial, 0.0, 1.0));
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// ---------------------------------------------------------------- final grade (folds tone map + sRGB encode)
const GradeShader = {
  name: 'postfx:grade',
  uniforms: {
    tDiffuse: { value: null }, texel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    time: { value: 0 }, aspect: { value: 16 / 9 }, graded: { value: 1 },
    shadowTint: { value: new THREE.Vector3(0.80, 0.98, 1.14) },
    highTint: { value: new THREE.Vector3(1.10, 0.96, 1.02) },
    toneK: { value: 0.55 }, lift: { value: 0.040 }, contrast: { value: 1.10 }, pivot: { value: 0.42 }, saturation: { value: 1.10 },
    vignette: { value: 0.30 }, grain: { value: 0.020 }, ca: { value: 0.0016 },
    flash: { value: 0 }, heat: { value: 0 }, rain: { value: 0 }, periphDesat: { value: 0 },
    finDesat: { value: 0 }, finCA: { value: 0 }, finWarm: { value: 0 }, finCrush: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    uniform float time, aspect, toneK, lift, contrast, pivot, saturation, vignette, grain, ca, flash, heat, rain, graded, periphDesat;
    uniform float finDesat, finCA, finWarm, finCrush;
    uniform vec3 shadowTint, highTint;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    vec2 hash22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
    // three's ACESFilmicToneMapping + sRGB OETF, FOLDED IN from OutputPass. Exposure is applied pre-bloom by
    // the haze pass, so toneMappingExposure is 1 here. Folding removes a whole full-res HalfFloat round trip
    // from the tail of the chain (OutputPass -> grade -> SMAA was three separate read/write cycles for one
    // texture fetch of real work) and moves the chromatic-aberration fetch into linear HDR, where it belongs.
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 color) {
      const mat3 ACESIn = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOut = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color = ACESOut * RRTAndODTFit(ACESIn * (color / 0.6));
      return clamp(color, 0.0, 1.0);
    }
    vec3 encodeSRGB(vec3 c) {
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    vec3 fetchDisplay(vec2 uv) { return encodeSRGB(aces(max(texture2D(tDiffuse, uv).rgb, 0.0))); }
    // wet lens: sparse droplets refracting the composited frame, each running down its own cell and resetting.
    // xy = uv refraction, z = coverage (used for the specular pickup — a droplet catches the signage behind it).
    vec3 droplets(vec2 uv, float cells, float amp, float seed) {
      vec2 p = uv * vec2(aspect * cells, cells) + seed;
      vec2 id = floor(p), f = fract(p) - 0.5;
      vec2 rnd = hash22(id + seed);
      float pick = hash12(id + seed + 3.7);
      if (pick > 0.22) return vec3(0.0);
      // time * 0.35 completes an integer number of cycles over the 100 s wrap, so the streak never pops
      float run = fract(time * 0.35 * (0.6 + rnd.x) + pick * 7.13) - 0.5;
      vec2 d = f - (rnd - 0.5) * 0.55 - vec2(0.0, run * 0.85);
      d.y *= 0.45;                                   // gravity: a droplet on glass is a teardrop, not a bead
      float rad = 0.05 + 0.20 * fract(pick * 17.0);  // a 5x size spread, not the 1.5x that read as bubble wrap
      float t = length(d) / rad;
      if (t > 1.0) return vec3(0.0);
      // the ramp must reach zero ACROSS THE WHOLE DISC, with a continuous derivative at both ends. The old
      // smoothstep(1.0, 0.72, t) was flat at 1 inside t < 0.72 — a uniformly scaled core with the rim annulus
      // compressed against it, i.e. a hard ring with duplicated content on either side of it. That ring, and
      // not the droplet, is what cut MAGN|ET in half.
      float k = pow(smoothstep(1.0, 0.0, t), 2.0);
      // a LENS, not a radial shock: displacement is linear in the offset from the droplet's own centre, so it
      // is zero at the middle and largest at the rim — the image behind is magnified. normalize(d) * k was a
      // singularity at the centre and put a starburst of resampling moire over any fine facade texture.
      return vec3(-d / rad * k * amp, k);
    }
    void main() {
      vec2 uv = vUv;
      float wet = 0.0;
      if (rain > 0.001) {
        // ONE droplet, never a sum. Two summed layers doubled the displacement wherever a 13-cell and a
        // 26-cell droplet overlapped (~23 px) and crossed their two rims — that diagonal cut is what shredded
        // the MAGNET board. The strongest single droplet is what a lens does anyway. amp is in UV: 0.0025 is
        // ~4 px of magnification at the rim of a ~40 px droplet, which reads as glass without eating a glyph.
        vec3 dA = droplets(uv, 13.0, 0.0025, 0.0), dB = droplets(uv, 26.0, 0.0015, 5.3);
        vec3 d = dA.z > dB.z ? dA : dB;
        uv += d.xy * rain;
        wet = d.z * rain;
      }
      vec2 cc = uv - 0.5; cc.x *= aspect;
      float r2 = dot(cc, cc), rr = sqrt(r2);
      vec2 dir = uv - 0.5;
      // CA is a LATERAL aberration: it is zero on axis and grows toward the corner. Flat across the frame it
      // just re-aliases every edge the AA resolved — and it now runs BEFORE SMAA, so SMAA cleans up after it.
      float k = (ca + finCA) * smoothstep(0.25, 1.0, r2) * (0.3 + r2 * 2.2);
      // the three fetches are tone-mapped and encoded individually: the aberration is a lens property and
      // belongs in linear HDR, ahead of the curve, not to the display values that come out of it.
      vec3 col = k > 1e-5
        ? vec3(fetchDisplay(uv + dir * k).r, fetchDisplay(uv).g, fetchDisplay(uv - dir * k).b)
        : fetchDisplay(uv);
      if (graded < 0.5) { gl_FragColor = vec4(col, 1.0); return; }   // ?postfx=nograde: tone map + encode only
      float l = dot(col, LUMA);                                       // weights stay perceptual (display-space luma)
      float sw = 1.0 - smoothstep(0.0, 0.46, l);
      // the highlight tint is a BAND: it dies at the shoulder, so a white LED wall / headlight stays white
      float hw = smoothstep(0.34, 0.60, l) * (1.0 - smoothstep(0.60, 0.92, l));
      // the split tone is weighted by how NEUTRAL the pixel is, which is what split toning actually is: a
      // tint of the neutral axis. Applied flat it has to be kept weak — a strong sodium shadow tint on an
      // already-warm face takes the skin to swamp, which is why it shipped at a near-neutral (1.06,0.93,1.02).
      // Weighted, it can carry a real sodium/magenta shadow and an amber highlight across the concrete, the
      // asphalt and the crowd, and that neutral majority is exactly where the frame's missing chroma was:
      // measured mean RGB over the centre of the flagship night preset was (81, 74, 81).
      float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
      float neutral = 1.0 - smoothstep(0.03, 0.22, mx - mn);
      vec3 lin = pow(col, vec3(2.2));                                 // split tone runs in linear...
      lin *= mix(vec3(1.0), shadowTint / dot(shadowTint, LUMA), sw * toneK * neutral);   // ...level-preserving,
      lin *= mix(vec3(1.0), highTint / dot(highTint, LUMA), hw * toneK * neutral);       //   so it cannot clip
      col = pow(max(lin, 0.0), vec3(1.0 / 2.2));
      // pivot-preserving POWER contrast, not (col - pivot) * contrast + pivot. The linear form maps scene black
      // to -pivot*(contrast-1) — below the visible range — and the toe that follows could never climb back, so
      // the frame carried 4% pure RGB(0,0,0). A power curve is bounded below by zero by construction.
      col = pivot * pow(max(col, 1e-4) / pivot, vec3(contrast));
      // saturation BEFORE the shoulder, so the ceiling is chroma-independent. Run after it, the only pixels
      // that could exceed the shoulder's output were saturated ones pushed back past it — which is why the
      // one thing in the game that reached L246 was an achromatic headlight at sat 0.057.
      // ...with a CHROMA KNEE. A flat multiplier raises a neon tube, a red awning and the lead's SKIN by the
      // same factor, and the skin is the one thing in frame that must not go ruddy: measured on postfx_hero,
      // a cheek that arrives at sat 0.58 came out at 0.73 under a flat 1.26. All of the frame's missing chroma
      // is in the low-chroma majority — asphalt, concrete, the crowd, the night air — so the boost is spent
      // there and faded out across the pixels that are already saturated (which are also the ones a flat
      // boost would push into clipping).
      vec3 grey = vec3(dot(col, LUMA));
      vec3 dev = col - grey;
      float ch = max(max(abs(dev.r), abs(dev.g)), abs(dev.b));
      col = grey + dev * mix(saturation, 1.0, smoothstep(0.04, 0.20, ch));
      // combat pulls the chroma out of the PERIPHERY only, so the eye is left with the fight in the middle of
      // a cooling frame. Driven from postfx.combatMix, it is exactly 0 outside a fight.
      if (periphDesat > 0.0001) col = mix(vec3(dot(col, LUMA)), col, 1.0 - periphDesat * smoothstep(0.06, 0.62, r2));
      // the final blow's slow motion: the colour goes out of the street, but the WARM light stays — the contact's
      // white-hot core blooming orange, sodium, skin, the red/amber neon — so the moment reads hot against grey
      if (finDesat > 0.0001) {
        float warm = smoothstep(0.02, 0.16, col.r - col.b) * smoothstep(-0.12, 0.04, col.r - col.g);
        float keep = max(warm, 0.6 * smoothstep(0.55, 0.9, dot(col, LUMA)));
        col = mix(col, vec3(dot(col, LUMA)), finDesat * (1.0 - 0.85 * keep));
      }
      // ...and punchier: the bright end runs hot (amber-white), the blacks go deeper (the subject floor below still
      // holds a suit off pure black)
      if (finWarm + finCrush > 0.0001) {
        float lw = dot(col, LUMA);
        col = mix(col, col * vec3(1.14, 0.97, 0.76), min(1.0, finWarm * smoothstep(0.30, 0.80, lw)));
        col *= 1.0 - finCrush * (1.0 - smoothstep(0.03, 0.32, lw));
      }
      // ...and an explicit soft shoulder on top. The signal here is ALREADY ACES-tone-mapped and clamped to
      // [0,1] — nothing above 1.0 can exist in it — so a knee at 0.80 made display white unreachable BY
      // CONSTRUCTION: col = 1.0 landed at 0.9264 = L236 and the "asymptote at 1.6x" the old comment relied on
      // is not in the signal. At K = 0.94, col = 1.0 lands at 0.978 = L249 and a crosswalk in direct sun or an
      // LED glyph core can be paper white again, while a 0.5 midtone is untouched.
      const float K = 0.94;
      vec3 hi = max(col - K, 0.0);
      col = min(col, vec3(K)) + (1.0 - K) * (1.0 - exp(-hi / (1.0 - K)));
      // filmic toe last, and MULTIPLICATIVE. The old "col += lift * (1 - smoothstep(...))" was a flat additive
      // pedestal: NIGHT lift 0.050 put +12.8 display levels into every shadow in the frame, so a Kamurocho
      // night had min L15 and literally 0.00% of pixels below L8 — grey fog, not alleys. This form lifts the
      // near-black by the same ratio but is bounded at zero by construction, so true black stays black.
      float lu = dot(col, LUMA);
      col *= (lu + lift) / (lu + lift * 0.55 + 1e-4);
      // ...and an explicit floor. The toe is bounded at zero by construction, which is right for the sky and
      // for an unlit alley but wrong for a SUBJECT: measured on postfx_hero, 89.5% of the lead's suit and 93%
      // of his torso in combat sat below L8 with no lapel edge, no sleeve seam and no shoulder roll at 3x —
      // a subject-shaped hole, not a black suit. L2.5 is still black on a calibrated display but it is a
      // floor the split tone and the dither have something to work with.
      col = max(col, vec3(0.010));
      col += col * wet * 0.08 * (1.0 - l);       // droplets pick up the signage behind them — but never on an
      //                                            already-bright glyph, where a multiplicative pickup was
      //                                            what welded a white blob to the top of the MAGNET T
      col += heat * vec3(0.30, 0.035, 0.02) * smoothstep(0.06, 0.55, r2);
      col += flash;
      // the ramp must not reach 0 inside the frame, or the whole outer band is a flat multiplier with no taper
      // (measured -25.7% on the day sky at less than half the corner radius, with banding to match)
      col *= mix(1.0, smoothstep(1.85, 0.55, rr / 0.72), vignette);
      vec2 px = uv / texel;                                           // hashes must run on pixels, not on [0,1] uv
      float n = hash12(px + time * 71.3) * 2.0 - 1.0;
      // grain peaks in the MIDTONES. Weighted into the toe (the old 0.25 + 0.75*(1-smoothstep)) it gave the
      // hero's black suit 18% relative modulation and a flat black prop 21% — a crawling dither field that
      // reads as video compression, not as film stock. Silver halide has the least density variance at both ends.
      col += n * grain * (0.30 + 0.70 * (1.0 - abs(l * 2.0 - 1.0)));
      col = max(col, 0.0);
      float d1 = hash12(px + time * 13.1), d2 = hash12(px + time * 13.1 + 37.0);  // TPDF dither kills the 8-bit bands
      // ...but a flat +/- 1 LSB cannot: the toe compresses the deep shadows hard enough that an input LSB
      // becomes a sub-LSB output step, so the dither had nothing left to break up and the hero's shoulder
      // carried visible diagonal contours. Scale it with the local toe slope — ~3 LSB in the blacks.
      col += (d1 + d2 - 1.0) / 255.0 * (1.0 + 2.5 * (1.0 - smoothstep(0.0, 0.14, l)));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Kamurocho night shadows are sodium + magenta neon spill — warm, never blue.
// pivot 0.42 with contrast 1.12 put the crush point ON THE SUBJECT: a suit, a trouser leg and the pavement
// under the lead all sit between 0.01 and 0.10, i.e. deep inside the compressed part of pivot*pow(col/pivot,c).
// Pivot 0.30 moves the fulcrum below the character, contrast 1.05 flattens what is left of the crush, and the
// saturation cut stops the warm shadowTint from taking his skin to sat 0.74 swamp green.
// ...but 1.04 saturation on the one scene that must be saturated was the opposite failure: measured mean
// chroma (max-min per pixel) over the centre was 15.7 at night against 29.5 at noon, i.e. the neon-drenched
// frame carried HALF the chroma of a noon street, with a mean RGB of (81, 74, 81) — neutral. The split tone
// has to actually SPLIT (sodium/magenta shadows), and vignette/grain/CA have to clear the perceptual floor:
// 0.14 vignette is a 10.4% corner falloff that is invisible against the scene's own content, 0.008 grain
// peaks at the same +/-2 LSB as the dither it sits next to, and 0.0003 CA is ~1 px at the extreme corner only.
const NIGHT_GRADE = {
  shadowTint: [1.22, 0.87, 1.09], highTint: [1.14, 0.97, 0.94], toneK: 0.95, lift: 0.045,
  contrast: 1.16, pivot: 0.30, saturation: 1.38, vignette: 0.26, grain: 0.018, ca: 0.0011,
};
// contrast 1.18 around a 0.355 pivot on a signal with no shoulder is what made the day frame flat grey TV:
// it stretched a histogram that was already clipped at both ends. Gentler curve, higher pivot, real shoulder.
// pivot 0.38, not 0.42: nothing in the 13:00 scene reaches ACES saturation (the brightest crosswalk paint
// arrives at 0.91 display), so with the fulcrum at 0.42 the frame could not produce a single display-white
// pixel and read as heavy overcast with a blue gradient pasted on. Dropping the fulcrum below the sunlit
// paint lets direct sun clip and leaves the shaded side where it was.
const DAY_GRADE = {
  shadowTint: [0.93, 0.99, 1.11], highTint: [1.06, 1.01, 0.95], toneK: 0.55, lift: 0.018,
  contrast: 1.08, pivot: 0.38, saturation: 1.20, vignette: 0.18, grain: 0.012, ca: 0.0004,
};
// the night haze carried a magenta cast (R 1.6x B) that the sky then amplified into a salmon gradient. Cooler
// and closer to neutral: the warmth in a Kamurocho night belongs to the emitters and to the pollution band.
const NIGHT_HAZE = { color: [0.120, 0.094, 0.105], density: 0.0046, skyAmount: 0.10, heightFall: 2.2, glow: 0.45 };
// daylight inscatter must sit near the horizon sky, or distant towers read darker than the air in front of them
const DAY_HAZE = { color: [0.34, 0.41, 0.55], density: 0.0015, skyAmount: 0.10, heightFall: 1.7, glow: 0.05 };
// Rain is NOT a sepia lift. In 龍が如く7外伝 the far blocks go darker and COOLER and the glow localises around
// the lights; a haze colour that pushes far geometry up toward the same value as the sky erases the skyline.
// ...but scaling the glow DOWN to 45% and the inscatter to 40% made the rainy frame darker and flatter than
// the clear one (measured centre mean L69.1 against L76.2), which is backwards: rain scatters MORE. Water in
// the air is what makes a wet Kamurocho night glow. The far blocks still go cooler — that is the haze COLOUR,
// which is unchanged — but the air itself now carries the emitters' light instead of swallowing it.
// ...and densityK 1.8 was the other half of the deficit: a denser mix toward a DARK haze colour is a dimmer,
// flatter frame by construction. 1.35 with a brighter (still cool) colour and a real inscatter term keeps the
// far blocks separated from the sky while the air itself carries the emitters.
const RAIN_HAZE = { color: [0.125, 0.104, 0.122], densityK: 1.35, skyAmount: 0.10, glowK: 1.35, inscatterK: 2.0 };

// NIGHT EXPOSURE TRIM. postfx owns the exposure that is applied pre-bloom (HazeShader's `outc * exposure`),
// and at lighting's 0.85 the frame had no emitter separation at all: measured on crossing_night, the blue
// panel field INSIDE the SHIBUYA SKY LED wall read L118 while the unlit corrugated concrete bolted to it
// read L111-122 — a 6x4 m advertising screen at the same display value as the concrete beside it. A Kamurocho
// night frame is defined by emitters sitting 2-4 stops above every surface. Trimming the pre-bloom exposure
// drops the mid-surfaces ~0.55 stops while the ACES shoulder holds the emitters where they are, and it also
// lifts the LED field over the (exposure-relative) bloom threshold instead of leaving it just under.
const NIGHT_EXPOSURE = 0.68;
// NEAR-FIELD FILL gain at night (HazeShader fillNear). It was 3.4 with a blue tint (0.96, 1.0, 1.18), added when
// the lead had no light of his own. He has one now (humanoid.js: a sign-motivated key and rim evaluated in his
// shader), and on top of it the fill is what made him look self-lit: its weight grows as a pixel gets DARKER
// (1 - smoothstep(0.003, 0.05, L)), so the shadow side of the suit was lifted 4-5x and the lit side ~1x — the
// modelling flattened to one even grey and the navy went royal blue. Measured on ?shot=combat&fight=1, the back
// of his jacket read L49 against L52 for the street behind him: no silhouette, a figure glowing from nowhere.
// 2.4, near-neutral (A/B'd at 1.3 / 1.8 / 2.4 / 3.4 on player_closeup and combat): the charcoal keeps its weave
// and lapel edges and still separates from a dark background (the fill stops at ~12 m, the backdrop does not get
// it), the jacket reads L43 against the street's L54 instead of L49 against L52, and the tint no longer paints the
// suit. 1.3-1.8 read more "photographic" but left him a black cut-out against dark facades in the live fight.
// humanoid.js's face pre-compensation reads this gain live (syncFill), so it follows.
const FILL_NIGHT = 2.4;
// the fight has to LOOK different from the first frame, not only once the heat gauge fills. Contrast punch,
// a desaturated periphery, a deeper vignette and a warm corner floor, eased in over 0.25 s.
const COMBAT_GRADE = { contrast: 0.12, vignette: 0.30, periphDesat: 0.10, heatFloor: 0.12 };

const lerp = (a, b, t) => a + (b - a) * t;

const postfx = {
  name: 'postfx',
  composer: null,
  bloom: null,
  gtao: null,
  enabled: true,
  exposure: 0.85,
  nightFactor: 1,
  quality: 2,                 // 2 = GTAO half res, 1 = quarter res, 0 = GTAO off

  init(engine) {
    this.engine = engine;
    const renderer = engine.renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderPR(engine);
    const W = Math.max(2, Math.floor(size.x * pr)), H = Math.max(2, Math.floor(size.y * pr));

    this.depthTex = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    this.depthTex.format = THREE.DepthFormat;
    // WebGL2 depth textures are NOT texture-filterable: LinearFilter makes the texture incomplete and every
    // depth-driven pass (haze, DoF, GTAO) reads black. NearestFilter is mandatory here, not a choice.
    this.depthTex.minFilter = this.depthTex.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType, samples: msaaFor(pr), depthBuffer: true, stencilBuffer: false, depthTexture: this.depthTex,
    });
    this.sceneRT.texture.name = 'postfx:scene';

    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 0, depthBuffer: false });
    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    this.composer = composer;

    this.scenePass = new ScenePass(engine.scene, engine.camera, this.sceneRT);
    composer.addPass(this.scenePass);

    // view-space normals for GTAO/obscurance, reconstructed from the shared depth — RGBA8 is what
    // unpackRGBToNormal expects, alpha is the "not sky" coverage mask the haze pass reads
    this.normalRT = new THREE.WebGLRenderTarget(Math.floor(W * CONTACT_SCALE), Math.floor(H * CONTACT_SCALE), {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.normalRT.texture.name = 'postfx:normal';
    this.normalPass = new OffscreenShaderPass(NormalFromDepthShader, this.normalRT);
    composer.addPass(this.normalPass);

    // GTAO reuses our full-res depth + the normal buffer above: no reconstruction, no G-buffer of its own.
    // Two radii: one 1.2 m radius could do neither job — too large for shoe contact, too sparse for an alley.
    // `thickness` must bracket the radius or the `abs(viewDelta.z) < thickness` test rejects every real
    // occluder and the buffer comes back white. Both run OUTPUT.Off; the haze pass multiplies the two AO
    // buffers in with an emissive guard, which also saves four full-screen blits.
    const makeGTAO = (ao, pd, intensity) => {
      const g = new GTAOPass(engine.scene, engine.camera, Math.floor(W * CONTACT_SCALE), Math.floor(H * CONTACT_SCALE));
      g.setGBuffer(this.depthTex, this.normalRT.texture);
      g.output = GTAOPass.OUTPUT.Off;
      g.needsSwap = false;
      g.blendIntensity = intensity;
      g.updateGtaoMaterial(ao);
      g.updatePdMaterial(pd);
      const base = g.setSize.bind(g);
      g.setSize = (w, h) => {
        const s = CONTACT_SCALE * (this.quality === 1 ? 0.5 : 1) * (this.aoScale || 1);
        const aw = Math.max(2, Math.floor(w * s)), ah = Math.max(2, Math.floor(h * s));
        base(aw, ah);
        if (this.normalRT) this.normalRT.setSize(aw, ah);
        if (g.normalRenderTarget) g.normalRenderTarget.setSize(2, 2);   // unused: we supply the G-buffer
      };
      composer.addPass(g);
      return g;
    };
    // `thickness` is a thin-object REJECTION distance, not a search range: a sample whose view-Z is further
    // than this is treated as unrelated geometry. It must stay well UNDER the radius, or a facade seen at a
    // grazing angle counts its own coplanar samples as occluders. The shipped 1.4 against a 0.9 m radius was
    // 1.56x — the code contradicting its own comment, and half of why the frame had no contact AO at all.
    // The other half was the denoise: `radius: 8` at 0.40 res is a ~20 screen-px smear, wider than the shoe
    // pool it is meant to preserve. At 0.75 res with radius 3 the kernel is ~4 screen px and the pool survives.
    this.gtao = makeGTAO(
      { radius: 0.9, distanceExponent: 1.0, thickness: 0.5, scale: 2.4, samples: 16 },
      { lumaPhi: 6, depthPhi: 1.5, normalPhi: 3, radius: 3, samples: 12 }, 1.15);

    // large-scale obscurance at ~0.3 res: 9 m radius, no clamp dead zone, upsampled with a 2x2 tent in haze
    this.bigRT = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(W * BIG_SCALE)), Math.max(2, Math.floor(H * BIG_SCALE)), {
      type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.bigRT.texture.name = 'postfx:bigAO';
    this.bigAO = new OffscreenShaderPass(BigAOShader, this.bigRT);
    this.bigAO.intensity = 1.15;
    composer.addPass(this.bigAO);
    this.bigRT2 = this.bigRT.clone();
    this.bigRT2.texture.name = 'postfx:bigAOsmooth';
    this.bigBlur = new OffscreenShaderPass(BigBlurShader, this.bigRT2);
    this.bigBlur.uniforms.tDiffuse.value = this.bigRT.texture;
    composer.addPass(this.bigBlur);

    this.haze = new SourceShaderPass(HazeShader, this.sceneRT);
    composer.addPass(this.haze);

    // ?aotune=r,thick,scale,samples,bigRadius,sigma,power,bias,gtaoExp,bigExp — sweep both tiers from the URL
    // instead of an edit/reload cycle. `sigma` is now the linear strength of a bounded [0,1] estimator and
    // `bias` a dimensionless sine bias, so the shipped 2.0 / 0.06 do not mean what the old 2.0 / 0.008 did.
    const tune = engine.params && engine.params.raw ? engine.params.raw.aotune : null;
    if (tune) {
      const v = tune.split(',').map(Number);
      this.gtao.updateGtaoMaterial({ radius: v[0], thickness: v[1], scale: v[2], samples: v[3] });
      const b = this.bigAO.uniforms;
      b.radiusW.value = v[4]; b.sigma.value = v[5]; b.power.value = v[6]; b.bias.value = v[7];
      this.gtao.blendIntensity = v[8]; this.bigAO.intensity = v[9];
      console.info('[postfx] aotune', v.join(' '));
    }

    // near-field CoC mask at half res, consumed by CineShader below
    this.nearRT = new THREE.WebGLRenderTarget(Math.max(2, W >> 1), Math.max(2, H >> 1), {
      type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.nearRT.texture.name = 'postfx:nearCoC';
    this.nearPass = new OffscreenShaderPass(NearCoCShader, this.nearRT);
    this.nearPass.enabled = false;
    composer.addPass(this.nearPass);

    // far-field bokeh at half res — see FarFieldShader. `tDiffuse` is bound to the composer's live read buffer
    // each frame (that is what the srcUniform argument does), so this sits wherever it is added in the chain.
    this.farRT = new THREE.WebGLRenderTarget(Math.max(2, W >> 1), Math.max(2, H >> 1), {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.farRT.texture.name = 'postfx:farField';
    this.farPass = new OffscreenShaderPass(FarFieldShader, this.farRT, 'tDiffuse');
    this.farPass.enabled = false;
    composer.addPass(this.farPass);

    // DoF BEFORE bloom: the halo then follows the CoC. The other way round, bloom builds a halo and DoF
    // smears it again — that is the unreadable pink-white smear the rubric bans.
    this.cine = new ShaderPass(CineShader);
    this.cine.enabled = false;
    this.cine.uniforms.tNear.value = this.nearRT.texture;
    this.cine.uniforms.tFar.value = this.farRT.texture;
    composer.addPass(this.cine);

    // TIGHT tier: threshold below display white so a 6x4 m LED wall actually spills onto the concrete next to it
    // (at 1.05 the threshold sat at the value ACES maps to white — only already-clipping pixels bloomed).
    // 0.90/0.95, not 1.60/0.72: at 0.72 the LED glyph cores AND the gaps between them cleared the bar, and
    // three's 0.01-wide step let both in at full alpha. See MaskedHighPassShader for the knee that replaces it.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(W * BLOOM_SCALE, H * BLOOM_SCALE), 0.45, 0.28, 0.50);
    // swap in the masked high-pass. It SHARES highPassUniforms, which is the object UnrealBloomPass.render
    // writes tDiffuse/luminosityThreshold into by name, so nothing about the pass's own flow changes.
    const hp = this.bloom.highPassUniforms;
    hp.tMask = { value: null };            // the BLOOM-layer gate, allocated lazily by setSelectiveBloom(true)
    hp.tDepth = { value: this.depthTex };
    hp.maskMix = { value: 1 };
    hp.maskLo = { value: 0.02 };
    hp.maskHi = { value: 0.30 };
    this.bloom.materialHighPassFilter.dispose();
    this.bloom.materialHighPassFilter = new THREE.ShaderMaterial({
      name: MaskedHighPassShader.name, uniforms: hp,
      vertexShader: VERT, fragmentShader: MaskedHighPassShader.fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    // ...but OFF by default, and the reason is measured, not aesthetic. Layer BLOOM is no longer "things that
    // glow": crowd.js puts 150 pedestrian BODIES on layer 1 and weather.js mirrors that layer for the wet
    // ground, so a layer-1 render is a second full crowd pass. Cost on day_crossing: 460 -> 715 draw calls and
    // 2.34 M -> 3.62 M triangles, i.e. over the §0 budget. `?postfx=selective` turns it on, and NOTHING is
    // allocated or compiled for it until it is (see setSelectiveBloom): the mask target, its depth buffer and
    // the BloomMaskPass shaders used to be built on every session for a pass that never rendered a frame.
    // The cheap shipping path is an emissive mask in sceneRT's alpha — see the materials/signage request in
    // docs/reports/render.md. Until then the luminance knee + the unconditional sky kill do the gating.
    this.setSelectiveBloom(false);
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(2, Math.floor(w * BLOOM_SCALE)), Math.max(2, Math.floor(h * BLOOM_SCALE)));
    // three's default per-mip weights ([1, .8, .6, .4, .2]) make the pyramid a frame-wide low pass. The halo
    // has to live in mip 0-1; the top mips are what produced the veil that lifted the sky 600 px from a light.
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = BLOOM_FACTORS.slice();
    this.patchBloomComposite();
    // ...and a disabled mip is not BLURRED either. The composite already multiplies mips 3-4 by exactly 0 (see
    // patchBloomComposite), but three still ran their two blur passes every frame: four render passes (clear, bind,
    // draw) for a result weighted zero. With nMips 3 the loop stops after mip 2; the composite still samples the
    // never-written (zero-initialised) mip 3-4 targets at factor 0, so the output is bit-identical.
    this.bloom.nMips = BLOOM_FACTORS[4] > 0 ? 5 : BLOOM_FACTORS[3] > 0 ? 4 : 3;
    composer.addPass(this.bloom);

    // ORDER: bloom -> grade (tone map + encode + grade, one pass) -> SMAA. Anti-aliasing has to be the LAST
    // thing that touches the frame, for two reasons that both bit here. (1) The grade does the chromatic-
    // aberration fetch; run before AA it re-aliased every high-contrast edge SMAA had just resolved, leaving
    // an orange/cyan fringe sitting on a 1 px stair-step. (2) SMAA's edge detector thresholds on GAMMA-space
    // luma, so on the linear HalfFloat buffer it under-detected bright emissive edges (LED glyphs kept
    // staircasing) and over-detected in the toe. Tone-mapped sRGB in, morphological AA out.
    // OutputPass is GONE: it was a whole full-res HalfFloat read/write cycle for a tone map and an encode that
    // the grade's first three lines now do for free, and the grade's shoulder could never reach display white
    // while its input arrived already ACES-clamped to [0,1] from a separate pass.
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    composer.addPass(this.smaa);

    this.fxaa = new ShaderPass(FXAAShader);   // quality 0 fallback: cheaper than SMAA's 3 passes
    this.fxaa.enabled = false;
    composer.addPass(this.fxaa);

    // ---- performance profile (client call 2026-09-22) ---------------------------------------------------
    // The isolation probe (tools/perfprobe.mjs) put the whole 41 -> 60 fps gap in this chain, not in the
    // scene: hiding the entire 3,000-strong crowd bought 4 fps, disabling post-processing bought 19 WITH
    // more geometry on screen. So the chain gets a profile, switchable at runtime so the old look is one
    // URL away:  ?fx=lite (default)  ?fx=full (everything as authored)  ?fx=off (no post at all).
    this.profileName = (engine.params && engine.params.raw && engine.params.raw.fx) || 'lite';
    this.applyProfile(this.profileName);

    const btune = engine.params && engine.params.raw ? engine.params.raw.bloomtune : null;
    if (btune) {
      const v = btune.split(',').map(Number);
      this._bloomS = v[0];
      this.bloom.compositeMaterial.uniforms.bloomFactors.value = v.slice(1, 6);
      this.bloom.nMips = 5;                          // a tuning sweep may switch the top mips back on
    }
    // ?postfx=ao|haze|nograde|off  — isolate one stage for critics / debugging
    const dbg = engine.params && engine.params.raw ? engine.params.raw.postfx : null;
    if (dbg === 'ao') {
      // the haze pass already holds both AO buffers: ask it for their product and nothing else
      this.haze.uniforms.aoDebug.value = 1;
      this.bloom.enabled = this.grade.enabled = false;
      this._noCine = true;                           // an isolated AO buffer must not be measured through a blur
      // the debug output is already gamma-encoded and OutputPass is off, so (display/255)^2.2 IS the AO term.
      // Measuring it through ACES (as this mode used to) reported 0.05 where the buffer held 0.25.
    }
    // ?postfx=normal shows the G-buffer itself (one frame behind — the normal pass runs after the blit)
    if (dbg === 'normal') {
      this.haze.enabled = this.bloom.enabled = false;
      this.grade.uniforms.graded.value = 0;              // grade OFF, tone map + encode still on (see GradeShader)
      this.scenePass.debugTex = this.normalRT.texture;
      this._noCine = true;
    }
    // ?postfx=near shows the near-field CoC mask (red = dilated CoC, green = raw CoC, blue = foreground coverage)
    if (dbg === 'near') {
      this.haze.enabled = this.bloom.enabled = false;
      this.grade.uniforms.graded.value = 0;              // grade OFF, tone map + encode still on (see GradeShader)
      this.scenePass.debugTex = this.nearRT.texture;
      this._noCine = true;
    }
    // ?postfx=far shows the half-res bokeh buffer itself. The gather is re-pointed at the scene target so it
    // does not read back the blit this debug puts in the ping-pong buffer (that would be a feedback loop).
    if (dbg === 'far') {
      this.haze.enabled = this.bloom.enabled = false;
      this.grade.uniforms.graded.value = 0;              // grade OFF, tone map + encode still on (see GradeShader)
      this.farPass.srcUniform = null;
      this.farPass.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.scenePass.debugTex = this.farRT.texture;
      this._noCine = this._debugFar = true;
    }
    // ?postfx=mask shows the BLOOM-layer gate itself
    if (dbg === 'mask') {
      this.setSelectiveBloom(true);
      this.haze.enabled = this.bloom.enabled = false;
      this.grade.uniforms.graded.value = 0;              // grade OFF, tone map + encode still on (see GradeShader)
      this.scenePass.debugTex = this.maskRT.texture;
      this._noCine = true;
    }
    if (dbg === 'noao') this.gtao.enabled = this.bigAO.enabled = this.bigBlur.enabled = this.normalPass.enabled = false;
    if (dbg === 'nobloom') this.bloom.enabled = false;
    if (dbg === 'selective') this.setSelectiveBloom(true);   // A/B the gate against the pure luminance threshold
    if (dbg === 'nograde') this.grade.uniforms.graded.value = 0;   // the pass still tone maps and encodes
    if (dbg === 'off') this.enabled = false;

    this.setSize(size.x, size.y);
    if (dbg === 'q0' || dbg === 'q1') this.setQuality(dbg === 'q0' ? 0 : 1);   // force a degraded tier for review

    // ---- GPU timing for the degrade ladder (see GpuTimer)
    const gl = renderer.getContext();
    const probe = new GpuTimer(gl);
    if (probe.ext) {
      this.frameTimer = probe;
      this.sceneTimer = new GpuTimer(gl);
    } else {
      this.frameTimer = this.sceneTimer = null;
      console.info('[postfx] EXT_disjoint_timer_query_webgl2 unavailable: degrade ladder falls back to CPU ms');
    }
    this._timerFrame = 0; this.postMs = 0; this.frameMs = 0;

    // ---- state driven from other systems
    this.flash = 0; this.radial = 0; this.radialT = 0; this.heat = 0; this.rain = 0; this.combatMix = 0;
    this.dof = 0; this.dofTarget = 0; this.focus = 5; this.t = 0; this.lowFrames = 0; this.highFrames = 0;
    this._radialCenter = new THREE.Vector2(0.5, 0.5);
    this._impact = new THREE.Vector3();
    this._focusPt = new THREE.Vector3();

    // the bloom threshold is relative to the buffer the pass actually sees, and haze applies exposure to it
    engine.events.on('lighting:exposure', (v) => { this.exposure = v || 1; this.applyLook(); });
    engine.events.on('lighting:changed', (e) => { this.setNight(e && e.night != null ? e.night : this.nightFactor); });
    engine.events.on('postfx:bloom', (p) => this.applyBloom(p));
    engine.events.on('postfx:ao', (p) => this.applyAO(p));
    engine.events.on('postfx:haze', (p) => this.applyHaze(p));
    engine.events.on('postfx:grade', (p) => this.applyGrade(p));
    engine.events.on('weather:changed', (e) => { this.rainTarget = e && e.rain != null ? e.rain : 0; });
    engine.events.on('combat:hit', (e) => this.onHit(e));
    engine.events.on('combat:ko', (e) => this.onHit(e, 1.4));
    engine.events.on('heat:action', () => { this.flash = Math.max(this.flash, 0.55); this.radial = 1; this.radialT = 0.2; });
    engine.events.on('combat:start', () => { this._combatOn = true; });
    engine.events.on('combat:end', () => { this._combatOn = false; });

    const lighting = engine.get('lighting');           // lighting inits earlier: pick up its current values
    if (lighting) {
      if (lighting.exposure) this.exposure = lighting.exposure;
      this.setNight(lighting.nightFactor != null ? lighting.nightFactor : 1);
      if (lighting.bloomParams) this.applyBloom(lighting.bloomParams);
      if (lighting.aoParams) this.applyAO(lighting.aoParams);
    }
    const weather = engine.get('weather');
    this.rainTarget = weather && weather.rainIntensity != null ? weather.rainIntensity : 0;
    this.rain = this.rainTarget;
    this.applyLook();                 // rain is only known now: re-derive haze/grade/bloom with it
    // ?doftune=focus,range,strength — pin the cinematic lens for a critic shot (setDOF from the URL)
    const dt = engine.params && engine.params.raw ? engine.params.raw.doftune : null;
    if (dt) { const v = dt.split(',').map(Number); this.setDOF(true, { focus: v[0], range: v[1], strength: v[2] }); }

  },

  // ---- parameter plumbing -------------------------------------------------
  // lighting sends a PRE-tone-map threshold (1.25 night / 1.6 day); ours is exposure-relative, so remap.
  applyBloom({ strength, radius, threshold, absolute } = {}) {
    if (absolute) {
      if (strength != null) this.bloom.strength = strength;
      if (radius != null) this.bloom.radius = radius;
      if (threshold != null) this.bloom.threshold = Math.min(threshold, 1.6);
      const cu = this.bloom.compositeMaterial.uniforms;
      if (cu.selfSup) cu.selfSup.value.x = this.bloom.threshold * 0.5;
      return;
    }
    if (threshold != null) this.bloomDay = THREE.MathUtils.clamp((threshold - 1.25) / 0.35, 0, 1);
    // the THRESHOLD follows lighting's remapped value; the STRENGTH follows the time of day, because lighting
    // sends a high threshold at night too and the strength would then be graded as if it were noon
    const d = this.bloomDay != null ? this.bloomDay : 1 - this.nightFactor;
    const day = 1 - this.nightFactor;
    const wet = this.rain > 0.02 ? this.rain : 0;                    // veiling glare in the rain
    // the threshold is relative to the exposure the BLOOM actually sees, which is the trimmed one
    const e = THREE.MathUtils.clamp(this.hazeExposure(), 0.3, 2);
    // 0.50, not 0.95. At 0.95 the only pixels admitted to the pyramid were ones already clipping: measured
    // A/B on crossing_night, the LED bezel under the 8x6 m SHIBUYA SKY screen moved +0.35%, the 109 neon tube
    // +0.11% and the whole frame 2.5% — in a scene with 7451 signs, 331 halos and 8 LED screens. A 龍が如く8
    // Kamurocho night IS the glow on the signage, so the gate has to open at a real emitter (~L206 displayed)
    // and reach full contribution at ~0.9x white, not at 1.28x. The day bump and the unconditional sky kill
    // stay. Exposure-relative so daylight (lighting runs it at 0.55) lands on the same part of the curve.
    // RAIN drops the gate hard. A wet night in 龍が如く7外伝 is the frame where every emitter grows a halo,
    // because the air itself is full of scattering water; -0.06 was inside the noise.
    this.bloom.threshold = Math.min((0.44 + 0.12 * d - 0.14 * wet) * (e / 0.85), 1.12);
    // 0.62, not 0.45. With mips 3-4 zeroed the pyramid lost the pedestal it was spreading over the whole
    // frame; the halo energy has to come back onto mips 0-1 or a neon tube's glow dies inside its own bezel.
    // The rain bonus is +0.22, not +0.05: veiling glare around the emitters is the point of a wet frame.
    this.bloom.strength = (this._bloomS != null ? this._bloomS : 0.62) * (1.0 - 0.45 * day) + 0.22 * wet;
    // `radius` biases UnrealBloom's per-mip lerp. 0.08 with front-loaded factors put the whole halo inside
    // mip 0 — a 6 px glow on an 18 px neon tube, i.e. inside its own bezel. 0.32 buys the 20-30 px falloff a
    // tube actually has without reaching the frame-average mips.
    this.bloom.radius = 0.17 + 0.03 * wet;
    // the knee's upper edge tracks the threshold so full contribution always lands at ~0.9x display white
    const hp = this.bloom.highPassUniforms;
    if (hp && hp.smoothWidth) hp.smoothWidth.value = Math.max(0.04, 0.90 * (e / 0.85) - this.bloom.threshold * 1.35);
    // the self-bloom scale follows the threshold (half of it: see SELF-BLOOM in patchBloomComposite)
    const cu = this.bloom.compositeMaterial.uniforms;
    if (cu.selfSup) cu.selfSup.value.x = this.bloom.threshold * 0.5;
  },

  // The sky kill has to run on the COMPOSITE. MaskedHighPassShader stops the dome SEEDING the pyramid; it does
  // nothing about UnrealBloomPass adding the summed, blurred result on top of every sky pixel afterwards, and
  // that landing is what measured L8.25 -> L13.45 (+63%) on a sky patch 250-350 px from the nearest emitter.
  // The composite runs at BLOOM_SCALE but samples vUv, so the full-res depth texture indexes straight into it.
  // The knee is on the pyramid's OWN energy, normalised by the strength, so a halo a rooftop sign genuinely
  // throws across its roofline survives and the frame-wide veil under it does not.
  // The chroma guard is the other half: five mips average every emitter in the neighbourhood together, so a
  // halo fed by saturated red, blue and green fields came out warm-neutral (delta chroma 13 on sources at 60-70).
  patchBloomComposite() {
    const cm = this.bloom.compositeMaterial;
    if (cm.uniforms.tDepth) return;
    cm.uniforms.tDepth = { value: this.depthTex };
    cm.uniforms.bloomChroma = { value: 2.3 };
    cm.uniforms.skyKill = { value: new THREE.Vector2(0.035, 0.16) };
    // SELF-BLOOM (below): the frame the pyramid is about to land on — the very uniform UnrealBloomPass.render
    // points at its input each frame — and x = the brightness scale (0.5 x threshold, kept in step by applyBloom),
    // y = how much of the lit field around a pixel (the mip-0 blur of the high-pass) counts as its own brightness
    cm.uniforms.tScene = this.bloom.highPassUniforms.tDiffuse;
    cm.uniforms.selfSup = { value: new THREE.Vector2(0.15, 0.7) };
    cm.fragmentShader = cm.fragmentShader
      // A ZEROED MIP FACTOR DOES NOT ZERO THE MIP. three's lerpBloomFactor is mix(f, 1.2 - f, bloomRadius),
      // so with radius 0.28 a factor of 0.0 comes out at mix(0, 1.2, 0.28) = 0.336 — MORE weight than mip 2's
      // nominal 0.26. That mirror term is what put a flat +3.1 LSB pedestal from mips 3-4 (a 30x17 px frame
      // average at 1080p) on every pixel in the frame, and setting BLOOM_FACTORS[3..4] = 0 could never remove
      // it. An explicitly disabled mip now stays disabled; the radius still biases the mips that are in use.
      .replace('return mix( factor, mirrorFactor, bloomRadius );',
        'return factor <= 0.0 ? 0.0 : mix( factor, mirrorFactor, bloomRadius );')
      .replace('uniform float bloomRadius;',
        'uniform float bloomRadius;\nuniform sampler2D tDepth;\nuniform float bloomChroma;\nuniform vec2 skyKill;\nuniform sampler2D tScene;\nuniform vec2 selfSup;')
      .replace('float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );', /* glsl */`
        vec3 raw = bloom / max(3.0 * bloomStrength, 1e-4);
        float sky = step(0.999999, texture2D(tDepth, vUv).x);
        bloom *= mix(1.0, smoothstep(skyKill.x, skyKill.y, max(raw.r, max(raw.g, raw.b))), sky);
        bloom = max(mix(vec3(dot(bloom, vec3(0.2126, 0.7152, 0.0722))), bloom, bloomChroma), 0.0);
        // SELF-BLOOM. The pyramid is added back over its own source as well as around it, and three's composite
        // carries a 3x "backwards compatibility" gain: inside any sign wider than the mip-0 kernel the summed
        // pyramid is ~3 x 0.62 x 1.87 = 3.5x the (capped) source, i.e. the face of a sign got +350 % of itself
        // on top of its own emission. That, not the emissive or the exposure, is what drove the sign faces into
        // the ACES shoulder: measured on crossing_night vs ?postfx=nobloom, the Bumblebee board's field went
        // rgb(191,123,33) -> (253,204,88) and its dark lettering vanished into the fill, and the センター街 gate's
        // pink field went (245,124,155) sat 0.53 -> (255,198,217) sat 0.25 — a red sign reading white-pink, the
        // white glyph cores smearing over it. The halo belongs AROUND the emitter, so the pyramid lands on a pixel
        // in inverse proportion to how bright that pixel already is — a screen-like blend, 1 / (1 + (a/s)^2):
        // unlit concrete, asphalt and sky next to a sign (a ~0.02-0.06) keep 86-98 % of the halo, a sign field
        // (a ~0.5-1) keeps 2-8 %. a also counts the lit field AROUND the pixel (the high-pass's mip-0 blur), so
        // the dark lettering inside a lit panel is protected like the panel. Smooth, no mask edge: an all-or-
        // nothing emitter mask was tried and left dark rings where the glyphs' halo stopped and the field's began.
        vec3 sc = texture2D(tScene, vUv).rgb, b1 = texture2D(blurTexture1, vUv).rgb;
        float selfA = max(max(sc.r, max(sc.g, sc.b)), selfSup.y * max(b1.r, max(b1.g, b1.b))) / max(selfSup.x, 1e-4);
        bloom *= 1.0 / (1.0 + selfA * selfA);
        float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );`);
    cm.needsUpdate = true;
  },

  // the gate is the only thing that costs a second geometry pass, so it is also the first thing the ladder
  // drops: without it the pass falls back to the plain luminance threshold + sky kill it had before.
  // Nothing is allocated until the gate is switched on for the first time — see _ensureMask.
  setSelectiveBloom(on) {
    this.selective = !!on;
    if (this.selective) this._ensureMask();
    if (this.maskPass) this.maskPass.enabled = this.selective;
    const hp = this.bloom && this.bloom.highPassUniforms;
    if (hp && hp.maskMix) hp.maskMix.value = this.selective ? 1 : 0;
  },

  // selective bloom: one extra render of layer BLOOM only, at 0.35 res, used purely as a gate on the high-pass.
  // Everything that glows in this city is on that layer (signage, LED boards, lamp heads, headlights, taxi roof
  // lights, the moon). No depthBuffer: the mask is a flat layer render consumed as a single scalar, and a 0.35
  // res depth attachment for it was pure VRAM. Inserted directly before the bloom pass so the gate is written
  // in the same frame it is read.
  _ensureMask() {
    if (this.maskRT || !this.composer) return;
    const s = this.sceneRT;
    const mw = Math.max(2, Math.floor(s.width * MASK_SCALE)), mh = Math.max(2, Math.floor(s.height * MASK_SCALE));
    this.maskRT = new THREE.WebGLRenderTarget(mw, mh, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.maskRT.texture.name = 'postfx:bloomMask';
    this.maskPass = new BloomMaskPass(this.engine.scene, this.engine.camera, this.maskRT);
    this.composer.insertPass(this.maskPass, this.composer.passes.indexOf(this.bloom));
    this.bloom.highPassUniforms.tMask.value = this.maskRT.texture;
  },

  applyAO({ radius, intensity } = {}) {
    if (!this.gtao) return;
    // lighting's radius/intensity SCALE the two tuned radii; they must not replace them, or the bounce pass
    // collapses back onto the contact pass and the alleys lose their occlusion again
    if (radius != null) {
      const k = THREE.MathUtils.clamp(radius / 0.6, 0.5, 2);
      this.gtao.updateGtaoMaterial({ radius: 0.9 * k, thickness: 0.5 * k });
      this.bigAO.uniforms.radiusW.value = 6.0 * k;
    }
    if (intensity != null) {
      const k = THREE.MathUtils.clamp(intensity / 0.9, 0.4, 1.4);
      this.gtao.blendIntensity = 1.15 * k;
      this.bigAO.intensity = 1.15 * k;
    }
    this.syncAO();
  },

  // the AO multiply lives in the haze pass now, so the intensities and both buffers have to be pushed there
  syncAO() {
    if (!this.haze || !this.gtao) return;
    const u = this.haze.uniforms;
    u.tAO1.value = this.gtao.gtaoMap;
    u.tAO2.value = this.bigRT2.texture;
    u.tNormal.value = this.normalRT.texture;
    u.aoTexel.value.set(1 / this.bigRT2.width, 1 / this.bigRT2.height);
    // DAY needs more bite than night. At 13:00 under a clear sky the contact tier is the only thing in the
    // frame doing the job a shadow cascade should be doing (there is none at that hour — filed against
    // lighting), and a pedestrian band measured 0.46% of pixels below L8, i.e. no contact darkening at all.
    // At night the same intensity muddies a frame that is already lit from every direction, so it is gated.
    // ...and lighting sends a LOWER intensity at 13:00 than at night (measured: blendIntensity 1.15 -> 0.77),
    // which is backwards for the one frame whose only contact cue this buffer is. Day pulls the composite
    // exponent up to a floor instead of scaling whatever arrived.
    const day = 1 - this.nightFactor;
    const i1 = this.gtao.blendIntensity, i2 = this.bigAO.intensity;
    u.aoI1.value = this.gtao.enabled ? lerp(i1, Math.max(i1, 1.6), day) : 0;
    u.aoI2.value = this.bigAO.enabled ? lerp(i2, Math.max(i2, 1.4), day) : 0;
    if (this.normalPass) this.normalPass.enabled = this.gtao.enabled || this.bigAO.enabled;
  },

  applyHaze({ color, density, skyAmount, heightFall, skyGlow, skyGlowColor, inscatter } = {}) {
    const u = this.haze.uniforms;
    if (color) u.hazeColor.value.setRGB(color[0], color[1], color[2]);
    if (skyGlowColor) u.skyGlowColor.value.setRGB(skyGlowColor[0], skyGlowColor[1], skyGlowColor[2]);
    if (density != null) u.density.value = density;
    if (skyAmount != null) u.skyAmount.value = skyAmount;
    if (heightFall != null) u.heightFall.value = heightFall;
    if (skyGlow != null) u.skyGlow.value = skyGlow;
    if (inscatter != null) u.inscatter.value = inscatter;
  },

  applyGrade(p = {}) {
    const u = this.grade.uniforms;
    // 'pivot' was missing from this list although both grades define it and applyLook applies it, so every
    // postfx:grade carrying a pivot was a silent no-op — the one parameter a tuning pass reaches for first.
    for (const k of ['toneK', 'lift', 'contrast', 'pivot', 'saturation', 'vignette', 'grain', 'ca']) if (p[k] != null) u[k].value = p[k];
    if (p.shadowTint) u.shadowTint.value.fromArray(p.shadowTint);
    if (p.highTint) u.highTint.value.fromArray(p.highTint);
    // the combat look is layered on top of these two per frame, so it has to know what it is layering onto
    if (p.contrast != null) this._baseContrast = p.contrast;
    if (p.vignette != null) this._baseVignette = p.vignette;
  },

  // the pre-bloom exposure: lighting's value with the night trim folded in (see NIGHT_EXPOSURE)
  hazeExposure() { return (this.exposure || 0.85) * lerp(1, NIGHT_EXPOSURE, this.nightFactor); },

  // night 0..1 crossfades the whole look (grade + haze) without any new wiring in lighting
  setNight(n) {
    this.nightFactor = THREE.MathUtils.clamp(n, 0, 1);
    this.applyLook();
  },

  // night AND rain drive the look: a rainy night is not a clear night with streaks on it
  applyLook() {
    const k = this.nightFactor, u = this.grade.uniforms, h = this.haze.uniforms;
    const r = THREE.MathUtils.clamp(this.rain || 0, 0, 1) * k;
    for (const key of ['toneK', 'lift', 'contrast', 'pivot', 'saturation', 'vignette', 'grain', 'ca']) u[key].value = lerp(DAY_GRADE[key], NIGHT_GRADE[key], k);
    u.saturation.value += 0.10 * r;
    this._baseContrast = u.contrast.value; this._baseVignette = u.vignette.value;
    // no rain lift bonus. Stacked on the night lift it was +15.8 display levels into every shadow and night_rain
    // came back with min L19 — a rainy Kamurocho gets its glow from the emitters, never from a pedestal.
    for (let i = 0; i < 3; i++) {
      u.shadowTint.value.setComponent(i, lerp(DAY_GRADE.shadowTint[i], NIGHT_GRADE.shadowTint[i], k));
      u.highTint.value.setComponent(i, lerp(DAY_GRADE.highTint[i], NIGHT_GRADE.highTint[i], k));
    }
    h.hazeColor.value.setRGB(
      lerp(lerp(DAY_HAZE.color[0], NIGHT_HAZE.color[0], k), RAIN_HAZE.color[0], r),
      lerp(lerp(DAY_HAZE.color[1], NIGHT_HAZE.color[1], k), RAIN_HAZE.color[1], r),
      lerp(lerp(DAY_HAZE.color[2], NIGHT_HAZE.color[2], k), RAIN_HAZE.color[2], r));
    h.density.value = lerp(DAY_HAZE.density, NIGHT_HAZE.density, k) * lerp(1, RAIN_HAZE.densityK, r);
    h.skyAmount.value = lerp(lerp(DAY_HAZE.skyAmount, NIGHT_HAZE.skyAmount, k), RAIN_HAZE.skyAmount, r);
    h.heightFall.value = lerp(DAY_HAZE.heightFall, NIGHT_HAZE.heightFall, k);
    // in rain the veiling glare belongs to the bloom tiers (localised around emitters), not to a global
    // additive term that raises the far blocks to exactly the value the sky is being raised to
    h.skyGlow.value = lerp(DAY_HAZE.glow, NIGHT_HAZE.glow, k) * lerp(1, RAIN_HAZE.glowK, r);
    h.inscatter.value = 0.28 * lerp(1, RAIN_HAZE.inscatterK, r);
    h.night.value = k;                       // drives the night ceiling and the confined pollution band
    // the AO floor is a BOUNCE floor: at night a hundred signs fill every crease, at 13:00 nothing does —
    // and 0.26 against DAY_HAZE's 0.28 inscatter is what washed the shoe pools off the crosswalk.
    h.aoFloor.value = lerp(0.12, 0.26, k);
    h.fillNear.value = FILL_NIGHT * k;       // night-only near bounce gain; daylight has a sun for this
    h.exposure.value = this.hazeExposure();  // the night trim that buys the emitter separation
    if (this.bloom) this.applyBloom({});
  },

  setDOF(on, { focus, range, strength } = {}) {
    // the 'lite' profile parks DoF for gameplay; a cutscene asking for it explicitly still gets it
    if (on && this.dofAllowed === false && !this._cineOwner && engineIsPlaying(this.engine)) on = false;
    this._dofManual = !!on;
    this.dofTarget = on ? (strength != null ? strength : 0.75) : 0;
    if (focus != null) this.focus = focus;
    if (range != null) this.cine.uniforms.focusRange.value = range;
  },

  onHit(e, k = 1) {
    this.flash = Math.min(0.42, this.flash + (e && e.heavy ? 0.26 : 0.15) * k);
    this.radial = Math.max(this.radial, e && e.heavy ? 0.9 : 0.55);
    this.radialT = 0.12;
    const p = e && e.target && e.target.position;
    if (p && this.engine.camera) {
      this._impact.copy(p); this._impact.y += 1.1;
      this._impact.project(this.engine.camera);
      this._radialCenter.set(this._impact.x * 0.5 + 0.5, this._impact.y * 0.5 + 0.5);
    }
  },

  // ---- per-frame ----------------------------------------------------------
  update(dt) {
    if (!this.composer) return;
    const engine = this.engine, rt = Math.min(dt || 0, 1 / 20);
    this.haze.uniforms.arrivalClarity.value = engine.state.arrival ? THREE.MathUtils.smoothstep(engine.camera.position.y, 80, 420) : 0;
    // dt already carries engine.time.speed, so the grain still freezes with a hit-stop. Wrapping matters:
    // an unbounded t makes hash12(px + t*71.3) exceed float32's mantissa and the grain/dither go static.
    this.t = (this.t + (rt || 1 / 60)) % 1024;
    const u = this.grade.uniforms, c = this.cine.uniforms;
    u.time.value = this.t % 100;

    this.flash = Math.max(0, this.flash - rt * 6.5);                  // ~2 frames of white on a hit
    if (this.radialT > 0) { this.radialT -= rt; } else { this.radial = Math.max(0, this.radial - rt * 5.5); }
    // THE FINAL BLOW runs on its own real-time clock (combat.finale.t), not on the slowed dt: the radial (zoom) blur
    // is centred on the contact through THIS frame's lens and gone after blurT; the white is the bloom burst at the
    // contact (combat's two-frame core), so the full-screen flash is only a two-frame lift. A heat action keeps its
    // own flash and radial and only takes the grade below.
    const cbm = engine.get('combat'), fin = cbm && cbm.finale;
    const fk = fin ? fbLook(fin.t) : 0;
    // a heat action's own radial would otherwise hang for the whole slowed tail (it decays on game time): real time here
    if (fin && fin.heat && !this.hold) this.radial = Math.min(this.radial, Math.max(0, 1 - fin.t / 0.6));
    if (fin && !fin.heat && !this.hold) {
      this.flash = fin.t < FINAL_BLOW.flash ? FINAL_BLOW.screenFlash : 0;
      this.radial = fbBlur(fin.t); this.radialT = 0;
      if (this.radial > 0 && fin.point && engine.camera) {
        this._impact.copy(fin.point).project(engine.camera);
        if (this._impact.z < 1) this._radialCenter.set(this._impact.x * 0.5 + 0.5, this._impact.y * 0.5 + 0.5);
      }
    }
    if (this.hold) { this.flash = this.hold.flash; this.radial = this.hold.radial; }   // frozen for stills
    u.flash.value = this.flash;
    c.radial.value = this.radial * 0.6;
    c.radialCenter.value.copy(this._radialCenter);

    const player = engine.player;
    const inCombat = engine.state.mode === 'combat' || !!this._combatOn;
    const heatTarget = this.hold ? this.hold.heat
      : (inCombat && player && player.heat != null ? player.heat / 100 : 0);
    this.heat += (heatTarget - this.heat) * Math.min(1, rt * 3);

    // THE COMBAT LOOK. A standing combat frame used to be graded identically to walking down the street —
    // measured centre mean RGB (77.0, 72.3, 77.4) in combat against (82.9, 74.6, 81.8) in exploration, i.e.
    // the same neutral grade. The heat vignette and the hit flash are both event-driven, so the frame only
    // changed once the gauge filled or a punch landed. 龍が如く changes the whole frame the instant a fight
    // starts: contrast punch, desaturated periphery, deeper vignette and a warm corner floor, over 0.25 s.
    const cm = inCombat ? 1 : 0;
    this.combatMix = THREE.MathUtils.clamp(this.combatMix + Math.sign(cm - this.combatMix) * rt * 4, 0, 1);
    const m = this.combatMix;
    if (this._baseContrast != null) u.contrast.value = this._baseContrast + COMBAT_GRADE.contrast * m;
    if (this._baseVignette != null) u.vignette.value = lerp(this._baseVignette, COMBAT_GRADE.vignette, m);
    u.periphDesat.value = COMBAT_GRADE.periphDesat * m;
    u.heat.value = this.heat * 0.55 + COMBAT_GRADE.heatFloor * m;
    // the final blow's look, eased back with the time ramp (fbLook)
    this.finK = fk;
    u.finDesat.value = FINAL_BLOW.desat * fk;
    u.finCA.value = FINAL_BLOW.ca * fk;
    u.finWarm.value = FINAL_BLOW.warm * fk;
    u.finCrush.value = FINAL_BLOW.crush * fk;
    if (fk > 0 && this._baseContrast != null) u.contrast.value += FINAL_BLOW.contrast * fk;   // both are re-set every
    if (fk > 0 && this._baseVignette != null) u.vignette.value += FINAL_BLOW.vignette * fk;   // frame just above

    const weather = engine.get('weather');
    if (weather && weather.rainIntensity != null) this.rainTarget = weather.rainIntensity;
    const prevRain = this.rain;
    this.rain += ((this.rainTarget || 0) - this.rain) * Math.min(1, rt * 2);
    u.rain.value = this.rain;
    if (Math.abs(this.rain - prevRain) > 0.02) this.applyLook();

    // depth of field: focus the fight, soften the background (and the far wet-ground reflections with it)
    const combat = inCombat;
    if (combat && player && player.position && !this._dofManual) {
      // the CHEST, not the character root. player.position is at the feet, and focusing there put the lead's
      // torso and head 0.5-0.8 m in FRONT of the focal plane — i.e. the one shot where he must be sharp was
      // the one shot where he was the only blurred thing in frame, with the pavement at his feet razor sharp.
      this._focusPt.copy(player.position).y += 1.35;
      this.focus = Math.max(1.5, engine.camera.position.distanceTo(this._focusPt));
      // 0.62 was a portrait lens on a brawl. 龍が如く reserves that for cutscenes and finishers; during a
      // fight the player has to read the ring of bystanders and the incoming attacker, and at 0.62 x 26 px
      // the crowd band measured sd 15.1 / hfDev 0.70 — featureless porridge with no readable enemy in it.
      this.dofTarget = 0.28;
    } else if (!combat && !this._dofManual) this.dofTarget = 0;
    this.dof += (this.dofTarget - this.dof) * Math.min(1, rt * 4);
    c.dof.value = this.dof;
    c.focus.value = this.focus;
    // the in-focus window has to hold the whole fight, not just the lead: at a 5 m camera distance
    // max(3, focus * 0.9) was a 4.5 m window, so an enemy two steps behind him was already breaking up.
    if (!this._dofManual) c.focusRange.value = Math.max(8, this.focus * 2.2);
    // SMAA is morphological and cannot resolve a 3 px pedestrian or a 1 px antenna; exploration and the day
    // preset had literally zero far softening, i.e. none in the presets with the highest-frequency content.
    // The ramp starts at 60 m so it never touches the playable near field, and outside combat its radius is
    // capped separately (farSoftenRadius) so it can only ever kill sub-pixel shimmer, never a legible facade.
    // 0.25, not 0.03. At 0.03 the exploration soften produced rs = 0.03 x 4 px = 0.12 px MAXIMUM, which the
    // `r > 0.6` gate then discarded outright — so the half-res gather AND the full-res composite ran every
    // frame in all three non-combat presets and returned a bit-identical image, while the 1 px antenna and
    // the two-pixel roofline step they were built to kill were still there. 0.25 x 4 px = 1.0 px, above the
    // gate (now 0.4), and the composite ramps it separately from the lens so no facade dissolves.
    c.farSoften.value = combat ? 0.22 : (this.quality > 1 ? 0.25 : 0);
    c.farSoftenRadius.value = combat ? c.maxRadius.value : 4;
    // in combat the background is defocused anyway, so the normal G-buffer's far half would be blurred away:
    // halve its reach and hand the draw calls back to the fight
    const nearOn = this.dof > 0.01;
    const farOn = this.dof > 0.01 || c.farSoften.value > 0.001;
    c.nearOn.value = nearOn ? 1 : 0;
    c.farOn.value = farOn ? 1 : 0;
    if (this.nearPass) {
      this.nearPass.enabled = nearOn;
      const n = this.nearPass.uniforms;
      n.dof.value = this.dof; n.focus.value = this.focus;
      n.focusRange.value = c.focusRange.value; n.maxRadius.value = c.maxRadius.value;
    }
    if (this.farPass) {
      this.farPass.enabled = farOn && (!this._noCine || this._debugFar);
      const f = this.farPass.uniforms;
      f.dof.value = this.dof; f.focus.value = this.focus; f.farSoften.value = c.farSoften.value;
      f.maxRadius.value = c.maxRadius.value; f.lowQ.value = c.lowQ.value;
      f.farSoftenRadius.value = c.farSoftenRadius.value;
    }
    this.cine.enabled = !this._noCine && (nearOn || this.radial > 0.005 || farOn);

    // auto-degrade. The window starts at frame 120 (the first seconds are shader compilation and geometry
    // building, not a slow GPU) and the trigger is two-tier: a real stall gets relief in half a second, a
    // marginal frame gets the gentle ladder. Hitch frames (dt > 50 ms) are not evidence either way.
    const fps = engine.stats.fps, cpuMs = engine.stats.ms || 0;
    // the ladder keys on the CHAIN's own GPU cost (composer total minus the scene pass, both measured with
    // EXT_disjoint_timer_query_webgl2 on alternate frames). engine.stats.ms is CPU submission time and does
    // not contain the passes at all, so the old `gpuMs > 14` gate could never fire on this hardware — the
    // safety net was dead code. Where the extension is missing there is no honest GPU number, so the CPU
    // rule survives as a fallback at a threshold the frame can actually reach.
    // ...with a sanity guard. ANGLE's Metal backend reports TIME_ELAPSED including driver waits: measured on
    // this machine, a 60 fps frame comes back as "composer 37.5 ms", which is longer than the frame itself.
    // A number that exceeds the frame budget is not measuring the passes, so the CPU rule takes over rather
    // than degrading the shipping tier on a lie. On a driver that reports honestly, the chain gate applies.
    const budget = fps > 0 ? 1000 / fps : 16.7;
    this.timerTrusted = this.postMs > 0 && this.frameMs <= budget * 1.15;
    // On this machine the timers are never trusted (ANGLE/Metal reports 26-53 ms for a 60 fps frame), so the
    // shipping path was paying for two TIME_ELAPSED queries a frame to produce a number it then threw away.
    // After 300 consecutive untrusted frames the timers are shut down for the session and the chain costs zero.
    if (this.frameTimer) {
      if (this.timerTrusted) this._untrusted = 0;
      else if (engine.stats.frame > 150 && (this._untrusted = (this._untrusted || 0) + 1) > 300) this.stopTimers();
    }
    // ...and the fallback is the FRAME TIME, not cpuMs. engine.stats.ms is CPU submission time and provably
    // does not contain this chain (?postfx=off measured 6.4 ms against 6.0 ms with all 14 passes), so the old
    // `cpuMs > 10` rule could not fire under any of the four presets — the safety net was dead code. The
    // frame's own dt does contain every pass by construction.
    const heavy = this.timerTrusted ? this.postMs > 6 : rt > 1 / 50;
    // one line for the headless harness: the ladder's own inputs, once the timers have settled
    if (!this._loggedTiming && engine.stats.frame > 150 && (this.postMs > 0 || !this.frameTimer)) {
      this._loggedTiming = true;
      console.info(`[postfx] timing chain ${this.postMs.toFixed(2)} ms, composer ${this.frameMs.toFixed(2)} ms, ` +
        `scene ${this.sceneTimer ? this.sceneTimer.ms.toFixed(2) : '-'} ms, cpu ${cpuMs} ms, fps ${fps}, ` +
        `gate ${this.timerTrusted ? 'gpu' : 'frame dt (timer over budget)'}`);
    }
    // the engine's governor owns the quality tier when it is running (it calls setQuality itself, after the
    // cheaper knobs, and undoes a step that bought nothing); this ladder is the fallback for ?gov=0
    const governed = engine.governor && engine.governor.auto;
    if (!governed && fps > 0 && engine.stats.frame > 120 && rt < 0.05) {
      if (fps < 55 && heavy) { this.lowFrames++; this.highFrames = 0; } else { this.highFrames++; this.lowFrames = 0; }
      // `fps` is a 30-frame rolling mean, so it lags a recovery by half a second. The stall tier also wants
      // THIS frame to be slow, or one 40 ms hiccup keeps the mean under 45 long enough to drop a tier that
      // the machine did not need to lose.
      if (fps < 45 && rt > 0.020 && heavy) this.stallFrames = (this.stallFrames || 0) + 1; else this.stallFrames = 0;
      if (this.quality > 0 && (this.stallFrames > 30 || this.lowFrames > 150)) {
        this.setQuality(this.quality - 1); this.lowFrames = 0; this.stallFrames = 0;
      } else if (this.highFrames > 600 && this.quality < 2) { this.setQuality(this.quality + 1); this.highFrames = 0; }
    }
  },

  // the timers are a diagnostic, not a feature: once the driver has proved it cannot report honestly they go
  // away for the session, queries and all, and the ladder runs on the frame time.
  stopTimers() {
    if (this.frameTimer) this.frameTimer.dispose();
    if (this.sceneTimer) this.sceneTimer.dispose();
    this.frameTimer = this.sceneTimer = null;
    this.scenePass.timer = null;
    console.info('[postfx] gpu timers off (driver reported over the frame budget for 300 frames); ladder on frame dt');
  },

  // Switchable cost profile. Call it any time: postfx.applyProfile('full') restores the authored chain
  // without a reload, which is how a look regression gets A/B'd against the cheap version.
  //   lite — ship default: AO tiers at 0.75x their authored resolution and fewer taps, bloom pyramid at
  //          0.70x, the depth-of-field/cine pass parked unless a cutscene asks for it, auto-degrade on.
  //   full — exactly what the render owner authored. Use it to compare, or if a machine can afford it.
  //   off  — composer bypassed entirely (raw forward render). Diagnostic, not shippable: no AA, no grade.
  applyProfile(name = 'lite') {
    const p = (name === 'full' || name === 'off') ? name : 'lite';
    this.profileName = p;
    this.bypass = (p === 'off');
    const lite = (p === 'lite');

    // 1. AO: the two GTAO tiers and the big-obscurance buffer are the widest full-screen reads in the chain.
    this.aoScale = lite ? 0.75 : 1;
    if (this.gtao) {
      this.gtao.updateGtaoMaterial(lite
        ? { radius: 0.9, distanceExponent: 1.0, thickness: 0.5, scale: 2.4, samples: 10 }
        : { radius: 0.9, distanceExponent: 1.0, thickness: 0.5, scale: 2.4, samples: 16 });
      this.gtao.updatePdMaterial(lite
        ? { lumaPhi: 6, depthPhi: 1.5, normalPhi: 3, radius: 3, samples: 8 }
        : { lumaPhi: 6, depthPhi: 1.5, normalPhi: 3, radius: 3, samples: 12 });
      const s = this.composer && this.composer.renderTarget1;
      if (s) this.gtao.setSize(s.width, s.height);
    }
    // 2. Bloom: keep both tiers (the wide one is what makes a 6 m LED read as a light source) but run the
    //    pyramid smaller. The halo lives on mips 0-1, which survive the resolution drop.
    if (this.bloom && this.composer) {
      const rt = this.composer.renderTarget1;
      const k = lite ? 0.70 : 1;
      if (rt) this.bloom.setSize(Math.max(2, Math.floor(rt.width * BLOOM_SCALE * k)), Math.max(2, Math.floor(rt.height * BLOOM_SCALE * k)));
    }
    // 3. Depth of field: a 16-tap full-res gather. Plan A only needs it inside cutscenes, so it is parked
    //    here and setDOF() still turns it on when the director asks.
    this.dofAllowed = !lite;
    if (lite && !this._cineOwner) this.setDOF(false);

    if (this.smaa) this.smaa.enabled = !this.bypass && this.quality > 0;
    if (this.fxaa) this.fxaa.enabled = !this.bypass && this.quality === 0;
    console.info(`[postfx] profile -> ${p} (ao x${this.aoScale}, bloom x${lite ? 0.7 : 1}, dof ${this.dofAllowed ? 'on' : 'cutscene only'})`);
    return p;
  },

  // every stage degrades, not just GTAO: the 16-tap CineShader runs full res for all of combat and is the
  // single most expensive pass in the chain when DoF is up.
  setQuality(q) {
    this.quality = THREE.MathUtils.clamp(q, 0, 2);
    const c = this.cine.uniforms;
    c.lowQ.value = this.quality < 2 ? 1 : 0;
    // 26 px is a 52 px blur disc — a portrait lens, and the reason a 10 m sign's edge transition measured
    // 12-16 px and the crowd behind the fight was unreadable. 10 px reads as a lens at 1080p and still lets
    // an enemy, a bystander and a shop sign be read during a brawl, which is what the fight camera is for.
    c.maxRadius.value = this.quality < 2 ? 6 : 10;
    if (this.nearPass) this.nearPass.uniforms.maxRadius.value = c.maxRadius.value;
    if (this.farPass) this.farPass.uniforms.maxRadius.value = c.maxRadius.value;
    if (this.smaa) this.smaa.enabled = this.quality > 0;
    if (this.fxaa) this.fxaa.enabled = this.quality === 0;
    if (this.selective && this.quality === 0) this.setSelectiveBloom(false);   // the gate is a geometry pass
    if (!this.gtao) return;
    this.gtao.enabled = this.quality > 0;
    this.bigAO.enabled = this.bigBlur.enabled = this.quality > 0;
    const s = this.composer.renderTarget1;
    this.gtao.setSize(s.width, s.height);

    this.syncAO();
    console.info(`[postfx] quality -> ${this.quality} (gtao ${this.gtao.enabled ? this.gtao.width + 'x' + this.gtao.height : 'off'}, big ${this.bigAO.enabled}, aa ${this.quality > 0 ? 'smaa' : 'fxaa'})`);
  },

  // city interiors.js hands over its open-window boxes (the same uniform objects it updates): the haze composite skips
  // AO inside them. Returns false (and the caller retries) until the chain exists.
  setInteriorCuts(u) {
    if (!this.haze) return false;
    if (!u || !u.uCutA || u.uCutA.value.length !== 12) { console.warn('[postfx] interior cuts: expected 12 boxes'); return true; }
    const h = this.haze.uniforms;
    for (const k of ['uCutA', 'uCutB', 'uCutC', 'uCutS', 'uCutY', 'uCutN']) h[k] = u[k];
    return true;
  },
  setCamera(cam) {
    this.scenePass.scene = this.engine.scene; this.scenePass.camera = cam;
    if (this.maskPass) { this.maskPass.scene = this.engine.scene; this.maskPass.camera = cam; }
    {
      const n = this.normalPass.uniforms;
      n.tDepth.value = this.depthTex;
      n.projInv.value.copy(cam.projectionMatrixInverse);
      n.texel.value.set(1 / this.normalRT.width, 1 / this.normalRT.height);
    }
    this.gtao.scene = this.engine.scene; this.gtao.camera = cam;

    const h = this.haze.uniforms, c = this.cine.uniforms;
    h.cameraNear.value = c.cameraNear.value = cam.near;
    h.cameraFar.value = c.cameraFar.value = cam.far;
    h.projInv.value.copy(cam.projectionMatrixInverse);
    h.camWorld.value.copy(cam.matrixWorld);
    h.tDepth.value = c.tDepth.value = this.depthTex;
    h.exposure.value = this.hazeExposure();
    if (this.bigAO) {
      const b = this.bigAO.uniforms;
      b.tDepth.value = this.depthTex; b.tNormal.value = this.normalRT.texture;
      b.projInv.value.copy(cam.projectionMatrixInverse);
      b.proj.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
      b.texel.value.set(1 / this.bigRT.width, 1 / this.bigRT.height);
      this.bigBlur.uniforms.texel.value.copy(b.texel.value);
    }
    if (this.nearPass) {
      const n = this.nearPass.uniforms;
      n.tDepth.value = this.depthTex; n.cameraNear.value = cam.near; n.cameraFar.value = cam.far;
    }
    if (this.farPass) {
      const f = this.farPass.uniforms;
      f.tDepth.value = this.depthTex; f.cameraNear.value = cam.near; f.cameraFar.value = cam.far;
    }
  },

  setSize(w, h) {
    if (!this.composer) return;
    const pr = renderPR(this.engine);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const W = Math.max(2, Math.floor(w * pr)), H = Math.max(2, Math.floor(h * pr));
    this.sceneRT.setSize(W, H);
    this.sceneRT.samples = msaaFor(pr);        // MSAA lives on the scene target only; never lost on resize
    this.grade.uniforms.texel.value.set(1 / W, 1 / H);
    this.grade.uniforms.aspect.value = W / H;
    this.cine.uniforms.texel.value.set(1 / W, 1 / H);
    if (this.bigRT) {
      const bw = Math.max(2, Math.floor(W * BIG_SCALE)), bh = Math.max(2, Math.floor(H * BIG_SCALE));
      this.bigRT.setSize(bw, bh); this.bigRT2.setSize(bw, bh);
    }
    if (this.nearRT) {
      this.nearRT.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
      this.nearPass.uniforms.texel.value.set(1 / W, 1 / H);   // dilation is measured in FULL-res pixels
    }
    if (this.farRT) {
      this.farRT.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
      this.farPass.uniforms.texel.value.set(1 / W, 1 / H);    // so is the bokeh disc
    }
    if (this.maskRT) this.maskRT.setSize(Math.max(2, Math.floor(W * MASK_SCALE)), Math.max(2, Math.floor(H * MASK_SCALE)));
    if (this.fxaa) this.fxaa.uniforms.resolution.value.set(1 / W, 1 / H);
  },

  render(dt) {
    const engine = this.engine;
    if (!this.composer || !this.enabled || this.bypass) { engine.renderer.render(engine.scene, engine.camera); return; }
    engine.renderer.toneMappingExposure = 1;   // exposure is applied pre-bloom; the grade tone-maps at 1
    this.setCamera(engine.camera);
    this.syncAO();
    // alternate frames: one measures the whole composer, the next measures the scene pass inside it. Only
    // one TIME_ELAPSED query can be in flight per context, so they cannot both run on the same frame.
    const T = this.frameTimer;
    const sceneFrame = T ? (this._timerFrame = (this._timerFrame + 1) % 2) === 1 : false;
    this.scenePass.timer = sceneFrame ? this.sceneTimer : null;
    if (T && !sceneFrame) T.begin();
    this.composer.render(dt);
    if (T && !sceneFrame) T.end();
    if (T) {
      T.poll(); this.sceneTimer.poll();
      this.frameMs = T.ms;
      if (T.samples > 2 && this.sceneTimer.samples > 2) this.postMs = Math.max(0, T.ms - this.sceneTimer.ms);
    }
  },

  dispose() {
    if (this.frameTimer) this.frameTimer.dispose();
    if (this.sceneTimer) this.sceneTimer.dispose();
    this.frameTimer = this.sceneTimer = null;
    if (this.composer) this.composer.dispose();
    if (this.sceneRT) this.sceneRT.dispose();
    if (this.normalRT) this.normalRT.dispose();
    if (this.nearRT) this.nearRT.dispose();
    if (this.farRT) this.farRT.dispose();
    if (this.bigRT) this.bigRT.dispose();
    if (this.bigRT2) this.bigRT2.dispose();
    if (this.maskRT) this.maskRT.dispose();
  },

  selfTest() {
    const names = this.composer ? this.composer.passes.map((p) => (p.material && p.material.name) || p.constructor.name) : [];
    const problems = [];
    const pr = renderPR(this.engine);
    const idx = (p) => this.composer.passes.indexOf(p);
    if (!this.composer) problems.push('no composer');
    if (this.sceneRT && this.sceneRT.samples !== msaaFor(pr)) problems.push('MSAA lost');
    if (!this.gtao || this.gtao._renderGBuffer) problems.push('gtao g-buffer not shared');
    if (this.bigAO && idx(this.bigAO) > idx(this.haze)) problems.push('obscurance built after it is read');
    if (this.gtao && this.gtao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE !== 1) problems.push('gtao reconstructing normals from depth');
    if (this.normalRT && this.gtao && this.normalRT.width !== this.gtao.width) problems.push('normal buffer size != AO size');
    if (this.bloom && this.bloom.threshold > 1.15) problems.push('bloom threshold above display white');
    if (this.bloom && idx(this.cine) > idx(this.bloom)) problems.push('DoF after bloom (halo would be smeared)');
    if (this.nearPass && idx(this.nearPass) > idx(this.cine)) problems.push('near-CoC mask built after it is read');
    if (this.farPass && idx(this.farPass) > idx(this.cine)) problems.push('bokeh buffer built after it is read');
    const bf = this.bloom && this.bloom.compositeMaterial.uniforms.bloomFactors.value;
    if (bf && (bf[3] > 0 || bf[4] > 0)) problems.push('bloom pyramid top mips are a frame average');
    if (this.bloom && !this.bloom.compositeMaterial.uniforms.tDepth) problems.push('bloom composite not sky-killed');
    if (this.haze && this.haze.source !== this.sceneRT) problems.push('haze not reading the scene target directly');
    // non-monotonic weights mean a wider mip outranks a tighter one, i.e. the pyramid is a veil by construction
    if (bf) for (let i = 1; i < bf.length; i++) if (bf[i] > bf[i - 1]) problems.push(`bloom pyramid not monotonic at mip ${i}`);
    if (this.normalPass && idx(this.normalPass) > idx(this.gtao)) problems.push('normal pass after GTAO');
    if (this.maskPass && idx(this.maskPass) > idx(this.bloom)) problems.push('bloom gate built after it is read');
    if (!this.selective && this.maskRT) problems.push('bloom gate allocated but never rendered');
    if (this.selective && this.bloom.materialHighPassFilter.name !== MaskedHighPassShader.name) problems.push('bloom high-pass not masked');
    if (this.output) problems.push('OutputPass still in the chain (the grade folds the tone map + encode)');
    if (this.grade && !/aces|encodeSRGB/.test(this.grade.material.fragmentShader)) problems.push('grade does not tone map');
    // CA lives in the grade; AA has to clean up after it, not before
    if (this.smaa && this.grade && idx(this.smaa) < idx(this.grade)) problems.push('SMAA before the grade (CA would re-alias)');
    if (this.fxaa && this.grade && idx(this.fxaa) < idx(this.grade)) problems.push('FXAA before the grade');
    return {
      ok: problems.length === 0, passes: names, msaa: this.sceneRT && this.sceneRT.samples,
      size: this.sceneRT ? [this.sceneRT.width, this.sceneRT.height] : null,
      bloom: this.bloom ? { s: +this.bloom.strength.toFixed(2), r: +this.bloom.radius.toFixed(2), t: +this.bloom.threshold.toFixed(2),
        selective: !!this.selective, mask: this.maskRT ? [this.maskRT.width, this.maskRT.height] : null } : null,
      ao: this.gtao ? { on: this.gtao.enabled, w: this.gtao.width, i: +this.haze.uniforms.aoI1.value.toFixed(2),
        big: this.bigAO.enabled, bigI: +this.haze.uniforms.aoI2.value.toFixed(2),
        bigRT: this.bigRT ? [this.bigRT.width, this.bigRT.height] : null,
        normals: this.gtao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE === 1 ? 'gbuffer' : 'from-depth',
        normalRT: this.normalRT ? [this.normalRT.width, this.normalRT.height] : null } : null,
      haze: { d: +this.haze.uniforms.density.value.toFixed(5), sky: this.haze.uniforms.skyAmount.value,
        c: this.haze.uniforms.hazeColor.value.toArray().map((v) => +v.toFixed(3)) },
      grade: { lift: +this.grade.uniforms.lift.value.toFixed(3), contrast: +this.grade.uniforms.contrast.value.toFixed(2),
        sat: +this.grade.uniforms.saturation.value.toFixed(2), vignette: +this.grade.uniforms.vignette.value.toFixed(2),
        combat: +this.combatMix.toFixed(2), periphDesat: +this.grade.uniforms.periphDesat.value.toFixed(2),
        heat: +this.grade.uniforms.heat.value.toFixed(2) },
      dof: { maxRadius: this.cine.uniforms.maxRadius.value, softenRadius: this.cine.uniforms.farSoftenRadius.value,
        soften: +this.cine.uniforms.farSoften.value.toFixed(3), strength: +this.dofTarget.toFixed(2),
        range: +this.cine.uniforms.focusRange.value.toFixed(1) },
      // both numbers the ladder needs: the chain's own GPU cost and the frame's. engine.stats.ms is CPU only.
      perf: { postMs: +this.postMs.toFixed(2), frameMs: +this.frameMs.toFixed(2),
        sceneMs: this.sceneTimer ? +this.sceneTimer.ms.toFixed(2) : null,
        cpuMs: this.engine.stats.ms, timer: this.frameTimer ? 'gpu' : 'off (frame dt)',
        gate: this.timerTrusted ? 'postMs > 6' : 'dt > 20 ms (gpu timer over frame budget)' },
      exposure: +this.exposure.toFixed(2), night: +this.nightFactor.toFixed(2), rain: +this.rain.toFixed(2),
      quality: this.quality, problems,
    };
  },

  shotPresets: {
    // the cinematic lens with the focus pushed back: the near field (defect 9) is only visible when something
    // actually sits in front of the focal plane, which the default combat framing does not have
    postfx_dof: (ctx) => ({
      ...PRESETS.combat(ctx), fight: true,
      setup(engine) { const p = engine.get('postfx'); if (p) p.setDOF(true, { focus: 14, range: 10, strength: 0.85 }); },
    }),
    // tight on the LED boards: bloom falloff, sign edges (SMAA) and grain are all legible here
    postfx_signs: { pos: [-20, 2.2, 20], lookAt: [26, 16, -28], fov: 24, t: 'night' },
    // the hero at a portrait framing, at night: this is where a too-strong AO shows as blotches on the face
    // and where the night grade would show if it were crushing the character to a silhouette
    postfx_hero: (ctx) => ({ ...PRESETS.player_closeup(ctx), t: 'night' }),
    // long axis of the avenue: aerial haze separating the far blocks from the MAGNET facade
    postfx_depth: { pos: [-18, 3.2, 26], lookAt: [-120, 20, -90], fov: 40, t: 'night' },
    // the combat framing with the impact treatment frozen: hit flash, radial blur, heat vignette, DoF
    postfx_hit: (ctx) => ({
      ...PRESETS.combat(ctx), fight: true,
      setup(engine) { const p = engine.get('postfx'); if (p) p.hold = { flash: 0.10, radial: 0.7, heat: 1 }; },
    }),
  },
};

export default postfx;
