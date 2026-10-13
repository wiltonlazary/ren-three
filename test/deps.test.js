// The package imports only what it declares: a module a dependent does not
// install (a devDependency) must not be reached from src/.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);

describe('ren-three dependencies', () => {
  it('imports from src/ only its dependencies and peers (and node: builtins)', () => {
    /** @type {string[]} */
    const stray = [];
    for (const file of readdirSync(new URL('src/', root)).filter(f => f.endsWith('.js'))) {
      const text = readFileSync(new URL(`src/${file}`, root), 'utf8');
      for (const [, spec] of text.matchAll(/\bfrom\s+'([^'.][^']*)'/g)) {
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!declared.has(name)) stray.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(stray, []);
  });
});
