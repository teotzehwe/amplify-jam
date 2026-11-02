/**
 * Supabase account sync: real server against a PostgREST stand-in so accounts
 * land in the fake table and survive a wiped night blob.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeSupabase } from './helpers/fake-supabase.js';
import { mergeUsers } from '../src/supabase-users.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let supabase;
let server;
let dataDir;
let base;
let hostKey;

before(async () => {
  supabase = await startFakeSupabase();
  dataDir = await mkdtemp(join(tmpdir(), 'amplify-sb-'));
  const port = 3900 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR || '',
      HOME: process.env.HOME || '',
      PORT: String(port),
      DATA_DIR: dataDir,
      SUPABASE_URL: supabase.url,
      SUPABASE_SERVICE_ROLE_KEY: supabase.key,
      SUPABASE_JAM_ID: 'amplify-test',
      HOST_KEY: 'supabase-test-host-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  hostKey = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (/listening|Host key|Amplify/i.test(buffer) || buffer.includes('http')) {
        // HOST_KEY is fixed; wait until the process printed something.
        clearTimeout(timer);
        resolve('supabase-test-host-key');
      }
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
    // Also resolve once the port answers.
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok || res.status === 503) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve('supabase-test-host-key');
        }
      } catch { /* not up yet */ }
    }, 50);
  });
});

after(async () => {
  server?.kill();
  supabase?.server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body, host = false } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(host ? { 'x-host-token': hostKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('mergeUsers lets local CAS rows override remote on the same id', () => {
  const merged = mergeUsers(
    [{ id: 'a', username: 'new', displayName: 'New', passwordHash: 'h', passwordSalt: 's', role: 'player', disabled: false, createdAt: 2, instruments: [] }],
    [{ id: 'a', username: 'old', displayName: 'Old', passwordHash: 'h', passwordSalt: 's', role: 'player', disabled: false, createdAt: 1, instruments: [] },
     { id: 'b', username: 'only-remote', displayName: 'R', passwordHash: 'h', passwordSalt: 's', role: 'player', disabled: false, createdAt: 1, instruments: [] }],
  );
  assert.equal(merged.find((u) => u.id === 'a').username, 'new');
  assert.ok(merged.some((u) => u.id === 'b'));
});

test('mergeUsers drops tombstoned ids so deletes cannot resurrect', () => {
  const merged = mergeUsers(
    [],
    [{ id: 'gone', username: 'x', displayName: 'X', passwordHash: 'h', passwordSalt: 's', role: 'player', disabled: false, createdAt: 1, instruments: [] }],
    ['gone'],
  );
  assert.equal(merged.length, 0);
});

test('health reports Supabase account sync without secrets', async () => {
  const res = await call('/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.hasSupabaseUsers, true);
  assert.equal(res.data.storeOk, true);
  assert.equal(res.data.supabaseKey, undefined);
});

test('creating a user dual-writes into Supabase', async () => {
  // HOST_KEY is set in this suite, so setup requires the host token.
  const setup = await call('/host/setup', {
    method: 'POST',
    body: { username: 'boss', displayName: 'Boss', password: 'password1' },
    host: true,
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));

  const rows = supabase.listJam('amplify-test');
  assert.ok(rows.some((r) => r.username === 'boss' && r.role === 'admin'));

  const created = await call('/host/users', {
    method: 'POST',
    host: true,
    body: {
      username: 'alex',
      displayName: 'Alex',
      password: 'password1',
      role: 'player',
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.ok(supabase.listJam('amplify-test').some((r) => r.username === 'alex'));
});

test('accounts survive wiping the night blob when Supabase still has them', async () => {
  // Confirm accounts exist remotely, then replace jam.json with an empty night.
  assert.ok(supabase.listJam('amplify-test').length >= 2);

  const emptyNight = {
    jam: { name: 'Wiped', createdAt: Date.now(), allowSuggestions: true, requireApproval: true, slots: [] },
    hostToken: hostKey,
    users: [],
    players: [],
    songs: [],
    rounds: [],
    current: null,
    roundIndex: 0,
  };
  await writeFile(join(dataDir, 'jam.json'), JSON.stringify(emptyNight, null, 2));

  // Bounce through an API call so the file backend reloads… file backend keeps
  // in-memory state. Force a fresh process would be heavier; instead hit login
  // which reads store state — for FileBackend the in-memory copy still has
  // users. So we verify via a second server against the same DATA_DIR + supabase.
  const port2 = 4200 + Math.floor(Math.random() * 200);
  const base2 = `http://127.0.0.1:${port2}`;
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port2),
      DATA_DIR: dataDir,
      SUPABASE_URL: supabase.url,
      SUPABASE_SERVICE_ROLE_KEY: supabase.key,
      SUPABASE_JAM_ID: 'amplify-test',
      HOST_KEY: hostKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second server failed')), 10000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${base2}/api/health`);
        if (res.ok) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      } catch { /* wait */ }
    }, 40);
    child.stderr.on('data', (c) => process.stderr.write(c));
  });

  try {
    const listed = await fetch(`${base2}/api/host/users`, {
      headers: { 'x-host-token': hostKey },
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(listed.status, 200);
    const names = listed.data.users.map((u) => u.username).sort();
    assert.deepEqual(names, ['alex', 'boss']);

    const login = await fetch(`${base2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alex', password: 'password1' }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.equal(login.data.username, 'alex');
  } finally {
    child.kill();
  }
});

test('a failed Supabase delete does not resurrect the account on reload', async () => {
  const listed = await call('/host/users', { host: true });
  const victim = listed.data.users.find((u) => u.username === 'alex');
  assert.ok(victim);

  // replaceAll does POST then DELETE — fail enough writes that sync cannot finish.
  supabase.failNextWrites(6);
  const deleted = await call(`/host/users/${victim.id}`, { method: 'DELETE', host: true });
  // Blob delete may still return 503 after CAS if remote sync throws.
  assert.ok(deleted.status === 200 || deleted.status === 503, JSON.stringify(deleted.data));

  // Remote still has the row (writes failed), but tombstone must keep them out.
  assert.ok(supabase.listJam('amplify-test').some((r) => r.id === victim.id));

  const port2 = 4300 + Math.floor(Math.random() * 200);
  const base2 = `http://127.0.0.1:${port2}`;
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port2),
      DATA_DIR: dataDir,
      SUPABASE_URL: supabase.url,
      SUPABASE_SERVICE_ROLE_KEY: supabase.key,
      SUPABASE_JAM_ID: 'amplify-test',
      HOST_KEY: hostKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second server failed')), 10000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${base2}/api/health`);
        if (res.ok) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      } catch { /* wait */ }
    }, 40);
    child.stderr.on('data', (c) => process.stderr.write(c));
  });

  try {
    const again = await fetch(`${base2}/api/host/users`, {
      headers: { 'x-host-token': hostKey },
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(again.status, 200);
    assert.ok(!again.data.users.some((u) => u.id === victim.id));

    const login = await fetch(`${base2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alex', password: 'password1' }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(login.status, 401);
  } finally {
    child.kill();
  }
});
