# ren-three

The three.js renderer for [ren-core](https://github.com/wiltonlazary/ren-core): a ren-core `Host`
(`ren-core/host`) over a three.js scene graph. JSX describes the scene; rrx-core
signals drive it; ren-core's control flow (`Show`, `For`, `Choose`, `Render`,
`Pending`, `Recover`) adds and removes objects. Plain JavaScript with JSDoc
types, strict `tsc` checking and generated declarations.

The package is published on npm as `@maxenve/ren-three` under the MIT license;
install it under its import name: `npm install ren-three@npm:@maxenve/ren-three`. Its runtime dependencies are ren-canv and ren-core (linked from
the sibling checkouts); three.js is a peer
the caller imports and passes in (`>=0.160`; tested with 0.186.1), so the
application decides how it loads (ren-show loads it as a chunk of its
own on first use). It can share a page with ren-dom and ren-skia: each
application root has its own renderer.

```jsx
import * as THREE from 'three';
import { Root, $signal, $read, $write, $active, For } from 'ren-core';
import { $dom } from 'ren-dom';
import { $three, $animate } from 'ren-three';

const Lantern = () => {
  const lit = $signal($active(), false);
  let globe = null;
  $animate(frame => (globe.position.y = Math.sin(frame.time) * 0.2));
  return (
    <>
      <hemisphereLight intensity={0.6} />
      <pointLight position={[0, 2, 3]} intensity={() => ($read(lit) ? 30 : 5)} />
      <mesh ref={m => (globe = m)} onClick={() => $write(lit, !$read(lit))}>
        <sphereGeometry params={[0.7, 32, 16]} />
        <meshPhongMaterial color={() => ($read(lit) ? '#ffd166' : '#5b6c8f')} shininess={60} />
      </mesh>
      <For each={[-1.2, 0, 1.2]}>
        {x => <mesh position={() => [x(), -1.4, 0]}><cylinderGeometry params={[0.15, 0.2, 0.6]} /><meshNormalMaterial /></mesh>}
      </For>
    </>
  );
};

Root({ id: 'stage', target: document.body, renderer: $three(THREE, { width: 640, height: 360 }), children: <Lantern /> });
// Nested in a DOM view, fed by props: <Root id="stage" renderer={$three(THREE)} props={…}>{() => <Scene />}</Root>
```

| Export | What |
| --- | --- |
| `$three(THREE, options)` | the renderer (a `Renderer`): the Host, its `scene` and `camera`, `frame(time)`, `resize(w, h)`, `pick(x, y)`, `dispatch(type, x, y)`, and `dragOver(x, y, files, types)`, `dragLeave()`, `dropFiles(x, y, files)` |
| `render(view, renderer, options)` | `mount` into the renderer's scene; returns the dispose function |
| `$animate(fn)` | in a component: runs `fn(frame)` before every frame while the component lives (`frame.time`, `frame.delta` in seconds, `frame.scene`, `frame.camera`, `frame.renderer`) |
| `CONSTRUCT` | the props `element` reads at creation; a worker passes it to `serve` |
| `loadLayout`, `remoteLayout` | the primitives' layout engine: load it once; lay out in a worker |
| `loadShaper` | the primitives' text shaper (HarfBuzz): in a browser, load it once with the URL of harfbuzzjs's `harfbuzz.wasm`; node loads it when text first needs it |
| `Renderer`, `Tick` | the classes |

## Elements

- **Tags are three.js classes.** A lowercase element is the class of the
  same name, capitalized, from the namespace passed to `$three`: `<mesh>`,
  `<group>`, `<boxGeometry>`, `<meshStandardMaterial>`, `<ambientLight>`,
  `<perspectiveCamera>`, `<instancedMesh>`, … An unknown name throws.
  `<existing of={made}>` places an object made elsewhere (and leaves
  its disposal to its owner unless `dispose` is true).
- **A host node is the three.js object itself**, with ren-core's record on it
  under `__ren`; a `ref` receives the object.
- **Construction.** `params` are the constructor's arguments, compiled or not
  (the Host's `construct` props). New params (a different list of values)
  rebuild the object in place: it keeps its identity, parent and handlers; a
  fresh one is made and copied in (a scene object takes only what its class
  sets beyond Object3D's fields, never its transform or children; a
  geometry frees its old GPU buffers), and the properties the view set apply
  again. A class without `copy` needs a keyed element (a `Show` or a `For`
  row) to make a new one.
- **Slots.** Geometries go into the parent's `geometry`, materials into
  `material`, fog into `fog`, and `slot="name"` into any other property;
  removal restores the previous value. Other objects are added as children.
- **Properties** are set by name. A dash sets a path (`position-x`,
  `rotation-y`). A property holding a math object (Vector3, Euler,
  Color, Quaternion, …) is updated in place: an array spreads into `set`,
  the same type is copied, a number is a Color's hex or goes to `setScalar`,
  anything else to `set` (`color="#f80"`, `scale={2}`). Reactive values bind
  as everywhere in ren-core.
- **Resources.** A removed object's geometries, materials and textures are
  disposed at the end of the flush, unless it was inserted again meanwhile
  (a moved row). `dispose={null}` on a geometry, material or texture
  element keeps that resource; on an object it skips only that object's own
  `dispose()`, and the resources of its elements still go.
- **`<gl>`** sets the WebGL renderer's own properties from the view
  (`<gl toneMapping={ACESFilmicToneMapping} toneMappingExposure={1.2}
  shadowMap-enabled />`): kept, applied to the renderer as it is made, and
  reactive like any property.
- **Cursor.** `cursor="pointer"` on an object shows that CSS cursor while
  the pointer is over it or a child (where no primitive is on top).
- **Camera.** A PerspectiveCamera by default (`camera` option), sized to the
  canvas; `<perspectiveCamera main>` in the view replaces it.
- **Portable primitives render too** (`View`, `Layout`, `Scroll`, `Label`,
  `Edit`, `Action`, `Image`, `Shape`), through
  [ren-canv](https://github.com/wiltonlazary/ren-canv): the same layout, portable style,
  editing, text selection, native text entry and accessibility mirror as on
  ren-skia, drawn with a 2D canvas into a texture. An application of
  primitives alone runs here as on ren-dom or ren-skia, and mixes freely
  with three.js objects:
  - **The overlay.** Primitives placed in the scene itself lie over the
    canvas, pixel for pixel, drawn after the scene; in the order of the
    view among the scene's objects.
  - **Panels.** Primitives placed in a three.js object (`<group>`,
    `<mesh>`) become a plane in it, as large as their content (`pixel`
    world units per pixel, 0.01), facing +z.
  - **Input.** The pointer reaches the overlay first, then a panel under
    it (by the raycast's texture coordinate; a drag stays with the surface
    it started on), then the scene's objects, so a press on a button never
    also clicks the mesh behind it. Keys, copy and select all go to the
    surface last pressed; an Edit's native text entry lies over it on the
    canvas (a panel's projected). A touch follows the `touchAction` of
    the primitives under it on the surface it presses (the overlay where
    it has something there, else a panel), as ren-canv's attach does: its
    start is cancelled where they allow no pan, its first move where it
    goes along an axis they forbid, a second finger where they forbid a
    pinch zoom; where none sets one, a touch that a surface or an object
    with a handler took keeps the page from panning. When the browser
    takes the pointer back (a `pointercancel`), the surface holding the
    press hears `onPointerCancel` where the pointer last was and the press
    ends with no `pointerup`; with no surface holding it, the scene's
    objects there hear `pointercancel` through the raycast.
  - **Drag and drop.** Files dragged over the canvas go to the surfaces as
    presses do: the overlay where it has something there or an item that
    hears drags or drops, else a panel by the raycast's texture coordinate.
    Its items hear `onDragEnter`, `onDragOver`, `onDragLeave` and `onDrop`
    (`{ files, x, y }` in its pixels) as on ren-canv; a drag moving to
    another surface leaves the first, then enters the second, and leaving
    the canvas leaves the one under it; a drop ends the drag without a
    leave. The browser's default (opening a dropped file) is prevented only
    where a surface or a scene object takes the drag. Main thread only.
  - They need the `font` option: the typeface's bytes, which measure the
    text (from the font file itself) and draw it (registered as a
    FontFace); `families` and `fallback` add typefaces by family name and
    for the characters a typeface lacks, measured and registered the same
    way. A character no typeface has measures as the missing glyph, but the
    2D canvas draws it in the browser's fallback font, at another width.
    Right-to-left text is laid out by ren-canv's bidirectional algorithm;
    the 2D canvas sets each right-to-left run from its right edge in its
    visual order. Text that needs shaping (Arabic joined, Indic clusters,
    marks) is measured shaped (ren-canv's `loadShaper`: in a browser, load
    it once with the URL of harfbuzzjs's `harfbuzz.wasm`) and the browser
    shapes what it draws with the same features (kerning and optional
    ligatures off), at the width measured. A three.js object inside a
    primitive throws.
  - **Surfaces.** Each is a ren-canv Document: `renderer.overlay` is the
    overlay's (null until a primitive is placed in the scene) and
    `renderer.surfaces` holds the overlay's and every panel's, with the
    Document's API (`commands()`, `copied()`, `press`, `key`, …). Pointer
    events, keys, focus, scrolling and the cursor behave as on the DOM
    (ren-canv's README, "Input as the DOM has it"). A root's `$keys` and
    `$scrolls` (listened on the scene) hear every surface: the overlay's
    and each panel's keys, chords too, and scrolls; a key with no surface
    focused goes to the overlay (else the first panel). One surface has
    the focus: a press, an item's `focus()` or `focusFirst()` and
    `$focus(ref)` take it from the others, and the keys go there; a blur
    handler there that moves the focus wins, in whichever surface, as in
    Chrome.
  - **Theme.** `renderer.setTheme(tokens)` takes a new theme at once for the
    overlay and every panel; the scene and all state stay.
  - **Viewport.** In a three.js root `$viewport()` and `$media()` read the
    canvas's size in CSS pixels, followed as it resizes, not the page's
    window; the dark color scheme and reduced motion come from the
    window the canvas is in (none without one). In worker mode the
    connection carries them to the worker (ren-core's README, "Viewport
    and media queries"). In a panel whose primitive sets its width and
    height in pixels (its style's `width` and `height`, or the `width` and
    `height` props), they read the panel's size, followed as it changes;
    the preferences stay the window's. A panel sized by its content reads
    the canvas's: its size follows what it shows, so a view reading it
    could swing between two layouts. The Host's `viewportOf` gives each
    primitive this source, bound to its panel once the primitive is
    placed (a component runs before its nodes are), the canvas's until
    then; in worker mode the connection carries the panel's too.

## Frames

Rendering is on demand: a flush that changed the scene asks for one frame
(`requestAnimationFrame`), and an unchanged flush draws nothing. While any
`$animate` callback lives, every animation frame runs the callbacks and
renders. `schedule: false` leaves frames to the caller (`frame(time)`), for
tests and hosts with their own loop.

## Events

`on<Name>` handlers on any object receive raycast pointer events: `click`,
`dblclick`, `contextmenu`, `pointerdown`, `pointerup`, `pointermove`,
`pointercancel` (the browser took the pointer back; where it last was),
`wheel`, and `pointerover`/`pointerout` as the objects under the pointer
change. Files dragged over the canvas where no primitive takes them reach
`onDragOver` (with `files`, their count, and `types`) and `onDrop`
(`files`, the dropped File objects) on the objects under them. The nearest hit's handler runs first, then its ancestors', until one
calls `stopPropagation()`. The event carries `object` (hit), `currentObject`
(the handler's), `point`, `distance`, `intersection`, `intersections` and
`native`. The pointer is read in the canvas's drawn pixels, so a canvas
the page's CSS resizes still picks what is under it. An object that is
not drawn (`visible={false}` on it or an ancestor) takes no pointer, as a
hidden element on the DOM; a catcher that must take it without showing
stays visible with `colorWrite={false} depthWrite={false}`. Handlers run as a `$batch` in the context they were bound in, as
everywhere in ren-core. The raycast runs only while some object has a handler or a cursor.

## Layout

The primitives are laid out by ren-canv's engine, Taffy by default: `await
loadLayout()` once before the first renderer that draws them (in a browser,
with the URL of taffy-layout's `taffy_wasm_bg.wasm`). Or in a worker:
`layout: remoteLayout(worker)`, with `serveLayout` from `ren-canv/worker`
there; the overlay and every panel lay out there and paint when their boxes
come back.

## Options

| Option | Meaning |
| --- | --- |
| `width`, `height` | the canvas in CSS pixels; by default the host element's size, followed as it resizes (300 × 150 without one) |
| `scale` | the device pixel ratio (the window's) |
| `renderer` | what draws: a `WebGLRenderer` made on the canvas by default (antialiased); or one given, or a function of the canvas that makes it (a WebGPU renderer, a stub in tests) |
| `camera` | a three.js camera, or `{ fov, near, far, position }` for the default PerspectiveCamera (50°, 0.1, 1000, at [0, 0, 5]) |
| `background` | the scene's background color |
| `schedule` | `'frame'` (default): frames on `requestAnimationFrame`; `false`: only when `frame()` is called |
| `font` | the typeface's bytes for the primitives (needed once one renders) |
| `mono` | a monospace typeface's bytes: text whose `fontFamily` names monospace is measured and drawn in it |
| `families` | typefaces' bytes by family name: text whose `fontFamily` names one (the first of its list given here, before a generic family) is measured and drawn in it |
| `fallback` | typefaces' bytes, in order: a character a typeface lacks is measured and drawn in the first of them that has it |
| `pixel` | world units per pixel of a panel (0.01) |
| `theme` | theme overrides for the primitives (ren-core's tokens) |
| `aria` | the primitives' accessibility mirror, as ren-canv's (`true`, `false`, `'demand'`) |
| `layout` | where the primitives are laid out: this thread (default), or a layout worker, `remoteLayout(port)` |
| `image` | loads an `Image` source for a 2D canvas (an HTMLImageElement by default) |

An application root in a document makes a `<canvas>` in its host element and
routes its pointer events; `close` (the root's dispose) empties the scene,
disposes its resources and the WebGL renderer, and removes the canvas.

## Worker mode

As with ren-dom and ren-skia, three.js and the scene stay on the main
thread, with the renderer; the worker holds only the application and its
components (no three.js, no DOM, no renderer code).

```jsx
// worker.jsx: the application only
import { serve } from 'ren-core/worker';
import { CONSTRUCT } from 'ren-three';
serve(() => <Scene />, { id: 'stage', construct: CONSTRUCT });

// main.jsx: three.js and the renderer
import * as THREE from 'three';
Root({ id: 'stage', runtime: 'worker', worker: () => new Worker(url, { type: 'module' }), target, renderer: $three(THREE) });
```

- `construct: CONSTRUCT` sends each element's constructor `params` (and
  `slot`, `dispose`) with it, and each compiled template instance's, so
  the main thread builds the same objects. `<existing of>` holds an
  object made on the main thread, so it belongs to the direct runtime.
- `$animate` runs in the worker on its own frames, with a `Tick` whose
  renderer, scene and camera are null: animate through signals
  (`rotation-y={angle}`), whose writes cross like any update.
- Pointer events are raycast on the main thread and cross with their canvas
  `x` and `y`, buttons and modifier keys; refs in the worker are handles.
- Importing `CONSTRUCT` and `$animate` brings no renderer code into a worker
  bundle (`$animate` recognizes the renderer by its shape).

## Tests

```sh
(cd ../../../rrx-core/wtree/_repo_ && npm install)   # rrx-core, ren-core, ren-canv, then ren-dom: their installs generate the types checked here
(cd ../../../ren-core/wtree/_repo_ && npm install)
(cd ../../../ren-canv/wtree/_repo_ && npm install)
(cd ../../../ren-dom/wtree/_repo_ && npm install)
npm install        # ren-core, rrx-core, ren-canv and ren-dom (linked), pinned devDependencies: three, esbuild, happy-dom, typescript
npm test           # declarations, tsc --checkJs --strict, the TypeScript consumer, node:test twice
```

`test/three.test.jsx` builds and raycasts real three.js scenes in node (no
WebGL: a drawer stub counts frames): classes, params, slots and
properties; reactive properties and regions with one render per changed
flush; resource disposal of removed objects, not of moved ones or
`<existing>` ones; raycast events with bubbling and hover; `$animate`; a
`main` camera and resizing; the refusals; and a three.js root nested
in a ren-dom view with props; and worker mode (the application served over
a MessageChannel: params, props, raycast clicks answered by the worker,
`$animate` in the worker). ren-show checks both on WebGL in headless
Chrome, the worker mode with a real Worker. `test/primitives.test.jsx`
renders the portable primitives through ren-canv, in the overlay and on a
panel: their layout, text, input and a layout worker.
`test/viewport.test.jsx` checks `$viewport` and `$media` against the
canvas's size as it resizes, directly and in worker mode.
`test/deps.test.js` checks that `src/` reaches no module a dependent does not install.
`test/timers.test.js` fails a timer call that does not say why it is one,
and `test/exports.test.js` locks the public contract to
`test/exports.lock.json`. `npm test` runs the
suites with the automatic runtime (`ren-core/loader`) and compiled by
ren-core/esbuild (`ren-core/compiled`).

## Benchmarks

The harnesses live in [ren-bench](https://github.com/wiltonlazary/ren-bench).
Run benchmark commands from that checkout.

[ren-bench's three.js benchmark](https://github.com/wiltonlazary/ren-bench/blob/main/bench/r3f/README.md) measures ren-three
against a market renderer on the same scene
(1,000 meshes in a keyed list, created, recolored, reordered, removed), as
each library's users write it; its README has the method and the current
results.
