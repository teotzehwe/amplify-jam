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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('Ready.')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
  });

  const setup = await fetch(`${base}/api/host/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boss', displayName: 'Boss', password: 'secret1' }),
  });
  const setupBody = await setup.json();
  assert.equal(setup.status, 200, JSON.stringify(setupBody));
  hostKey = setupBody.token;
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

test('accounts survive wiping the directory blob when Supabase still has them', async () => {
  // Confirm accounts exist remotely, then clear local directory users.
  assert.ok(supabase.listJam('amplify-test').length >= 2);

  const emptyDirectory = {
    users: [],
    hostSessions: [],
    deletedUserIds: [],
    jams: [{
      id: 'jamrecover',
      name: 'Recovered',
      createdAt: Date.now(),
      createdBy: null,
      archived: false,
    }],
  };
  await writeFile(join(dataDir, 'directory.json'), JSON.stringify(emptyDirectory, null, 2));

  // Fresh process reloads directory from disk and heals users from Supabase.
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
    const adminLogin = await fetch(`${base2}/api/host/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'secret1' }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));

    const listed = await fetch(`${base2}/api/host/users`, {
      headers: { 'x-host-token': adminLogin.data.token },
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

  // replaceAll deletes absent ids then upserts — fail writes so remote stays stale.
  supabase.failNextWrites(6);
  const deleted = await call(`/host/users/${victim.id}`, { method: 'DELETE', host: true });
  // Night commit succeeds even when remote sync fails.
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));

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
    const adminLogin = await fetch(`${base2}/api/host/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'secret1' }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));

    const again = await fetch(`${base2}/api/host/users`, {
      headers: { 'x-host-token': adminLogin.data.token },
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
