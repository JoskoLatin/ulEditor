/**
 * The 3D model viewer.
 *
 * Viewing only. A modeller is not a thing you add to a document editor as a
 * feature — but opening a `.stl` somebody sent you, turning it around and seeing
 * how many triangles it has is a thing a general editor should do, and today it
 * means finding a separate program.
 *
 * three.js does the drawing. It is the only mature WebGL renderer with loaders
 * for the formats people actually exchange, it is MIT, and it costs nothing
 * until a model is opened: the whole package is behind a dynamic import, so a
 * session that never opens a model never downloads it.
 *
 * The formats are the interchange ones — STL and 3MF from printing, OBJ and PLY
 * from scanning, glTF and GLB from everywhere else. Not FBX, not the native
 * files of Blender, SolidWorks or Fusion: those are either undocumented or a
 * whole application's worth of semantics, and a viewer that opens them
 * half-correctly is worse than one that says it does not.
 */

import {
  Emitter,
  plainPayload,
  type ClipboardPayload,
  type DocumentHandle,
  type EditorHost,
  type EditorInstance,
  type EditorProvider,
  type FindResult,
  type SaveResult,
} from '@uleditor/plugin-sdk';
import { t } from '@uleditor/i18n';

import { loadModel, type LoadedModel } from './load.js';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

class ModelViewer implements EditorInstance {
  #root: HTMLElement | null = null;
  #stage: HTMLElement | null = null;
  #model: LoadedModel | null = null;

  #wireframe = false;
  #statusEmitter = new Emitter<string>();
  #dirtyEmitter = new Emitter<boolean>();
  readonly onStatusChange = this.#statusEmitter.event;
  readonly onDirtyChange = this.#dirtyEmitter.event;

  constructor(
    private readonly doc: DocumentHandle,
    private readonly bytes: Uint8Array,
  ) {}

  async mount(container: HTMLElement): Promise<void> {
    const root = document.createElement('div');
    root.className = 'ul-3d';

    const stage = document.createElement('div');
    stage.className = 'ul-3d-stage';
    /* Focusable so the arrow keys reach the controls rather than scrolling the
       shell behind them. */
    stage.tabIndex = 0;

    const loading = document.createElement('div');
    loading.className = 'ul-3d-note';
    loading.textContent = t('Reading the model…');
    stage.appendChild(loading);

    root.append(this.#buildToolbar(), stage);
    container.appendChild(root);
    this.#root = root;
    this.#stage = stage;

    this.#statusEmitter.fire(t('Reading the model…'));

    try {
      this.#model = await loadModel(stage, this.bytes, extensionOf(this.doc.name));
    } catch (err) {
      loading.remove();
      const error = document.createElement('div');
      error.className = 'ul-3d-error';
      error.textContent = t('{name} could not be read: {reason}', {
        name: this.doc.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      stage.appendChild(error);
      this.#statusEmitter.fire(t('Could not be read'));
      return;
    }

    loading.remove();
    this.#syncButtons();

    const { triangles, vertices, size } = this.#model.stats;
    this.#statusEmitter.fire(
      t('{triangles} triangles · {vertices} vertices · {x} × {y} × {z}', {
        triangles: triangles.toLocaleString(),
        vertices: vertices.toLocaleString(),
        x: size.x.toFixed(1),
        y: size.y.toFixed(1),
        z: size.z.toFixed(1),
      }),
    );
  }

  #buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ul-3d-toolbar';

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'ul-3d-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    const reset = button(t('Fit'), t('Frame the whole model again'), () => this.#model?.frame());
    const wireframe = button(t('Wireframe'), t('Show the mesh rather than the surface'), () => {
      this.#wireframe = !this.#wireframe;
      this.#model?.setWireframe(this.#wireframe);
      this.#syncButtons();
    });

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = t('Drag to turn · right-drag to move · wheel to zoom');

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const info = document.createElement('span');
    info.className = 'readout';
    info.textContent = humanBytes(this.doc.stat.size);

    bar.append(reset, wireframe, hint, spacer, info);

    this.#syncButtons = () => {
      wireframe.dataset.active = String(this.#wireframe);
      reset.disabled = !this.#model;
      wireframe.disabled = !this.#model;
    };
    this.#syncButtons();
    return bar;
  }

  #syncButtons: () => void = () => {};

  unmount(): void {
    /* WebGL contexts are a limited resource — a browser drops the oldest once
       there are too many, and a tab that closes models without releasing them
       kills the ones still open. */
    this.#model?.dispose();
    this.#model = null;
    this.#root?.remove();
    this.#root = null;
  }

  isDirty(): boolean {
    return false;
  }

  async save(): Promise<SaveResult> {
    throw new Error(t('3D models open read-only — ulEditor does not edit them.'));
  }

  undo(): void {}
  redo(): void {}
  canUndo(): boolean {
    return false;
  }
  canRedo(): boolean {
    return false;
  }

  /** A mesh has no text. Reporting nothing is the honest answer; the shell
   *  already shows "no results" rather than pretending the search failed. */
  async find(): Promise<FindResult[]> {
    return [];
  }

  async copySelection(): Promise<ClipboardPayload | null> {
    return plainPayload(this.doc.name, { editorId: 'org.uleditor.model', uri: this.doc.uri });
  }

  async paste(): Promise<boolean> {
    return false;
  }

  focus(): void {
    this.#stage?.focus();
  }
}

export const modelEditorProvider: EditorProvider = {
  id: 'org.uleditor.model',
  displayName: '3D model viewer',
  matches: {
    extensions: ['stl', 'obj', 'ply', 'gltf', 'glb', '3mf', 'model'],
    mimeTypes: ['model/stl', 'model/obj', 'model/gltf+json', 'model/gltf-binary'],
  },
  capabilities: ['view'],
  priority: 30,

  async createInstance(_host: EditorHost, doc: DocumentHandle): Promise<EditorInstance> {
    return new ModelViewer(doc, await doc.bytes());
  },
};

export default modelEditorProvider;
