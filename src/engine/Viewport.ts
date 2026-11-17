import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  FloatType,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RGBAFormat,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  WireframeGeometry,
  type Intersection,
  type Material,
} from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PaintAtlas } from '@/core/atlas';
import type { IndexedMesh } from '@/core/mesh';
import { triPages, type Rect } from '@/core/paint';
import { DepthView } from './depth';
import { applyNavPreset, type NavPreset } from './navigation';
import { createDepthMaterial, createPaintMaterial, createPaletteUniform, createSlotTexture } from './paintMaterial';
import { SelectionOutline } from './selectionOutline';

const OPEN_EDGE_COLOR = '#ff4d4d';
const NON_MANIFOLD_COLOR = '#ffa53d';
/** Front-right-above, like the slicers' default view. */
const DEFAULT_VIEW = new Vector3(0.55, -1, 0.75);
/** Layer that only paintable meshes are on (used by the depth pass). */
const PAINT_LAYER = 1;

/** Paint data the viewport shows and the paint tool writes. Arrays are shared with the document. */
export interface PaintBinding {
  atlas: PaintAtlas;
  maps: Uint8Array[];
  pageOf: Uint8Array;
  textures: DataTexture[];
  bvh: MeshBVH;
}

interface ViewObject {
  mesh: Mesh;
  edges: Group;
  paint: PaintBinding | null;
  /** Fill preview: some paint triangles drawn over the surface (shares the paint mesh's positions). */
  highlight: Mesh | null;
  /** Export preview: the cut mesh in flat filament colours. */
  cut: { group: Group; slots: Uint8Array; colors: BufferAttribute } | null;
}

/** A mesh where every triangle has one slot (the export cut). Positions in source units. */
export interface SlotMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  slots: Uint8Array;
}

export interface PaintHit {
  id: string;
  /** World position (mm). */
  point: Vector3;
  /** False while the object's paint surface is still being prepared. */
  ready: boolean;
  /** Paint triangle hit (when ready). */
  tri: number;
}

/** Scene units are millimetres, Z up (like the slicers). The plate is centred on the origin. */
export class Viewport {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.5, 20000);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Imported objects go here. */
  readonly objects = new Group();

  private plate = new Group();
  private plateSize = { w: 256, d: 256 };
  private renderQueued = false;
  private disposeNav: () => void = () => {};
  private resizeObserver: ResizeObserver;
  private views = new Map<string, ViewObject>();
  private selectedId: string | null = null;
  private edgesVisible = true;
  private outline = new SelectionOutline();
  private raycaster = new Raycaster();
  private palette = createPaletteUniform();
  private depthMaterial = createDepthMaterial();
  private depthTarget: WebGLRenderTarget | null = null;
  private ringMaterials = new Map<string, LineBasicMaterial>();
  private ring: Group;

  /** Called when the user clicks (without dragging) on an object, or on empty space (null). */
  onPick: ((id: string | null) => void) | null = null;
  /** True while a paint stroke is in progress (set by the paint tool); 3D-mouse moves wait for it. */
  strokeActive: () => boolean = () => false;
  /** Called when a 3D-mouse move starts (true) and stops (false). */
  onNavMotion: ((moving: boolean) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.background = new Color('#141414');
    this.camera.up.set(0, 0, 1); // before OrbitControls reads it

    // Headlight follows the camera so painted surfaces are always lit the same way.
    this.scene.add(new HemisphereLight('#ffffff', '#444444', 1.6));
    const head = new DirectionalLight('#ffffff', 1.4);
    head.position.set(0.3, 0.4, 1);
    this.camera.add(head);
    this.scene.add(this.camera);

    this.ring = this.buildRing();
    this.scene.add(this.plate, this.objects, this.ring);
    this.buildPlate();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());

    this.installClickPicking();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.frame();
  }

  /** Largest paint page the GPU can hold. */
  get maxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  setNavPreset(preset: NavPreset): void {
    this.disposeNav();
    this.disposeNav = applyNavPreset(this.controls, preset);
  }

  // --- Objects -------------------------------------------------------------

  /**
   * Adds an object, drawn in the base colour until its paint surface is attached.
   * Geometry stays in source units and shares the mesh's arrays (no copy); position it
   * with setObjectTransform.
   */
  addObject(id: string, mesh: IndexedMesh, openEdges: Uint32Array, nonManifoldEdges: Uint32Array): void {
    this.removeObject(id);
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geom.setIndex(new BufferAttribute(mesh.indices, 1));
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    const obj = new Mesh(geom, createPaintMaterial(this.palette, null));
    obj.userData.id = id;
    obj.layers.enable(PAINT_LAYER);

    // Edge highlights use the cleaned mesh's vertices, which stay valid after the
    // paint surface (with its seam-split vertices) replaces the geometry.
    const edges = new Group();
    const edgePos = new BufferAttribute(mesh.positions, 3);
    const edgeLines = (pairs: Uint32Array, color: string) => {
      const g = new BufferGeometry();
      g.setAttribute('position', edgePos);
      g.setIndex(new BufferAttribute(pairs, 1));
      return new LineSegments(g, new LineBasicMaterial({ color }));
    };
    if (openEdges.length) edges.add(edgeLines(openEdges, OPEN_EDGE_COLOR));
    if (nonManifoldEdges.length) edges.add(edgeLines(nonManifoldEdges, NON_MANIFOLD_COLOR));
    edges.visible = this.edgesVisible;
    obj.add(edges);

    this.views.set(id, { mesh: obj, edges, paint: null, highlight: null, cut: null });
    this.objects.add(obj);
    this.requestRender();
  }

  /**
   * Swaps the object's geometry for its paint mesh and shows the slot maps. The maps
   * are shared, not copied: write them, then call uploadPaint with the changed rects.
   */
  setPaintSurface(id: string, atlas: PaintAtlas, maps: Uint8Array[]): void {
    const view = this.views.get(id);
    if (!view) return;
    this.disposePaint(view);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(atlas.positions, 3));
    g.setAttribute('paintUv', new BufferAttribute(atlas.uvs, 2));
    g.setIndex(new BufferAttribute(atlas.indices, 1));
    atlas.pages.forEach((p, i) => g.addGroup(p.triStart * 3, p.triCount * 3, i));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    // Indirect keeps our triangle order (pages, triSource) intact.
    const bvh = new MeshBVH(g, { indirect: true });
    g.boundsTree = bvh;
    const textures = atlas.pages.map((p, i) => createSlotTexture(maps[i]!, p.width, p.height));
    view.mesh.geometry.dispose();
    disposeMaterial(view.mesh.material);
    view.mesh.geometry = g;
    view.mesh.material = textures.map((t) => {
      const m = createPaintMaterial(this.palette, t);
      m.visible = !view.cut;
      return m;
    });
    view.mesh.raycast = acceleratedRaycast;
    view.paint = { atlas, maps, pageOf: triPages(atlas), textures, bvh };
    this.requestRender();
  }

  /** Ids of visible objects whose paint surface is ready. */
  paintableIds(): string[] {
    return [...this.views].filter(([, v]) => v.mesh.visible && v.paint).map(([id]) => id);
  }

  paintBinding(id: string): PaintBinding | null {
    return this.views.get(id)?.paint ?? null;
  }

  /** The object's mesh (for its transform and bounds). */
  objectMesh(id: string): Mesh | null {
    return this.views.get(id)?.mesh ?? null;
  }

  /** Uploads the changed rectangles of an object's slot maps (null = page unchanged; 'all' = everything). */
  uploadPaint(id: string, dirty: (Rect | null)[] | 'all'): void {
    const paint = this.views.get(id)?.paint;
    if (!paint) return;
    paint.textures.forEach((tex, i) => {
      const r = dirty === 'all' ? null : dirty[i];
      if (dirty !== 'all' && !r) return;
      const { width: W, height: H } = paint.atlas.pages[i]!;
      if (!r || (r.x1 - r.x0) * (r.y1 - r.y0) > (W * H) / 3) {
        tex.clearUpdateRanges(); // whole texture
      } else {
        // three.js counts update ranges in RGBA components, whatever the format.
        for (let y = r.y0; y < r.y1; y++) tex.addUpdateRange((y * W + r.x0) * 4, (r.x1 - r.x0) * 4);
      }
      tex.needsUpdate = true;
    });
    this.requestRender();
  }

  /** Palette colours for slots 1..n. Uniform index 0 ("unpainted") shows slot 1. */
  setPalette(colors: readonly string[]): void {
    const u = this.palette.value;
    for (let i = 0; i < u.length; i++) u[i]!.set(colors[Math.max(0, i - 1)] ?? colors[0] ?? '#c9ccd3');
    for (const v of this.views.values()) if (v.cut) this.colourCut(v.cut);
    this.requestRender();
  }

  /**
   * Shows the export cut instead of the painted surface (null goes back). The cut
   * mesh is a child of the object, so it follows its transform.
   */
  setCutPreview(id: string, cut: SlotMesh | null): void {
    const view = this.views.get(id);
    if (!view) return;
    if (view.cut) {
      view.mesh.remove(view.cut.group);
      view.cut.group.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments) {
          o.geometry.dispose();
          disposeMaterial(o.material);
        }
      });
      view.cut = null;
    }
    const mats = view.mesh.material;
    for (const m of Array.isArray(mats) ? mats : [mats]) m.visible = !cut;
    view.edges.visible = !cut && this.edgesVisible;
    if (cut) {
      const T = cut.slots.length;
      const pos = new Float32Array(T * 9);
      for (let t = 0; t < T; t++) {
        for (let k = 0; k < 3; k++) {
          const v = cut.indices[t * 3 + k]! * 3;
          pos[t * 9 + k * 3] = cut.positions[v]!;
          pos[t * 9 + k * 3 + 1] = cut.positions[v + 1]!;
          pos[t * 9 + k * 3 + 2] = cut.positions[v + 2]!;
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const colors = new BufferAttribute(new Float32Array(T * 9), 3);
      g.setAttribute('color', colors);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const group = new Group();
      group.add(new Mesh(g, new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 })));
      const wire = new LineSegments(
        new WireframeGeometry(g),
        new LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.18 }),
      );
      group.add(wire);
      view.mesh.add(group);
      view.cut = { group, slots: cut.slots, colors };
      this.colourCut(view.cut);
    }
    this.requestRender();
  }

  private colourCut(cut: NonNullable<ViewObject['cut']>): void {
    const u = this.palette.value;
    const a = cut.colors.array as Float32Array;
    for (let t = 0; t < cut.slots.length; t++) {
      const c = u[cut.slots[t]!] ?? u[1]!;
      for (let k = 0; k < 3; k++) {
        a[t * 9 + k * 3] = c.r;
        a[t * 9 + k * 3 + 1] = c.g;
        a[t * 9 + k * 3 + 2] = c.b;
      }
    }
    cut.colors.needsUpdate = true;
  }

  /** World = source × scale + offset (mm). */
  setObjectTransform(id: string, scale: number, offset: readonly [number, number, number]): void {
    const obj = this.views.get(id)?.mesh;
    if (!obj) return;
    obj.scale.setScalar(scale);
    obj.position.set(offset[0], offset[1], offset[2]);
    obj.updateMatrixWorld(true);
    this.requestRender();
  }

  setHidden(id: string, hidden: boolean): void {
    const obj = this.views.get(id)?.mesh;
    if (!obj) return;
    obj.visible = !hidden;
    this.requestRender();
  }

  removeObject(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.objects.remove(view.mesh);
    this.disposePaint(view);
    view.mesh.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        disposeMaterial(o.material);
      }
    });
    this.views.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    this.requestRender();
  }

  private disposePaint(view: ViewObject): void {
    if (view.highlight) {
      view.mesh.remove(view.highlight);
      // Detach the shared positions first, so disposing frees only the preview's index buffer.
      view.highlight.geometry.deleteAttribute('position');
      view.highlight.geometry.dispose();
      (view.highlight.material as Material).dispose();
      view.highlight = null;
    }
    if (!view.paint) return;
    view.paint.textures.forEach((t) => t.dispose());
    view.mesh.geometry.boundsTree = undefined;
    view.paint = null;
  }

  /** The selected object gets an outline drawn around it; its surface colours are untouched. */
  setSelected(id: string | null): void {
    this.selectedId = id;
    this.requestRender();
  }

  private drawSelectionOutline(): void {
    const sel = this.selectedId ? this.views.get(this.selectedId) : undefined;
    if (!sel?.mesh.visible) return;
    // While the export cut is shown, outline the cut mesh (the painted one is hidden).
    const shown = (v: ViewObject): Mesh => (v.cut ? (v.cut.group.children[0] as Mesh) : v.mesh);
    const visible = [...this.views.values()].filter((v) => v.mesh.visible).map(shown);
    this.outline.render(this.renderer, this.camera, shown(sel), visible);
  }

  setEdgeHighlightsVisible(visible: boolean): void {
    this.edgesVisible = visible;
    for (const v of this.views.values()) v.edges.visible = visible && !v.cut;
    this.requestRender();
  }

  // --- Picking and painting support -------------------------------------------

  private visibleMeshes(): Mesh[] {
    return [...this.views.values()].filter((v) => v.mesh.visible).map((v) => v.mesh);
  }

  private castFrom(clientX: number, clientY: number, meshes: Mesh[]): Intersection | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = true;
    const hits = this.raycaster.intersectObjects(meshes, false);
    // firstHitOnly gives one hit per mesh; the nearest overall comes first after sorting.
    return hits.sort((a, b) => a.distance - b.distance)[0];
  }

  /** The point on the visible objects at the centre of the view, or null. */
  centreHit(): Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.castFrom(r.left + r.width / 2, r.top + r.height / 2, this.visibleMeshes())?.point.clone() ?? null;
  }

  /** Returns the id of the visible object under the given client coordinates, or null. */
  pick(clientX: number, clientY: number): string | null {
    const hit = this.castFrom(clientX, clientY, this.visibleMeshes());
    return (hit?.object.userData.id as string | undefined) ?? null;
  }

  /**
   * The surface point under the cursor for painting. Objects still being prepared are
   * only tested when `includePending` (they have no BVH yet, so that is slow on big meshes).
   */
  paintHit(clientX: number, clientY: number, includePending = false): PaintHit | null {
    const meshes = [...this.views.values()]
      .filter((v) => v.mesh.visible && (v.paint || includePending))
      .map((v) => v.mesh);
    const hit = this.castFrom(clientX, clientY, meshes);
    if (!hit) return null;
    const id = hit.object.userData.id as string;
    return { id, point: hit.point.clone(), ready: !!this.views.get(id)?.paint, tri: hit.faceIndex ?? -1 };
  }

  /**
   * Shows some paint triangles of one object tinted (the fill preview), or hides the
   * preview (id null). Only one object shows a preview at a time.
   */
  setHighlight(id: string | null, tris: ArrayLike<number> | null = null, color = '#ffffff'): void {
    for (const [vid, v] of this.views) {
      if (v.highlight && (vid !== id || !tris)) v.highlight.visible = false;
    }
    const view = id ? this.views.get(id) : undefined;
    if (!view?.paint || !tris) {
      this.requestRender();
      return;
    }
    let h = view.highlight;
    if (!h) {
      const src = view.mesh.geometry;
      const g = new BufferGeometry();
      g.setAttribute('position', src.getAttribute('position'));
      // Sized for every triangle once; each preview fills the front and sets the draw range.
      g.setIndex(new BufferAttribute(new Uint32Array(src.index!.count), 1));
      const m = new MeshBasicMaterial({
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      h = new Mesh(g, m);
      h.raycast = () => {};
      h.renderOrder = 10;
      view.mesh.add(h);
      view.highlight = h;
    }
    const I = view.paint.atlas.indices;
    const index = h.geometry.index!;
    const out = index.array as Uint32Array;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i]!;
      out[i * 3] = I[t * 3]!;
      out[i * 3 + 1] = I[t * 3 + 1]!;
      out[i * 3 + 2] = I[t * 3 + 2]!;
    }
    index.clearUpdateRanges();
    index.addUpdateRange(0, tris.length * 3);
    index.needsUpdate = true;
    h.geometry.setDrawRange(0, tris.length * 3);
    (h.material as MeshBasicMaterial).color.set(color);
    h.visible = true;
    this.requestRender();
  }

  /** Projects a world point to client coordinates (for screen-space tools). */
  toClient(world: Vector3): { x: number; y: number; inFront: boolean } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = world.clone().project(this.camera);
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (0.5 - v.y * 0.5) * r.height, inFront: v.z < 1 };
  }

  /** Renders the view-space depth of the visible objects and reads it back (once per stroke). */
  captureDepth(): DepthView {
    const w = Math.max(1, Math.round(this.host.clientWidth));
    const h = Math.max(1, Math.round(this.host.clientHeight));
    if (!this.depthTarget || this.depthTarget.width !== w || this.depthTarget.height !== h) {
      this.depthTarget?.dispose();
      this.depthTarget = new WebGLRenderTarget(w, h, { type: FloatType, format: RGBAFormat, depthBuffer: true });
    }
    const bg = this.scene.background;
    const clear = this.renderer.getClearColor(new Color());
    const clearAlpha = this.renderer.getClearAlpha();
    const ringVisible = this.ring.visible;
    this.ring.visible = false;
    this.scene.background = null;
    this.scene.overrideMaterial = this.depthMaterial;
    this.camera.layers.set(PAINT_LAYER);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.depthTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, clearAlpha);
    this.camera.layers.set(0);
    this.scene.overrideMaterial = null;
    this.scene.background = bg;
    this.ring.visible = ringVisible;

    const rgba = new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.depthTarget, 0, 0, w, h, rgba);
    const depth = new Float32Array(w * h);
    for (let i = 0; i < depth.length; i++) depth[i] = rgba[i * 4]!;
    this.camera.updateMatrixWorld();
    return new DepthView(depth, w, h, this.camera.matrixWorldInverse, this.camera.projectionMatrix, this.camera.fov);
  }

  /** World size (mm) of one CSS pixel at a world point. */
  pixelSizeAt(point: Vector3): number {
    const d = point.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
    return (2 * d * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.host.clientHeight);
  }

  /** Shows the brush outline at a surface point, facing along the brush axis. */
  showBrushRing(point: Vector3, radiusMm: number, color: string): void {
    const dir = point.clone().sub(this.camera.position).normalize();
    this.ring.position.copy(point);
    this.ring.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir));
    this.ring.scale.setScalar(radiusMm);
    (this.ring.children[1] as LineLoop).material = this.ringMaterial(color);
    this.ring.visible = true;
    this.requestRender();
  }

  hideBrushRing(): void {
    if (!this.ring.visible) return;
    this.ring.visible = false;
    this.requestRender();
  }

  private ringMaterial(color: string): LineBasicMaterial {
    let m = this.ringMaterials.get(color);
    if (!m) {
      m = new LineBasicMaterial({ color, depthTest: false, transparent: true });
      this.ringMaterials.set(color, m);
    }
    return m;
  }

  private buildRing(): Group {
    const pts: number[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(Math.cos(a), Math.sin(a), 0);
    }
    const geom = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3));
    // A dark outline just outside a coloured ring, both drawn over everything.
    const outline = new LineLoop(geom, new LineBasicMaterial({ color: '#000000', depthTest: false, transparent: true, opacity: 0.6 }));
    outline.scale.setScalar(1.04);
    outline.renderOrder = 999;
    const ring = new LineLoop(geom, this.ringMaterial('#ffffff'));
    ring.renderOrder = 1000;
    const g = new Group().add(outline, ring);
    g.visible = false;
    return g;
  }

  private installClickPicking(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    el.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved < 4 && quick) this.onPick?.(this.pick(e.clientX, e.clientY));
    });
  }

  setPlateSize(w: number, d: number): void {
    this.plateSize = { w, d };
    this.buildPlate();
    this.requestRender();
  }

  /**
   * Fits the camera to the given box, or to the visible objects, or to the plate if empty.
   * `from` is the direction the camera looks from (default: front-right-above).
   */
  frame(box?: Box3, from: Vector3 = DEFAULT_VIEW): void {
    const target = box ?? new Box3();
    if (!box) for (const m of this.visibleMeshes()) target.expandByObject(m);
    if (target.isEmpty()) {
      const { w, d } = this.plateSize;
      target.set(new Vector3(-w / 2, -d / 2, 0), new Vector3(w / 2, d / 2, 20));
    }
    const sphere = target.getBoundingSphere(new Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = sphere.radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    const dir = from.clone().normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.1, dist / 1000);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Frames the visible objects from the top, front (-Y, as in the slicers) or right. */
  viewFrom(side: 'top' | 'front' | 'right'): void {
    // Straight down would leave "up" undefined; a hair off keeps the front at the bottom.
    const dir = side === 'top' ? new Vector3(0, -1e-3, 1) : side === 'front' ? new Vector3(0, -1, 0) : new Vector3(1, 0, 0);
    this.frame(undefined, dir);
  }

  /** Turns the view about the vertical axis through the orbit centre. */
  turnView(angle: number): void {
    const t = this.controls.target;
    this.camera.position.sub(t).applyAxisAngle(new Vector3(0, 0, 1), angle).add(t);
    this.controls.update();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderer.render(this.scene, this.camera);
      this.drawSelectionOutline();
    });
  }

  dispose(): void {
    this.disposeNav();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const v of this.views.values()) this.disposePaint(v);
    this.depthTarget?.dispose();
    this.depthMaterial.dispose();
    this.ringMaterials.forEach((m) => m.dispose());
    this.outline.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments || o instanceof LineLoop) {
        o.geometry.dispose();
        disposeMaterial(o.material);
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private buildPlate(): void {
    this.plate.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial | LineBasicMaterial).dispose();
      }
    });
    this.plate.clear();
    const { w, d } = this.plateSize;

    const surface = new Mesh(new PlaneGeometry(w, d), new MeshBasicMaterial({ color: '#1c1c1c' }));
    surface.position.z = -0.01;
    surface.renderOrder = -1;

    // Grid lines every 10 mm from the front-left corner (slicer origin), brighter every 50 mm.
    const minor: number[] = [];
    const major: number[] = [];
    const x0 = -w / 2, y0 = -d / 2;
    for (let x = 10; x < w; x += 10) (x % 50 ? minor : major).push(x0 + x, y0, 0, x0 + x, -y0, 0);
    for (let y = 10; y < d; y += 10) (y % 50 ? minor : major).push(x0, y0 + y, 0, -x0, y0 + y, 0);
    const lines = (pts: number[], color: string) =>
      new LineSegments(
        new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pts, 3)),
        new LineBasicMaterial({ color }),
      );
    const grid = new Group().add(lines(minor, '#2a2a2a'), lines(major, '#3c3c3c'));

    const outline = new LineSegments(
      new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute(
          [-w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, d / 2, 0,
            w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, -d / 2, 0],
          3,
        ),
      ),
      new LineBasicMaterial({ color: '#5e772c' }),
    );

    // Small X (red) / Y (green) axis marks at the front-left corner.
    const axes = new LineSegments(
      new BufferGeometry()
        .setAttribute('position', new Float32BufferAttribute(
          [-w / 2, -d / 2, 0.02, -w / 2 + 20, -d / 2, 0.02, -w / 2, -d / 2, 0.02, -w / 2, -d / 2 + 20, 0.02], 3))
        .setAttribute('color', new Float32BufferAttribute([0.9, 0.25, 0.25, 0.9, 0.25, 0.25, 0.3, 0.75, 0.3, 0.3, 0.75, 0.3], 3)),
      new LineBasicMaterial({ vertexColors: true }),
    );

    this.plate.add(surface, grid, outline, axes);
  }
}

function disposeMaterial(m: Material | Material[]): void {
  (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
}
