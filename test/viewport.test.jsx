// The viewport of a three.js root: the canvas's size and the page's media
// preferences, read reactively through ren-core's $viewport and $media,
// directly and in worker mode; in a panel, the panel's size when its
// primitive sets one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { Root, $read, $write, $signal, $dispose, $viewport, $media, $effect, $active, $owner, $cleanup, View, Layout, Show } from 'ren-core';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { $three, CONSTRUCT, render, loadLayout } from 'ren-three';
import { closeAfter } from './fixtures/after.js';

/** The layout engine (Taffy's WebAssembly), once, before any renderer. */
await loadLayout();
/** DejaVu Sans, from the test fixtures (with its license): panels measure text with it. */
const font = readFileSync(new URL('./fixtures/dejavu.ttf', import.meta.url));

/** A drawer that records its size instead of drawing. */
const stub = () => {
  const drawer = {
    size: [0, 0],
    render() {},
    setSize: (/** @type {number} */ w, /** @type {number} */ h) => void (drawer.size = [w, h]),
    dispose() {},
  };
  return drawer;
};

/** A mesh named after the viewport and a media query over it. */
const Sized = () => {
  const v = $viewport();
  const wide = $media('(min-width: 500px)');
  return <mesh name="sized" userData-text={() => `${$read(v.width)}x${$read(v.height)} ${$read(wide) ? 'wide' : 'narrow'}${$read(v.dark) ? ' dark' : ''}${$read(v.reduced) ? ' reduced' : ''}`} />;
};

/** @param {any} three */
const text = three => three.scene.getObjectByName('sized')?.userData.text;

describe('ren-three viewport', () => {
  it("reads the canvas's size, not the window's, and the page's preferences", async t => {
    const window = new Window({ width: 1280, height: 720, settings: { device: { prefersColorScheme: 'dark', prefersReducedMotion: 'reduce' } } });
    closeAfter(t, () => window.happyDOM.close());
    const document = window.document;
    const three = $three(THREE, { renderer: stub(), width: 320, height: 180, schedule: false });
    const root = Root({ id: 'stage', target: document.body, renderer: three, storage: null, locks: null, children: () => <Sized /> });
    assert.equal(text(three), '320x180 narrow dark reduced', 'the canvas, at a size other than the window');
    three.resize(640, 360);
    assert.equal(text(three), '640x360 wide dark reduced', '$media follows the canvas as it resizes');
    three.resize(480, 360);
    assert.equal(text(three), '480x360 narrow dark reduced');
    assert.equal(three.viewers.size, 1);
    $dispose(root);
    assert.equal(three.viewers.size, 0, 'none after the last reader');
    assert.equal(three.queries, null, 'nor the preference queries');
  });

  it("carries the canvas's size to a worker", { timeout: 30000 }, async t => {
    const three = $three(THREE, { renderer: stub(), width: 320, height: 180, schedule: false });
    three.open(null, 'stage');
    const W = Root('stage');
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, three, three.scene, { schedule: 'now' });
    const session = serve(() => <Sized />, { port: port1, root: W, construct: CONSTRUCT });
    // Closed after the test however it ends, a timeout too (a finally would wait on a hung await).
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      $dispose(W);
      three.close();
    });
    await connection.idle();
    assert.equal(text(three), '320x180 narrow', 'in place when the view builds');
    three.resize(800, 600);
    await connection.idle();
    assert.equal(text(three), '800x600 wide', 'a resize here reaches the worker');
  });

  /** What each `Seen` reads, by its name. @type {Record<string, string>} */
  const seen = {};
  /** Records its viewport and a media query over it under `name`. @param {{ name: string }} props */
  const Seen = props => {
    const v = $viewport();
    const wide = $media('(min-width: 500px)');
    $effect($active(), () => void (seen[props.name] = `${$read(v.width)}x${$read(v.height)} ${$read(wide) ? 'wide' : 'narrow'}`));
    $cleanup(/** @type {any} */ ($owner($active())), () => void delete seen[props.name]);
    return null;
  };
  /** The view: the overlay, a panel with a size of its own (by style, then by shorthand), one sized by its content. @param {{ width: any, open: any }} props */
  const Panels = props => (
    <>
      <View><Seen name="overlay" /></View>
      <group>
        <View style={() => ({ width: $read(props.width), height: 120 })}>
          <Seen name="sized" />
          <Layout><Seen name="nested" /></Layout>
        </View>
      </group>
      <mesh><View width={240} height={90}><Seen name="shorthand" /></View></mesh>
      <Show when={props.open}>
        <group><View><Seen name="content" /></View></group>
      </Show>
    </>
  );

  it("reads a panel's own size where its primitive sets one, else the canvas's", async () => {
    const three = /** @type {any} */ ($three(THREE, { renderer: stub(), width: 640, height: 360, schedule: false, font }));
    /** @type {any} */
    let width = null;
    /** @type {any} */
    let open = null;
    const dispose = render(() => {
      width = $signal($active(), 300);
      open = $signal($active(), true);
      return <Panels width={width} open={open} />;
    }, three);
    three.present();
    assert.deepEqual({ ...seen }, {
      overlay: '640x360 wide',
      sized: '300x120 narrow',
      nested: '300x120 narrow',
      shorthand: '240x90 narrow',
      content: '640x360 wide',
    }, 'a panel sized by its content reads the canvas: its size follows what it shows');
    $write(width, 520);
    three.present();
    // The panel reports its new size after the layout that gave it.
    await Promise.resolve();
    assert.equal(seen.sized, '520x120 wide', 'the panel follows its resize');
    assert.equal(seen.nested, '520x120 wide');
    three.resize(400, 300);
    assert.equal(seen.overlay, '400x300 narrow');
    assert.equal(seen.content, '400x300 narrow', 'a panel sized by its content follows the canvas');
    assert.equal(seen.sized, '520x120 wide', 'a sized panel keeps its own');
    $write(open, false);
    assert.equal(three.unbound.size, 0);
    dispose();
    assert.deepEqual(seen, {});
    assert.equal(three.viewers.size, 0, 'nothing follows the canvas after the last reader');
    for (const surface of three.surfaces) assert.equal(surface.viewers.size, 0, 'nor a panel');
    three.close();
  });

  it("carries a panel's own size to a worker", { timeout: 30000 }, async t => {
    const three = /** @type {any} */ ($three(THREE, { renderer: stub(), width: 640, height: 360, schedule: false, font }));
    three.open(null, 'stage');
    const W = Root('stage');
    const width = $signal(W, 300);
    const open = $signal(W, true);
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, three, three.scene, { schedule: 'now' });
    // The worker's Seen records here: the test shares this thread with it.
    const session = serve(() => <Panels width={width} open={open} />, { port: port1, root: W, construct: CONSTRUCT });
    closeAfter(t, () => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      $dispose(W);
      three.close();
    });
    await connection.idle();
    // The panels' reports cross after the view's first message.
    await connection.idle();
    assert.deepEqual({ ...seen }, {
      overlay: '640x360 wide',
      sized: '300x120 narrow',
      nested: '300x120 narrow',
      shorthand: '240x90 narrow',
      content: '640x360 wide',
    });
    $write(width, 520);
    await connection.idle();
    three.present();
    await Promise.resolve();
    await connection.idle();
    assert.equal(seen.sized, '520x120 wide', 'the panel follows its resize');
    three.resize(400, 300);
    await connection.idle();
    assert.equal(seen.content, '400x300 narrow');
    assert.equal(seen.sized, '520x120 wide');
    $write(open, false);
    await connection.idle();
    assert.equal('content' in seen, false);
  });
});
