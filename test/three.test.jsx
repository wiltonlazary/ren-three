// ren-three: JSX over a three.js scene graph, in node. three.js builds and
// raycasts its scene without WebGL; a drawer stub counts the frames. Worker
// mode runs the application over a MessageChannel: three.js stays here.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window as HappyWindow } from 'happy-dom';
import { Root, $signal, $read, $write, $dispose, Show, For, Recover, $lookup, Runtime, Props, Label, $cleanup, $owner, $active, read } from 'ren-core';
import { $dom } from 'ren-dom';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { $three, render, $animate, Renderer, CONSTRUCT, loadLayout } from 'ren-three';
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

/** A drawer that records its frames instead of drawing. */
const stub = () => {
  const drawer = {
    frames: 0,
    size: [0, 0],
    disposed: false,
    render: (/** @type {any} */ _scene, /** @type {any} */ _camera) => void drawer.frames++,
    setSize: (/** @type {number} */ w, /** @type {number} */ h) => void (drawer.size = [w, h]),
    dispose: () => void (drawer.disposed = true),
  };
  return drawer;
};

/** A renderer drawing into a stub, frames driven by hand. */
const setup = (options = {}) => {
  const drawer = stub();
  const three = $three(THREE, { renderer: drawer, width: 200, height: 100, schedule: false, ...options });
  return { drawer, three };
};

describe('ren-three', () => {
  it('keeps writing a material\'s own color in place when the view also hands that color to a background', () => {
    const { three } = setup();
    const R = Root('shared');
    const hex = $signal(R, '#ff0000');
    /** @type {any} */
    let material = null;
    /** @type {any} */
    let scene = null;
    const own = $signal(R, /** @type {any} */ (null));
    const dispose = render(
      () => (
        <scene ref={s => (scene = s)} background={() => $read(own)}>
          <mesh>
            <meshBasicMaterial ref={m => (material = m)} color={() => $read(hex)} />
          </mesh>
        </scene>
      ),
      three,
      { root: R },
    );
    const color = material.color;
    $write(own, color);
    three.frame(0);
    assert.equal(scene.background, color, 'the background is the material\'s color');
    $write(hex, '#0000ff');
    three.frame(0);
    assert.equal(material.color, color, 'the material keeps its Color');
    assert.ok(material.color.isColor, 'not the string it was given');
    assert.equal(material.color.getHexString(), '0000ff', 'set in place');
    assert.equal(scene.background, color);
    dispose();
  });

  it('places a Color or Texture the view gives by reference, never writing into it, and lets null clear it', () => {
    const { three } = setup();
    const R = Root('background');
    const RED = new THREE.Color('#ff0000');
    const BLUE = new THREE.Color('#0000ff');
    const texture = new THREE.Texture();
    const background = $signal(R, /** @type {any} */ (RED));
    /** @type {any} */
    let scene = null;
    const dispose = render(() => <scene ref={s => (scene = s)} background={() => $read(background)} />, three, { root: R });
    assert.equal(scene.background, RED);
    $write(background, BLUE);
    three.frame(0);
    assert.equal(RED.getHexString(), 'ff0000', 'the view\'s RED stays red');
    assert.equal(scene.background, BLUE);
    $write(background, RED);
    three.frame(0);
    assert.equal(scene.background, RED, 'back to red');
    assert.equal(BLUE.getHexString(), '0000ff', 'and BLUE stays blue');
    $write(background, texture);
    three.frame(0);
    assert.equal(scene.background, texture, 'a Texture after a Color');
    $write(background, null);
    three.frame(0);
    assert.equal(scene.background, null, 'null clears it');
    $write(background, RED);
    $write(background, undefined);
    three.frame(0);
    assert.equal(scene.background, null, 'undefined clears it to null, which three.js draws as none');
    $write(background, RED);
    three.frame(0);
    assert.equal(scene.background, RED);
    dispose();
  });

  it('leaves a position, scale or color as it is when its value goes to null or undefined: no NaN matrix', () => {
    const { three } = setup();
    const R = Root('math');
    const place = $signal(R, /** @type {any} */ ([1, 2, 3]));
    const size = $signal(R, /** @type {any} */ (2));
    const tint = $signal(R, /** @type {any} */ ('#ff0000'));
    /** @type {any} */
    let mesh = null;
    const dispose = render(
      () => (
        <mesh ref={m => (mesh = m)} position={() => $read(place)} scale={() => $read(size)}>
          <meshBasicMaterial color={() => $read(tint)} />
        </mesh>
      ),
      three,
      { root: R },
    );
    for (const empty of [undefined, null]) {
      $write(place, empty);
      $write(size, empty);
      $write(tint, empty);
      three.frame(0);
      mesh.updateMatrixWorld(true);
      assert.deepEqual(mesh.position.toArray(), [1, 2, 3], `position ${empty}`);
      assert.deepEqual(mesh.scale.toArray(), [2, 2, 2], `scale ${empty}`);
      assert.equal(mesh.material.color.getHexString(), 'ff0000', `color ${empty}`);
      assert.ok(mesh.matrixWorld.elements.every((/** @type {number} */ v) => Number.isFinite(v)), `a finite matrix after ${empty}`);
      $write(place, [1, 2, 3]);
      $write(size, 2);
      $write(tint, '#ff0000');
    }
    dispose();
  });

  it('gives a slot back to what stood before when an earlier value leaves first: no disposed material returns', () => {
    const { three } = setup();
    const R = Root('slots');
    const a = $signal(R, true);
    const b = $signal(R, true);
    /** @type {any} */
    let mesh = null;
    /** @type {any} */
    let first = null;
    let disposedA = 0;
    const dispose = render(
      () => (
        <mesh ref={m => (mesh = m)}>
          <Show when={() => $read(a)}>
            <meshBasicMaterial name="A" ref={m => void (m !== null && (first = m).addEventListener('dispose', () => disposedA++))} />
          </Show>
          <Show when={() => $read(b)}>
            <meshStandardMaterial name="B" />
          </Show>
        </mesh>
      ),
      three,
      { root: R },
    );
    assert.equal(mesh.material.name, 'B', 'the last one set shows');
    $write(a, false);
    three.frame(0);
    assert.equal(disposedA, 1, 'A, removed, is disposed');
    assert.equal(mesh.material.name, 'B', 'B still shows');
    $write(b, false);
    three.frame(0);
    assert.notEqual(mesh.material, first, 'the disposed A does not come back');
    assert.ok(mesh.material instanceof THREE.MeshBasicMaterial && mesh.material.name === '', 'the mesh\'s own material stands again');
    $write(a, true);
    $write(b, true);
    three.frame(0);
    assert.equal(mesh.material.name, 'B');
    dispose();
  });

  it('builds three.js objects from JSX: classes, params, slots and properties', () => {
    const { three } = setup();
    /** @type {any} */
    let mesh = null;
    const dispose = render(
      () => (
        <group name="world" position={[1, 2, 3]}>
          <mesh ref={m => (mesh = m)} name="box" scale={2} rotation-y={0.5}>
            <boxGeometry params={[1, 2, 3]} />
            <meshStandardMaterial color="#ff8800" roughness={0.25} />
          </mesh>
          <ambientLight intensity={0.5} />
        </group>
      ),
      three,
    );
    const world = three.scene.getObjectByName('world');
    assert.ok(world instanceof THREE.Group);
    assert.deepEqual(world.position.toArray(), [1, 2, 3]);
    assert.ok(mesh instanceof THREE.Mesh, 'a ref receives the three.js object');
    assert.equal(mesh.parent, world);
    assert.deepEqual(mesh.scale.toArray(), [2, 2, 2], 'a number sets every component');
    assert.equal(mesh.rotation.y, 0.5, 'a dashed name sets a path');
    assert.ok(mesh.geometry instanceof THREE.BoxGeometry, 'a geometry attaches to geometry');
    assert.equal(mesh.geometry.parameters.height, 2, 'params construct');
    assert.ok(mesh.material instanceof THREE.MeshStandardMaterial, 'a material attaches to material');
    assert.equal(mesh.material.color.getHexString(), 'ff8800', 'a color is set through Color.set');
    assert.equal(mesh.material.roughness, 0.25);
    // A number is a Color's hex, as three.js's Color.set reads it.
    const tinted = render(() => <mesh name="hex"><meshBasicMaterial color={0x3366ff} /></mesh>, three);
    assert.equal(/** @type {any} */ (three.scene.getObjectByName('hex')).material.color.getHexString(), '3366ff');
    tinted();
    // `slot` names the parent property any other object attaches to; removal restores it.
    const slotted = render(() => <mesh name="slotted"><meshDepthMaterial slot="customDepthMaterial" /></mesh>, three);
    const holder = /** @type {any} */ (three.scene.getObjectByName('slotted'));
    assert.ok(holder.customDepthMaterial instanceof THREE.MeshDepthMaterial, 'slot attaches to the named property');
    assert.ok(holder.material instanceof THREE.MeshBasicMaterial, 'the default material slot stays as it was');
    slotted();
    assert.equal(world.children.length, 2, 'the geometry and material are not scene children');
    dispose();
    assert.equal(three.scene.children.length, 0);
  });

  it('rebuilds an object in place when its params change, keeping what the view set', () => {
    const { three } = setup();
    const R = Root('params');
    const size = $signal(R, 1);
    const fov = $signal(R, 50);
    const tint = $signal(R, '#ff0000');
    /** @type {any} */
    let mesh = null;
    /** @type {any} */
    let camera = null;
    const dispose = render(
      () => (
        <>
          <mesh ref={m => (mesh = m)} position={[1, 2, 3]}>
            <boxGeometry name="box" params={() => [Math.min($read(size), 4), 2, 3]} />
            <meshBasicMaterial params={() => [{ color: $read(tint) }]} opacity={0.5} transparent />
          </mesh>
          <perspectiveCamera ref={c => (camera = c)} params={() => [$read(fov), 2, 0.1, 100]} position-z={7} />
        </>
      ),
      three,
      { root: R },
    );
    const geometry = mesh.geometry;
    const material = mesh.material;
    let disposed = 0;
    geometry.addEventListener('dispose', () => disposed++);
    $write(size, 4);
    assert.equal(mesh.geometry, geometry, 'the same geometry, attached where it was');
    assert.equal(geometry.parameters.width, 4, 'built from the new params');
    assert.equal(geometry.attributes.position.array[0], 2, 'with new vertices');
    assert.equal(geometry.name, 'box', 'what the view set applies again');
    assert.equal(disposed, 1, 'its old GPU buffers were freed');
    $write(tint, '#00ff00');
    assert.equal(mesh.material, material);
    assert.equal(material.color.getHexString(), '00ff00');
    assert.equal(material.opacity, 0.5, 'a property set beside the params stays');
    assert.equal(material.transparent, true);
    const before = camera.projectionMatrix.elements[5];
    $write(fov, 30);
    assert.equal(camera.fov, 30);
    assert.notEqual(camera.projectionMatrix.elements[5], before, 'the projection follows');
    assert.equal(camera.position.z, 7, 'a scene object keeps its transform');
    assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);
    // The params rerun to a new list of the same values: nothing is rebuilt.
    $write(size, 5);
    assert.equal(geometry.parameters.width, 4);
    assert.equal(disposed, 1, 'equal params rebuild nothing');
    dispose();
    $dispose(R);
  });

  it('updates reactive properties and regions, and renders once per changed flush', () => {
    const { three, drawer } = setup();
    const R = Root('scene');
    const x = $signal(R, 0);
    const shown = $signal(R, true);
    const colors = $signal(R, ['red', 'green']);
    render(
      () => (
        <>
          <mesh name="moving" position-x={x}>
            <sphereGeometry />
          </mesh>
          <Show when={shown}>
            <pointLight name="light" />
          </Show>
          <For each={colors}>{color => <mesh name={color}><meshBasicMaterial color={color} /></mesh>}</For>
        </>
      ),
      three,
      { root: R },
    );
    assert.equal(three.frame(), true, 'the first frame renders');
    assert.equal(three.frame(), false, 'an unchanged scene does not render again');
    $write(x, 3);
    assert.equal(three.scene.getObjectByName('moving').position.x, 3);
    assert.equal(three.frame(), true);
    $write(shown, false);
    assert.equal(three.scene.getObjectByName('light'), undefined);
    $write(colors, ['blue', 'red']);
    assert.deepEqual(three.scene.children.filter(o => o.type === 'Mesh' && o.name !== 'moving').map(o => o.name).sort(), ['blue', 'red']);
    assert.equal(three.frame(), true);
    assert.equal(drawer.frames, 3);
    $dispose(R);
  });

  it('frees the GPU resources of removed objects, not of moved or kept ones', () => {
    const { three } = setup();
    const R = Root('scene');
    const items = $signal(R, ['a', 'b']);
    /** @type {Record<string, any>} */
    const geometries = {};
    const kept = new THREE.BoxGeometry();
    let keptDisposed = 0;
    kept.addEventListener('dispose', () => keptDisposed++);
    render(
      () => (
        <>
          <For each={items}>
            {name => (
              <mesh name={name}>
                <boxGeometry ref={g => (geometries[read(name)] = g)} />
              </mesh>
            )}
          </For>
          <mesh>
            <existing of={kept} />
          </mesh>
        </>
      ),
      three,
      { root: R },
    );
    /** @type {string[]} */
    const disposed = [];
    for (const name in geometries) geometries[name].addEventListener('dispose', () => disposed.push(name));
    $write(items, ['b', 'a']);
    three.present();
    assert.deepEqual(disposed, [], 'a moved row keeps its geometry');
    $write(items, ['b']);
    three.present();
    assert.deepEqual(disposed, ['a']);
    $dispose(R);
    three.close();
    assert.equal(keptDisposed, 0, 'an existing object stays its owner\'s to dispose');
  });

  it('keeps a resource marked dispose={null} when its object is removed, and frees the others', () => {
    const { three } = setup();
    const R = Root('scene');
    const open = $signal(R, true);
    /** @type {any} */
    let geometry = null;
    /** @type {any} */
    let material = null;
    const dispose = render(
      () => (
        <Show when={open}>
          {() => (
            <mesh>
              <boxGeometry dispose={null} ref={g => (geometry = g)} />
              <meshBasicMaterial ref={m => (material = m)} />
            </mesh>
          )}
        </Show>
      ),
      three,
      { root: R },
    );
    /** @type {string[]} */
    const disposed = [];
    geometry.addEventListener('dispose', () => disposed.push('geometry'));
    material.addEventListener('dispose', () => disposed.push('material'));
    $write(open, false);
    three.present();
    assert.deepEqual(disposed, ['material'], 'the geometry marked dispose={null} is kept');
    dispose();
    $dispose(R);
  });

  it('raycasts pointer events to objects and their ancestors, with hover', () => {
    const { three } = setup();
    const R = Root('scene');
    const clicks = $signal(R, 0);
    /** @type {string[]} */
    const seen = [];
    render(
      () => (
        <group name="outer" onClick={() => seen.push('group')}>
          <mesh
            name="target"
            onClick={(/** @type {any} */ e) => {
              seen.push(`mesh ${e.object.name}`);
              $write(clicks, $read(clicks) + 1);
            }}
            onPointerOver={() => seen.push('over')}
            onPointerOut={() => seen.push('out')}
          >
            <boxGeometry params={[2, 2, 2]} />
          </mesh>
        </group>
      ),
      three,
      { root: R },
    );
    three.scene.updateMatrixWorld();
    // The camera at z=5 looks down -z: the canvas centre hits the box.
    assert.equal(three.dispatch('click', 100, 50), true);
    assert.deepEqual(seen, ['mesh target', 'group'], 'the event bubbles to the ancestors');
    assert.equal($read(clicks), 1, 'handlers run in the view\'s root, as a batch');
    assert.equal(three.dispatch('click', 1, 1), false, 'a corner misses');
    seen.length = 0;
    three.dispatch('pointermove', 100, 50);
    three.dispatch('pointermove', 101, 50);
    three.dispatch('pointermove', 1, 1);
    assert.deepEqual(seen, ['over', 'out']);
    $dispose(R);
  });

  it('gives a throwing $animate callback\'s error to its Recover, and goes on with the others and the render', () => {
    const { three, drawer } = setup();
    let n = 0;
    let other = 0;
    const Bad = () => {
      $animate(() => {
        if (++n > 1) throw new Error('boom');
      });
      return <group />;
    };
    const Good = () => {
      $animate(() => void other++);
      return <group />;
    };
    render(() => <group><Recover fallback={<group name="fell" />}><Bad /></Recover><Good /></group>, three);
    three.frame(16);
    for (let t = 32; t < 100; t += 16) three.frame(t);
    assert.ok(three.scene.getObjectByName('fell') !== undefined, 'the Recover shows its fallback');
    assert.equal(other, 6, 'the callback after it ran every frame');
    assert.equal(drawer.frames, 6, 'and every frame rendered');
    assert.equal(three.animations.size, 1, 'the thrower went with its component');
    // With nothing to handle it, the error is reported and the callback dropped; the rest goes on.
    const alone = setup();
    const reported = /** @type {any[]} */ ([]);
    const g = /** @type {any} */ (globalThis);
    const report = g.reportError;
    const error = console.error;
    g.reportError = (/** @type {any} */ e) => reported.push(e.message);
    console.error = (/** @type {any} */ e) => reported.push(e.message);
    try {
      render(() => <group><Bad /><Good /></group>, alone.three);
      for (let t = 16; t < 100; t += 16) alone.three.frame(t);
    } finally {
      g.reportError = report;
      console.error = error;
    }
    assert.deepEqual(reported, ['boom'], 'reported once, then dropped');
    assert.equal(alone.three.animations.size, 1);
    assert.equal(alone.drawer.frames, 6);
  });

  it('keeps its own frame loop going off a ren-three renderer when a callback throws', () => {
    const g = /** @type {any} */ (globalThis);
    const raf = g.requestAnimationFrame;
    const caf = g.cancelAnimationFrame;
    /** @type {((now: number) => void)[]} */
    let queued = [];
    g.requestAnimationFrame = (/** @type {(now: number) => void} */ fn) => queued.push(fn);
    g.cancelAnimationFrame = () => {};
    const window = new Window();
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    let good = 0;
    let n = 0;
    const Bad = () => {
      $animate(() => {
        if (++n > 1) throw new Error('boom');
      });
      return <p>bad</p>;
    };
    const Good = () => {
      $animate(() => void good++);
      return <p>good</p>;
    };
    try {
      const R = Root({ id: 'loop', target: container, renderer: $dom(window.document, { styles: false }), children: () => <div><Recover fallback={<p>fell</p>}><Bad /></Recover><Good /></div> });
      for (let t = 0; t < 5; t++) {
        const now = queued;
        queued = [];
        for (const fn of now) fn(t * 16);
      }
      assert.ok(container.textContent.includes('fell'), 'the Recover shows its fallback');
      assert.equal(good, 5, 'the other loop kept going');
      $dispose(R);
    } finally {
      g.requestAnimationFrame = raf;
      g.cancelAnimationFrame = caf;
    }
  });

  it('gives an animation its first frame with delta 0, however long the scene was idle before it', () => {
    const { three } = setup();
    const R = Root('scene');
    const on = $signal(R, false);
    /** @type {number[]} */
    const deltas = [];
    const Spin = () => {
      $animate(frame => void deltas.push(frame.delta));
      return <mesh />;
    };
    render(() => <group><Show when={on}>{() => <Spin />}</Show></group>, three, { root: R });
    three.frame(0);
    // Ten seconds later an animation starts.
    $write(on, true);
    three.frame(10000);
    three.frame(10016);
    assert.deepEqual(deltas, [0, 0.016], 'as a worker\'s $animate: 0, then the time since the previous frame');
  });

  it('runs $animate callbacks every frame while their component lives', () => {
    const { three, drawer } = setup();
    const R = Root('scene');
    const spinning = $signal(R, true);
    /** @type {any} */
    let mesh = null;
    const Spinner = () => {
      $animate(frame => (mesh.rotation.z += frame.delta));
      return <mesh ref={m => (mesh = m)} />;
    };
    render(() => <Show when={spinning}>{() => <Spinner />}</Show>, three, { root: R });
    three.frame(0);
    three.frame(500);
    three.frame(1000);
    assert.equal(mesh.rotation.z, 1, 'the deltas sum to the time passed');
    assert.equal(drawer.frames, 3, 'an animated scene renders every frame');
    const before = mesh;
    $write(spinning, false);
    three.frame(1500);
    assert.equal(three.animations.size, 0, 'the callback stops with its component');
    assert.equal(before.rotation.z, 1);
    $dispose(R);
  });

  it('takes a camera from the view with main, and sizes it', () => {
    const { three, drawer } = setup();
    render(() => <perspectiveCamera name="eye" main fov={30} position={[0, 0, 10]} />, three);
    assert.equal(three.camera.name, 'eye');
    three.resize(400, 100);
    assert.deepEqual(drawer.size, [400, 100]);
    assert.equal(three.camera.aspect, 4);
  });

  it('refuses unknown classes, and primitives without a font, with the way out', () => {
    const { three } = setup();
    assert.throws(() => render(() => <Label text="hi" />, three), /the primitives need options.font/);
    const other = setup().three;
    assert.throws(() => render(() => <warpDrive />, other), /unknown element <warpDrive>: three.js has no WarpDrive/);
    assert.throws(() => $three(/** @type {any} */ ({})), /pass the three.js namespace/);
  });

  it('lives beside DOM roots: a three root nested in a DOM view, with props, and gone on dispose', () => {
    const window = new Window();
    const document = window.document;
    const page = document.createElement('main');
    document.body.appendChild(page);
    const drawer = stub();
    const three = $three(THREE, { renderer: drawer, width: 120, height: 80, schedule: false });
    /** @type {any} */
    let inside = null;
    const Scene = () => {
      inside = { renderer: $lookup(Runtime).renderer };
      return <mesh name="cube" position-y={() => $lookup(Props)}><boxGeometry /></mesh>;
    };
    const app = Root({
      id: 'app',
      target: page,
      renderer: $dom(document),
      storage: null,
      locks: null,
      children: () => {
        const height = $signal($active(), 1);
        $cleanup(/** @type {any} */ ($owner($active())), () => {});
        return (
          <div>
            <button onClick={() => $write(height, $read(height) + 1)}>raise</button>
            <Root id="stage" renderer={three} storage={null} locks={null} props={() => $read(height)}>
              {() => <Scene />}
            </Root>
          </div>
        );
      },
    });
    assert.deepEqual(inside, { renderer: 'three' });
    const host = page.querySelector('[data-ren-root="stage"]');
    assert.ok(host, 'the three root has a host element in the DOM view');
    assert.equal(three.scene.getObjectByName('cube').position.y, 1);
    page.querySelector('button').click();
    assert.equal(three.scene.getObjectByName('cube').position.y, 2, 'props flow from the DOM root into the scene');
    $dispose(app);
    assert.equal(three.closed, true);
    assert.equal(drawer.disposed, true);
    assert.equal(page.children.length, 0);
    assert.ok(three instanceof Renderer);
  });

  it('runs the application in a worker and the scene here: params, props, events, $animate', { timeout: 30000 }, async t => {
    const { three } = setup();
    three.open(null, 'stage');
    // The "worker": the application and its components, no three.js.
    const W = Root('stage');
    const size = $signal(W, 2);
    const clicks = $signal(W, 0);
    const angle = $signal(W, 0);
    /** @type {(value?: any) => void} */
    let turned = () => {};
    const animated = new Promise(resolve => (turned = resolve));
    const Scene = () => {
      $animate(frame => {
        $write(angle, $read(angle) + frame.delta);
        // A frame after the first (whose delta is 0) turned it.
        if ($read(angle) > 0) turned();
      });
      return (
        <group name="world" rotation-y={angle}>
          <mesh name="box" position-x={() => $read(clicks)} onClick={(/** @type {any} */ e) => $write(clicks, $read(clicks) + (e.x > 0 ? 1 : 0))}>
            <boxGeometry params={[$read(size), 2, 2]} />
            <meshBasicMaterial color="#1e4191" />
          </mesh>
          <For each={() => [1, 2]}>{n => <mesh name={() => `row ${n()}`}><sphereGeometry params={() => [n() / 2]} /></mesh>}</For>
        </group>
      );
    };
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, three, three.scene, { schedule: 'now' });
    const session = serve(() => <Scene />, { port: port1, root: W, construct: CONSTRUCT });
    // Closed after the test however it ends, a timeout too (a finally would wait on a hung await).
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      $dispose(W);
    });
    await connection.idle();
    const box = three.scene.getObjectByName('box');
    assert.ok(box instanceof THREE.Mesh, 'the scene is made here, from the worker\'s records');
    assert.equal(box.geometry.parameters.width, 2, 'params made in the worker construct the geometry here');
    assert.deepEqual(['row 1', 'row 2'].map(n => three.scene.getObjectByName(n).geometry.parameters.radius), [0.5, 1]);
    assert.equal(box.material.color.getHexString(), '1e4191');
    // A click here is raycast here and handled there; the answer comes back.
    assert.equal(three.dispatch('click', 100, 50), true);
    await connection.idle();
    assert.equal($read(clicks), 1);
    assert.equal(box.position.x, 1, 'the worker\'s update reached the scene');
    // $animate runs on the worker's frames and its signal writes cross.
    await animated;
    await connection.idle();
    assert.ok(three.scene.getObjectByName('world').rotation.y > 0, 'the animated rotation crossed');
  });

  it('gives raycast events the wheel deltas, buttons and modifiers, here and in a worker', { timeout: 30000 }, async t => {
    /** @type {any[]} */
    const seen = [];
    const note = (/** @type {any} */ e) => void seen.push([e.type, e.deltaY, e.buttons, e.shiftKey === true]);
    // Direct.
    const { three } = setup();
    const dispose = render(() => <mesh name="pad" onWheel={note}><boxGeometry params={[4, 4, 1]} /><meshBasicMaterial /></mesh>, three);
    three.input('wheel', 100, 50, /** @type {any} */ ({ deltaY: -120, buttons: 0, shiftKey: true }));
    assert.deepEqual(seen, [['wheel', -120, 0, true]]);
    dispose();
    // In a worker: the fields cross with the event.
    const other = setup().three;
    other.open(null, 'wheel');
    const W = Root('wheel');
    const got = $signal(W, /** @type {any} */ (null));
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, other, other.scene, { schedule: 'now' });
    const session = serve(() => <mesh onWheel={(/** @type {any} */ e) => $write(got, [e.deltaY, e.shiftKey])}><boxGeometry params={[4, 4, 1]} /><meshBasicMaterial /></mesh>, { port: port1, root: W, construct: CONSTRUCT });
    // Closed after the test however it ends, a timeout too (a finally would wait on a hung await).
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      $dispose(W);
    });
    await connection.idle();
    other.input('wheel', 100, 50, /** @type {any} */ ({ deltaY: 90, shiftKey: true }));
    await connection.idle();
    assert.deepEqual($read(got), [90, true]);
  });

  it('takes the WebGL renderer\'s settings from the view (<gl>), cursors from objects, and the pointer on a CSS-scaled canvas', () => {
    const drawer = /** @type {any} */ ({ ...stub(), shadowMap: { enabled: false }, toneMapping: 0, toneMappingExposure: 1 });
    const three = $three(THREE, { renderer: drawer, width: 200, height: 100, schedule: false });
    /** @type {string[]} */
    const clicks = [];
    const R = Root('gl');
    const exposure = $signal(R, 1.5);
    const dispose = render(
      () => (
        <>
          <gl toneMapping={4} toneMappingExposure={() => $read(exposure)} shadowMap-enabled />
          <mesh name="pad" cursor="pointer" onClick={() => clicks.push('pad')}><boxGeometry params={[4, 4, 1]} /><meshBasicMaterial /></mesh>
        </>
      ),
      three,
      { root: R },
    );
    assert.deepEqual([drawer.toneMapping, drawer.toneMappingExposure, drawer.shadowMap.enabled], [4, 1.5, true], 'the view set the drawer');
    $write(exposure, 0.8);
    assert.equal(drawer.toneMappingExposure, 0.8, 'and follows it');
    assert.equal(three.scene.children.filter((/** @type {any} */ c) => !c.isMesh).length, 0, '<gl> is nothing in the scene');
    // A cursor on an object shows while the pointer is over it.
    three.canvas = /** @type {any} */ ({ style: { cursor: '' }, clientWidth: 100, clientHeight: 50, addEventListener() {}, removeEventListener() {} });
    three.input('pointermove', 100, 50);
    assert.equal(three.canvas.style.cursor, 'pointer');
    three.input('pointermove', 5, 5);
    assert.equal(three.canvas.style.cursor, '', 'off it: the page\'s own');
    // A canvas the page shows at half its size: the pointer is scaled to the drawn pixels.
    /** @type {Record<string, (e: any) => void>} */
    const listeners = {};
    const shown = /** @type {any} */ ({ clientWidth: 100, clientHeight: 50, style: {}, addEventListener: (/** @type {string} */ t, /** @type {any} */ f) => (listeners[t] = f), removeEventListener() {} });
    const stop = three.attach(shown);
    listeners.click({ type: 'click', offsetX: 50, offsetY: 25, preventDefault() {} });
    assert.deepEqual(clicks, ['pad'], 'the middle of what is shown is the middle of what is drawn');
    listeners.click({ type: 'click', offsetX: 95, offsetY: 5, preventDefault() {} });
    assert.deepEqual(clicks, ['pad']);
    stop();
    dispose();
    $dispose(R);
  });

  it('stops raycasting once the objects with a cursor are removed', () => {
    const { three } = setup();
    const R = Root('cursor-removed');
    const open = $signal(R, true);
    const dispose = render(
      () => (
        <Show when={open}>
          {() => (
            <group>
              <mesh cursor="pointer"><boxGeometry params={[4, 4, 1]} /><meshBasicMaterial /></mesh>
            </group>
          )}
        </Show>
      ),
      three,
      { root: R },
    );
    assert.equal(three.cursors, 1);
    $write(open, false);
    three.present();
    assert.equal(three.cursors, 0, 'a removed subtree takes its cursors off the count');
    let picks = 0;
    const pick = three.pick.bind(three);
    three.pick = (/** @type {number} */ x, /** @type {number} */ y) => (picks++, pick(x, y));
    three.input('pointermove', 100, 50);
    assert.equal(picks, 0, 'no handler or cursor left: the pointer is not raycast');
    dispose();
    $dispose(R);
  });

  it('lets go of a hovered object once it is removed', () => {
    const { three } = setup();
    const R = Root('hovered-removed');
    const open = $signal(R, true);
    const dispose = render(
      () => (
        <Show when={open}>
          {() => <mesh cursor="pointer"><boxGeometry params={[4, 4, 1]} /><meshBasicMaterial /></mesh>}
        </Show>
      ),
      three,
      { root: R },
    );
    three.canvas = /** @type {any} */ ({ style: { cursor: '' }, clientWidth: 200, clientHeight: 100, addEventListener() {}, removeEventListener() {} });
    three.input('pointermove', 100, 50);
    assert.equal(three.canvas.style.cursor, 'pointer');
    assert.equal(three.hovered.length, 1);
    $write(open, false);
    three.present();
    three.input('pointermove', 100, 50);
    assert.equal(three.hovered.length, 0, 'the removed, disposed mesh is not kept as hovered');
    dispose();
    $dispose(R);
  });

  it('loses the WebGL context of a drawer it made when it closes, and leaves a given one', () => {
    const made = Object.assign(stub(), { lost: 0, forceContextLoss() { made.lost++; } });
    const mine = $three(THREE, { renderer: () => made, width: 20, height: 10, schedule: false });
    mine.open();
    mine.close();
    assert.equal(made.lost, 1, 'a drawer made for its canvas loses its context');
    const given = Object.assign(stub(), { lost: 0, forceContextLoss() { given.lost++; } });
    const theirs = $three(THREE, { renderer: given, width: 20, height: 10, schedule: false });
    theirs.open();
    theirs.close();
    assert.equal(given.lost, 0, 'a drawer the caller made stays theirs');
  });

  it('marks its host element while open, and keeps the element unmarked after close', () => {
    const page = new Window().document;
    const host = page.createElement('div');
    page.body.appendChild(host);
    const { three } = setup();
    three.open(host, 'stage');
    assert.equal(host.getAttribute('data-ren-root'), 'stage');
    three.close();
    assert.equal(host.hasAttribute('data-ren-root'), false);
    assert.equal(host.parentNode, page.body, 'the element stays the page\'s');
    assert.equal(host.children.length, 0, 'its canvas goes');
  });
});
