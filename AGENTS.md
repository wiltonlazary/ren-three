# ren-three

Standing rules for agents working in this checkout.

Read the workspace layer first: [`../../../AGENTS.md`](https://github.com/wiltonlazary/rui/blob/main/AGENTS.md) and [`../../../.ai/config/`](https://github.com/wiltonlazary/rui/tree/main/.ai/config)
(stability.md first, then javascript.md, design.md, benchmarks.md, concepts.md,
resources.md, git.md).
Then read [README.md](README.md), ren-core's README for the component layer and
the Host contract ([`../../../ren-core/wtree/_repo_/README.md`](https://github.com/wiltonlazary/ren-core)), and
[TODO.md](TODO.md) for open work.

## What this is

ren-three is ren-core's three.js renderer, a production library packaged as
`ren-three`: JSX over a three.js scene graph, raycast events,
on-demand frames and `$animate`, and the portable primitives through
ren-canv (src/surface.js). Its runtime dependencies are ren-canv and ren-core,
linked from the sibling checkouts; three.js is a peer the caller passes in,
and ren-three imports nothing of it (no three.js declarations either).
ren-dom is a devDependency, for the tests of a three.js root in a DOM view.

## Layout and outputs

- Checkout: `wtree/_repo_` (branch `main`); feature branches are sibling
  worktrees under `wtree/<name>`, each with its own build directory
  `build/<name>_<version>` and its own `artifact` link to it.
- Build output: `build/_repo__0.1.10`, reached through the ignored `artifact`
  link: generated output and scratch (`artifact/tmp/<task>/`).
- Benchmarks belong to [ren-bench](https://github.com/wiltonlazary/ren-bench);
  their bundles, profiles and results are generated there.
- `types/` is generated (`scripts/types.mjs`) and ignored.

## Project specifics

- ren-three consumes ren-core's public entries only (`ren-core`, `ren-core/host`). When it
  needs something new from ren-core (as the Host's `construct`), change ren-core
  first, with ren-core's tests, then this package; both suites must pass.
- Install rrx-core, ren-core, ren-canv and ren-dom first: `tsc` reads their
  generated declarations.
- three.js lives on the main thread only. In worker mode the worker holds
  the application and its components, nothing of three.js or of this
  package but `CONSTRUCT` and `$animate` (which must never reference
  `Renderer`, so a worker bundle stays free of it).
- Node has no WebGL: tests drive frames by hand with a drawer stub; real
  WebGL is checked in ren-show's headless Chrome run (SwiftShader).
