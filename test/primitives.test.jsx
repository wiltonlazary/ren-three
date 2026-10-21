// The portable primitives on ren-three: in the scene they lie over the canvas
// (the overlay), in a three.js object they are a panel in it; either way
// ren-canv lays them out, styles, edits and selects them, and input reaches
// them before the scene's raycast. In node there is no 2D canvas: the
// frames are checked as commands, and input by coordinates.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import * as THREE from 'three';
import { $signal, $read, $write } from 'rrx-core';
import { Root, View, Label, Edit, Action, Scroll, Show, Image, $active, $keys, $scrolls, $presses, $dispose, $focus, editOf, textAt, selectText, selectedText } from 'ren-core';
import { $three, render, loadLayout, remoteLayout } from 'ren-three';
import { serveLayout } from 'ren-canv/worker';
import { Sfnt } from 'ren-canv';
import { closeAfter } from './fixtures/after.js';


/** The happy-dom windows this file's tests open, each closed after its test (its window.close() frees nothing). @type {HappyWindow[]} */
const windows = [];
/** happy-dom's Window, tracked for closing. */
class Window extends HappyWindow {
  /** @param {ConstructorParameters<typeof HappyWindow>} args */
  constructor(...args) {
    super(...args);
    windows.push(this);
  }
}
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/** The layout engine (Taffy's WebAssembly), once, before any renderer. */
await loadLayout();

/** DejaVu Sans, from the test fixtures (with its license). */
const font = readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url));
const stub = () => ({ render() {}, setSize() {} });
/** A 200 × 100 renderer, its camera at z 5 looking at the origin. @param {{ behavior?: import('ren-core/host').Behavior }} [options] */
const setup = (options = {}) => $three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font, ...options });
const texts = (/** @type {any} */ surface) => surface.commands().filter((/** @type {any[]} */ c) => c[0] === 'text').map((/** @type {any[]} */ c) => c[1]);

describe('ren-three primitives', () => {
  it('loads an Image source as an image element of the document by default', async () => {
    const three = /** @type {any} */ (setup());
    /** @type {any[]} */
    const made = [];
    const saved = globalThis.document;
    /** @type {any} */ (globalThis).document = { createElement: (/** @type {string} */ tag) => (made.push({ tag }), made[made.length - 1]) };
    try {
      const loading = three.picture('data:image/png;base64,AAAA');
      assert.equal(made[0].tag, 'img');
      assert.equal(made[0].src, 'data:image/png;base64,AAAA');
      made[0].onload();
      assert.equal(await loading, made[0], 'the element, once loaded');
      const failing = three.picture('nope.png');
      made[1].onerror();
      assert.equal(await failing, null, 'null when it fails');
    } finally {
      /** @type {any} */ (globalThis).document = saved;
    }
  });

  it('lays primitives in the scene over the canvas, and sends the pointer on where they have nothing', () => {
    const three = setup();
    /** @type {string[]} */
    const log = [];
    render(() => (
      <>
        <mesh name="box" onClick={() => log.push('box')}>
          <boxGeometry params={[4, 4, 1]} />
          <meshBasicMaterial />
        </mesh>
        <View style={{ padding: 4 }}>
          <Action text="Go" onPress={() => log.push('go')} />
        </View>
      </>
    ), three);
    const overlay = /** @type {any} */ (three.overlay);
    assert.ok(overlay.mesh.visible);
    assert.deepEqual(texts(overlay), ['Go']);
    assert.equal(overlay.width, 200, 'the overlay is the canvas');
    // The Action, 4 in and a field (38) high: pressed, and its click does not reach the box.
    three.input('pointerdown', 100, 20);
    three.input('click', 100, 20);
    assert.deepEqual(log, ['go']);
    // Below it the overlay has nothing: the pointer raycasts into the scene.
    three.input('pointerdown', 100, 80);
    three.input('click', 100, 80);
    assert.deepEqual(log, ['go', 'box']);
  });

  it('takes no pointer on what is not drawn: a mesh in a hidden group, a hidden mesh in front, a panel in a hidden group', () => {
    const box = () => [<boxGeometry params={[4, 4, 1]} />, <meshBasicMaterial />];
    /** @type {string[]} */
    const log = [];
    const hiddenGroup = setup();
    render(() => <group visible={false}><mesh onClick={() => log.push('hidden mesh')}>{box()}</mesh></group>, hiddenGroup);
    hiddenGroup.input('click', 100, 50);
    assert.deepEqual(log, [], 'a mesh in a hidden group is not clicked');
    hiddenGroup.close();
    const hiddenFront = setup();
    render(() => [
      <mesh position-z={2} visible={false}>{box()}</mesh>,
      <mesh onClick={() => log.push('back')}>{box()}</mesh>,
    ], hiddenFront);
    hiddenFront.input('click', 100, 50);
    assert.deepEqual(log.splice(0), ['back'], 'a hidden mesh in front hides nothing behind it');
    hiddenFront.close();
    const hiddenPanel = setup();
    render(() => (
      <group visible={false}>
        <View style={{ width: 400, height: 400 }}>
          <Action text="Tap" style={{ width: 400, height: 400 }} onPress={() => log.push('panel press')} />
        </View>
      </group>
    ), hiddenPanel);
    hiddenPanel.present();
    for (const type of ['pointerdown', 'pointerup', 'click']) hiddenPanel.input(type, 100, 50);
    assert.deepEqual(log, [], 'a panel in a hidden group takes no press');
    hiddenPanel.close();
  });

  it('gives the pointer to the overlay before the scene: a move over an Action leaves the mesh behind, a wheel stays in the overlay', () => {
    const three = setup();
    /** @type {string[]} */
    const log = [];
    render(() => [
      <mesh onPointerOver={() => log.push('mesh over')} onPointerOut={() => log.push('mesh out')} onPointerMove={() => log.push('mesh move')} onWheel={() => log.push('mesh wheel')}>
        <boxGeometry params={[4, 4, 1]} />
        <meshBasicMaterial />
      </mesh>,
      <View style={{ padding: 4 }}>
        <Action text="Go" onPointerMove={() => log.push('action move')} />
      </View>,
    ], three);
    three.present();
    three.input('pointermove', 100, 60);
    assert.deepEqual(log.splice(0), ['mesh over', 'mesh move'], 'off the overlay, the mesh hears the move');
    three.input('pointermove', 100, 20);
    assert.deepEqual(log.splice(0), ['action move', 'mesh out'], 'over the Action: the Action moves, the mesh is left');
    three.input('wheel', 100, 20, { deltaY: 10 });
    assert.deepEqual(log.splice(0), [], 'a wheel over the overlay does not fall through to the mesh');
    three.close();
    // A panel is in the scene: over it, its group keeps the pointer (no out), and hears the press.
    const card = setup();
    render(() => (
      <group onPointerOver={() => log.push('over')} onPointerOut={() => log.push('out')} onPointerDown={() => log.push('down')}>
        <mesh position-z={-0.2}><boxGeometry params={[4, 4, 0.1]} /><meshBasicMaterial /></mesh>
        <View style={{ width: 100, height: 60 }}><Label text="Card" /></View>
      </group>
    ), card);
    card.present();
    const panel = /** @type {any} */ ([...card.surfaces].find(s => /** @type {any} */ (s).panel));
    card.input('pointermove', 80, 50);
    const [px, py] = card.project(panel, 50, 30);
    card.input('pointermove', px, py);
    card.input('pointerdown', px, py);
    assert.deepEqual(log.splice(0), ['over', 'down'], 'over the panel the group is not left');
    card.close();
  });

  it('forgets an overlay image source that failed once its cache evicts it: a reload that works hears no error', async () => {
    let bad = 0;
    const three = /** @type {any} */ ($three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font, image: (/** @type {string} */ source) => {
      if (source !== 'bad.png') return /** @type {any} */ ({ width: 1, height: 1 });
      return ++bad === 1 ? Promise.reject(new Error('404')) : /** @type {any} */ ({ width: 1, height: 1 });
    } }));
    /** @type {string[]} */
    const heard = [];
    /** @type {any} */
    let shown = null;
    render(() => {
      shown = $signal($active(), false);
      return <View><Show when={() => $read(shown)}><Image source="bad.png" width={4} height={4} onError={() => heard.push('error')} /></Show></View>;
    }, three);
    three.present();
    const overlay = three.overlay;
    const replay = overlay.replay;
    // The overlay's replay loads it and it fails (as a frame drawing it would).
    replay.image('bad.png');
    // The rejected load's handler runs in a microtask.
    for (let k = 0; k < 3; k++) await Promise.resolve();
    assert.ok(overlay.broken.has('bad.png'), 'the failure is known');
    // Whole repaints of 40 other images push it out of the cache.
    for (let f = 0; f < 3; f++) {
      replay.frame++;
      replay.whole = replay.frame;
      for (let i = 0; i < 40; i++) replay.image(`ok${f}-${i}.png`);
      replay.evict();
    }
    assert.equal(overlay.broken.has('bad.png'), false, 'the surface forgot it with its cache entry');
    // Drawn again, it loads (and works): an Image on it hears no error.
    replay.image('bad.png');
    $write(shown, true);
    three.present();
    await Promise.resolve();
    assert.equal(bad, 2);
    assert.deepEqual(heard, []);
    three.close();
  });

  it('lets a root-wide listener go of the panels that closed', () => {
    const three = /** @type {any} */ (setup());
    /** @type {any} */
    let shown = null;
    render(() => {
      shown = $signal($active(), true);
      $keys(() => {});
      return <group><Show when={() => $read(shown)}>{() => <mesh><View><Label text="panel" /></View></mesh>}</Show></group>;
    }, three);
    three.present();
    for (let i = 0; i < 50; i++) {
      $write(shown, false);
      three.present();
      $write(shown, true);
      three.present();
    }
    const [rooted] = [...three.rooted];
    // A closed panel leaves the listener's removers, so nothing holds it.
    assert.equal(rooted.off.size, three.surfaces.size, 'one remover per live surface');
    three.close();
  });

  it('keeps the order of the view among three.js objects', () => {
    const three = setup();
    const R = { open: /** @type {any} */ (null) };
    const App = () => {
      R.open = $signal($active(), true);
      return (
        <>
          <Show when={R.open}><View><Label text="a" /></View></Show>
          <mesh />
          <View><Label text="b" /></View>
        </>
      );
    };
    render(() => <App />, three);
    const overlay = /** @type {any} */ (three.overlay);
    assert.deepEqual(texts(overlay), ['a', 'b']);
    $write(R.open, false);
    three.present();
    assert.deepEqual(texts(overlay), ['b']);
    $write(R.open, true);
    three.present();
    assert.deepEqual(texts(overlay), ['a', 'b'], 'back before the second, as in the view');
  });

  it('makes primitives in a three.js object a panel: a plane its size, pressed and edited through the raycast', () => {
    const three = setup();
    let taps = 0;
    const App = () => {
      const value = $signal($active(), '');
      return (
        <group name="holder">
          <View style={{ width: 100, padding: 10, background: '#ffffff' }}>
            <Action text="Tap" onPress={() => taps++} />
            <Edit value={value} onChange={e => $write(value, e.value)} />
            <Label text={() => `typed ${$read(value)}`} />
          </View>
        </group>
      );
    };
    render(() => <App />, three);
    const holder = three.scene.getObjectByName('holder');
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    assert.ok(panel.mesh.parent === holder, 'the plane is in the object');
    // The View's width; its height: padding, a field for the Action and the Edit, a line of text.
    assert.equal(panel.width, 100);
    assert.equal(panel.height, Math.ceil(10 + 38 + 38 + 17 * 1.4 + 10));
    assert.deepEqual([panel.mesh.scale.x, panel.mesh.scale.y], [1, panel.height * 0.01], '0.01 world units a pixel');
    // Press the Action where it shows on the canvas.
    const [ax, ay] = three.project(panel, 50, 10 + 19);
    three.input('pointerdown', ax, ay);
    three.input('pointerup', ax, ay);
    assert.equal(taps, 1);
    // Focus the Edit and type into it.
    const [ex, ey] = three.project(panel, 50, 10 + 38 + 19);
    three.input('pointerdown', ex, ey);
    assert.equal(three.active, panel);
    assert.equal(panel.focused?.kind, 4);
    panel.type('hi');
    three.present();
    assert.ok(texts(panel).includes('typed hi'));
  });

  it("tells an item in a panel its size, as in the overlay (onResize)", () => {
    // The panel adopts items the overlay made; rui-show's panel stage follows its demo's height by this.
    const three = setup();
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <>
        <group>
          <View onResize={(/** @type {any} */ e) => heard.push(`panel ${e.width}x${e.height}`)} style={{ width: 100, height: 50 }} />
        </group>
        <View onResize={(/** @type {any} */ e) => heard.push(`overlay ${e.width}x${e.height}`)} style={{ width: 60, height: 20 }} />
      </>
    ), three);
    three.present();
    assert.deepEqual(heard.sort(), ['overlay 60x20', 'panel 100x50']);
  });

  it('selects text in the overlay with a drag, and copies it', () => {
    // A page's: loose text selects.
    const three = setup({ behavior: 'page' });
    render(() => <View><Label text="select this text" /></View>, three);
    const overlay = /** @type {any} */ (three.overlay);
    three.input('pointerdown', 1, 10);
    three.input('pointermove', 190, 10);
    three.input('pointerup', 190, 10);
    assert.equal(overlay.copied(), 'select this text');
    assert.equal(three.active, overlay);
  });

  it('frees a panel with its primitives, and refuses three.js objects inside primitives', () => {
    const three = setup();
    const App = () => {
      const open = $signal($active(), true);
      App.open = open;
      return <group name="g"><Show when={open}><View><Label text="x" /></View></Show></group>;
    };
    /** @type {any} */ (App).open = null;
    render(() => <App />, three);
    const group = three.scene.getObjectByName('g');
    assert.equal(group.children.length, 1);
    $write(/** @type {any} */ (App).open, false);
    three.present();
    assert.equal(group.children.length, 0, 'the plane left the object');
    assert.equal([...three.surfaces].filter(s => /** @type {any} */ (s).panel).length, 0, 'and its surface is freed');
    assert.throws(() => render(() => <View><mesh /></View>, setup()), /a three.js object cannot go inside a primitive/);
  });

  it('lays out the overlay and panels in a layout worker, as in this thread', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const view = () => (
      <>
        <View style={{ padding: 4 }}>
          <Action text="Go" />
        </View>
        <group>
          <View style={{ width: 100, padding: 10 }}>
            <Label wrap text="a panel sized by its content" />
          </View>
        </group>
      </>
    );
    const here = setup();
    const there = $three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font, layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      layout.close();
      stop();
      channel.port1.close();
    });
    render(view, here);
    render(view, there);
    const surfaces = (/** @type {any} */ three) => [three.overlay, [...three.surfaces].find(s => /** @type {any} */ (s).panel)];
    // Each paints once the worker answers (`framed`, after each frame).
    for (const s of surfaces(there))
      while (s.boxes.engine.busy || s.damage || s.frames === 0) {
        assert.ok(s.boxes.engine.busy, 'damage with no layout in flight: nothing paints it');
        await new Promise(resolve => (s.framed = resolve));
      }
    const [overlay, panel] = surfaces(there);
    const [overlay0, panel0] = surfaces(here);
    assert.deepEqual(overlay.commands(), overlay0.commands(), 'the overlay');
    assert.deepEqual([panel.width, panel.height], [panel0.width, panel0.height], 'the panel fits its content');
    assert.deepEqual(panel.commands(), panel0.commands());
  });

  it('sends pointer events to the primitives of the overlay: a drag held by a capture, modifiers from the host event', () => {
    const three = setup();
    /** @type {string[]} */
    const seen = [];
    const note = (/** @type {any} */ e) => void seen.push(`${e.type} ${Math.round(e.offsetX)},${Math.round(e.offsetY)}${e.ctrlKey ? ' ctrl' : ''}`);
    render(() => <View style={{ width: 80, height: 40, margin: 4 }} onPointerDown={(/** @type {any} */ e) => (note(e), e.currentTarget.setPointerCapture(e.pointerId))} onPointerMove={note} onPointerUp={note} />, three);
    three.input('pointerdown', 20, 20, /** @type {any} */ ({ ctrlKey: true, button: 0, buttons: 1 }));
    three.input('pointermove', 150, 90, /** @type {any} */ ({ buttons: 1 }));
    three.input('pointerup', 150, 90, /** @type {any} */ ({ buttons: 0 }));
    assert.deepEqual(seen, ['pointerdown 16,16 ctrl', 'pointermove 146,86', 'pointerup 146,86']);
  });

  it('shows the cursor of the primitives under the pointer on its canvas, and the page\'s over the scene', () => {
    const three = $three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font });
    render(() => <View style={{ width: 80, height: 40, cursor: 'pointer' }} onPointerDown={() => {}} />, three);
    // A canvas element's style (node has none: render opened without a document).
    const canvas = /** @type {any} */ ({ style: { cursor: '' } });
    three.canvas = canvas;
    three.input('pointermove', 20, 20);
    assert.equal(canvas.style.cursor, 'pointer');
    three.input('pointermove', 150, 90);
    assert.equal(canvas.style.cursor, '', 'over the scene: the page\'s own');
  });

  it('shows the cursor of a panel\'s primitives, and one a press or a frame changes under a still pointer', () => {
    const three = setup();
    const R = Root('panel-cursor');
    const tool = $signal(R, 'move');
    render(() => (
      <group onClick={() => {}}>
        <View style={{ width: 100 }}>
          <View style={{ height: 30, cursor: 'grab', press: { cursor: 'grabbing' } }} onPress={() => {}} />
          <View style={() => ({ height: 30, cursor: $read(tool) })} />
        </View>
      </group>
    ), three, { root: R });
    const canvas = /** @type {any} */ ({ style: { cursor: '' } });
    three.canvas = canvas;
    three.present();
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    const [ax, ay] = three.project(panel, 50, 15);
    three.input('pointermove', ax, ay);
    assert.equal(canvas.style.cursor, 'grab', 'the panel\'s item, not its group\'s hand');
    three.input('pointerdown', ax, ay);
    assert.equal(canvas.style.cursor, 'grabbing', 'pressed, with no move');
    three.input('pointerup', ax, ay);
    assert.equal(canvas.style.cursor, 'grab', 'released');
    const [bx, by] = three.project(panel, 50, 45);
    three.input('pointermove', bx, by);
    assert.equal(canvas.style.cursor, 'move');
    $write(tool, 'crosshair');
    three.present();
    assert.equal(canvas.style.cursor, 'crosshair', 'a restyle under a still pointer');
    $dispose(R);
  });

  it('measures a monospace family in the mono typeface', () => {
    const mono = readFileSync(new URL('./fixtures/dejavu-mono.ttf', import.meta.url));
    const three = $three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font, mono });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ el) => (refs.code = el)} text="iiii" style={{ fontFamily: 'monospace', fontSize: 20 }} />
        <Label ref={(/** @type {any} */ el) => (refs.prose = el)} text="iiii" style={{ fontSize: 20 }} />
      </View>
    ), three);
    three.frame();
    const code = refs.code.getBoundingClientRect().width;
    assert.ok(Math.abs(code - new Sfnt(mono).width('iiii', 20)) < 0.01, 'the mono file measures it');
    assert.ok(refs.prose.getBoundingClientRect().width < code * 0.6);
    assert.equal(/** @type {any} */ (three.overlay).commands().find((/** @type {any[]} */ c) => c[0] === 'text')[6], 4, 'drawn in the monospace face');
  });

  it('sets a named family in its typeface and a character the typeface lacks in a fallback, each drawn in its registered family', () => {
    // The monospace file has no Hebrew; DejaVu Sans has.
    const mono = readFileSync(new URL('./fixtures/dejavu-mono.ttf', import.meta.url));
    const three = /** @type {any} */ ($three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font: mono, families: { Sans: font }, fallback: [font] }));
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ el) => (refs.named = el)} text="iiii" style={{ fontFamily: 'Sans', fontSize: 20 }} />
        <Label text={'a\u05d0'} style={{ fontSize: 20 }} />
      </View>
    ), three);
    three.frame();
    assert.ok(Math.abs(refs.named.getBoundingClientRect().width - new Sfnt(font).width('iiii', 20)) < 0.01, 'the named file measures it');
    const drawn = three.overlay.commands().filter((/** @type {any[]} */ c) => c[0] === 'text').map((/** @type {any[]} */ c) => [c[1], c[6]]);
    assert.deepEqual(drawn, [['iiii', 1 << 4], ['a', 0], ['\u05d0', 8 | (2 << 4)]], 'slot 1 the named one, slot 2 the fallback (right to left)');
    assert.deepEqual(three.typefaces, [null, `${three.family}-1`, `${three.family}-2`]);
    assert.equal(three.overlay.replay.faces, three.typefaces, 'the 2D canvas draws each slot in its family');
  });

  it('takes a new theme at once for the overlay and the panels, the scene staying', () => {
    const three = $three(THREE, { renderer: stub(), width: 200, height: 100, schedule: false, font, theme: { accent: 0xff112233 } });
    render(() => (
      <>
        <Action text="over" />
        <group name="holder"><Action text="panel" /></group>
      </>
    ), three);
    const fills = (/** @type {any} */ surface) => surface.commands().filter((/** @type {any[]} */ c) => c[0] === 'round').map((/** @type {any[]} */ c) => c[5]);
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    const holder = three.scene.getObjectByName('holder');
    assert.deepEqual([fills(three.overlay), fills(panel)], [['#ff112233'], ['#ff112233']]);
    /** @type {any} */ (three).setTheme({ accent: 0xff445566 });
    assert.deepEqual([fills(three.overlay), fills(panel)], [['#ff445566'], ['#ff445566']]);
    assert.equal(three.scene.getObjectByName('holder'), holder, 'the scene stays');
  });

  it('measures a panel\'s items in the panel\'s pixels, places and stacks them, and paints what an Action holds', () => {
    const three = setup();
    let taps = 0;
    /** @type {any} */
    const refs = {};
    render(() => (
      <group>
        <View style={{ width: 120, padding: 10 }}>
          <Action ref={(/** @type {any} */ el) => (refs.action = el)} onPress={() => taps++}>
            <Label ref={(/** @type {any} */ el) => (refs.label = el)} text="inside" />
          </Action>
          <View ref={(/** @type {any} */ el) => (refs.pop = el)} style={{ position: 'absolute', top: '50%', left: 30, width: '25%', height: 12, zIndex: 1, background: '#123456' }} />
        </View>
      </group>
    ), three);
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    panel.present();
    assert.deepEqual(panel.height, 10 + 38 + 10);
    const a = refs.action.getBoundingClientRect();
    assert.deepEqual([a.x, a.y, a.width, a.height], [10, 10, 100, 38], 'in the panel\'s own pixels');
    assert.deepEqual(refs.pop.getBoundingClientRect(), { x: 30, y: 29, left: 30, top: 29, right: 60, bottom: 41, width: 30, height: 12 });
    assert.ok(texts(panel).includes('inside'), 'what the Action holds is painted');
    const fills = panel.commands().filter((/** @type {any[]} */ c) => c[0] === 'rect' || c[0] === 'round').map((/** @type {any[]} */ c) => c[5]);
    assert.equal(fills[fills.length - 1], '#ff123456', 'the stacked item paints over the Action');
    const l = refs.label.getBoundingClientRect();
    const [x, y] = three.project(panel, l.x + 2, l.y + 2);
    three.input('pointerdown', x, y);
    three.input('pointerup', x, y);
    assert.equal(taps, 1, 'a press on its content presses the Action');
  });

  it('lets a panel\'s items act on the panel: a ref focuses there', () => {
    const three = setup();
    /** @type {any} */
    let field = null;
    render(() => <group><View style={{ width: 120 }}><Edit value="" ref={(/** @type {any} */ el) => (field = el)} /></View></group>, three);
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    panel.present();
    field.focus();
    assert.equal(panel.current, field, 'focused on its panel, not the overlay');
  });

  it('keeps the focus in one surface: code that focuses an item in another takes it from the rest, and keys follow', () => {
    const three = /** @type {any} */ (setup());
    /** @type {string[]} */
    const log = [];
    /** @type {Record<string, any>} */
    const refs = {};
    /** @param {string} tag */
    const on = tag => ({
      ref: (/** @type {any} */ n) => (refs[tag] = n),
      text: tag,
      onFocus: () => log.push(`${tag} focus`),
      onBlur: () => log.push(`${tag} blur`),
      onKey: (/** @type {any} */ e) => log.push(`${tag} key ${e.key}`),
    });
    render(() => (
      <>
        <Action {...on('O')} style={{ width: 30 }} />
        <group position={[-1, 0, 0]}>
          <View style={{ width: 80, padding: 4 }}>
            <Action {...on('A')} />
          </View>
        </group>
        <group position={[1, 0, 0]}>
          <View ref={(/** @type {any} */ n) => (refs.trap = n)} trap style={{ width: 80, padding: 4 }}>
            <Action {...on('B')} />
            <Action {...on('C')} />
          </View>
        </group>
      </>
    ), three);
    three.frame(0);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => void (listeners[t] = fn), removeEventListener() {} });
    const press = (/** @type {string} */ key, shiftKey = false) => listeners.keydown({ type: 'keydown', key, ctrlKey: false, metaKey: false, altKey: false, shiftKey, preventDefault() {} });
    const surfaceOf = (/** @type {string} */ tag) => three.page(refs[tag]);
    /** The surfaces with a focused item. */
    const focused = () => [...three.surfaces].filter(s => s.focused !== null).map(s => s.focused.text);
    const a = surfaceOf('A');
    const [ax, ay] = three.project(a, 40, 10);
    three.input('pointerdown', ax, ay);
    three.input('pointerup', ax, ay);
    assert.ok(three.active === a);
    log.length = 0;
    refs.B.focus();
    press('x');
    assert.deepEqual(log.splice(0), ['A blur', 'B focus', 'B key x'], "an item's focus()");
    assert.ok(three.active === surfaceOf('B'));
    assert.deepEqual(focused(), ['B']);
    refs.O.focus();
    press('y');
    assert.deepEqual(log.splice(0), ['B blur', 'O focus', 'O key y'], 'into the overlay');
    assert.ok(three.active === three.overlay);
    assert.deepEqual(focused(), ['O']);
    assert.equal($focus(refs.trap, true), true);
    press('z');
    assert.deepEqual(log.splice(0), ['O blur', 'C focus', 'C key z'], "$focus(ref, true): a trap's last, from the overlay");
    assert.deepEqual(focused(), ['C']);
    press('Tab');
    assert.deepEqual(log.splice(0), ['C key Tab', 'C blur', 'B focus'], 'Tab cycles inside the trap');
    assert.deepEqual(focused(), ['B']);
    assert.equal($focus(refs.A.parent), true);
    press('w');
    assert.deepEqual(log.splice(0), ['B blur', 'A focus', 'A key w'], '$focus(ref) into another panel');
    assert.deepEqual(focused(), ['A']);
    assert.equal(refs.trap.focusFirst(), true);
    assert.deepEqual(log.splice(0), ['A blur', 'B focus'], 'focusFirst');
    assert.ok(three.active === surfaceOf('B'));
    assert.deepEqual(focused(), ['B']);
  });

  it('takes the focus from no other surface for an item that cannot take it', () => {
    const three = /** @type {any} */ (setup());
    /** @type {Record<string, any>} */
    const refs = {};
    render(() => (
      <>
        <group position={[-1, 0, 0]}>
          <View style={{ width: 80, padding: 4 }}>
            <Action ref={(/** @type {any} */ n) => (refs.A = n)} text="A" />
          </View>
        </group>
        <group position={[1, 0, 0]}>
          <View ref={(/** @type {any} */ n) => (refs.view = n)} style={{ width: 80, padding: 4 }}>
            <Label ref={(/** @type {any} */ n) => (refs.label = n)}>x</Label>
          </View>
        </group>
      </>
    ), three);
    three.frame(0);
    const focused = () => [...three.surfaces].filter(s => s.focused !== null).map(s => s.focused.text);
    const a = three.page(refs.A);
    const b = three.page(refs.view);
    refs.A.focus();
    // Told to focus an item that cannot take the focus (a View, a Label), as Chrome's focus() of a div.
    b.focus(refs.view);
    b.focus(refs.label);
    refs.view.focus();
    assert.deepEqual(focused(), ['A'], 'A keeps the focus');
    assert.ok(three.active === a, 'and its surface stays the active one');
  });

  it('lets a blur handler that moves the focus within its own surface win, as Chrome does', () => {
    const three = /** @type {any} */ (setup());
    /** @type {string[]} */
    const log = [];
    /** @type {Record<string, any>} */
    const refs = {};
    let moving = true;
    render(() => (
      <>
        <group position={[-1, 0, 0]}>
          <View style={{ width: 80, padding: 4 }}>
            <Action
              ref={(/** @type {any} */ n) => (refs.A = n)}
              text="A"
              onBlur={() => {
                log.push('A blur');
                if (moving) {
                  moving = false;
                  refs.A2.focus();
                }
              }}
            />
            <Action ref={(/** @type {any} */ n) => (refs.A2 = n)} text="A2" onFocus={() => log.push('A2 focus')} />
          </View>
        </group>
        <group position={[1, 0, 0]}>
          <View style={{ width: 80, padding: 4 }}>
            <Action ref={(/** @type {any} */ n) => (refs.B = n)} text="B" onFocus={() => log.push('B focus')} />
          </View>
        </group>
      </>
    ), three);
    three.frame(0);
    const focused = () => [...three.surfaces].filter(s => s.focused !== null).map(s => s.focused.text);
    const a = three.page(refs.A);
    refs.A.focus();
    log.length = 0;
    refs.B.focus();
    assert.deepEqual(log, ['A blur', 'A2 focus'], "A's blur handler moved the focus to A2: B hears nothing");
    assert.deepEqual(focused(), ['A2'], 'one surface has the focus');
    assert.ok(three.active === a, "A2's surface is the active one");
  });

  /**
   * A 40-pixel strip of the overlay along the top, a 100 × 50 panel at the
   * origin (about 44 to 56 down the canvas), and a box to the right in the
   * scene, each logging the drag and drop it hears.
   */
  const dropping = () => {
    const three = setup();
    /** @type {string[]} */
    const log = [];
    /** @type {any[]} */
    const drops = [];
    const on = (/** @type {string} */ name) => ({
      onDragEnter: () => log.push(`enter ${name}`),
      onDragOver: () => log.push(`over ${name}`),
      onDragLeave: () => log.push(`leave ${name}`),
      onDrop: (/** @type {any} */ e) => drops.push([name, e.files, Math.round(e.x), Math.round(e.y)]),
    });
    render(() => (
      <>
        <View style={{ height: 40 }} {...on('overlay')} />
        <group>
          <View style={{ width: 100, height: 50 }} {...on('panel')} />
        </group>
        <mesh position={[3, 0, 0]} onDragOver={() => log.push('over box')} onDrop={(/** @type {any} */ e) => drops.push(['box', e.files, e.object.name])} name="box">
          <boxGeometry params={[1, 1, 1]} />
          <meshBasicMaterial />
        </mesh>
      </>
    ), three);
    three.frame();
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    return { three, panel, log, drops };
  };

  it('drops files on the primitive under the point: the overlay by point, a panel by its texture coordinate, else the scene', () => {
    const { three, panel, drops } = dropping();
    const file = { name: 'a.png', type: 'image/png' };
    assert.equal(three.dropFiles(30, 20, [file]), true, 'the overlay took it');
    const [px, py] = three.project(panel, 60, 20);
    assert.equal(three.dropFiles(px, py, [file]), true, 'the panel took it');
    assert.equal(three.dropFiles(164, 50, [file]), true, 'the box heard it');
    assert.equal(three.dropFiles(10, 90, [file]), false, 'nothing there');
    assert.deepEqual(drops, [['overlay', [file], 30, 20], ['panel', [file], 60, 20], ['box', [file], 'box']]);
  });

  it('sends a drag across surfaces: the first left, the second entered, the canvas left at the end', () => {
    const { three, panel, log } = dropping();
    const [px, py] = three.project(panel, 50, 25);
    assert.equal(three.dragOver(30, 20, 1, ['image/png']), true);
    three.dragOver(31, 21, 1, ['image/png']);
    three.dragOver(px, py, 1, ['image/png']);
    three.dragOver(164, 50, 1, ['image/png']);
    assert.equal(three.dragOver(10, 90, 1, ['image/png']), false, 'nothing under it takes it');
    three.dragOver(30, 20, 1, ['image/png']);
    three.dragLeave();
    assert.deepEqual(log, ['enter overlay', 'over overlay', 'over overlay', 'leave overlay', 'enter panel', 'over panel', 'leave panel', 'over box', 'enter overlay', 'over overlay', 'leave overlay']);
    // A drop ends the drag without a leave.
    log.length = 0;
    three.dragOver(px, py, 1, []);
    three.dropFiles(px, py, []);
    three.dragLeave();
    assert.deepEqual(log, ['enter panel', 'over panel']);
  });

  it('routes a canvas element\'s drag and drop, keeping the browser\'s default where no surface or object takes it', () => {
    const { three, drops } = dropping();
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
    const file = { name: 'a.txt', type: 'text/plain' };
    const event = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) => {
      const e = { type, offsetX: x, offsetY: y, prevented: false, dataTransfer: { items: [{ kind: 'file', type: 'text/plain' }], files: [file] }, preventDefault() { e.prevented = true; } };
      listeners[type](e);
      return e.prevented;
    };
    assert.deepEqual([event('dragenter', 30, 20), event('dragover', 30, 20), event('drop', 30, 20)], [true, true, true], 'the overlay');
    assert.deepEqual([event('dragover', 10, 90), event('drop', 10, 90)], [false, false], 'the empty scene');
    event('dragleave', 10, 90);
    assert.deepEqual(drops, [['overlay', [file], 30, 20]]);
  });

  it("counts a canvas element's clicks by time and place (a pointerdown's detail is 0), and keeps the browser's context menu off the app's own", () => {
    // A page's: loose text selects, and the browser's menu shows where the app has none.
    const three = setup({ behavior: 'page' });
    render(() => (
      <View prevent="contextmenu" style={{ fontSize: 10, lineHeight: 2, width: 120 }}>
        <Label text="hello world" />
      </View>
    ), three);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
    const fire = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ timeStamp = 0) => {
      const e = { type, offsetX: x, offsetY: y, button: 0, detail: 0, timeStamp, prevented: false, preventDefault() { e.prevented = true; } };
      listeners[type](e);
      return e.prevented;
    };
    const overlay = /** @type {any} */ (three).overlay;
    fire('pointerdown', 40, 10, 1000);
    fire('pointerup', 40, 10, 1050);
    assert.equal(overlay.copied(), '');
    fire('pointerdown', 40, 10, 1200);
    assert.equal(overlay.copied(), 'world', 'a double click selects the word');
    fire('pointerup', 40, 10, 1250);
    assert.equal(fire('contextmenu', 40, 10), true, "the app's menu, not the browser's");
    // A right press selects nothing (and would open the app's menu through its pointer handlers).
    listeners.pointerdown({ type: 'pointerdown', offsetX: 12, offsetY: 10, button: 2, detail: 0, timeStamp: 5000, preventDefault() {} });
    listeners.pointerup({ type: 'pointerup', offsetX: 12, offsetY: 10, button: 2, preventDefault() {} });
    assert.equal(overlay.copied(), 'world', 'the selection stays');
    assert.equal(fire('contextmenu', 180, 90), false, 'the scene keeps the browser\'s');
  });

  it("behaves as an application by default: the browser's context menu only in an Edit, Ctrl+A kept from the page, no touch callout", () => {
    /**
     * Overlay text at 0..20 and an Edit below it (50 wide), a panel's text at the
     * origin, a box to the right hearing its context menu, attached to a
     * canvas with a `behavior`.
     * @param {import('ren-core/host').Behavior} [behavior]
     */
    const build = behavior => {
      const three = setup({ behavior });
      /** @type {string[]} */
      const heard = [];
      render(() => (
        <>
          <View style={{ fontSize: 10, lineHeight: 2, width: 60 }}>
            <Label text="hello world" />
            <Edit value="alpha" style={{ width: 50 }} />
          </View>
          <group>
            <View style={{ fontSize: 10, lineHeight: 2, width: 100, height: 50 }}><Label text="panel text" /></View>
          </group>
          <mesh position={[3, 0, 0]} onContextMenu={() => heard.push('box')}>
            <boxGeometry params={[1, 1, 1]} />
            <meshBasicMaterial />
          </mesh>
        </>
      ), three);
      three.frame();
      const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
      /** @type {Record<string, (e: any) => void>} */
      const listeners = {};
      /** @type {Map<string, string>} */
      const props = new Map();
      const style = {
        setProperty: (/** @type {string} */ name, /** @type {string} */ value) => void props.set(name, value),
        getPropertyValue: (/** @type {string} */ name) => props.get(name) ?? '',
        removeProperty: (/** @type {string} */ name) => void props.delete(name),
      };
      const stop = three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, style, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
      const fire = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ more = {}) => {
        const e = { type, offsetX: x, offsetY: y, button: type === 'contextmenu' ? 2 : 0, detail: 0, timeStamp: 0, prevented: false, preventDefault() { e.prevented = true; }, ...more };
        listeners[type](e);
        return e.prevented;
      };
      const all = () => fire('keydown', 0, 0, { key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
      const overlay = /** @type {any} */ (three).overlay;
      return { three, panel, overlay, heard, fire, all, props, stop };
    };
    const app = build();
    const [px, py] = app.three.project(app.panel, 10, 10);
    assert.equal(app.fire('contextmenu', 10, 10), true, 'over overlay text');
    assert.equal(app.fire('contextmenu', 17, 37), false, 'over an Edit: paste, spelling');
    assert.equal(app.fire('contextmenu', px, py), true, 'over a panel\'s text');
    assert.equal(app.fire('contextmenu', 164, 50), true, 'over an object');
    assert.deepEqual(app.heard, ['box'], 'which still hears it');
    assert.equal(app.fire('contextmenu', 180, 90), true, 'over the empty scene');
    assert.equal(app.all(), true, 'Ctrl+A with nothing pressed: not the page');
    assert.equal(app.overlay.copied(), '');
    app.fire('pointerdown', 5, 10);
    app.fire('pointerup', 5, 10);
    assert.equal(app.all(), true);
    assert.equal(app.overlay.copied(), '', 'loose text: nothing');
    app.fire('pointerdown', 17, 37);
    app.fire('pointerup', 17, 37);
    assert.equal(app.all(), true);
    assert.equal(app.overlay.copied(), 'alpha', 'the focused Edit\'s value');
    assert.equal(app.props.get('-webkit-touch-callout'), 'none');
    assert.equal(app.props.get('user-select'), 'none');
    app.stop();
    assert.equal(app.props.size, 0, 'put back');
    const page = build('page');
    assert.deepEqual([page.fire('contextmenu', 10, 10), page.fire('contextmenu', 17, 37), page.fire('contextmenu', 164, 50), page.fire('contextmenu', 180, 90)], [false, false, false, false], 'a page keeps the browser\'s');
    assert.equal(page.all(), false, 'Ctrl+A with nothing pressed: the browser\'s');
    assert.equal(page.props.size, 0);
    page.stop();
    const menu = build({ menu: true });
    assert.deepEqual([menu.fire('contextmenu', 10, 10), menu.fire('contextmenu', 164, 50), menu.fire('contextmenu', 180, 90)], [false, false, false], 'menu alone');
    menu.stop();
    const edit = build({ editMenu: false });
    assert.equal(edit.fire('contextmenu', 17, 37), true, 'editMenu: false');
    edit.stop();
  });

  it("keeps a touch a surface took from the page's pan, and ends a press the browser takes back with pointercancel", () => {
    const three = setup();
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <View
        style={{ width: 120, height: 40 }}
        onPointerDown={e => heard.push(`down ${e.x}`)}
        onPointerUp={e => heard.push(`up ${e.x},${e.y}`)}
        onPointerCancel={e => heard.push(`cancel ${e.x},${e.y}`)}
      />
    ), three);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
    const fire = (/** @type {string} */ type, /** @type {number} */ x = 0, /** @type {number} */ y = 0) => {
      const e = { type, offsetX: x, offsetY: y, button: 0, buttons: 1, detail: 0, pointerType: 'touch', prevented: false, cancelable: true, preventDefault() { e.prevented = true; } };
      listeners[type](e);
      return e.prevented;
    };
    fire('pointerdown', 10, 10);
    assert.equal(fire('touchstart'), true, 'the overlay took it');
    fire('pointermove', 30, 12);
    fire('pointercancel');
    assert.deepEqual(heard, ['down 10', 'cancel 30,12'], 'where the pointer last was; no release follows');
    assert.equal(three.grab, null);
    fire('pointerdown', 180, 90);
    assert.equal(fire('touchstart'), false, 'the empty scene lets the page pan');
  });

  it('keeps the page from the pans a touch\'s primitives forbid (touchAction), on the overlay and a panel', () => {
    const three = setup();
    /** @type {string[]} */
    const heard = [];
    render(() => (
      <>
        <View style={{ width: 60, height: 40, touchAction: 'pan-y' }} onPointerDown={() => {}} />
        <View style={{ width: 60, height: 20, touchAction: 'none', background: '#ffffff' }} />
        <group name="holder" position={[0, 0, 0]}>
          <View style={{ width: 100, height: 100, touchAction: 'pan-x' }} onPointerCancel={() => heard.push('panel cancel')} onPointerDown={() => heard.push('panel down')} />
        </group>
      </>
    ), three);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
    const fire = (/** @type {string} */ type, /** @type {number} */ x = 0, /** @type {number} */ y = 0, /** @type {any} */ touches = undefined) => {
      const e = { type, offsetX: x, offsetY: y, button: 0, buttons: 1, detail: 0, pointerType: 'touch', touches, prevented: false, cancelable: true, preventDefault() { e.prevented = true; } };
      listeners[type](e);
      return e.prevented;
    };
    /** A touch at a canvas point: whether its start, then a first move by (dx, dy), were cancelled. @param {number} x @param {number} y @param {number} dx @param {number} dy */
    const gesture = (x, y, dx, dy) => {
      fire('pointerdown', x, y);
      const start = fire('touchstart', x, y, [{ clientX: x, clientY: y }]);
      const move = fire('touchmove', x, y, [{ clientX: x + dx, clientY: y + dy }]);
      fire('pointerup', x, y);
      return [start, move];
    };
    assert.deepEqual(gesture(10, 10, 0, 20), [false, false], 'pan-y: the page pans down, though a handler took the press');
    assert.deepEqual(gesture(10, 10, 20, 0), [false, true], 'not across');
    assert.deepEqual(gesture(10, 50, 0, 20), [true, false], 'none: the start is cancelled');
    // The panel, through the raycast: its middle is at the canvas's center.
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    const [px, py] = three.project(panel, 50, 50);
    assert.deepEqual(gesture(px, py, 20, 0), [false, false], 'pan-x on the panel: across is the page\'s');
    assert.deepEqual(gesture(px, py, 0, 20), [false, true]);
    fire('pointerdown', px, py);
    fire('pointercancel');
    assert.deepEqual(heard.slice(-2), ['panel down', 'panel cancel'], 'the panel holding the press hears the cancel');
  });

  it("hears the root's keys and scrolls with $keys and $scrolls on every surface, chords too", () => {
    const three = setup();
    /** @type {string[]} */
    const seen = [];
    const App = () => {
      $keys(e => seen.push(`key ${e.editable ? 'field ' : ''}${e.ctrlKey ? 'ctrl+' : ''}${e.key}`));
      $scrolls(() => seen.push('scroll'));
      return (
        <>
          <Scroll style={{ height: 40, fontSize: 10, lineHeight: 2 }}>
            {Array.from({ length: 10 }, (_, i) => <Label text={`line ${i}`} />)}
          </Scroll>
          <group>
            <View style={{ width: 100, padding: 10 }}>
              <Edit value="" />
            </View>
          </group>
        </>
      );
    };
    render(() => <App />, three);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => void (listeners[type] = fn), removeEventListener() {} });
    const press = (/** @type {string} */ key, ctrl = false) => {
      const e = { type: 'keydown', key, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false, prevented: false, preventDefault() { e.prevented = true; } };
      listeners.keydown(e);
    };
    press('k', true);
    assert.deepEqual(seen, ['key ctrl+k'], 'nothing focused: the root hears a chord');
    three.input('wheel', 20, 20, { deltaY: 10 });
    assert.deepEqual(seen.slice(1), ['scroll'], "the overlay's Scroll");
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    const [ex, ey] = three.project(panel, 50, 10 + 19);
    three.input('pointerdown', ex, ey);
    press('a');
    assert.deepEqual(seen.slice(2), ['key field a'], "a panel's Edit: a field typed it");
  });

  it("hears every press with $presses on its own surface, the overlay's and a panel's, with the text under it (textAt)", () => {
    const three = setup();
    /** @type {string[]} */
    const seen = [];
    /** @type {any} */
    let stop = false;
    /** @type {any} */
    let last = null;
    const App = () => {
      $presses(e => {
        last = textAt(e);
        seen.push(`${e.button} ${e.pointerType} ${e.target.getRootNode().panel ? 'panel' : 'overlay'} ${last?.text ?? '-'}`);
      });
      return (
        <>
          <Label text="overlay words" />
          <group>
            <View style={{ width: 100, padding: 10 }} onPointerDown={(/** @type {any} */ e) => { if (stop) e.stopPropagation(); }}>
              <Label text="panel words" />
            </View>
          </group>
        </>
      );
    };
    render(() => <App />, three);
    three.present();
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    three.input('pointerdown', 10, 10, { button: 0, pointerType: 'touch' });
    const [px, py] = three.project(panel, 30, 10 + 8);
    three.input('pointerdown', px, py, { button: 0 });
    three.input('pointerdown', px, py, { button: 2 });
    assert.deepEqual(seen, ['0 touch overlay overlay words', '0 mouse panel panel words', '2 mouse panel panel words'], "each surface's own, in its own pixels");
    // An item's stopPropagation keeps it from the root's.
    stop = true;
    three.input('pointerdown', px, py, { button: 0 });
    assert.equal(seen.length, 3);
    // The menu's "Select text" on the text the last press found.
    assert.equal(typeof selectText(last.node), 'function');
    assert.equal(selectedText(last.node), 'panel words', "a panel's text selects in its own surface");
    assert.equal(selectedText(panel.root.first), 'panel words');
  });

  it("selects an opened text an overlay's Action holds, pressing nothing (textAt: pressed)", () => {
    const three = /** @type {any} */ (setup());
    let presses = 0;
    /** @type {any} */
    let hit = null;
    /** @type {any} */
    let label = null;
    render(() => (
      <View onPointerDown={(/** @type {any} */ e) => (hit = textAt(e))}>
        <Action onPress={() => presses++} style={{ align: 'start' }}>
          <Label ref={(/** @type {any} */ e) => (label = e)} text="hello world" />
        </Action>
      </View>
    ), three);
    three.present();
    const r = label.getBoundingClientRect();
    const y = r.y + r.height / 2;
    three.input('pointerdown', r.x + 1, y, { button: 2 });
    assert.equal(hit?.node === label && hit.pressed, true, "an Action's label, pressed");
    selectText(label);
    three.input('pointerdown', r.x + 1, y, { button: 0 });
    three.input('pointermove', r.x + r.width / 2, y);
    three.input('pointerup', r.x + r.width / 2, y);
    const part = selectedText(label);
    assert.ok(part.length > 0 && part.length < 11 && 'hello world'.startsWith(part), `a part is selected (${part})`);
    assert.equal(presses, 0, 'the Action is not pressed');
    assert.equal(three.overlay.pressed === null && three.overlay.current === null, true, 'nor in its press state or focused');
  });

  it("selects an overlay text Action's own text once opened, pressing nothing", () => {
    const three = /** @type {any} */ (setup());
    let presses = 0;
    /** @type {any} */
    let hit = null;
    /** @type {any} */
    let action = null;
    render(() => (
      <View onPointerDown={(/** @type {any} */ e) => (hit = textAt(e))}>
        <Action ref={(/** @type {any} */ e) => (action = e)} text="hello world" onPress={() => presses++} style={{ align: 'start' }} />
      </View>
    ), three);
    three.present();
    const overlay = three.overlay;
    const r = action.getBoundingClientRect();
    const y = r.y + r.height / 2;
    // Its text starts at its content box's left.
    const texts = overlay.painter.texts;
    let x = -1;
    for (let i = 0; i < texts.n; i++) if (texts.items[i] === action) x = texts.box[i * 6 + 4];
    const hello = overlay.fonts.width('hello', action.r.size, action.r.face);
    three.input('pointerdown', x + 1, y, { button: 2 });
    assert.equal(hit?.node === action && hit.text === 'hello world' && hit.pressed, true, "the Action's own text, pressed");
    selectText(action);
    three.input('pointerdown', x + 1, y, { button: 0 });
    three.input('pointermove', x + hello, y);
    three.input('pointerup', x + hello, y);
    const part = selectedText(action);
    assert.ok(part.length > 0 && part.length < 11 && 'hello world'.startsWith(part), `a part is selected (${part})`);
    assert.equal(presses, 0, 'the Action is not pressed');
  });

  it("keeps a focused Edit's native entry focused on a right press, for the app's own menu", () => {
    const window = new Window();
    const doc = window.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    /** @type {any} */
    let edit = null;
    const three = /** @type {any} */ ($three(THREE, { renderer: stub, width: 200, height: 100, schedule: false, font }));
    const root = Root({ id: 'menus', target: host, renderer: three, children: <Edit ref={(/** @type {any} */ e) => (edit = e)} value="text" /> });
    edit.focus();
    three.present();
    const area = /** @type {any} */ (doc.activeElement);
    assert.equal(area?.tagName, 'TEXTAREA');
    const canvas = three.canvas;
    const down = new window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true });
    canvas.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true, "the canvas does not take the focus as the press's default");
    canvas.dispatchEvent(new window.PointerEvent('pointerdown', { button: 2, bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, area, 'nor from the press handler');
    assert.equal(edit.getRootNode().current, edit);
    assert.equal(editOf(edit)?.value(), 'text');
    $dispose(root);
  });

  it("deletes the faces it added to the document's fonts when its root is disposed", async () => {
    const doc = new Window().document;
    const fonts = new Set();
    Object.defineProperty(doc, 'fonts', { value: { add: (/** @type {any} */ f) => fonts.add(f), delete: (/** @type {any} */ f) => fonts.delete(f) } });
    /** @type {any} */ (doc.defaultView).FontFace = class { load() { return Promise.resolve(this); } };
    for (let i = 0; i < 3; i++) {
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      const root = Root({ id: `faces${i}`, target: host, renderer: $three(THREE, { renderer: stub, width: 200, height: 100, schedule: false, font, mono: font }), children: <Label text="hi" /> });
      assert.equal(fonts.size, 2, 'the regular and monospace faces, while the root lives');
      $dispose(root);
      await Promise.resolve();
      assert.equal(fonts.size, 0, 'none once it is disposed');
    }
  });
  it('scrolls a wheel in lines and pages as far as a browser does, on a surface', () => {
    const three = /** @type {any} */ (setup());
    /** @type {any} */
    let scroll = null;
    render(
      () => (
        <Scroll ref={(/** @type {any} */ n) => (scroll = n)} style={{ width: 100, height: 50 }}>
          {Array.from({ length: 40 }, (_, i) => <Label text={'row ' + i} />)}
        </Scroll>
      ),
      three,
    );
    three.frame(0);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, focus() {}, addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => void (listeners[t] = fn), removeEventListener() {} });
    const line = three.overlay.theme.text * three.overlay.theme.leading;
    listeners.wheel({ type: 'wheel', offsetX: 20, offsetY: 20, deltaY: 3, deltaMode: 1, preventDefault() {} });
    assert.equal(scroll.scrollTop, 3 * line, 'three lines, in the theme line height');
  });

  it('holds the pointer on a main-button press, as ren-canv attach does', () => {
    const three = /** @type {any} */ (setup());
    render(() => <Label text="hello" />, three);
    three.frame(0);
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    /** @type {number[]} */
    const captured = [];
    three.attach({ tabIndex: 0, clientWidth: 0, clientHeight: 0, focus() {}, setPointerCapture: (/** @type {number} */ id) => captured.push(id), addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => void (listeners[t] = fn), removeEventListener() {} });
    listeners.pointerdown({ type: 'pointerdown', pointerId: 7, button: 0, offsetX: 5, offsetY: 5, preventDefault() {} });
    listeners.pointerdown({ type: 'pointerdown', pointerId: 8, button: 2, offsetX: 5, offsetY: 5, preventDefault() {} });
    assert.deepEqual(captured, [7], 'the main button only');
  });

  it('lets go of a closed panel: keys go to the overlay again', () => {
    const three = /** @type {any} */ (setup());
    const R = Root('closing');
    const on = $signal(R, true);
    render(
      () => (
        <>
          <Edit value="overlay field" />
          <Show when={() => $read(on)}>
            <group>
              <View style={{ width: 100, padding: 10 }}>
                <Edit value="" />
              </View>
            </group>
          </Show>
        </>
      ),
      three,
      { root: R },
    );
    three.frame(0);
    const panel = /** @type {any} */ ([...three.surfaces].find(s => /** @type {any} */ (s).panel));
    const [ex, ey] = three.project(panel, 50, 10 + 19);
    three.input('pointerdown', ex, ey);
    three.input('pointerup', ex, ey);
    assert.ok(three.active === panel, 'the pressed panel is active');
    $write(on, false);
    three.frame(0);
    assert.equal(panel.closed, true);
    assert.ok(three.active === null, 'a closed panel is not active');
    assert.ok(three.grab === null, 'nor held');
    assert.ok(three.over === null, 'nor hovered');
  });
});
