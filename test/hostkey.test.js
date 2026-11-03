/**
 * HOST_KEY is retired. Accounts own the console; these tests lock that in so
 * a hosted deploy cannot get stuck waiting for a shared night key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
      if (!buffer.includes('Ready.')) return;
      clearTimeout(timer);
      resolve({ proc, base: `http://127.0.0.1:${port}` });
    });
    proc.stderr.on('data', (c) => process.stderr.write(c));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${buffer}`)));
  });
}

test('local server starts without HOST_KEY and bootstraps via admin setup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amplify-nohostkey-'));
  const { proc, base } = await startServer({ DATA_DIR: dataDir });
  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.hasHostKey, undefined);

    const setup = await fetch(`${base}/api/host/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', displayName: 'Boss', password: 'secret1' }),
    });
    const body = await setup.json();
    assert.equal(setup.status, 200, JSON.stringify(body));
    assert.ok(body.token);
    assert.ok(body.jam?.id);

    const state = await fetch(`${base}/api/state`, {
      headers: { 'x-host-token': body.token },
    }).then((r) => r.json());
    assert.equal(state.needsHostSetup, false);
    assert.equal(state.setupRequiresHostKey, false);
    assert.equal(state.isHost, true);
  } finally {
    proc.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});
