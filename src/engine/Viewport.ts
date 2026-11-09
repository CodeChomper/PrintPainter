import {
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyNavPreset, type NavPreset } from './navigation';

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.frame();
  }

  setNavPreset(preset: NavPreset): void {
    this.disposeNav();
    this.disposeNav = applyNavPreset(this.controls, preset);
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
