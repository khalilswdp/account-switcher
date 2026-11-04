import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SCRIPTS, exists, makeStubs, run, scratch } from './helpers.mjs';

const swap = (env, ...args) => run('bash', [path.join(SCRIPTS, 'desktop-swap.sh'), ...args], { env });

test('desktop-swap: init, new, use, and the refusals that keep data safe', async () => {
  const dir = await scratch('swap');
  const support = path.join(dir, 'support');
  const env = { SUPPORT_DIR: support, SWAP_STATE_DIR: path.join(dir, 'state'), SWAP_SKIP_RUNNING_CHECK: '1' };
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.writeFile(path.join(support, 'Claude', 'marker'), 'A');

  let r = await swap(env, 'use', 'b');
  assert.equal(r.code, 1);
  assert.match(r.err, /not initialised/);
  r = await swap(env, 'init', 'bad name');
  assert.equal(r.code, 1);
  r = await swap(env, 'init', 'a');
  assert.equal(r.code, 0, r.err);
  r = await swap(env, 'init', 'a');
  assert.equal(r.code, 1);
  assert.match(r.err, /already initialised/);
  r = await swap(env, 'list');
  assert.equal(r.out, 'active a\nrunning no\n');

  // "new" parks the current data and leaves no active folder, so the app starts signed out
  r = await swap(env, 'new', 'b');
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists(path.join(support, 'Claude')), false);
  assert.equal(await fs.readFile(path.join(support, 'Claude.a', 'marker'), 'utf8'), 'A');
  r = await swap(env, 'list');
  assert.equal(r.out, 'active b\nrunning no\nparked a\n');

  // the app "signs in" as b, then the two accounts are swapped
  await fs.mkdir(path.join(support, 'Claude'));
  await fs.writeFile(path.join(support, 'Claude', 'marker'), 'B');
  r = await swap(env, 'use', 'a');
  assert.equal(r.code, 0, r.err);
  assert.equal(await fs.readFile(path.join(support, 'Claude', 'marker'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(support, 'Claude.b', 'marker'), 'utf8'), 'B');
  r = await swap(env, 'use', 'a');
  assert.equal(r.code, 0);
  assert.match(r.out, /already active/);
  r = await swap(env, 'use', 'zzz');
  assert.equal(r.code, 1);
  assert.match(r.err, /no parked account/);
  r = await swap(env, 'new', 'b');
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
  r = await swap(env, 'status');
  assert.match(r.out, /Active account : a/);
  assert.match(r.out, /Parked {9}: b/);
});

test('desktop-swap refuses to move folders while the app is running', async () => {
  const dir = await scratch('swap-running');
  const stubs = await makeStubs(dir);
  const support = path.join(dir, 'support');
  const env = { ...stubs.env, SUPPORT_DIR: support, SWAP_STATE_DIR: path.join(dir, 'state') };
  await fs.mkdir(path.join(support, 'Claude'), { recursive: true });
  await fs.mkdir(path.join(support, 'Claude.b'), { recursive: true });
  assert.equal((await swap(env, 'init', 'a')).code, 0);
  await stubs.setRunning(true);
  let r = await swap(env, 'use', 'b');
  assert.equal(r.code, 1);
  assert.match(r.err, /still running/);
  assert.equal((await swap(env, 'list')).out, 'active a\nrunning yes\nparked b\n');
  await stubs.setRunning(false);
  r = await swap(env, 'use', 'b');
  assert.equal(r.code, 0, r.err);
});
