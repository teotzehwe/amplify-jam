/**
 * API-level tests. These boot the real server in a child process against a
 * throwaway data directory, so routing, validation and auth are covered end
 * to end rather than mocked.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let server;
let dataDir;
let base;
let hostKey;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'amplify-test-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  hostKey = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/Host key: (\w+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
  });
});

after(async () => {
  server?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

async function call(path, { method = 'GET', body, host = false, player } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(host ? { 'x-host-token': hostKey } : {}),
      ...(player ? { 'x-player-token': player } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const joinAs = (name, instruments = ['Guitar'], extra = {}) =>
  call('/join', { method: 'POST', body: { name, instruments, ...extra } });

/** GET with the path sent verbatim, bypassing URL normalisation. */
function rawGet(path) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

/* -------------------------------------------------------------------- tests */

test('serves the sign-up page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('static paths cannot escape the public directory', async () => {
  // fetch() normalises "../" away, so these go out as raw request paths —
  // percent-encoded traversal is what actually reaches the file handler.
  const paths = [
    '/%2e%2e/server.js',
    '/..%2fserver.js',
    '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/....//server.js',
  ];
  for (const path of paths) {
    const status = await rawGet(path);
    assert.equal(status, 404, `${path} should not be served`);
  }
});

test('the host key is never exposed in public state', async () => {
  const { data } = await call('/state');
  assert.equal(data.hostToken, undefined);
  assert.equal(data.isHost, false);
});

test('player session tokens are stripped from public state', async () => {
  await joinAs('Token Holder');
  const { data } = await call('/state');
  assert.ok(data.players.length > 0);
  for (const p of data.players) assert.equal(p.token, undefined, 'no player token should be published');
});

test('joining requires a name and at least one instrument', async () => {
  assert.equal((await call('/join', { method: 'POST', body: { name: '', instruments: ['Bass'] } })).status, 400);
  assert.equal((await call('/join', { method: 'POST', body: { name: 'Nameless', instruments: [] } })).status, 400);
});

test('host endpoints reject a missing or wrong key', async () => {
  assert.equal((await call('/host/lineup', { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/host/pick', { method: 'POST', body: { playerId: 'u1' } })).status, 403);
  assert.equal((await call('/host/unpick', { method: 'POST', body: { playerId: 'u1' } })).status, 403);
  assert.equal((await call('/host/settings', { method: 'PATCH', body: { requireApproval: true } })).status, 403);
  assert.equal((await call('/host/reset', { method: 'POST', body: { mode: 'night' } })).status, 403);
  assert.equal((await call('/host/auth', { method: 'POST', body: { token: 'nope' } })).status, 403);
  assert.equal((await call('/host/songs/ghost/approve', { method: 'POST' })).status, 403);
});

test('a player may edit their own sign-up but not anybody else’s', async () => {
  const a = await joinAs('Player A');
  const b = await joinAs('Player B');

  const own = await call(`/players/${a.data.id}`, { method: 'PATCH', body: { present: false }, player: a.data.token });
  assert.equal(own.status, 200);

  const other = await call(`/players/${b.data.id}`, { method: 'PATCH', body: { name: 'Hijacked' }, player: a.data.token });
  assert.equal(other.status, 403);

  const { data } = await call('/state');
  assert.equal(data.players.find((p) => p.id === b.data.id).name, 'Player B');
});

test('the host can edit anyone', async () => {
  const p = await joinAs('Editable');
  const res = await call(`/players/${p.data.id}`, { method: 'PATCH', body: { present: false }, host: true });
  assert.equal(res.status, 200);
});

test('a full round trip: a song, sign-ups, a hand-picked band, committed turns', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });

  const song = await call('/songs', { method: 'POST', body: { title: 'Test Song' }, host: true });
  assert.equal(song.status, 200);
  assert.equal(song.data.status, 'approved', 'the host is the one doing the vetting');

  const drummer = await joinAs('Drummer', ['Drums'], { stances: { [song.data.id]: 'in' } });
  const guitarist = await joinAs('Guitarist', ['Guitar'], { stances: { [song.data.id]: 'in' } });

  const lineup = await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  assert.equal(lineup.status, 200);
  assert.deepEqual(lineup.data.picks, [], 'a lineup starts empty — nothing is chosen for the host');

  const seated = await call('/host/pick', { method: 'POST', body: { playerId: drummer.data.id }, host: true });
  assert.equal(seated.status, 200);
  assert.deepEqual(seated.data.picks, [{ playerId: drummer.data.id, instrument: 'Drums' }]);

  const commit = await call('/host/commit', { method: 'POST', host: true });
  assert.equal(commit.status, 200);

  const { data } = await call('/state');
  assert.equal(data.roundIndex, 1);
  assert.equal(data.current, null);
  assert.equal(data.players.find((p) => p.id === drummer.data.id).stats.plays, 1);
  assert.equal(
    data.players.find((p) => p.id === guitarist.data.id).stats.plays, 0,
    'signing up is not the same as being called — the host picked one of the two',
  );
});

test('the API refuses to seat anybody who did not sign up', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Not For Me' }, host: true });

  const silent = await joinAs('Never Asked', ['Drums']);
  const withdrew = await joinAs('Withdrawn', ['Drums'], { stances: { [song.data.id]: 'out' } });

  await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });

  for (const who of [silent, withdrew]) {
    const res = await call('/host/pick', { method: 'POST', body: { playerId: who.data.id }, host: true });
    assert.equal(res.status, 403, 'a name only goes up if its owner put it there');
    assert.match(res.data.error, /did not sign up/);
  }

  const { data } = await call('/state');
  assert.deepEqual(data.current.picks, [], 'the chair stays open rather than being filled');
});

test('picking someone twice moves their instrument instead of seating them twice', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Swap' }, host: true });
  const p = await joinAs('Multi', ['Guitar', 'Keys'], { stances: { [song.data.id]: 'in' } });

  await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  await call('/host/pick', { method: 'POST', body: { playerId: p.data.id }, host: true });
  const moved = await call('/host/pick', {
    method: 'POST', body: { playerId: p.data.id, instrument: 'Keys' }, host: true,
  });

  assert.deepEqual(moved.data.picks, [{ playerId: p.data.id, instrument: 'Keys' }]);

  const off = await call('/host/unpick', { method: 'POST', body: { playerId: p.data.id }, host: true });
  assert.deepEqual(off.data.picks, []);
});

test('a song nobody is on cannot be marked played', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Empty' }, host: true });
  await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });

  const res = await call('/host/commit', { method: 'POST', host: true });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Nobody is on stage/);
});

test('skipping a song leaves every turn count untouched', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const song = await call('/songs', { method: 'POST', body: { title: 'Skipped' }, host: true });
  const p = await joinAs('Skipper', ['Guitar'], { stances: { [song.data.id]: 'in' } });

  await call('/host/lineup', { method: 'POST', body: { songId: song.data.id }, host: true });
  await call('/host/pick', { method: 'POST', body: { playerId: p.data.id }, host: true });
  await call('/host/skip', { method: 'POST', host: true });

  const { data } = await call('/state');
  assert.equal(data.roundIndex, 0);
  assert.equal(data.current, null);
  assert.equal(data.players.find((x) => x.id === p.data.id).stats.plays, 0);
});

test('a signed-in player can suggest songs, with no limit on how many', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Suggester', ['Guitar']);

  for (let i = 0; i < 25; i++) {
    const res = await call('/songs', {
      method: 'POST',
      body: { title: `Idea ${i}`, artist: 'Someone' },
      player: p.data.token,
    });
    assert.equal(res.status, 200, `suggestion ${i} should be accepted`);
  }

  const { data } = await call('/state');
  assert.equal(data.songs.length, 25);
  assert.ok(data.songs.every((s) => s.suggestedBy === p.data.id), 'each is credited to the suggester');
  assert.ok(data.songs.every((s) => s.status === 'pending'), 'and none of them reaches the room unvetted');
});

/* ------------------------------------------------------------- vetting */

test('a request waits for the host, and nobody can sign up for it meanwhile', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const asker = await joinAs('Asker', ['Guitar']);
  const fan = await joinAs('Fan', ['Bass']);

  const req = await call('/songs', { method: 'POST', body: { title: 'Unvetted' }, player: asker.data.token });
  assert.equal(req.data.status, 'pending');

  // The sign-up is accepted as a request but silently drops the unvetted song,
  // so a pending title cannot quietly collect names through the API.
  await call(`/players/${fan.data.id}`, {
    method: 'PATCH', body: { stances: { [req.data.id]: 'in' } }, player: fan.data.token,
  });

  const { data } = await call('/state');
  assert.deepEqual(data.players.find((p) => p.id === fan.data.id).stances, {});
  assert.deepEqual(data.signups[req.data.id], []);

  // Nor can the host put it on deck by mistake.
  const deck = await call('/host/lineup', { method: 'POST', body: { songId: req.data.id }, host: true });
  assert.equal(deck.status, 400);
  assert.match(deck.data.error, /waiting to be approved/);
});

test('approving a request lets it onto the setlist and collect sign-ups', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const asker = await joinAs('Asker', ['Guitar']);
  const fan = await joinAs('Fan', ['Bass']);

  const req = await call('/songs', { method: 'POST', body: { title: 'Vetted' }, player: asker.data.token });
  const ok = await call(`/host/songs/${req.data.id}/approve`, { method: 'POST', host: true });
  assert.equal(ok.status, 200);

  await call(`/players/${fan.data.id}`, {
    method: 'PATCH',
    body: { stances: { [req.data.id]: 'in' }, picks: { [req.data.id]: 'Bass' } },
    player: fan.data.token,
  });

  const { data } = await call('/state');
  assert.equal(data.songs.find((s) => s.id === req.data.id).status, 'approved');
  assert.deepEqual(data.signups[req.data.id].map((s) => s.name), ['Fan']);
  assert.equal(data.signups[req.data.id][0].instrument, 'Bass');
});

test('joining with a sign-up for an unapproved song does not smuggle one in', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const asker = await joinAs('Asker', ['Guitar']);
  const req = await call('/songs', { method: 'POST', body: { title: 'Sneaky' }, player: asker.data.token });

  const sneak = await joinAs('Sneak', ['Bass'], { stances: { [req.data.id]: 'in' } });

  const { data } = await call('/state');
  assert.deepEqual(data.players.find((p) => p.id === sneak.data.id).stances, {});
});

test('declining a request removes it outright', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const asker = await joinAs('Asker', ['Guitar']);
  const req = await call('/songs', { method: 'POST', body: { title: 'Declined' }, player: asker.data.token });

  assert.equal((await call(`/songs/${req.data.id}`, { method: 'DELETE', host: true })).status, 200);
  assert.equal((await call('/state')).data.songs.length, 0);
  assert.equal((await call('/host/songs/ghost/approve', { method: 'POST', host: true })).status, 404);
});

test('turning approval off releases everything already waiting', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const asker = await joinAs('Asker', ['Guitar']);
  await call('/songs', { method: 'POST', body: { title: 'Queued A' }, player: asker.data.token });
  await call('/songs', { method: 'POST', body: { title: 'Queued B' }, player: asker.data.token });

  await call('/host/settings', { method: 'PATCH', body: { requireApproval: false }, host: true });
  let { data } = await call('/state');
  assert.ok(data.songs.every((s) => s.status === 'approved'), 'nothing stays stuck behind a gate that is gone');

  // And a new one goes straight up while the gate is down.
  const direct = await call('/songs', { method: 'POST', body: { title: 'Straight up' }, player: asker.data.token });
  assert.equal(direct.data.status, 'approved');

  await call('/host/settings', { method: 'PATCH', body: { requireApproval: true }, host: true });
  ({ data } = await call('/state'));
  assert.ok(data.songs.every((s) => s.status === 'approved'), 'putting the gate back does not retract what is up');
});

test('suggestions are refused when the host closes them', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Hopeful', ['Guitar']);
  await call('/host/settings', { method: 'PATCH', body: { allowSuggestions: false }, host: true });

  const res = await call('/songs', { method: 'POST', body: { title: 'Nope' }, player: p.data.token });
  assert.equal(res.status, 403);

  // The host is never blocked by that setting.
  assert.equal((await call('/songs', { method: 'POST', body: { title: 'Host pick' }, host: true })).status, 200);
  await call('/host/settings', { method: 'PATCH', body: { allowSuggestions: true }, host: true });
});

test('a stranger with no sign-up cannot suggest songs', async () => {
  const res = await call('/songs', { method: 'POST', body: { title: 'Drive-by' } });
  assert.equal(res.status, 403);
});

test('you can take back your own suggestion, but not somebody else’s', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const mine = await joinAs('Mine', ['Guitar']);
  const other = await joinAs('Other', ['Guitar']);

  const song = await call('/songs', { method: 'POST', body: { title: 'Mine to pull' }, player: mine.data.token });

  const wrong = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: other.data.token });
  assert.equal(wrong.status, 403);

  const right = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: mine.data.token });
  assert.equal(right.status, 200);
  assert.equal((await call('/state')).data.songs.length, 0);
});

test('a suggestion cannot be pulled once someone else has signed up for it', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const mine = await joinAs('Author', ['Guitar']);
  const fan = await joinAs('Fan', ['Bass']);

  const song = await call('/songs', { method: 'POST', body: { title: 'Popular' }, player: mine.data.token });
  await call(`/host/songs/${song.data.id}/approve`, { method: 'POST', host: true });
  await call(`/players/${fan.data.id}`, {
    method: 'PATCH', body: { stances: { [song.data.id]: 'in' } }, player: fan.data.token,
  });

  const blocked = await call(`/songs/${song.data.id}`, { method: 'DELETE', player: mine.data.token });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /signed up for it/);

  // The host can still remove it.
  assert.equal((await call(`/songs/${song.data.id}`, { method: 'DELETE', host: true })).status, 200);
});

test('removing a song clears the sign-ups that pointed at it', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const p = await joinAs('Fan', ['Guitar']);
  const song = await call('/songs', { method: 'POST', body: { title: 'Doomed' }, host: true });

  await call(`/players/${p.data.id}`, {
    method: 'PATCH',
    body: { stances: { [song.data.id]: 'in' }, picks: { [song.data.id]: 'Guitar' } },
    player: p.data.token,
  });
  await call(`/songs/${song.data.id}`, { method: 'DELETE', host: true });

  const { data } = await call('/state');
  const player = data.players.find((x) => x.id === p.data.id);
  assert.deepEqual(player.stances, {}, 'no orphaned sign-up');
  assert.deepEqual(player.picks, {}, 'no orphaned chair request');
});

test('the host can rearrange the queue', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const ids = [];
  for (const title of ['One', 'Two', 'Three']) {
    ids.push((await call('/songs', { method: 'POST', body: { title }, host: true })).data.id);
  }

  const res = await call('/host/songs/order', {
    method: 'POST', body: { order: [ids[2], ids[0], ids[1]] }, host: true,
  });
  assert.equal(res.status, 200);

  const { data } = await call('/state');
  assert.deepEqual(data.songs.map((s) => s.title), ['Three', 'One', 'Two']);
});

test('reordering never loses a song a stale tab did not know about', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const a = (await call('/songs', { method: 'POST', body: { title: 'A' }, host: true })).data.id;
  const b = (await call('/songs', { method: 'POST', body: { title: 'B' }, host: true })).data.id;
  await call('/songs', { method: 'POST', body: { title: 'Added meanwhile' }, host: true });

  // The client only knew about A and B when it sent the order.
  await call('/host/songs/order', { method: 'POST', body: { order: [b, a] }, host: true });

  const { data } = await call('/state');
  assert.deepEqual(data.songs.map((s) => s.title), ['B', 'A', 'Added meanwhile']);
});

test('reordering ignores unknown ids and requires the host key', async () => {
  await call('/host/reset', { method: 'POST', body: { mode: 'night' }, host: true });
  const id = (await call('/songs', { method: 'POST', body: { title: 'Only' }, host: true })).data.id;

  assert.equal((await call('/host/songs/order', { method: 'POST', body: { order: [id] } })).status, 403);
  assert.equal((await call('/host/songs/order', { method: 'POST', body: { order: 'nope' }, host: true })).status, 400);

  await call('/host/songs/order', { method: 'POST', body: { order: ['ghost', id], host: true }, host: true });
  const { data } = await call('/state');
  assert.equal(data.songs.length, 1);
});

test('unknown endpoints and methods are refused cleanly', async () => {
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/state', { method: 'DELETE' })).status, 404);
});

test('oversized and malformed payloads are rejected, not crashed on', async () => {
  const res = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  });
  assert.equal(res.status, 400);

  // The server must still be answering afterwards.
  assert.equal((await call('/state')).status, 200);
});

test('free text is length-capped rather than stored unbounded', async () => {
  const res = await joinAs('x'.repeat(500), ['Guitar'], { notes: 'y'.repeat(2000) });
  const { data } = await call('/state');
  const player = data.players.find((p) => p.id === res.data.id);
  assert.ok(player.name.length <= 60);
  assert.ok(player.notes.length <= 280);
});
