// ren-three: the three.js renderer for ren-core, a Host (ren-core/host) over a
// three.js scene graph.
//
// ren-core's portable primitives (View, Label, Edit, Action, …) render here too,
// through ren-canv (surface.js): placed in the scene itself they lie over the
// canvas; placed in a three.js object they are a panel in it. An
// application of primitives alone runs on ren-three as on ren-dom or
// ren-skia, and the two mix freely.
//
// A lowercase element is the three.js class of the same name, capitalized:
// `<mesh>` is a Mesh, `<sphereGeometry params={[1, 24, 16]}>` a
// SphereGeometry, `<meshPhongMaterial shininess={60}>` a MeshPhongMaterial.
// `<existing of={…}>` places an object made elsewhere. A host node is
// the three.js object itself (a `ref` receives it), with one record of ren-core's
// own under `__ren`. Geometries, materials and fog go into the parent's
// property of that name; `slot="…"` names any other. Properties set by
// name, with a dash for a path (`position-x`), and through `set`/`copy` for
// vectors, eulers, colors and quaternions (`position={[0, 1, 0]}`,
// `scale={2}`, `color="#f80"`).
//
// Rendering is on demand: a flush that changed the scene renders one frame,
// on the next animation frame. `$animate(fn)` in a component runs `fn` every
// frame while the component lives, and the loop renders each of those
// frames. Pointer events are raycast from the camera: `onClick`,
// `onPointerDown`, `onPointerMove`, `onPointerOver`, `onPointerOut`, … on
// any object, bubbling to its ancestors.
//
// three.js is injected, as CanvasKit is for ren-skia:
// `$three(THREE, options)` with `import * as THREE from 'three'`.
//
// Worker mode: three.js and the scene stay on the main thread, where the
// renderer is; the worker holds only the application and its components, as
// with ren-dom and ren-skia. The worker serves the view with
// `serve(view, { construct: CONSTRUCT })`, so constructor `params` travel
// with the elements, and `$animate` runs there on the worker's own frames,
// changing signals whose writes cross like any update. Pointer events cross
// with their canvas coordinates; refs in the worker are handles.

import { mount, $surface, $active, behaviorOf } from 'ren-core/host';
import { $owner, $cleanup, $deliver, $flush } from 'ren-core';
import { Item, Faces } from 'ren-canv';

export { loadLayout, loadShaper, remoteLayout } from 'ren-canv';
import { Surface } from './surface.js';

/** @typedef {import('ren-core/host').Host} Host */

/**
 * The three.js namespace (`import * as THREE from 'three'`): its classes by
 * name. Typed loosely, so ren-three needs no three.js declarations.
 * @typedef {Record<string, any>} Kit
 */

/**
 * What ren-three draws with: a THREE.WebGLRenderer, or anything with its
 * render/setSize shape (tests pass a stub).
 * @typedef {object} Drawer
 * @property {(scene: any, camera: any) => void} render
 * @property {(width: number, height: number, style?: boolean) => void} setSize
 * @property {((ratio: number) => void)=} setPixelRatio
 * @property {(() => void)=} dispose
 * @property {(() => void)=} forceContextLoss Loses the WebGL context now (a three.js WebGLRenderer has it).
 * @property {any=} domElement its canvas
 */

/**
 * @typedef {object} Options
 * @property {number=} width The canvas width in CSS pixels; by default the host element's, followed as it resizes (300 without one).
 * @property {number=} height The canvas height in CSS pixels; as width (150 without one).
 * @property {number=} scale The device pixel ratio (the window's by default).
 * @property {Drawer | ((canvas: any) => Drawer)=} renderer What draws: a WebGLRenderer made on the canvas by default (antialiased), or one given, or a function making it from the canvas.
 * @property {any=} camera The camera: a three.js camera, or `{ fov, near, far, position }` for a PerspectiveCamera (50°, 0.1, 1000, at [0, 0, 5] by default). A `<perspectiveCamera main>` in the view replaces it.
 * @property {(number | string)=} background The scene's background color.
 * @property {('frame' | false)=} schedule `frame` (default) renders on animation frames; false renders only when `frame()` is called (tests, a host that drives its own loop).
 * @property {(ArrayBuffer | Uint8Array)=} font The bytes of the typeface the primitives are measured and drawn with (needed once a primitive renders).
 * @property {(ArrayBuffer | Uint8Array)=} mono The bytes of a monospace typeface: text whose `fontFamily` names monospace is measured and drawn in it (in `font` without it).
 * @property {Record<string, ArrayBuffer | Uint8Array>=} families Typefaces by family name: text whose `fontFamily` names one (the first of its list given here, before a generic family) is measured and drawn in it.
 * @property {(ArrayBuffer | Uint8Array)[]=} fallback Typefaces for the characters a typeface lacks: each such character is measured and drawn in the first of them that has it.
 * @property {number=} pixel The world units of one pixel of a panel (0.01).
 * @property {import('ren-core/host').Tokens=} theme Theme overrides for the primitives.
 * @property {(boolean | 'demand')=} aria The accessibility mirror of the primitives, as ren-canv's.
 * @property {import('ren-core/host').Behavior=} behavior How the canvas behaves under the user's hands, as ren-canv's: as an application ('app', the default: loose text not selectable, Ctrl or Cmd+A and the I-beam only in an Edit or a `select: 'text'` element, the browser's context menu only in an Edit (not over the scene), no touch callout), as a page ('page'), or `like` one with switches of its own.
 * @property {import('ren-canv').LayoutPort=} layout Where the primitives are laid out: this thread by default, or the layout worker `remoteLayout(port)` reaches (ren-canv's).
 * @property {import('ren-canv/backend').Picture=} image Loads an Image source into something a 2D canvas draws (an HTMLImageElement by default).
 * @property {(string | null)=} cursor The CSS cursor over an object with a press handler (`onClick`, `onDblClick`, `onPointerDown`, `onPointerUp`) and no `cursor` of its own, or over a child: 'pointer' by default, null for none.
 */

/** Font families registered for the primitives, one per renderer. */
let families = 0;

/**
 * The props `element` reads at creation: the Host's `construct` (compiled
 * templates pass them too), and what a worker serving a ren-three view
 * passes as `serve`'s `construct`. `of` (`<existing>`) cannot cross
 * to a worker: an object made elsewhere belongs to the direct runtime.
 */
export const CONSTRUCT = new Set(['params', 'slot', 'of', 'dispose']);

/** Element props that are not three.js properties. */
const RESERVED = new Set([...CONSTRUCT, 'main', 'key', 'cursor']);

/** The handlers that make an object pressable: the `cursor` option shows over it. */
const PRESSES = ['click', 'dblclick', 'pointerdown', 'pointerup'];

/** Events that bubble through ancestors; over and out go to the objects the pointer enters and leaves. */
const HOVER = new Set(['pointerover', 'pointerout']);

/** ren-core's record on a host node: its place among its siblings, how it attaches, its handlers. */
class Slot {
  constructor() {
    /** @type {any} */ this.parent = null;
    /** @type {any} */ this.prev = null;
    /** @type {any} */ this.next = null;
    /** @type {any} */ this.first = null;
    /** @type {any} */ this.last = null;
    /** The parent property it is attached to, or null (added as a child object). @type {string | null} */
    this.property = null;
    /** The parent property's value before this node attached. @type {any} */
    this.previous = undefined;
    /** Event handlers by ren-core event name, or null. @type {Record<string, (event: any) => void> | null} */
    this.handlers = null;
    /** False (`dispose={null}`) skips this node's own dispose() when it is removed: on a geometry, material or texture element, that resource is kept; its children's still go. */
    this.dispose = true;
    /** True for a text or marker node: nothing in the scene. */
    this.empty = false;
    /** Its text, for a text node. */
    this.text = '';
    /** The panel of a primitive placed in a three.js object. @type {Surface | null} */
    this.surface = null;
    /** The properties set on an object built from `params`, applied again when new params rebuild it. @type {Map<string, any> | null} */
    this.props = null;
    /** The CSS cursor while the pointer is over the object or a child (null: none). @type {string | null} */
    this.cursor = null;
  }
}

/**
 * A length a primitive sets itself, in pixels: its style's, else (unset)
 * its shorthand prop's; null for none or a relative one.
 * @param {number | string} style @param {number | null} short
 */
const own = (style, short) => (typeof style === 'number' ? (style === style ? style : short) : null);

/**
 * The viewport a primitive's components read (the Host's `viewportOf`):
 * its panel's size when it is placed in a panel whose primitive sets its
 * width and height, else the root's (the canvas's). A panel sized by its
 * content reports the root's: its size follows what it shows, so a view
 * reading its own size could swing between two layouts. The color scheme
 * and motion are the root's either way. A component in a panel runs before
 * its nodes are placed: the source reports the root's until its primitive
 * is placed, then binds to the panel.
 */
class Region {
  /** @param {Renderer} owner @param {Item} item */
  constructor(owner, item) {
    this.owner = owner;
    this.item = item;
    /** @type {Set<(width: number, height: number, flags: number) => void>} */
    this.viewers = new Set();
    /** The root's viewport, as it last reported. */
    this.root = [0, 0, 0];
    /** The primitive placed in the panel it is bound to, whose size is the panel's when it sets one. @type {Item | null} */
    this.top = null;
    /** @type {(() => void) | null} */
    this.unroot = null;
    /** @type {(() => void) | null} */
    this.unpanel = null;
  }

  /** @param {(width: number, height: number, flags: number) => void} report @returns {() => void} */
  viewport(report) {
    const owner = this.owner;
    if (this.viewers.size === 0) {
      this.unroot = owner.viewport((width, height, flags) => {
        this.root = [width, height, flags];
        this.tell();
      });
      if (!this.bind()) owner.unbound.add(this);
    }
    this.viewers.add(report);
    const [w, h, f] = this.now();
    report(w, h, f);
    return () => {
      if (!this.viewers.delete(report) || this.viewers.size > 0) return;
      owner.unbound.delete(this);
      this.unroot?.();
      this.unpanel?.();
      this.unroot = this.unpanel = null;
      this.top = null;
    };
  }

  /**
   * Finds where its primitive is placed: a panel (followed), the overlay
   * (the root's). False while it is not placed yet.
   */
  bind() {
    /** @type {any} */
    let n = this.item;
    while (n != null && n.__ren === undefined) n = n.parent;
    if (n == null) return false;
    const s = slot(n);
    const surface = s.surface;
    if (surface !== null && s.parent !== this.owner.scene) {
      this.top = n;
      // The panel's size follows its primitive's: each change of it reports again.
      this.unpanel = surface.viewport(() => this.tell());
      this.tell();
    }
    return true;
  }

  /** What it reports now: the panel's size when its primitive sets one, else the root's. @returns {number[]} */
  now() {
    const root = this.root;
    const top = this.top;
    if (top === null) return root;
    const w = own(top.style.width, top.width);
    const h = own(top.style.height, top.height);
    return w !== null && h !== null ? [w, h, root[2]] : root;
  }

  /** Tells every reader. */
  tell() {
    if (this.viewers.size === 0) return;
    const [w, h, f] = this.now();
    for (const report of [...this.viewers]) report(w, h, f);
  }
}

/** ren-canv's item kinds of a text node and a marker (scene.js): a place in the tree, nothing in the scene. */
const TEXT = 8;
const MARKER = 9;

/** @param {any} value */
const slot = value => /** @type {Slot} */ (value.__ren);

/** The class name of a lowercase tag. @param {string} tag */
const className = tag => tag.charAt(0).toUpperCase() + tag.slice(1);

/** Reads an accessor once (element arguments are not reactive). @param {any} value */
const once = value => (typeof value === 'function' ? value() : value);

/** True when two params lists hold the same values. @param {any} a @param {any} b */
function sameParams(a, b) {
  a = once(a);
  b = once(b);
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * The slots (by target, its keys) that hold an object the view handed in,
 * placed by reference (a scene's background Color or Texture): the view's
 * own, so never written into, and replaced whole (null too) by what it
 * gives next. The slot is marked, not the object: the view may hand in one
 * three.js owns elsewhere (a material's color), which stays written in
 * place there.
 * @type {WeakMap<object, Set<string>>}
 */
const placed = new WeakMap();

/**
 * Sets `value` on `target[key]`: through the target's own `set`/`copy`/
 * `setScalar` for the math objects three.js made (position, scale, a
 * material's color; null or undefined leaves one as it is), by assignment
 * otherwise, and always over an object the view placed.
 * @param {any} target @param {string} key @param {any} value
 */
function assign(target, key, value) {
  const current = target[key];
  const own = current != null && typeof current === 'object' && placed.get(target)?.has(key) !== true;
  if (own && typeof current.set === 'function' && !(value != null && value.isObject3D)) {
    // Nothing to set (null or undefined): the math object keeps its value, as a Color does (set(undefined) is NaN).
    if (value == null) return;
    if (Array.isArray(value)) current.set(...value);
    else if (value != null && typeof value === 'object' && typeof current.copy === 'function' && value.constructor === current.constructor) current.copy(value);
    // A number is every component of a vector (scale={2}), but a Color's hex (color={0xff8800}).
    else if (typeof value === 'number' && typeof current.setScalar === 'function' && current.isColor !== true) current.setScalar(value);
    else current.set(value);
    return;
  }
  let keys = placed.get(target);
  // A placed object taken away leaves null (a scene's background cleared), not undefined, which three.js reads as none.
  const cleared = value == null && keys?.has(key) === true;
  if (value != null && typeof value === 'object') {
    if (keys === undefined) placed.set(target, (keys = new Set()));
    keys.add(key);
  } else keys?.delete(key);
  target[key] = cleared ? null : value;
}

/** Whether an object is drawn: it and every ancestor visible. @param {any} object */
function drawn(object) {
  for (let o = object; o != null; o = o.parent) if (o.visible === false) return false;
  return true;
}

/**
 * Frees a removed subtree's GPU resources (geometries, materials, textures),
 * takes its cursors off the renderer's count and its objects off the
 * hovered ones (as the DOM, a removed object hears no pointerout).
 * @param {any} node @param {{ cursors: number, hovered: any[] }} renderer
 */
function release(node, renderer) {
  const s = slot(node);
  if (node instanceof Item) {
    if (s.surface !== null) s.surface.close();
    return;
  }
  const at = renderer.hovered.indexOf(node);
  if (at >= 0) renderer.hovered.splice(at, 1);
  if (s.cursor !== null) {
    s.cursor = null;
    renderer.cursors--;
  }
  for (let c = s.first; c !== null; c = slot(c).next) release(c, renderer);
  if (!s.dispose || s.empty || node.isScene) return;
  if (typeof node.dispose === 'function') node.dispose();
}

/**
 * An Image source loaded as an HTMLImageElement of `doc` (the default
 * `image`): the element once decoded, null when it fails or there is no
 * document to make it in.
 * @param {any} doc @param {string} source
 * @returns {Promise<CanvasImageSource | null> | null}
 */
function element(doc, source) {
  if (doc == null || typeof doc.createElement !== 'function') return null;
  const img = doc.createElement('img');
  return new Promise(resolve => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = source;
  });
}


/**
 * A wheel's deltas in a surface's pixels: lines and pages (deltaMode 1 and 2)
 * scroll as far as a browser scrolls them, as ren-canv's attach reads them.
 * @param {any} surface @param {any} native @returns {[number, number]}
 */
function deltas(surface, native) {
  const mode = native?.deltaMode ?? 0;
  const line = surface.theme.text * surface.theme.leading;
  const y = native?.deltaY ?? 0;
  const x = native?.deltaX ?? 0;
  if (mode === 1) return [y * line, x * line];
  if (mode === 2) return [y * surface.height, x * surface.width];
  return [y, x];
}

/**
 * The three.js renderer: the Host `mount` renders into, and the scene,
 * camera and frame loop it draws.
 */
export class Renderer {
  /** @param {Kit} kit @param {Options} [options] */
  constructor(kit, options = {}) {
    if (kit == null || typeof kit.Scene !== 'function') throw new Error('REN three: pass the three.js namespace: $three(THREE, options)');
    this.kit = kit;
    this.construct = CONSTRUCT;
    this.options = options;
    /** How the canvas behaves under the user's hands: each switch of its `behavior` (its surfaces take it too). @type {import('ren-core/host').Switches} */
    this.behavior = behaviorOf(options.behavior);
    /** The scene, and the container views render into. */
    this.scene = new kit.Scene();
    this.scene.__ren = new Slot();
    this.scene.__ren.dispose = false;
    if (options.background !== undefined) this.scene.background = new kit.Color(options.background);
    const camera = options.camera;
    this.camera = camera != null && camera.isCamera ? camera : new kit.PerspectiveCamera(camera?.fov ?? 50, 2, camera?.near ?? 0.1, camera?.far ?? 1000);
    if (camera == null || !camera.isCamera) this.camera.position.set(...(camera?.position ?? [0, 0, 5]));
    /** @type {Drawer | null} */
    this.drawer = null;
    /** The canvas, once open. @type {any} */
    this.canvas = null;
    /** The host element that open marked (`data-ren-root`), unmarked on close. @type {any} */
    this.host = null;
    this.width = options.width ?? 300;
    this.height = options.height ?? 150;
    /** Rendered frames. */
    this.frames = 0;
    /** True when the scene changed since the last frame. */
    this.dirty = true;
    /** Per-frame callbacks (`$animate`): false when one threw and nothing handled it. @type {Set<(frame: Tick) => boolean>} */
    this.animations = new Set();
    /** The callbacks that had a frame: a callback's first frame has delta 0, whatever time passed before it. @type {WeakSet<(frame: Tick) => boolean>} */
    this.animated = new WeakSet();
    /** The pending animation frame, or null. @type {any} */
    this.pending = null;
    this.time = 0;
    this.opened = false;
    this.closed = false;
    /** Objects with handlers, for the raycast. */
    this.listening = 0;
    /** Objects with a `cursor`: while any, the pointer is raycast for them too. */
    this.cursors = 0;
    /** The cursor over an object with a press handler and no cursor of its own (the `cursor` option; null: none). @type {string | null} */
    this.cursor = options.cursor === undefined ? 'pointer' : options.cursor || null;
    /** `<gl>`'s settings by property name, applied to the drawer. @type {any} */
    this.gl = { settings: new Map() };
    /** Object3D's own fields, which a rebuild from new params leaves alone. @type {Set<string> | null} */
    this.base = null;
    /** The objects under the pointer, nearest first (pointerover/out). @type {any[]} */
    this.hovered = [];
    /** Removed nodes whose resources go at the next frame unless they come back. @type {any[]} */
    this.removed = [];
    /** @type {(() => void) | null} */
    this.detach = null;
    /** @type {any} */
    this.observer = null;
    this.raycaster = new kit.Raycaster();
    this.pointer = new kit.Vector2();
    // The primitives: the overlay, the panels, and what they share.
    /** The overlay of the primitives placed in the scene, once there is one. @type {Surface | null} */
    this.overlay = null;
    /** Its scene and camera, drawn over the scene. @type {any} */
    this.overlayScene = null;
    /** @type {any} */
    this.overlayCamera = null;
    /** Every surface, the overlay first. @type {Set<Surface>} */
    this.surfaces = new Set();
    /** The root's root-wide listeners (ren-core's `$keys`, `$scrolls`, `$presses` on the scene), heard on every surface; `off` by surface, which goes with it. @type {Set<{ name: string, fn: (event: any) => void, off: Map<Surface, () => void> }>} */
    this.rooted = new Set();
    /** The surfaces by their page's root item. @type {WeakMap<Item, Surface>} */
    this.pages = new WeakMap();
    /** The measure of the primitives' text. @type {import('ren-canv').Fonts | null} */
    this.measure = null;
    /** The font family the 2D canvas draws them in, and its monospace one (when `mono` is given). */
    this.family = `ren-three-${++families}`;
    this.monoFamily = options.mono == null ? null : `${this.family}-mono`;
    /** The font family each typeface slot of the measure draws in (the named typefaces, then the fallbacks; none for slot 0). @type {(string | null)[]} */
    this.typefaces = [null];
    /** The faces it added to the document's fonts, deleted on close. @type {any[]} */
    this.faces = [];
    this.pixel = options.pixel ?? 0.01;
    this.scale = options.scale ?? 1;
    /** @type {import('ren-canv/backend').Picture | null} */
    this.picture = options.image ?? (source => element(this.canvas?.ownerDocument ?? globalThis.document, source));
    /** The surface keys, copy and select all go to; the one a press grabbed (a drag); the panel under the pointer. @type {Surface | null} */
    this.active = null;
    /** @type {Surface | null} */
    this.grab = null;
    /** @type {Surface | null} */
    this.over = null;
    /** True when the last press went to a surface (its click does not reach the scene). */
    this.took = false;
    /** The surface under a drag over the canvas (null: none). @type {Surface | null} */
    this.dragged = null;
    /** Who follows the viewport (ren-core's `$viewport`), and the window's preference queries while one does. @type {Set<(width: number, height: number, flags: number) => void>} */
    this.viewers = new Set();
    /** @type {any[] | null} */
    this.queries = null;
    this.tell = () => this.viewed();
    /** Each primitive's viewport source (`viewportOf`), made on first use. @type {WeakMap<Item, Region>} */
    this.regions = new WeakMap();
    /** The sources followed whose primitive is not placed yet: bound as it is. @type {Set<Region>} */
    this.unbound = new Set();
    this.aspect();
  }

  /** The measure of the primitives' text, read from the `font` (and `mono`) option on first use. @returns {import('ren-canv').Fonts} */
  fonts() {
    if (this.measure === null) {
      const font = this.options.font;
      if (font == null) throw new Error('REN three: the primitives need options.font, the bytes of a typeface: $three(THREE, { font })');
      const families = this.options.families ?? {};
      const fallback = this.options.fallback ?? [];
      // Each character in the typeface that has it: the monospace one for MONO, a named one for its family, a fallback for what a typeface lacks.
      this.measure = new Faces({ font, mono: this.options.mono ?? null, families, fallback });
      /** The bytes of each slot's typeface, after the root one. */
      const slots = [...Object.values(families), ...fallback];
      this.typefaces = [null, ...slots.map((_, i) => `${this.family}-${i + 1}`)];
      // The 2D canvas draws the same faces: registered from the same bytes.
      const doc = this.canvas?.ownerDocument ?? null;
      const view = doc?.defaultView ?? null;
      if (view != null && typeof view.FontFace === 'function' && doc.fonts != null) {
        /** @param {string} family @param {ArrayBuffer | Uint8Array} source */
        const register = (family, source) => {
          const face = new view.FontFace(family, source instanceof Uint8Array ? source : new Uint8Array(source));
          doc.fonts.add(face);
          this.faces.push(face);
          face.load().then(() => {
            for (const surface of this.surfaces) {
              surface.damage = true;
              surface.full = true;
              surface.present();
            }
          }, () => {});
        };
        register(this.family, font);
        if (this.monoFamily !== null && this.options.mono != null) register(this.monoFamily, this.options.mono);
        slots.forEach((source, i) => register(/** @type {string} */ (this.typefaces[i + 1]), source));
      }
    }
    return this.measure;
  }

  /** The overlay, made on first use. */
  makeOverlay() {
    if (this.overlay === null) {
      const kit = this.kit;
      this.overlay = new Surface(this, false);
      this.adopt(this.overlay);
      this.pages.set(this.overlay.root, this.overlay);
      this.pages.set(this.overlay.overlay, this.overlay);
      this.overlayScene = new kit.Scene();
      this.overlayCamera = new kit.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.overlayScene.add(this.overlay.mesh);
    }
    return this.overlay;
  }

  /** A new surface: one of this renderer's, hearing the root-wide listeners. @param {Surface} surface */
  adopt(surface) {
    this.surfaces.add(surface);
    for (const r of this.rooted) r.off.set(surface, surface.listen(surface.root, r.name, r.fn));
  }

  /** The surface an item belongs to (the overlay for one not placed yet). @param {Item} item */
  page(item) {
    /** @type {Item} */
    let n = item;
    while (n.parent !== null) n = n.parent;
    return this.pages.get(n) ?? this.makeOverlay();
  }

  get kind() {
    return 'three';
  }

  // ---- Host ---------------------------------------------------------------

  /** @param {string} tag @param {any} props */
  element(tag, props) {
    const first = tag.charCodeAt(0);
    // A capitalized tag is a primitive: an item of the surfaces.
    if (first >= 65 && first <= 90) return this.makeOverlay().element(tag, props);
    let object;
    if (tag === 'gl') {
      // The WebGL renderer's own settings (tone mapping, exposure, the shadow
      // map), from the view: kept, and applied to the drawer as it is made.
      const gl = this.gl;
      if (gl.__ren === undefined) {
        const s = (gl.__ren = new Slot());
        s.empty = true;
        s.dispose = false;
      }
      return gl;
    }
    if (tag === 'existing') {
      object = once(props?.of);
      if (object == null || typeof object !== 'object') throw new Error('REN three: <existing> needs an object in `of`');
    } else {
      const code = tag.charCodeAt(0);
      if (code < 97 || code > 122) throw new Error(`REN three: <${tag}> is not a three.js element (<mesh>, <group>, …) or a primitive (<View>, <Label>, …)`);
      const Class = this.kit[className(tag)];
      if (typeof Class !== 'function') throw new Error(`REN three: unknown element <${tag}>: three.js has no ${className(tag)}`);
      const params = props == null ? undefined : once(props.params);
      object = Array.isArray(params) ? new Class(...params) : new Class();
    }
    const s = (object.__ren = new Slot());
    // New params rebuild it in place, then its properties apply again: keep them.
    if (props != null && props.params !== undefined && tag !== 'existing') s.props = new Map();
    if (props != null) {
      const into = once(props.slot);
      if (typeof into === 'string') s.property = into;
      else if (object.isMaterial) s.property = 'material';
      else if (object.isBufferGeometry) s.property = 'geometry';
      else if (object.isFog) s.property = 'fog';
      if (props.dispose === null || props.dispose === false) s.dispose = false;
      if (tag === 'existing') s.dispose = props.dispose === true;
    } else if (object.isMaterial) s.property = 'material';
    else if (object.isBufferGeometry) s.property = 'geometry';
    else if (object.isFog) s.property = 'fog';
    return object;
  }

  /** A text node: an item, drawn inside a primitive and nothing among three.js objects. @param {string} value */
  text(value) {
    return new Item(TEXT, value, 0);
  }

  /** @param {any} node @param {string} value */
  content(node, value) {
    if (!(node instanceof Item)) slot(node).text = value;
    else if (node.parent !== null) this.page(node).content(node, value);
    else node.text = value;
  }

  /** @param {any} node @param {string} name @param {any} value @param {any} [previous] */
  set(node, name, value, previous) {
    if (node instanceof Item) {
      this.page(node).set(node, name, value, previous);
      return;
    }
    if (node === this.gl) {
      node.settings.set(name, value);
      if (this.drawer !== null) this.apply(this.drawer, name, value);
      this.dirty = true;
      this.request();
      return;
    }
    if (RESERVED.has(name)) {
      if (name === 'cursor') {
        const s = slot(node);
        const had = s.cursor !== null;
        s.cursor = value == null || value === '' ? null : String(value);
        this.cursors += (s.cursor !== null ? 1 : 0) - (had ? 1 : 0);
      }
      if (name === 'params' && previous !== undefined && !sameParams(previous, value)) this.rebuild(node, once(value));
      if (name === 'main' && value && node.isCamera) {
        this.camera = node;
        this.aspect();
      }
      return;
    }
    const kept = node.__ren?.props;
    if (kept != null) kept.set(name, value);
    this.apply(node, name, value);
  }

  /** Writes a property on a three.js object: a dashed name reaches into it. @param {any} node @param {string} name @param {any} value */
  apply(node, name, value) {
    const dash = name.indexOf('-');
    if (dash < 0) assign(node, name, value);
    else {
      const path = name.split('-');
      let target = node;
      for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
      assign(target, path[path.length - 1], value);
    }
    if (node.isMaterial && name === 'transparent') node.needsUpdate = true;
    this.dirty = true;
  }

  /**
   * Rebuilds an object in place from new constructor `params`: the node keeps
   * its identity (the view, its parent and its handlers hold it). A fresh
   * object is made and copied in: a scene object takes only what its class
   * sets beyond Object3D's own fields (not its transform or children);
   * anything else (a geometry, a material, a curve) takes its whole state,
   * a geometry's old GPU buffers freed first. The properties the view set
   * apply again after.
   * @param {any} node @param {any} params
   */
  rebuild(node, params) {
    const Class = node.constructor;
    const fresh = Array.isArray(params) ? new Class(...params) : new Class();
    if (node.isObject3D) {
      const base = (this.base ??= new Set(Object.keys(new this.kit.Object3D())));
      for (const key of Object.keys(fresh)) if (!base.has(key) && key !== '__ren') node[key] = fresh[key];
    } else {
      if (typeof node.copy !== 'function') throw new Error(`REN three: a ${Class.name} cannot take new params (it has no copy); key it to make a new one`);
      if (node.isBufferGeometry) node.dispose();
      node.copy(fresh);
      if (typeof fresh.dispose === 'function') fresh.dispose();
    }
    const kept = slot(node).props;
    if (kept !== null) for (const [name, value] of kept) this.apply(node, name, value);
    if (node.isCamera && typeof node.updateProjectionMatrix === 'function') node.updateProjectionMatrix();
    if (node.isMaterial) node.needsUpdate = true;
    this.dirty = true;
  }

  /** @param {any} node @param {string} name @param {(event: any) => void} handler */
  listen(node, name, handler) {
    if (node instanceof Item) return this.page(node).listen(node, name, handler);
    // Root-wide keys, scrolls and presses (`$keys`, `$scrolls`, `$presses`) on the scene: every surface's, the overlay's and each panel's.
    if (node === this.scene && (name === 'keys' || name === 'scrolls' || name === 'presses')) {
      const r = { name, fn: handler, off: new Map([...this.surfaces].map(surface => [surface, surface.listen(surface.root, name, handler)])) };
      this.rooted.add(r);
      return () => {
        if (!this.rooted.delete(r)) return;
        for (const off of r.off.values()) off();
      };
    }
    const s = slot(node);
    if (s.handlers === null) s.handlers = {};
    if (s.handlers[name] === undefined) this.listening++;
    s.handlers[name] = handler;
    return () => {
      const handlers = s.handlers;
      if (handlers !== null && handlers[name] === handler) {
        delete handlers[name];
        this.listening--;
      }
    };
  }

  /** @param {any} parent @param {any} child @param {any} before */
  insert(parent, child, before) {
    if (parent instanceof Item) {
      if (!(child instanceof Item)) throw new Error('REN three: a three.js object cannot go inside a primitive; place primitives in three.js objects instead');
      this.page(parent).insert(parent, child, before);
      if (this.unbound.size > 0) this.bind();
      return;
    }
    // An item among three.js objects: a text or marker holds a place; a
    // primitive joins the overlay (in the scene) or becomes a panel.
    if (child instanceof Item && /** @type {any} */ (child).__ren === undefined) {
      const s = (/** @type {any} */ (child).__ren = new Slot());
      s.empty = child.kind >= TEXT;
    }
    const p = slot(parent);
    const c = slot(child);
    const moving = c.parent === parent;
    if (c.parent !== null) this.unlink(c.parent, child, moving);
    // Link before `before`, or last.
    c.parent = parent;
    c.next = before;
    c.prev = before === null ? p.last : slot(before).prev;
    if (c.prev === null) p.first = child;
    else slot(c.prev).next = child;
    if (before === null) p.last = child;
    else slot(before).prev = child;
    if (child instanceof Item) {
      if (!c.empty) this.place(parent, child, moving);
    } else if (!moving && !c.empty) {
      if (c.property !== null) {
        c.previous = parent[c.property];
        parent[c.property] = child;
      } else if (child.isObject3D && parent.isObject3D) parent.add(child);
    }
    this.dirty = true;
  }

  /**
   * Places a primitive linked among three.js objects: in the overlay, in
   * order among the overlay's other primitives, for the scene; in a panel
   * of its own for any other object.
   * @param {any} parent @param {Item} child @param {boolean} moving
   */
  place(parent, child, moving) {
    if (parent === this.scene) {
      const layer = this.makeOverlay();
      // Before the next primitive of the scene, in the order of the view.
      let next = slot(child).next;
      while (next !== null && !(next instanceof Item && !slot(next).empty)) next = slot(next).next;
      layer.insert(layer.root, child, next);
      if (this.unbound.size > 0) this.bind();
      return;
    }
    if (moving) return;
    const s = slot(child);
    let surface = s.surface;
    if (surface === null) {
      surface = new Surface(this, true);
      s.surface = surface;
      this.adopt(surface);
      this.pages.set(surface.root, surface);
      this.pages.set(surface.overlay, surface);
    }
    surface.insert(surface.root, child, null);
    parent.add(surface.mesh);
    if (this.unbound.size > 0) this.bind();
  }

  /** @param {any} parent @param {any} child */
  remove(parent, child) {
    if (parent instanceof Item) {
      this.page(parent).remove(parent, child);
      return;
    }
    this.unlink(parent, child, false);
    this.removed.push(child);
    this.dirty = true;
  }

  /** @param {any} parent @param {any} child @param {boolean} moving */
  unlink(parent, child, moving) {
    const p = slot(parent);
    const c = slot(child);
    if (c.prev === null) p.first = c.next;
    else slot(c.prev).next = c.next;
    if (c.next === null) p.last = c.prev;
    else slot(c.next).prev = c.prev;
    c.parent = c.prev = c.next = null;
    if (moving || c.empty) return;
    if (child instanceof Item) {
      if (parent === this.scene) this.overlay?.remove(this.overlay.root, child);
      else if (c.surface !== null) {
        c.surface.remove(c.surface.root, child);
        parent.remove(c.surface.mesh);
      }
      return;
    }
    if (c.property !== null) {
      if (parent[c.property] === child) parent[c.property] = c.previous;
      else {
        // Not the current value: the one set over it now stands over what it stood over.
        for (let s = p.first; s !== null; s = slot(s).next) {
          const o = slot(s);
          if (o.property === c.property && o.previous === child) o.previous = c.previous;
        }
      }
      c.previous = undefined;
    } else if (child.isObject3D) parent.remove?.(child);
  }

  marker() {
    return new Item(MARKER, '', 0);
  }

  /** @param {any} node */
  parent(node) {
    // An item placed among three.js objects has its place there.
    if (node instanceof Item && /** @type {any} */ (node).__ren === undefined) return node.parent;
    return slot(node).parent;
  }

  /** @param {any} node */
  next(node) {
    if (node instanceof Item && /** @type {any} */ (node).__ren === undefined) return node.next;
    return slot(node).next;
  }

  /** @param {any} value */
  owns(value) {
    return value instanceof Item || (value != null && typeof value === 'object' && value.__ren instanceof Slot);
  }

  layer() {
    return this.scene;
  }

  /**
   * The viewport (ren-core's `$viewport`, `$media`): the canvas's size in
   * CSS pixels, and the color scheme and motion preferences of the window
   * it is in (none without one); now, then on each resize or change.
   * @param {(width: number, height: number, flags: number) => void} report
   * @returns {() => void}
   */
  viewport(report) {
    const viewers = this.viewers;
    if (viewers.size === 0) this.prefer(true);
    viewers.add(report);
    report(this.width, this.height, this.flags());
    return () => {
      if (viewers.delete(report) && viewers.size === 0) this.prefer(false);
    };
  }

  /**
   * The viewport of the region `node` is in (ren-core's `$viewport` and
   * `$media` in a component built there): a primitive's is its panel's
   * once it is placed in one with a width and height of its own (see
   * Region), else the root's; null (the root's) for a three.js object.
   * @param {any} node
   * @returns {Region | null}
   */
  viewportOf(node) {
    if (!(node instanceof Item)) return null;
    let region = this.regions.get(node);
    if (region === undefined) {
      region = new Region(this, node);
      this.regions.set(node, region);
    }
    return region;
  }

  /** Binds the followed sources whose primitive is placed now. */
  bind() {
    for (const region of this.unbound) if (region.bind()) this.unbound.delete(region);
  }

  /** The viewport's flags: 1 a dark color scheme, 2 reduced motion (the window's media queries). */
  flags() {
    const q = this.queries;
    return q === null ? 0 : (q[0].matches ? 1 : 0) | (q[1].matches ? 2 : 0);
  }

  /** Follows the window's color scheme and motion preferences, or stops. @param {boolean} on */
  prefer(on) {
    const tell = this.tell;
    if (!on) {
      if (this.queries !== null) for (const q of this.queries) q.removeEventListener?.('change', tell);
      this.queries = null;
      return;
    }
    const win = (this.canvas ?? this.host)?.ownerDocument?.defaultView ?? globalThis;
    if (typeof win.matchMedia !== 'function') return;
    this.queries = [win.matchMedia('(prefers-color-scheme: dark)'), win.matchMedia('(prefers-reduced-motion: reduce)')];
    for (const q of this.queries) q.addEventListener?.('change', tell);
  }

  /** Reports the viewport to its followers. */
  viewed() {
    if (this.viewers.size === 0) return;
    const flags = this.flags();
    for (const report of [...this.viewers]) report(this.width, this.height, flags);
  }

  present() {
    // Nodes removed and not inserted again release their resources.
    const removed = this.removed;
    if (removed.length > 0) {
      this.removed = [];
      for (const node of removed) if (slot(node).parent === null) release(node, this);
    }
    for (const surface of this.surfaces) {
      if (surface.closed) {
        // A closed panel goes, with the root-wide listeners' hold on it.
        this.surfaces.delete(surface);
        for (const r of this.rooted) r.off.delete(surface);
        // Keys, a drag and the hover leave it: a key with no surface focused goes to the overlay.
        if (this.active === surface) this.active = null;
        if (this.grab === surface) this.grab = null;
        if (this.over === surface) this.over = null;
      } else surface.present();
    }
    if (this.dirty) this.request();
  }

  /**
   * Prepares an application root: a canvas in its host element (none
   * without a document), the drawer, pointer events and sizing.
   * @param {any} element @param {string} id
   */
  open(element, id) {
    if (this.opened) throw new Error('REN three: a renderer serves one root; make one per root');
    this.opened = true;
    const doc = element?.ownerDocument ?? null;
    if (element != null && typeof element.setAttribute === 'function') {
      element.setAttribute('data-ren-root', id);
      this.host = element;
    }
    const given = this.options.renderer;
    let canvas = given != null && typeof given === 'object' ? (given.domElement ?? null) : null;
    if (canvas === null && doc !== null) {
      canvas = doc.createElement('canvas');
      canvas.style.display = 'block';
    }
    this.canvas = canvas;
    const drawer = given == null ? new this.kit.WebGLRenderer({ canvas, antialias: true }) : typeof given === 'function' ? given(canvas) : given;
    this.drawer = drawer;
    /** The drawer is this renderer's (made here, or by the `renderer` function for its canvas): closing loses its WebGL context. */
    this.owned = typeof given !== 'object' || given === null;
    for (const [name, value] of this.gl.settings) this.apply(drawer, name, value);
    this.scale = this.options.scale ?? doc?.defaultView?.devicePixelRatio ?? 1;
    drawer.setPixelRatio?.(this.scale);
    if (canvas !== null && element != null && canvas.parentNode !== element) element.appendChild(canvas);
    if (canvas !== null && typeof canvas.addEventListener === 'function') this.detach = this.attach(canvas);
    const view = doc?.defaultView ?? null;
    if (element != null && (this.options.width === undefined || this.options.height === undefined) && typeof view?.ResizeObserver === 'function') {
      this.observer = new view.ResizeObserver(() => this.fit(element));
      this.observer.observe(element);
      this.fit(element);
    } else this.resize(this.width, this.height);
    return this.scene;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.animations.clear();
    if (this.detach !== null) this.detach();
    this.detach = null;
    if (this.observer !== null) this.observer.disconnect();
    this.observer = null;
    this.viewers.clear();
    this.prefer(false);
    for (let c = slot(this.scene).first; c !== null; ) {
      const next = slot(c).next;
      this.remove(this.scene, c);
      c = next;
    }
    for (const node of this.removed) release(node, this);
    this.removed = [];
    for (const surface of this.surfaces) surface.close();
    this.surfaces.clear();
    for (const r of this.rooted) r.off.clear();
    this.dragged = null;
    this.overlay = null;
    this.drawer?.dispose?.();
    // dispose() keeps the WebGL context until the canvas is collected: a
    // page that remakes roots would run out of contexts (the browser drops
    // the oldest). Lose the one this renderer made at once.
    if (this.owned) this.drawer?.forceContextLoss?.();
    const canvas = this.canvas;
    for (const face of this.faces) canvas?.ownerDocument?.fonts?.delete(face);
    this.faces = [];
    if (canvas !== null && canvas.parentNode != null) canvas.parentNode.removeChild(canvas);
    this.host?.removeAttribute?.('data-ren-root');
    this.host = null;
  }

  // ---- Drawing ------------------------------------------------------------

  /** Keeps the camera's aspect ratio to the canvas. */
  aspect() {
    const camera = this.camera;
    if (camera.isPerspectiveCamera) {
      camera.aspect = this.width / this.height;
      camera.updateProjectionMatrix();
    }
    this.dirty = true;
  }

  /** Sizes the canvas and the camera. @param {number} width @param {number} height */
  resize(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const moved = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    this.drawer?.setSize(w, h);
    this.overlay?.resize(w, h, this.scale);
    this.aspect();
    if (moved) this.viewed();
    this.request();
  }

  /** Follows the host element's size where the options leave it open. @param {any} element */
  fit(element) {
    const width = this.options.width ?? (element.clientWidth || 300);
    const height = this.options.height ?? (element.clientHeight || 150);
    if (width !== this.width || height !== this.height || this.frames === 0) this.resize(width, height);
  }

  /** Asks for a frame: on the next animation frame, unless one is pending or frames are driven by hand. */
  request() {
    if (this.pending !== null || this.closed || this.drawer === null || this.options.schedule === false) return;
    const view = /** @type {any} */ (this.canvas?.ownerDocument?.defaultView ?? globalThis);
    if (typeof view.requestAnimationFrame === 'function') {
      // timer: feature, the scene draws once a frame.
      this.pending = { view, id: view.requestAnimationFrame((/** @type {number} */ time) => this.tick(time)) };
    } else {
      // timer: fallback, 60 frames a second where the host has no requestAnimationFrame.
      this.pending = { view: null, id: setTimeout(() => this.tick(performance.now()), 16) };
    }
  }

  cancel() {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    if (pending.view !== null) pending.view.cancelAnimationFrame(pending.id);
    else clearTimeout(pending.id);
  }

  /** @param {number} time */
  tick(time) {
    this.pending = null;
    this.frame(time);
    if (this.animations.size > 0) this.request();
  }

  /**
   * One frame: runs the `$animate` callbacks, then renders if anything changed
   * (an animation always counts as a change).
   * @param {number} [time] milliseconds
   */
  frame(time = this.time + 16) {
    const delta = this.frames === 0 ? 0 : (time - this.time) / 1000;
    this.time = time;
    if (this.animations.size > 0) {
      const state = new Tick(this, time / 1000, delta);
      /** @type {Tick | null} */
      let first = null;
      // A callback whose error nothing handled is dropped; the others and the render go on.
      for (const animate of [...this.animations]) {
        let frame = state;
        if (!this.animated.has(animate)) {
          this.animated.add(animate);
          frame = first ??= new Tick(this, time / 1000, 0);
        }
        if (!animate(frame)) this.animations.delete(animate);
      }
      this.dirty = true;
    }
    if (!this.dirty || this.drawer === null || this.closed) return false;
    this.dirty = false;
    const drawer = this.drawer;
    drawer.render(this.scene, this.camera);
    // The overlay over the scene, without clearing it.
    if (this.overlay !== null && this.overlay.mesh.visible) {
      const clears = /** @type {any} */ (drawer).autoClear;
      /** @type {any} */ (drawer).autoClear = false;
      drawer.render(this.overlayScene, this.overlayCamera);
      /** @type {any} */ (drawer).autoClear = clears;
    }
    this.frames++;
    return true;
  }

  // ---- Pointer events -----------------------------------------------------

  /**
   * The objects at a canvas point, nearest first: three.js intersections
   * (`object`, `point`, `distance`, …).
   * @param {number} x @param {number} y CSS pixels from the canvas's top left
   * @returns {any[]}
   */
  pick(x, y) {
    // Matrices are brought up to date here, as a render would.
    this.scene.updateMatrixWorld();
    if (this.camera.parent === null) this.camera.updateMatrixWorld();
    this.pointer.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // What is not drawn (the object or an ancestor not visible) takes no pointer, as it shows nothing.
    return this.raycaster.intersectObject(this.scene, true).filter((/** @type {any} */ hit) => drawn(hit.object));
  }

  /**
   * Dispatches a pointer event at a canvas point: to the nearest object
   * with a handler for `type` and then its ancestors, until one stops it.
   * `pointermove` also sends pointerover and pointerout as the objects
   * under the pointer change. Returns true when a handler ran.
   * @param {string} type a ren-core event name (`click`, `pointerdown`, …)
   * @param {number} x @param {number} y
   * @param {any} [native] the browser event
   * @param {Record<string, any>} [more] fields the event also carries (a drop's `files`)
   */
  dispatch(type, x, y, native, more) {
    if ((this.listening === 0 && this.cursors === 0) || this.closed) return false;
    const hits = this.pick(x, y);
    let ran = false;
    if (type === 'pointermove' || type === 'pointerleave') {
      const over = type === 'pointerleave' ? [] : this.chain(hits);
      // The cursor of the nearest hovered object that has one, where no primitive is under the pointer.
      if (this.over === null) this.shown(over.find(o => this.cursorOf(o) !== null) ?? null);
      const before = this.hovered;
      for (const object of before) if (!over.includes(object)) ran = this.call(object, 'pointerout', null, x, y, native) || ran;
      for (const object of over) if (!before.includes(object)) ran = this.call(object, 'pointerover', hits[0] ?? null, x, y, native) || ran;
      this.hovered = over;
      if (type === 'pointerleave') return ran;
    }
    if (hits.length === 0) return ran;
    const hit = hits[0];
    /** @type {any} */
    const event = { type, x, y, button: native?.button, buttons: native?.buttons ?? 0, deltaX: native?.deltaX ?? 0, deltaY: native?.deltaY ?? 0, shiftKey: native?.shiftKey, ctrlKey: native?.ctrlKey, altKey: native?.altKey, metaKey: native?.metaKey, object: hit.object, currentObject: null, point: hit.point, distance: hit.distance, intersection: hit, intersections: hits, native, stopped: false };
    event.stopPropagation = () => void (event.stopped = true);
    if (more !== undefined) Object.assign(event, more);
    for (let object = hit.object; object != null && !event.stopped; object = object.parent) {
      const handler = object.__ren?.handlers?.[type];
      if (handler === undefined) continue;
      event.currentObject = object;
      handler(event);
      ran = true;
    }
    return ran;
  }

  /** The nearest hit and its ancestors that are part of the view. @param {any[]} hits */
  chain(hits) {
    /** @type {any[]} */
    const out = [];
    if (hits.length === 0) return out;
    for (let object = hits[0].object; object != null && object !== this.scene; object = object.parent) if (object.__ren !== undefined) out.push(object);
    return out;
  }

  /** @param {any} object @param {string} type @param {any} hit @param {number} x @param {number} y @param {any} native */
  call(object, type, hit, x, y, native) {
    const handler = object.__ren?.handlers?.[type];
    if (handler === undefined) return false;
    handler({ type, x, y, buttons: native?.buttons ?? 0, deltaX: native?.deltaX ?? 0, deltaY: native?.deltaY ?? 0, shiftKey: native?.shiftKey === true, ctrlKey: native?.ctrlKey === true, altKey: native?.altKey === true, metaKey: native?.metaKey === true, object, currentObject: object, point: hit?.point ?? null, distance: hit?.distance ?? Infinity, intersection: hit, intersections: [], native, stopped: false, stopPropagation() {} });
    return true;
  }

  /**
   * The surface and its pixel under a canvas point: the overlay where it
   * has something there, else the nearest panel the ray hits (from its
   * texture coordinate). Null when neither. For a `drag` of files, the
   * overlay also where an item under the point hears drags or drops.
   * @param {number} x @param {number} y @param {boolean} [drag]
   * @returns {[Surface, number, number] | null}
   */
  surfaceAt(x, y, drag = false) {
    const layer = this.overlay;
    if (layer !== null && layer.mesh.visible && (layer.at(x, y) || (drag && layer.drops(x, y)))) return [layer, x, y];
    if (this.surfaces.size <= (layer === null ? 0 : 1)) return null;
    for (const hit of this.pick(x, y)) {
      const surface = hit.object.userData?.surface;
      if (surface instanceof Surface && surface.panel && hit.uv != null) return [surface, hit.uv.x * surface.width, (1 - hit.uv.y) * surface.height];
      // The nearest object is in front of any panel behind it.
      return null;
    }
    return null;
  }

  /**
   * A canvas point on a panel's plane, in the panel's pixels, whether the
   * panel is under it or not (a drag that leaves it). Null when the ray
   * misses the plane.
   * @param {Surface} surface @param {number} x @param {number} y
   * @returns {[number, number] | null}
   */
  onPanel(surface, x, y) {
    if (!surface.panel) return [x, y];
    const kit = this.kit;
    this.pick(x, y);
    const mesh = surface.mesh;
    mesh.updateMatrixWorld();
    const normal = new kit.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    const plane = new kit.Plane().setFromNormalAndCoplanarPoint(normal, new kit.Vector3().setFromMatrixPosition(mesh.matrixWorld));
    const point = this.raycaster.ray.intersectPlane(plane, new kit.Vector3());
    if (point === null) return null;
    mesh.worldToLocal(point);
    return [(point.x + 0.5) * surface.width, (0.5 - point.y) * surface.height];
  }

  /**
   * Where a panel's pixel shows on the canvas, in CSS pixels.
   * @param {Surface} surface @param {number} px @param {number} py
   * @returns {[number, number]}
   */
  project(surface, px, py) {
    const kit = this.kit;
    const mesh = surface.mesh;
    this.scene.updateMatrixWorld();
    if (this.camera.parent === null) this.camera.updateMatrixWorld();
    mesh.updateMatrixWorld();
    const point = new kit.Vector3(px / surface.width - 0.5, 0.5 - py / surface.height, 0).applyMatrix4(mesh.matrixWorld).project(this.camera);
    return [((point.x + 1) / 2) * this.width, ((1 - point.y) / 2) * this.height];
  }

  /**
   * One input event at a canvas point: to the primitives first (the overlay,
   * then a panel under the pointer; a drag stays with the surface it
   * started on), then, when they take nothing, raycast into the scene.
   * Returns true when anything handled it.
   * @param {string} type `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `pointerleave`, `click`, `dblclick`, `contextmenu` or `wheel`
   * @param {number} x @param {number} y @param {any} [native]
   */
  input(type, x, y, native) {
    if (this.closed) return false;
    if (type === 'pointerdown') {
      const at = this.surfaceAt(x, y);
      this.took = false;
      // Another button than the main one (a right press) reaches the pointer handlers only: it presses, focuses and selects nothing.
      const main = (native?.button ?? 0) === 0;
      if (main) for (const surface of this.surfaces) if (at === null || surface !== at[0]) surface.focus(null);
      if (at !== null) {
        const [surface, px, py] = at;
        if (main) this.active = surface;
        this.took = main ? surface.press(px, py, native?.detail || 1, native?.shiftKey === true, native ?? undefined) : surface.secondary(px, py, native ?? undefined);
        if (this.took) this.grab = surface;
      } else this.active = null;
      if (this.took) return true;
    } else if (type === 'pointermove') {
      const grab = this.grab;
      if (grab !== null) {
        const p = this.onPanel(grab, x, y);
        if (p !== null) grab.move(p[0], p[1], native ?? undefined);
        this.show(grab);
        return true;
      }
      const at = this.surfaceAt(x, y);
      const over = at === null ? null : at[0];
      if (this.over !== null && this.over !== over) this.over.leave();
      this.over = over;
      if (at !== null) at[0].move(at[1], at[2], native ?? undefined);
      this.show(over);
      // The overlay on top takes the pointer: the scene behind it is left, not moved over. A panel
      // is in the scene: its mesh and ancestors keep hearing the move (their over and out).
      if (at !== null && at[0] === this.overlay) return this.dispatch('pointerleave', x, y, native);
    } else if (type === 'pointerup' || type === 'pointercancel') {
      // A cancel (the browser took the pointer back) ends the press with pointercancel, no pointerup.
      const grab = this.grab;
      this.grab = null;
      if (grab !== null) {
        const p = this.onPanel(grab, x, y) ?? [0, 0];
        if (type === 'pointerup') grab.release(p[0], p[1], native ?? undefined);
        else grab.cancel(p[0], p[1], native ?? undefined);
        return true;
      }
    } else if (type === 'pointerleave') {
      if (this.over !== null) this.over.leave();
      this.over = null;
    } else if (type === 'wheel') {
      const at = this.surfaceAt(x, y);
      // Over the overlay, the wheel is its own, used or not: it never reaches the scene behind it.
      // Over a panel, one the panel does not use goes on to the scene, the panel's ancestors among it.
      if (at !== null) {
        const [dy, dx] = deltas(at[0], native);
        if (at[0] === this.overlay) return at[0].wheel(at[1], at[2], dy, native ?? undefined, dx);
        if (at[0].wheel(at[1], at[2], dy, native ?? undefined, dx)) return true;
      }
    } else if (this.took && (type === 'click' || type === 'dblclick' || type === 'contextmenu')) return true;
    return this.dispatch(type, x, y, native);
  }

  /**
   * A drag over the canvas at a point, carrying `files` files of these MIME
   * `types` (all a drag tells before its drop): to the surface under it, as
   * a press (the overlay by point, a panel by the raycast's texture
   * coordinate), whose items hear it as ren-canv's `dragOver` sends it.
   * Moving to another surface leaves the first, then enters the second.
   * Over no surface, the scene's objects under it hear `dragover` through
   * the raycast. Returns whether a surface or an object took it (the
   * browser's default is prevented only then).
   * @param {number} x @param {number} y @param {number} [files] @param {readonly string[]} [types] @param {any} [native]
   */
  dragOver(x, y, files = 0, types = [], native) {
    if (this.closed) return false;
    const at = this.surfaceAt(x, y, true);
    const surface = at === null ? null : at[0];
    const last = this.dragged;
    this.dragged = surface;
    if (last !== null && last !== surface && !last.closed) last.dragLeave();
    if (at !== null) {
      at[0].dragOver(at[1], at[2], files, types);
      return true;
    }
    return this.dispatch('dragover', x, y, native, { files, types });
  }

  /** The drag left the canvas (or was cancelled): the surface under it leaves. */
  dragLeave() {
    const last = this.dragged;
    this.dragged = null;
    if (last !== null && !last.closed) last.dragLeave();
  }

  /**
   * Files dropped at a point: on the surface under it (its items hear
   * `drop` with the files and the point in its pixels), else on the scene's
   * objects through the raycast (`onDrop` with `files`). A drop ends the
   * drag without a leave where it lands. Returns whether a surface or an
   * object took it.
   * @param {number} x @param {number} y @param {readonly any[]} files @param {any} [native]
   */
  dropFiles(x, y, files, native) {
    if (this.closed) return false;
    const at = this.surfaceAt(x, y, true);
    const last = this.dragged;
    this.dragged = null;
    if (last !== null && (at === null || last !== at[0]) && !last.closed) last.dragLeave();
    if (at !== null) {
      at[0].dropFiles(at[1], at[2], files);
      return true;
    }
    return this.dispatch('drop', x, y, native, { files });
  }

  /** Shows a three.js object's cursor on the canvas (null: the page's own). @param {any} object */
  shown(object) {
    const style = this.canvas?.style;
    if (style == null) return;
    const cursor = object === null ? '' : (this.cursorOf(object) ?? '');
    if (style.cursor !== cursor) style.cursor = cursor;
  }

  /**
   * The cursor over a three.js object: its own `cursor`, else the `cursor`
   * option where it has a press handler; null for none.
   * @param {any} object
   */
  cursorOf(object) {
    const s = slot(object);
    if (s.cursor !== null) return s.cursor;
    const handlers = s.handlers;
    return this.cursor !== null && handlers !== null && PRESSES.some(name => handlers[name] !== undefined) ? this.cursor : null;
  }

  /**
   * Takes a new theme for the primitives at once: the overlay and every
   * panel resolve, lay out and repaint; the scene and all state stay.
   * @param {import('ren-core/host').Tokens} tokens
   */
  setTheme(tokens) {
    this.options = { ...this.options, theme: tokens };
    for (const surface of this.surfaces) surface.setTheme(tokens);
    this.dirty = true;
    this.request();
  }

  /**
   * Shows the cursor of the primitives under the pointer on the canvas (their
   * style's `cursor`); leaves the page's own cursor over the scene.
   * @param {Surface | null} surface
   */
  show(surface) {
    const style = this.canvas?.style;
    if (style == null) return;
    const cursor = surface === null ? '' : surface.cursor === 'default' ? '' : surface.cursor;
    if (style.cursor !== cursor) style.cursor = cursor;
  }

  /**
   * Routes a canvas element's pointer, wheel, key and copy events: to the
   * primitives and the scene (`input`), keys and copy to the surface last
   * pressed (keys with none to the overlay or the first panel, for the
   * root's `$keys`; a chord reaches the handlers, as on ren-canv's attach).
   * The canvas takes the CSS its behavior asks (no touch callout, not
   * selectable itself). Returns the function that stops.
   * @param {any} canvas
   */
  attach(canvas) {
    if (canvas.tabIndex === undefined || canvas.tabIndex < 0) canvas.tabIndex = 0;
    const types = ['click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'pointermove', 'pointerleave', 'wheel'];
    /**
     * Where the pointer was last (a cancel reports 0, 0), whether its press
     * was taken, and the pans and zoom the primitives under it leave to the
     * page (their `touchAction`'s bits, -1 where none sets one, or no
     * surface is there): a touch keeps the page from what they forbid.
     */
    let lastX = 0;
    let lastY = 0;
    let taken = false;
    let allow = -1;
    /** A touch whose pan its first move decides (some pans allowed, not all), and where it started. */
    let pending = false;
    let startX = 0;
    let startY = 0;
    /** Whether a surface's native text entry (a focused Edit's) holds the DOM focus. */
    const held = () => {
      const active = canvas.ownerDocument?.activeElement;
      if (active == null) return false;
      for (const surface of this.surfaces) if (surface.entry !== null && surface.entry.area === active) return true;
      return false;
    };
    /**
     * A press of another button (a right press, for the app's menu) leaves
     * a focused Edit's native entry the DOM focus and its selection, which
     * the canvas would take as the press's default, as ren-canv's attach.
     * @param {any} e
     */
    const hold = e => {
      if ((e.button ?? 0) !== 0 && held()) e.preventDefault();
    };
    /** @param {any} e */
    const listener = e => {
      if (e.type === 'pointerdown' && typeof canvas.focus === 'function' && ((e.button ?? 0) === 0 || !held())) canvas.focus();
      // A drag keeps the pointer past the canvas's edge, as a native drag does (ren-canv's attach does the same).
      if (e.type === 'pointerdown' && (e.button ?? 0) === 0) {
        try {
          canvas.setPointerCapture?.(e.pointerId);
        } catch {
          // A synthetic pointer may not be capturable.
        }
      }
      // A canvas the page's CSS resized: the pointer in the pixels it is drawn in.
      const sx = canvas.clientWidth > 0 ? this.width / canvas.clientWidth : 1;
      const sy = canvas.clientHeight > 0 ? this.height / canvas.clientHeight : 1;
      const x = e.offsetX * sx;
      const y = e.offsetY * sy;
      // The browser's context menu opens only where the behavior keeps it (on a surface, as its `menu` answers:
      // an app's in an Edit) and no surface's item shows the app's own (prevent="contextmenu"); the objects still hear it.
      if (e.type === 'contextmenu') {
        const at = this.surfaceAt(x, y);
        if (at !== null ? !at[0].menu(at[1], at[2]) : !this.behavior.menu) e.preventDefault();
      }
      if (e.type === 'pointerdown' || e.type === 'pointermove') {
        lastX = x;
        lastY = y;
      }
      if (e.type === 'pointerdown') {
        const at = e.pointerType === 'touch' ? this.surfaceAt(x, y) : null;
        allow = at === null ? -1 : at[0].touchAction(at[1], at[2]);
      }
      const handled = this.input(e.type, x, y, e);
      if (e.type === 'pointerdown') taken = handled;
      if (handled && (e.type === 'wheel' || (e.type === 'pointerdown' && this.took))) e.preventDefault();
    };
    /**
     * A touch keeps the page from the pans and zoom the primitives under it
     * forbid (`touchAction`, as ren-canv's attach follows it): its
     * touchstart is cancelled when they allow nothing; its first move, when
     * it goes along an axis they forbid; a second finger's, when they forbid
     * a pinch zoom. Where none sets one, a touch that pressed a primitive or
     * an object with a handler is the app's: the page does not pan under it.
     * @param {any} e
     */
    const touch = e => {
      pending = false;
      if (e.cancelable === false) return;
      const fingers = e.touches?.length ?? 1;
      if (allow < 0) {
        if (taken) e.preventDefault();
      } else if (fingers > 1) {
        if ((allow & 4) === 0) e.preventDefault();
      } else if (allow === 0) e.preventDefault();
      else if ((allow & 3) !== 3) {
        pending = true;
        startX = e.touches?.[0]?.clientX ?? 0;
        startY = e.touches?.[0]?.clientY ?? 0;
      }
    };
    /** A touch's first move decides its pan: along an axis its primitives forbid, the page stays. @param {any} e */
    const moved = e => {
      if (allow < 0 || e.cancelable === false) return;
      if ((e.touches?.length ?? 1) > 1) {
        if ((allow & 4) === 0) e.preventDefault();
        return;
      }
      if (!pending) return;
      const dx = Math.abs((e.touches?.[0]?.clientX ?? startX) - startX);
      const dy = Math.abs((e.touches?.[0]?.clientY ?? startY) - startY);
      if (dx === 0 && dy === 0) return;
      pending = false;
      if ((allow & (dx > dy ? 1 : 2)) === 0) e.preventDefault();
    };
    /** The browser took the pointer back: the press ends where the pointer last was, with pointercancel. @param {any} e */
    const cancel = e => {
      taken = false;
      pending = false;
      this.input('pointercancel', lastX, lastY, e);
    };
    /** @param {any} e */
    const key = e => {
      const surface = this.active ?? this.overlay ?? this.surfaces.values().next().value ?? null;
      if (surface === null) return;
      if (surface.key(e.key, e.shiftKey, e)) e.preventDefault();
      // Ctrl or Cmd+A selects in the surface last pressed, and, with the behavior's `selectAll` off, never the browser's page.
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A') && ((surface === this.active && surface.selectAll()) || !this.behavior.selectAll)) e.preventDefault();
    };
    /** @param {any} e */
    const copy = e => {
      const text = this.active?.copied() ?? '';
      if (text === '' || e.clipboardData == null) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    /**
     * Files dragged over the canvas and dropped: to the surface or object
     * under them; the default (the browser opening a dropped file) is
     * prevented only where one takes them.
     * @param {any} e
     */
    const drag = e => {
      if (e.type === 'dragleave') return this.dragLeave();
      const x = e.offsetX * (canvas.clientWidth > 0 ? this.width / canvas.clientWidth : 1);
      const y = e.offsetY * (canvas.clientHeight > 0 ? this.height / canvas.clientHeight : 1);
      if (e.type === 'drop') {
        const files = e.dataTransfer?.files;
        if (this.dropFiles(x, y, files == null ? [] : [...files], e)) e.preventDefault();
        return;
      }
      const items = e.dataTransfer?.items;
      /** @type {string[]} */
      const kinds = [];
      if (items != null) for (const item of items) if (item.kind === 'file') kinds.push(item.type ?? '');
      if (this.dragOver(x, y, kinds.length, kinds, e)) e.preventDefault();
    };
    const drags = ['dragenter', 'dragover', 'dragleave', 'drop'];
    for (const type of types) canvas.addEventListener(type, listener, type === 'wheel' ? { passive: false } : undefined);
    for (const type of drags) canvas.addEventListener(type, drag);
    canvas.addEventListener('mousedown', hold);
    canvas.addEventListener('keydown', key);
    canvas.addEventListener('copy', copy);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('touchstart', touch, { passive: false });
    canvas.addEventListener('touchmove', moved, { passive: false });
    const undress = dress(canvas, this.behavior);
    return () => {
      undress();
      for (const type of types) canvas.removeEventListener(type, listener);
      for (const type of drags) canvas.removeEventListener(type, drag);
      canvas.removeEventListener('mousedown', hold);
      canvas.removeEventListener('keydown', key);
      canvas.removeEventListener('copy', copy);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('touchstart', touch);
      canvas.removeEventListener('touchmove', moved);
    };
  }
}

/**
 * Sets the CSS a behavior gives the canvas, as ren-canv's attach does: no
 * long-press callout or tap highlight without `callout`, and the canvas
 * itself not selectable without `select`. Returns the function that puts
 * back what was there.
 * @param {any} canvas @param {import('ren-core/host').Switches} behavior
 */
function dress(canvas, behavior) {
  const style = canvas?.style;
  if (style == null || typeof style.setProperty !== 'function') return () => {};
  /** @type {[string, string][]} */
  const set = [];
  if (!behavior.callout) set.push(['-webkit-touch-callout', 'none'], ['-webkit-tap-highlight-color', 'transparent']);
  if (!behavior.select) set.push(['user-select', 'none'], ['-webkit-user-select', 'none']);
  const was = set.map(([name]) => String(style.getPropertyValue(name) ?? ''));
  for (const [name, value] of set) style.setProperty(name, value);
  return () => {
    set.forEach(([name, value], i) => {
      if (style.getPropertyValue(name) !== value) return;
      if (was[i] === '') style.removeProperty(name);
      else style.setProperty(name, was[i]);
    });
  };
}

/**
 * What a `$animate` callback receives each frame. In a worker there is no
 * renderer, scene or camera: they are null there, and the callback changes
 * signals instead.
 */
export class Tick {
  /** @param {Renderer | null} renderer @param {number} time seconds @param {number} delta seconds since the last frame */
  constructor(renderer, time, delta) {
    this.renderer = renderer;
    this.scene = renderer === null ? null : renderer.scene;
    this.camera = renderer === null ? null : renderer.camera;
    this.time = time;
    this.delta = delta;
  }
}

/**
 * A three.js renderer for `mount` or an application root's `renderer`.
 * @param {Kit} kit the three.js namespace
 * @param {Options} [options]
 */
export function $three(kit, options) {
  return new Renderer(kit, options);
}

/**
 * Renders `view()` into a renderer's scene; returns the dispose function.
 * @param {() => any} view
 * @param {Renderer} target
 * @param {import('ren-core/host').Options} [options]
 * @returns {() => void}
 */
export function render(view, target, options) {
  if (!target.opened) target.open(null, 'main');
  const dispose = mount(target, view, target.scene, options);
  return () => {
    dispose();
    target.present();
  };
}

/**
 * Runs `fn` before every frame while the calling component lives (its
 * owner's cleanup stops it). Rendered by ren-three, it runs in the
 * renderer's frame loop, which draws every animation frame while any runs.
 * Anywhere else (a worker serving the view), it runs on that thread's own
 * frames (`requestAnimationFrame` where the thread has it, 16 ms timers
 * otherwise), with a Tick whose renderer, scene and camera are null.
 * @param {(frame: Tick) => void} fn
 */
export function $animate(fn) {
  const H = /** @type {any} */ ($surface());
  const R = $active();
  const owner = $owner(R);
  /**
   * Runs `fn` for a frame. What it throws goes to its owner's boundary (a
   * Recover around it), as a handler's error does; false when nothing
   * handled it (reported), and the callback is dropped.
   * @param {Tick} frame
   */
  const run = frame => {
    try {
      fn(frame);
      return true;
    } catch (error) {
      const left = $deliver(R, owner, error);
      // What the boundary shows now, it shows this frame.
      if (!(/** @type {any} */ (R).closed)) $flush(R);
      if (left === null) return true;
      const g = /** @type {any} */ (globalThis);
      if (typeof g.reportError === 'function') g.reportError(left);
      else console.error(left);
      return false;
    }
  };
  // A ren-three renderer (by shape, so a worker bundle carries no Renderer).
  if (H.kind === 'three' && H.animations instanceof Set) {
    H.animations.add(run);
    if (owner !== null) $cleanup(owner, () => H.animations.delete(run));
    H.request();
    return;
  }
  const g = /** @type {any} */ (globalThis);
  const raf = typeof g.requestAnimationFrame === 'function';
  let last = -1;
  let id = /** @type {any} */ (null);
  let live = true;
  /** @param {number} now */
  const tick = now => {
    if (!live) return;
    const time = now ?? performance.now();
    const delta = last < 0 ? 0 : (time - last) / 1000;
    last = time;
    try {
      if (!run(new Tick(null, time / 1000, delta))) live = false;
    } finally {
      // timer: feature, the animation's frame loop; fallback, 60 frames a second where the host has no requestAnimationFrame.
      if (live) id = raf ? g.requestAnimationFrame(tick) : setTimeout(() => tick(performance.now()), 16);
    }
  };
  // timer: feature, as above (fallback without requestAnimationFrame).
  id = raf ? g.requestAnimationFrame(tick) : setTimeout(() => tick(performance.now()), 16);
  if (owner !== null)
    $cleanup(owner, () => {
      live = false;
      if (raf) g.cancelAnimationFrame(id);
      else clearTimeout(id);
    });
}
