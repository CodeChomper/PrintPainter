import {
  Color,
  DoubleSide,
  LessEqualDepth,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type Camera,
  type Matrix4,
  type WebGLRenderer,
} from 'three';

/** Something to draw into the mask: shared geometry at its world transform. */
export interface OutlineSource {
  geometry: BufferGeometry;
  matrixWorld: Matrix4;
}

/** Brand green, in sRGB: the composite writes it to the screen as-is. */
const COLOR = new Vector3(0x8c / 255, 0xc6 / 255, 0x41 / 255);
/** Line width in CSS pixels. */
const WIDTH_PX = 2;
/** Opacity of the outline where the object is hidden behind other objects. */
const HIDDEN_ALPHA = 0.35;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// mask.g = the selected object's silhouette, mask.r = the part of it no other object hides.
// Only pixels outside the visible part are drawn, so the object's own colours stay exact.
const FRAGMENT = /* glsl */ `
uniform sampler2D mask;
uniform vec2 texel;
uniform float radius;
uniform vec3 color;
uniform float hiddenAlpha;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(mask, vUv).rg;
  float r = 0.0;
  float g = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.39269908;
    vec2 d = vec2(cos(a), sin(a)) * texel * radius;
    vec2 s1 = texture2D(mask, vUv + d).rg;
    vec2 s2 = texture2D(mask, vUv + d * 0.5).rg;
    r = max(r, max(s1.r, s2.r));
    g = max(g, max(s1.g, s2.g));
  }
  // Around the visible part: outside the silhouette, or on whatever hides the rest.
  float solid = max(max(r - c.g, 0.0), max(r - c.r, 0.0) * c.g);
  // Around the hidden part, faintly.
  float faint = max(g - c.g, 0.0) * hiddenAlpha;
  float alpha = clamp(max(solid, faint), 0.0, 1.0);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(color, alpha);
}`;

/**
 * Draws a line around the selected object, outside its pixels, so it shows the
 * selection without tinting the filament colours. Solid where the object is visible,
 * faint where other objects hide it.
 */
export class SelectionOutline {
  private target: WebGLRenderTarget | null = null;
  private maskScene = new Scene();
  private proxies: Mesh[] = [];
  private silhouette = new MeshBasicMaterial({ color: 0x00ff00, side: DoubleSide, depthTest: false, depthWrite: false });
  private depthOnly = new MeshBasicMaterial({ side: DoubleSide, colorWrite: false });
  private visiblePart = new MeshBasicMaterial({ color: 0xffff00, side: DoubleSide, depthFunc: LessEqualDepth, depthWrite: false });
  private composite = new ShaderMaterial({
    uniforms: {
      mask: { value: null },
      texel: { value: new Vector2() },
      radius: { value: WIDTH_PX },
      color: { value: COLOR },
      hiddenAlpha: { value: HIDDEN_ALPHA },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    const quad = new Mesh(new PlaneGeometry(2, 2), this.composite);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** Call right after the scene is rendered to the screen. */
  render(renderer: WebGLRenderer, camera: Camera, selected: OutlineSource, occluders: OutlineSource[]): void {
    const size = renderer.getDrawingBufferSize(new Vector2());
    if (!this.target || this.target.width !== size.x || this.target.height !== size.y) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(size.x, size.y, { samples: 4, depthBuffer: true });
    }
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    this.draw(renderer, camera, [selected], this.silhouette);
    this.draw(renderer, camera, occluders, this.depthOnly);
    this.draw(renderer, camera, [selected], this.visiblePart);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, clearAlpha);

    const u = this.composite.uniforms;
    u.mask!.value = this.target.texture;
    (u.texel!.value as Vector2).set(1 / size.x, 1 / size.y);
    u.radius!.value = WIDTH_PX * renderer.getPixelRatio();
    renderer.render(this.quadScene, this.quadCamera);

    this.maskScene.clear();
    renderer.autoClear = autoClear;
  }

  private draw(renderer: WebGLRenderer, camera: Camera, sources: OutlineSource[], material: MeshBasicMaterial): void {
    this.maskScene.clear();
    sources.forEach((s, i) => {
      let m = this.proxies[i];
      if (!m) {
        m = new Mesh();
        m.matrixAutoUpdate = false;
        m.matrixWorldAutoUpdate = false;
        m.frustumCulled = false;
        this.proxies[i] = m;
      }
      m.geometry = s.geometry; // shared with the viewport object, never disposed here
      m.material = material;
      m.matrixWorld.copy(s.matrixWorld);
      this.maskScene.add(m);
    });
    renderer.render(this.maskScene, camera);
  }

  dispose(): void {
    this.target?.dispose();
    this.silhouette.dispose();
    this.depthOnly.dispose();
    this.visiblePart.dispose();
    this.composite.dispose();
    (this.quadScene.children[0] as Mesh).geometry.dispose();
  }
}
