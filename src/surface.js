// The portable primitives in a three.js scene: a Surface is a ren-canv
// Document (layout, portable style, text, editing, selection, the native
// text entry and the accessibility mirror) drawn with a 2D canvas into a
// three.js texture.
//
// - The overlay: primitives placed in the scene itself lie over the canvas,
//   pixel for pixel, drawn after the scene (a quad in front of an
//   orthographic camera). The whole canvas is its page.
// - A panel: primitives placed in a three.js object become a plane in that
//   object, as large as their content (`pixel` world units per pixel),
//   facing +z; the texture has `scale` pixels per pixel.
//
// Input reaches a surface in its own pixels: the overlay's are the
// canvas's; a panel's come from the raycast hit's texture coordinate.

import { Document, attach } from 'ren-canv';
import { Replay2D } from 'ren-canv/backend';

/** The kinds of ren-canv's items that take the focus: an Edit, an Action. */
const EDIT = 4;
const ACTION = 5;

/** @typedef {import('./index.js').Renderer} Renderer */

export class Surface extends Document {
  /**
   * @param {Renderer} owner @param {boolean} panel
   */
  constructor(owner, panel) {
    const options = owner.options;
    super(/** @type {any} */ (owner.fonts()), {
      width: panel ? 1 : owner.width,
      height: panel ? 1 : owner.height,
      scale: owner.scale,
      theme: options.theme,
      background: 0,
      aria: options.aria,
      behavior: options.behavior,
      fit: panel,
      layout: options.layout,
    });
    const kit = owner.kit;
    this.owner = owner;
    this.panel = panel;
    this.replay = new Replay2D(
      owner.family,
      owner.picture,
      () => {
        this.damage = true;
        this.full = true;
        this.present();
      },
      owner.monoFamily,
      // A source that fails: its Images hear `error`; one that left the cache is loaded again.
      source => this.failed(source),
      source => this.forgot(source),
      owner.typefaces,
    );
    /** The 2D canvas it draws on, where there is a document. @type {any} */
    this.image = null;
    /** @type {any} */
    this.ctx = null;
    const doc = owner.canvas?.ownerDocument ?? null;
    if (doc !== null) {
      const image = doc.createElement('canvas');
      const ctx = typeof image.getContext === 'function' ? image.getContext('2d') : null;
      if (ctx != null) {
        this.image = image;
        this.ctx = ctx;
      }
    }
    this.texture = new kit.CanvasTexture(this.image ?? undefined);
    if (kit.SRGBColorSpace !== undefined) this.texture.colorSpace = kit.SRGBColorSpace;
    const material = new kit.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: !panel, side: panel ? kit.DoubleSide : kit.FrontSide });
    // The overlay fills the orthographic view (-1..1); a panel is a unit
    // plane scaled to its size.
    this.mesh = new kit.Mesh(new kit.PlaneGeometry(panel ? 1 : 2, panel ? 1 : 2), material);
    this.mesh.userData.surface = this;
    this.mesh.visible = false;
    this.grow();
    /** Stops the entry and mirror beside the three.js canvas. @type {(() => void) | null} */
    this.stop = null;
    if (owner.canvas != null && doc !== null) this.stop = attach(this, owner.canvas, { input: false, shift: !panel });
    // A frame that changes the cursor under a still pointer (a press, a restyle) shows it while the pointer is here.
    this.aimed = () => {
      if ((owner.grab ?? owner.over) === this) owner.show(this);
    };
  }

  get kind() {
    return 'three';
  }

  get drawing() {
    return this.ctx !== null;
  }

  /** Sizes the canvas and the texture to the page, and a panel's plane. */
  grow() {
    const image = this.image;
    if (image !== null) {
      const w = Math.max(1, Math.round(this.width * this.scale));
      const h = Math.max(1, Math.round(this.height * this.scale));
      if (image.width !== w || image.height !== h) {
        image.width = w;
        image.height = h;
        // A texture keeps its size on the GPU: a new size needs a new upload.
        this.texture.dispose();
      }
    }
    if (this.panel) {
      const pixel = this.owner.pixel;
      this.mesh.scale.set(this.width * pixel, this.height * pixel, 1);
    }
    this.full = true;
  }

  sized() {
    this.grow();
  }

  /** @param {import('ren-canv/backend').Frame} frame @param {import('ren-canv/backend').Damage | null} damage */
  draw(frame, damage) {
    this.replay.run(this.ctx, frame, this.scale, 0, damage, this.shiftX, this.shiftY);
    this.texture.needsUpdate = true;
    this.owner.dirty = true;
    this.owner.request();
  }

  present() {
    const painted = super.present();
    // Shown while it holds anything.
    const shown = this.root.first !== null || this.overlay.first !== null;
    if (this.mesh.visible !== shown) {
      this.mesh.visible = shown;
      this.owner.dirty = true;
      this.owner.request();
    }
    return painted;
  }

  /**
   * Keyboard focus to `item` in this surface (null blurs), as ren-canv's
   * Document moves it, taking the focus from every other surface of the
   * renderer first: one surface has the focus and hears the keys, also when
   * code focuses an item (`focus()`, `focusFirst()`, ren-core's `$focus`)
   * rather than a press. An item that cannot take the focus (not an Edit
   * or an Action, or disabled) takes it from no other surface. A blur
   * handler there that moves the focus (in its own surface or this one)
   * wins, and `item` hears nothing, as in Chrome.
   * @param {import('ren-canv').Item | null} item @param {boolean} [ring]
   */
  focus(item, ring = false) {
    if (item !== null && (item.kind === EDIT || item.kind === ACTION) && !item.disabled && !this.closed) {
      const owner = this.owner;
      const before = this.current;
      for (const surface of owner.surfaces) if (surface !== this) surface.focus(null);
      // A blur handler moved the focus: its move wins.
      if (this.current !== before) return;
      for (const surface of owner.surfaces) if (surface !== this && surface.current !== null) return;
      owner.active = this;
    }
    super.focus(item, ring);
  }

  /**
   * Whether the item under a point, or an ancestor, hears a drag or a drop:
   * where the overlay takes files dragged over it though nothing is painted
   * there (a bare View with `onDrop`), as the DOM's element under them.
   * @param {number} x @param {number} y
   */
  drops(x, y) {
    return this.dropTarget(x, y) !== null;
  }

  /**
   * Where a box of the page shows on screen: the overlay's is the canvas's;
   * a panel's corners are projected through the camera.
   * @param {any} canvas @param {number} x @param {number} y @param {number} right @param {number} bottom
   * @returns {[number, number, number, number]}
   */
  screen(canvas, x, y, right, bottom) {
    if (!this.panel) return super.screen(canvas, x, y, right, bottom);
    const owner = this.owner;
    let left = Infinity;
    let top = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const [px, py] of [[x, y], [right, y], [x, bottom], [right, bottom]]) {
      const [sx, sy] = owner.project(this, px, py);
      left = Math.min(left, sx);
      top = Math.min(top, sy);
      r = Math.max(r, sx);
      b = Math.max(b, sy);
    }
    return [(canvas.offsetLeft ?? 0) + left, (canvas.offsetTop ?? 0) + top, r - left, b - top];
  }

  close() {
    if (this.closed) return;
    if (this.stop !== null) this.stop();
    this.stop = null;
    super.close();
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
