/**
 * Reading a model and putting it on screen.
 *
 * Everything three.js is kept behind this module, and this module is only
 * reached from `index.ts` through a dynamic import, so opening a text file never
 * downloads a renderer.
 *
 * The scene is deliberately plain: two lights, a grid, an orbit camera. A viewer
 * that tries to look impressive — shadows, tone mapping, an environment map —
 * shows you its own opinion of the model rather than the model. The one place
 * that judgement is unavoidable is a mesh with no material of its own (STL and
 * PLY carry none), and there the choice is a matte grey, because it shows form
 * without suggesting a colour the file does not have.
 */

import {
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

export interface ModelStats {
  triangles: number;
  vertices: number;
  size: Vector3;
}

export interface LoadedModel {
  stats: ModelStats;
  /** Frames the whole model again, after the view has been turned around. */
  frame(): void;
  setWireframe(on: boolean): void;
  dispose(): void;
}

/** Matte grey for geometry that carries no material — STL and PLY never do. */
const PLAIN = () => new MeshStandardMaterial({ color: 0x9aa7ad, roughness: 0.85, metalness: 0.05 });

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A fresh, correctly aligned copy of the bytes. Loaders read an ArrayBuffer,
 *  and a view onto a larger buffer would hand them the neighbouring file. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function parse(bytes: Uint8Array, extension: string): Promise<Object3D> {
  switch (extension) {
    case 'stl': {
      const geometry = new STLLoader().parse(bufferOf(bytes));
      return Promise.resolve(new Mesh(geometry, PLAIN()));
    }
    case 'ply': {
      const geometry = new PLYLoader().parse(bufferOf(bytes));
      geometry.computeVertexNormals();
      /* A point cloud has no faces, and a Mesh over it draws nothing at all —
         scans arrive this way often enough that a blank window would read as a
         broken viewer. */
      const hasFaces = geometry.index !== null && geometry.index.count > 0;
      return Promise.resolve(
        hasFaces
          ? new Mesh(geometry, PLAIN())
          : new Points(geometry, new PointsMaterial({ color: 0x9aa7ad, size: 0.01 })),
      );
    }
    case 'obj':
      return Promise.resolve(new OBJLoader().parse(decode(bytes)));
    case '3mf':
      return Promise.resolve(new ThreeMFLoader().parse(bufferOf(bytes)) as unknown as Object3D);
    case 'gltf':
    case 'glb':
      return new Promise((resolve, reject) => {
        /* The empty path is deliberate: a glTF may reference textures beside it,
           and resolving those means reading files the document handle never
           granted. Anything external simply does not load — a GLB, which carries
           everything inside it, is unaffected. */
        new GLTFLoader().parse(
          extension === 'glb' ? bufferOf(bytes) : decode(bytes),
          '',
          (result) => resolve(result.scene),
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      });
    default:
      return Promise.reject(new Error(`.${extension}`));
  }
}

function measure(object: Object3D): { triangles: number; vertices: number } {
  let triangles = 0;
  let vertices = 0;
  object.traverse((child) => {
    const geometry = (child as Mesh).geometry as BufferGeometry | undefined;
    const position = geometry?.getAttribute?.('position');
    if (!position) return;
    vertices += position.count;
    triangles += geometry?.index ? geometry.index.count / 3 : position.count / 3;
  });
  return { triangles: Math.round(triangles), vertices };
}

export async function loadModel(
  container: HTMLElement,
  bytes: Uint8Array,
  extension: string,
): Promise<LoadedModel> {
  const object = await parse(bytes, extension);

  const scene = new Scene();
  const root = new Group();
  scene.add(root);
  root.add(object);

  /*
   * Centred on the origin and framed by its own size, because files arrive in
   * every unit and every position — a printed part in millimetres sits a
   * thousand units from a scan in metres. Moving the model to the origin and
   * placing the camera from the bounding box makes both open the same way.
   */
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  object.position.sub(centre);

  const extent = Math.max(size.x, size.y, size.z) || 1;

  const grid = new GridHelper(extent * 4, 20, 0xb6c5cb, 0xdfe7ea);
  grid.position.y = -size.y / 2;
  scene.add(grid);

  scene.add(new AmbientLight(0xffffff, 1.6));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 2, 1.5);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.8);
  fill.position.set(-1.5, -0.5, -1);
  scene.add(fill);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new Color(0x1a2226), 1);
  container.appendChild(renderer.domElement);

  const camera = new PerspectiveCamera(45, 1, extent / 1000, extent * 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const frame = () => {
    // 2.2 rather than 2: the model then sits inside the window with a margin,
    // instead of touching all four edges the moment it opens.
    const distance = extent * 2.2;
    camera.position.set(distance * 0.7, distance * 0.5, distance * 0.7);
    controls.target.set(0, 0, 0);
    controls.update();
  };
  frame();

  let running = true;
  const tick = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();

  const resize = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  resize.observe(container);

  const stats = { ...measure(object), size };

  return {
    stats,

    frame,

    setWireframe(on: boolean) {
      object.traverse((child) => {
        const material = (child as Mesh).material;
        for (const one of Array.isArray(material) ? material : [material]) {
          if (one && 'wireframe' in one) (one as MeshStandardMaterial).wireframe = on;
        }
      });
    },

    dispose() {
      running = false;
      resize.disconnect();
      controls.dispose();
      /*
       * Geometries and materials hold GPU memory that the garbage collector
       * cannot see, and the context itself is a limited resource — browsers keep
       * around sixteen and drop the oldest, so a viewer that leaks them closes
       * the models still open in other tabs.
       */
      scene.traverse((child) => {
        const mesh = child as Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material;
        for (const one of Array.isArray(material) ? material : [material]) one?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
