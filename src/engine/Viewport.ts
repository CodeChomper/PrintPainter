import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { IndexedMesh } from '@/core/mesh';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyNavPreset, type NavPreset } from './navigation';

const OBJECT_COLOR = new Color('#c9ccd3');
const SELECTED_COLOR = new Color('#e9c46a');
const OPEN_EDGE_COLOR = '#ff4d4d';
const NON_MANIFOLD_COLOR = '#ffa53d';

/** Scene units are millimetres, Z up (like the slicers). The plate is centred on the origin. */
export class Viewport {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.5, 20000);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  /** Imported objects go here (M1 importers). */
  readonly objects = new Group();

  private plate = new Group();
  private plateSize = { w: 256, d: 256 };
  private renderQueued = false;
  private disposeNav: () => void = () => {};
  private resizeObserver: ResizeObserver;
  private meshes = new Map<string, Mesh>();
  private selectedId: string | null = null;
  private edgesVisible = true;
  private raycaster = new Raycaster();

  /** Called when the user clicks (without dragging) on an object, or on empty space (null). */
  onPick: ((id: string | null) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.background = new Color('#24262c');
    this.camera.up.set(0, 0, 1); // before OrbitControls reads it

    // Headlight follows the camera so painted surfaces are always lit the same way.
    this.scene.add(new HemisphereLight('#ffffff', '#444a55', 1.6));
    const head = new DirectionalLight('#ffffff', 1.4);
    head.position.set(0.3, 0.4, 1);
    this.camera.add(head);
    this.scene.add(this.camera);

    this.scene.add(this.plate, this.objects);
    this.buildPlate();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());

    this.installClickPicking();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.frame();
  }

  setNavPreset(preset: NavPreset): void {
    this.disposeNav();
    this.disposeNav = applyNavPreset(this.controls, preset);
  }

  // --- Objects -------------------------------------------------------------

  /**
   * Adds an object. Geometry stays in source units and shares the mesh's arrays
   * (no copy); position it with setObjectTransform.
   */
  addObject(id: string, mesh: IndexedMesh, openEdges: Uint32Array, nonManifoldEdges: Uint32Array): void {
    this.removeObject(id);
    const geom = new BufferGeometry();
    const pos = new BufferAttribute(mesh.positions, 3);
    geom.setAttribute('position', pos);
    geom.setIndex(new BufferAttribute(mesh.indices, 1));
    geom.computeBoundingSphere();
    const mat = new MeshStandardMaterial({
      color: OBJECT_COLOR,
      flatShading: true,
      roughness: 0.8,
      metalness: 0,
      side: DoubleSide, // open meshes stay visible from inside
      polygonOffset: true, // keeps edge highlights on top of their faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const obj = new Mesh(geom, mat);
    obj.userData.id = id;

    const edgeLines = (pairs: Uint32Array, color: string) => {
      const g = new BufferGeometry();
      g.setAttribute('position', pos);
      g.setIndex(new BufferAttribute(pairs, 1));
      const l = new LineSegments(g, new LineBasicMaterial({ color }));
      l.userData.edgeHighlight = true;
      l.visible = this.edgesVisible;
      return l;
    };
    if (openEdges.length) obj.add(edgeLines(openEdges, OPEN_EDGE_COLOR));
    if (nonManifoldEdges.length) obj.add(edgeLines(nonManifoldEdges, NON_MANIFOLD_COLOR));

    this.meshes.set(id, obj);
    this.objects.add(obj);
    this.requestRender();
  }

  /** World = source × scale + offset (mm). */
  setObjectTransform(id: string, scale: number, offset: readonly [number, number, number]): void {
    const obj = this.meshes.get(id);
    if (!obj) return;
    obj.scale.setScalar(scale);
    obj.position.set(offset[0], offset[1], offset[2]);
    obj.updateMatrixWorld(true);
    this.requestRender();
  }

  removeObject(id: string): void {
    const obj = this.meshes.get(id);
    if (!obj) return;
    this.objects.remove(obj);
    obj.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        (o.material as MeshStandardMaterial | LineBasicMaterial).dispose();
      }
    });
    this.meshes.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    this.requestRender();
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const [oid, obj] of this.meshes) {
      (obj.material as MeshStandardMaterial).color.copy(oid === id ? SELECTED_COLOR : OBJECT_COLOR);
    }
    this.requestRender();
  }

  setEdgeHighlightsVisible(visible: boolean): void {
    this.edgesVisible = visible;
    this.objects.traverse((o) => {
      if (o.userData.edgeHighlight) o.visible = visible;
    });
    this.requestRender();
  }

  /** Returns the id of the object under the given client coordinates, or null. */
  pick(clientX: number, clientY: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects([...this.meshes.values()], false)[0];
    return (hit?.object.userData.id as string | undefined) ?? null;
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

  /** Fits the camera to the given box, or to the objects, or to the plate if empty. */
  frame(box?: Box3): void {
    const target = box ?? new Box3().setFromObject(this.objects);
    if (target.isEmpty()) {
      const { w, d } = this.plateSize;
      target.set(new Vector3(-w / 2, -d / 2, 0), new Vector3(w / 2, d / 2, 20));
    }
    const sphere = target.getBoundingSphere(new Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = sphere.radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2);
    // Front-right-above, like the slicers' default view.
    const dir = new Vector3(0.55, -1, 0.75).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.1, dist / 1000);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  dispose(): void {
    this.disposeNav();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
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

    const surface = new Mesh(new PlaneGeometry(w, d), new MeshBasicMaterial({ color: '#30333b' }));
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
    const grid = new Group().add(lines(minor, '#3a3e47'), lines(major, '#4d525e'));

    const outline = new LineSegments(
      new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute(
          [-w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, d / 2, 0,
            w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, -d / 2, 0],
          3,
        ),
      ),
      new LineBasicMaterial({ color: '#7a8190' }),
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
