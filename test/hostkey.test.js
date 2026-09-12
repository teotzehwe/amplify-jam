/**
 * Host key tests.
 *
 * `HOST_KEY` exists for hosted deploys. There the generated key is printed to
 * a log nobody reads and stripped from every response, so without it there is
 * no way into the host console at all — these are the tests standing between a
 * deploy and a locked-out host.
 *
 * Both backends are covered because each plumbs the key through separately:
 * the file backend passes it to `migrate` on read, the key-value backend holds
 * it on the instance and applies it to whatever comes back from Redis.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeRedis } from './helpers/fake-redis.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CHOSEN = 'a-secret-the-host-picked';
const STORED = 'the-key-that-was-generated-earlier';

/* ----------------------------------------------------------------- helpers */

/** Boot the real server and wait until it announces the key it settled on. */
function startServer(env) {
  const port = 3900 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      // \S+ rather than \w+: a key someone chose is not always word characters.
      const match = buffer.match(/Host key: (\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ proc, base: `http://127.0.0.1:${port}`, printedKey: match[1] });
    });
    proc.stderr.on('data', (c) => process.stderr.write(c));
  });
}

async function authenticate(base, token) {
  const res = await fetch(`${base}/api/host/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** A night already in storage, saved under a key nobody wrote down. */
const savedNight = (name) => JSON.stringify({ hostToken: STORED, jam: { name } });

/* ------------------------------------------------------------- file backend */

test('a chosen host key supersedes the one already saved', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amplify-hostkey-'));
  await writeFile(join(dataDir, 'jam.json'), savedNight('Saved Night'));

  const { proc, base, printedKey } = await startServer({ DATA_DIR: dataDir, HOST_KEY: CHOSEN });
  t.after(async () => {
    proc.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(printedKey, CHOSEN, 'the server announces the key it was given');

  const chosen = await authenticate(base, CHOSEN);
  assert.equal(chosen.status, 200, 'the chosen key opens the host console');
  assert.equal(chosen.data.jam, 'Saved Night', 'and the saved night is still there, not replaced');

  const stored = await authenticate(base, STORED);
  assert.equal(stored.status, 403, 'the superseded key no longer works');
});

test('without a chosen key the saved one still works', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amplify-hostkey-'));
  await writeFile(join(dataDir, 'jam.json'), savedNight('Ordinary Night'));

  const { proc, base, printedKey } = await startServer({ DATA_DIR: dataDir });
  t.after(async () => {
    proc.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  // The whole point of the override is that it is an override. A laptop with
  // no HOST_KEY set must keep the key it has been printing all night.
  assert.equal(printedKey, STORED, 'the stored key survives when nothing overrides it');
  assert.equal((await authenticate(base, STORED)).status, 200);
});

test('the chosen key never leaves the server', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amplify-hostkey-'));
  const { proc, base } = await startServer({ DATA_DIR: dataDir, HOST_KEY: CHOSEN });
  t.after(async () => {
    proc.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  const body = await fetch(`${base}/api/state`).then((res) => res.text());
  assert.ok(!body.includes(CHOSEN), 'the host key must not appear in the public state');
  assert.equal(JSON.parse(body).isHost, false, 'and an anonymous reader is not the host');
});

/* --------------------------------------------------------------- kv backend */

test('a chosen host key reaches the hosted backend too', async (t) => {
  const redis = await startFakeRedis();
  redis.data.set('hktest:state', savedNight('Hosted Night'));
  redis.data.set('hktest:version', '1');

  const { proc, base, printedKey } = await startServer({
    KV_REST_API_URL: redis.url,
    KV_REST_API_TOKEN: 'test-token',
    KV_PREFIX: 'hktest',
    HOST_KEY: CHOSEN,
  });
  t.after(() => {
    proc.kill();
    redis.server.close();
  });

  assert.equal(printedKey, CHOSEN);

  const chosen = await authenticate(base, CHOSEN);
  assert.equal(chosen.status, 200, 'the chosen key opens the host console on a hosted deploy');
  assert.equal(chosen.data.jam, 'Hosted Night', 'reading the night out of the store, not a fresh one');

  const stored = await authenticate(base, STORED);
  assert.equal(stored.status, 403, 'the key held in Redis does not outrank the environment');

  // The override is applied on read, so it must not be written back into the
  // store — otherwise unsetting the variable would leave the chosen key baked
  // in, which is the wrong behaviour for something meant to be a secret.
  assert.ok(
    !redis.data.get('hktest:state').includes(CHOSEN),
    'the chosen key is not persisted into the shared store',
  );
});
