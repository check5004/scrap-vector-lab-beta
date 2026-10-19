import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_BUILD, APP_VERSION, RELEASE_VERSION } from '../src/build-info';
import { createJson, createSvg, createDxf } from '../src/geometry';
test('package, exports and diagnostics share the beta development version contract', () => {
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageInfo.version, RELEASE_VERSION);
  assert.match(APP_VERSION, /^0\.3\.0-dev\.1\+(local|[a-f0-9]{7})$/);
  const g = {outer:[{x:1,y:1},{x:20,y:1},{x:20,y:20},{x:1,y:20}],holes:[]};
  const board = {width:100,height:100};
  assert.deepEqual(JSON.parse(createJson(g,board)).provenance.app_build,APP_BUILD);
  assert.ok(createSvg(g,board).includes(APP_VERSION));
  assert.ok(createDxf(g,board).startsWith(`999\nScrap Vector Lab ${APP_VERSION}`));
  assert.match(readFileSync(new URL('../src/debug.ts', import.meta.url),'utf8'),/app_build: APP_BUILD/);
});
