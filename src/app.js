/**
 * The application: routing, validation and the REST API.
 *
 * Kept separate from the listener so the same handler serves both a plain
 * `node server.js` on a laptop and a serverless function on a host like
 * Vercel. Zero dependencies either way.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore, newId, DEFAULT_INSTRUMENTS } from './store.js';
import { commitRound, instrumentFor, mayPlay, signupsFor, STANCES, LEVELS } from './signups.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');

export const store = openStore();

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw bad('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('Expected JSON');
  }
}

/** Trim, cap length, and reject anything that is not a usable string. */
function str(value, { max = 120, field = 'value', required = false, fallback = '' } = {}) {
  if (value == null) {
    if (required) throw bad(`${field} is required`);
    return fallback;
  }
  const out = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  if (required && !out) throw bad(`${field} is required`);
  return out;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function intOrNull(value, { min = 1, max = 99 } = {}) {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function parseInstruments(input) {
  if (!Array.isArray(input)) throw bad('instruments must be a list');
  const seen = new Set();
  const out = [];
  for (const raw of input.slice(0, 12)) {
    const name = str(typeof raw === 'string' ? raw : raw?.name, { max: 40 });
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, level: oneOf(raw?.level, LEVELS, 'comfortable') });
  }
  if (!out.length) throw bad('Pick at least one instrument');
  return out;
}

function parseStances(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [songId, stance] of Object.entries(input).slice(0, 500)) {
    if (!STANCES.includes(stance)) continue;
    out[str(songId, { max: 40 })] = stance;
  }
  return out;
}

/** Songs the room is allowed to sign up for: on the setlist and approved. */
function playableIds(state) {
  return new Set(state.songs.filter((s) => s.status === 'approved').map((s) => s.id));
}

/**
 * Drop sign-ups pointing at a song that is unknown or still waiting on the
 * host. Validating here rather than in the UI is the point: a request that
 * nobody has vetted must not be able to collect names through the API either.
 */
function onlyPlayable(state, map) {
  const allowed = playableIds(state);
  return Object.fromEntries(Object.entries(map).filter(([songId]) => allowed.has(songId)));
}

/** Per-song chair requests: { [songId]: 'Guitar' }. */
function parsePicks(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [songId, instrument] of Object.entries(input).slice(0, 500)) {
    const name = str(instrument, { max: 40 });
    if (name) out[str(songId, { max: 40 })] = name;
  }
  return out;
}

function parseLimits(input = {}) {
  return { maxSongs: intOrNull(input.maxSongs, { min: 1, max: 50 }) };
}

function parseSlots(input, fallback) {
  if (!Array.isArray(input)) return fallback;
  const out = [];
  for (const slot of input.slice(0, 12)) {
    const instrument = str(slot?.instrument, { max: 40 });
    const count = intOrNull(slot?.count, { min: 0, max: 12 });
    if (!instrument || count == null) continue;
    out.push({ instrument, count });
  }
  return out.length ? out : fallback;
}

/* ------------------------------------------------------------------- lineup */

/**
 * The song currently on deck. A lineup may have no song at all — a free jam —
 * in which case there is nothing to check sign-ups against and the host picks
 * from whoever is in the room.
 */
function deckSong(state) {
  const songId = state.current?.songId;
  return songId ? state.songs.find((s) => s.id === songId) || null : null;
}

/* --------------------------------------------------------------------- API */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/** Anything under /api/host/* additionally requires the host token. */
function requireHost(ctx) {
  if (!store.isHost(ctx.hostToken)) throw new HttpError(403, 'Host key required');
}

route('GET', /^\/api\/state$/, (ctx) => {
  const me = store.playerByToken(ctx.playerToken);
  return {
    ...store.publicState(),
    presets: DEFAULT_INSTRUMENTS,
    realtime: store.realtime,
    youId: me?.id || null,
    isHost: store.isHost(ctx.hostToken),
    // Who put their name down for each song. This is the whole queue: the
    // stage display reads it out and the host picks the band from it.
    signups: Object.fromEntries(
      store.state.songs.map((s) => [s.id, signupsFor(store.state.players, s)]),
    ),
  };
});

route('POST', /^\/api\/join$/, (ctx) => {
  const name = str(ctx.body.name, { max: 60, field: 'Name', required: true });
  const player = {
    id: newId('u'),
    token: newId(),
    name,
    joinedAt: Date.now(),
    present: true,
    removed: false,
    instruments: parseInstruments(ctx.body.instruments),
    stances: onlyPlayable(store.state, parseStances(ctx.body.stances)),
    picks: onlyPlayable(store.state, parsePicks(ctx.body.picks)),
    limits: parseLimits(ctx.body.limits),
    notes: str(ctx.body.notes, { max: 280 }),
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {} },
  };
  store.update((state) => state.players.push(player));
  return { id: player.id, token: player.token };
});

route('PATCH', /^\/api\/players\/([\w-]+)$/, (ctx) => {
  const target = store.state.players.find((p) => p.id === ctx.params[0] && !p.removed);
  if (!target) throw new HttpError(404, 'Player not found');

  const me = store.playerByToken(ctx.playerToken);
  const isHost = store.isHost(ctx.hostToken);
  if (!isHost && me?.id !== target.id) throw new HttpError(403, 'That is not your sign-up');

  const body = ctx.body;
  store.update(() => {
    if (body.name != null) target.name = str(body.name, { max: 60, field: 'Name', required: true });
    if (body.instruments != null) target.instruments = parseInstruments(body.instruments);
    if (body.stances != null) {
      target.stances = { ...target.stances, ...onlyPlayable(store.state, parseStances(body.stances)) };
    }
    if (body.picks != null) {
      target.picks = { ...target.picks, ...onlyPlayable(store.state, parsePicks(body.picks)) };
    }
    // A withdrawal has to be able to clear a song, which a merge cannot express.
    for (const songId of Array.isArray(body.clearSongs) ? body.clearSongs.slice(0, 50) : []) {
      const id = str(songId, { max: 40 });
      delete target.stances[id];
      delete target.picks[id];
    }
    if (body.limits != null) target.limits = parseLimits(body.limits);
    if (body.notes != null) target.notes = str(body.notes, { max: 280 });
    if (body.present != null) target.present = Boolean(body.present);
  });
  return { ok: true };
});

route('DELETE', /^\/api\/players\/([\w-]+)$/, (ctx) => {
  const target = store.state.players.find((p) => p.id === ctx.params[0]);
  if (!target) throw new HttpError(404, 'Player not found');
  const me = store.playerByToken(ctx.playerToken);
  if (!store.isHost(ctx.hostToken) && me?.id !== target.id) throw new HttpError(403, 'That is not your sign-up');
  store.update(() => {
    target.removed = true;
    target.present = false;
  });
  return { ok: true };
});

route('POST', /^\/api\/songs$/, (ctx) => {
  const isHost = store.isHost(ctx.hostToken);
  const me = store.playerByToken(ctx.playerToken);
  if (!isHost && !store.state.jam.allowSuggestions) throw new HttpError(403, 'Suggestions are closed');
  if (!isHost && !me) throw new HttpError(403, 'Sign up before suggesting songs');

  // Anything the host adds is already vetted — they are the one doing the
  // vetting. A request from the room waits until they have looked at it.
  const status = isHost || !store.state.jam.requireApproval ? 'approved' : 'pending';

  const song = {
    id: newId('s'),
    title: str(ctx.body.title, { max: 80, field: 'Title', required: true }),
    artist: str(ctx.body.artist, { max: 80 }),
    key: str(ctx.body.key, { max: 12 }),
    notes: str(ctx.body.notes, { max: 200 }),
    slots: Array.isArray(ctx.body.slots) ? parseSlots(ctx.body.slots, null) : null,
    status,
    suggestedBy: isHost ? null : me.id,
    addedAt: Date.now(),
  };
  store.update((state) => state.songs.push(song));
  return { id: song.id, status };
});

/**
 * Let a request into the setlist. Declining one is a plain DELETE — there is
 * no third state to hold, and a request the host has said no to should not
 * linger on their screen asking again.
 */
route('POST', /^\/api\/host\/songs\/([\w-]+)\/approve$/, (ctx) => {
  requireHost(ctx);
  const song = store.state.songs.find((s) => s.id === ctx.params[0]);
  if (!song) throw new HttpError(404, 'Song not found');
  store.update(() => {
    song.status = 'approved';
    song.approvedAt = Date.now();
  });
  return { ok: true };
});

route('PATCH', /^\/api\/songs\/([\w-]+)$/, (ctx) => {
  requireHost(ctx);
  const song = store.state.songs.find((s) => s.id === ctx.params[0]);
  if (!song) throw new HttpError(404, 'Song not found');
  store.update(() => {
    if (ctx.body.title != null) song.title = str(ctx.body.title, { max: 80, field: 'Title', required: true });
    if (ctx.body.artist != null) song.artist = str(ctx.body.artist, { max: 80 });
    if (ctx.body.key != null) song.key = str(ctx.body.key, { max: 12 });
    if (ctx.body.notes != null) song.notes = str(ctx.body.notes, { max: 200 });
    if (ctx.body.slots !== undefined) song.slots = ctx.body.slots ? parseSlots(ctx.body.slots, null) : null;
  });
  return { ok: true };
});

/**
 * The host can remove any song. Whoever suggested one can take it back too,
 * but only while nobody else has signed up for it — once other people are
 * counting on a song, pulling it is the host's call.
 */
route('DELETE', /^\/api\/songs\/([\w-]+)$/, (ctx) => {
  const songId = ctx.params[0];
  const song = store.state.songs.find((s) => s.id === songId);
  if (!song) throw new HttpError(404, 'Song not found');

  if (!store.isHost(ctx.hostToken)) {
    const me = store.playerByToken(ctx.playerToken);
    if (!me || song.suggestedBy !== me.id) throw new HttpError(403, 'That is not your suggestion');

    const others = store.state.players.filter(
      (p) => !p.removed && p.id !== me.id && p.stances?.[songId] === 'in',
    );
    if (others.length) {
      throw bad(`${others.length === 1 ? 'Someone has' : `${others.length} people have`} signed up for it — ask the host to remove it`);
    }
  }

  store.update((state) => {
    state.songs = state.songs.filter((s) => s.id !== songId);
    if (state.current?.songId === songId) state.current = null;
    // Do not leave sign-ups pointing at a song that no longer exists.
    for (const p of state.players) {
      delete p.stances[songId];
      delete p.picks[songId];
    }
  });
  return { ok: true };
});

/**
 * Reorder the queue. Takes the full list of song ids; anything the client
 * left out keeps its relative place at the end, so a stale tab cannot drop
 * a song that somebody added a moment ago.
 */
route('POST', /^\/api\/host\/songs\/order$/, (ctx) => {
  requireHost(ctx);
  if (!Array.isArray(ctx.body.order)) throw bad('order must be a list of song ids');

  const wanted = ctx.body.order.slice(0, 500).map((id) => str(id, { max: 40 }));
  store.update((state) => {
    const seen = new Set();
    const ordered = [];
    for (const id of wanted) {
      const song = state.songs.find((s) => s.id === id);
      if (song && !seen.has(id)) {
        seen.add(id);
        ordered.push(song);
      }
    }
    for (const song of state.songs) if (!seen.has(song.id)) ordered.push(song);
    state.songs = ordered;
  });
  return { ok: true };
});

route('POST', /^\/api\/host\/auth$/, (ctx) => {
  if (!store.isHost(ctx.body.token)) throw new HttpError(403, 'That key does not match');
  return { ok: true, jam: store.state.jam.name };
});

route('PATCH', /^\/api\/host\/settings$/, (ctx) => {
  requireHost(ctx);
  const body = ctx.body;
  store.update((state) => {
    const jam = state.jam;
    if (body.name != null) jam.name = str(body.name, { max: 60, fallback: jam.name }) || jam.name;
    if (body.allowSuggestions != null) jam.allowSuggestions = Boolean(body.allowSuggestions);
    if (body.slots != null) jam.slots = parseSlots(body.slots, jam.slots);
    if (body.requireApproval != null) {
      jam.requireApproval = Boolean(body.requireApproval);
      // Taking the gate down releases whatever was queued behind it. Leaving
      // those stuck would read as a bug: the host just said they were fine.
      if (!jam.requireApproval) {
        for (const song of state.songs) if (song.status === 'pending') song.status = 'approved';
      }
    }
  });
  return { ok: true };
});

/** Put a song on deck. It starts with nobody on it — the host fills it in. */
route('POST', /^\/api\/host\/lineup$/, (ctx) => {
  requireHost(ctx);
  const songId = ctx.body.songId ? str(ctx.body.songId, { max: 40 }) : null;
  if (songId) {
    const song = store.state.songs.find((s) => s.id === songId);
    if (!song) throw new HttpError(404, 'Song not found');
    if (song.status !== 'approved') throw bad('That song is still waiting to be approved');
  }
  return store.update((state) => {
    state.current = { songId, picks: [], createdAt: Date.now() };
    return state.current;
  });
});

/**
 * Put somebody on stage for the song on deck, or move them to another
 * instrument. Calling it again for the same person replaces their chair
 * rather than seating them twice.
 *
 * This is where the rule the whole tool exists for is kept: a name can only
 * be seated if its owner signed up for this song. The check lives here and not
 * only in the console, so that no future screen — and no stray API call — can
 * volunteer somebody who did not ask to play.
 */
route('POST', /^\/api\/host\/pick$/, (ctx) => {
  requireHost(ctx);
  if (!store.state.current) throw bad('No song is on deck');

  const playerId = str(ctx.body.playerId, { max: 40, field: 'playerId', required: true });
  const player = store.state.players.find((p) => p.id === playerId && !p.removed);
  if (!player) throw new HttpError(404, 'Player not found');

  // A free jam has no song to sign up for, so there the roster is the list.
  const song = deckSong(store.state);
  if (song) {
    const verdict = mayPlay(player, song);
    if (!verdict.ok) throw new HttpError(403, `${player.name} ${verdict.why}`);
  }

  const instrument = str(ctx.body.instrument, { max: 40 }) || instrumentFor(player, song);

  return store.update((state) => {
    state.current.picks = [
      ...state.current.picks.filter((p) => p.playerId !== playerId),
      { playerId, instrument },
    ];
    return state.current;
  });
});

/** Take somebody back off the song on deck. */
route('POST', /^\/api\/host\/unpick$/, (ctx) => {
  requireHost(ctx);
  if (!store.state.current) throw bad('No song is on deck');
  const playerId = str(ctx.body.playerId, { max: 40, field: 'playerId', required: true });

  return store.update((state) => {
    state.current.picks = state.current.picks.filter((p) => p.playerId !== playerId);
    return state.current;
  });
});

/** The song happened: bank the turns and clear the deck. */
route('POST', /^\/api\/host\/commit$/, (ctx) => {
  requireHost(ctx);
  const current = store.state.current;
  if (!current) throw bad('No song is on deck');
  if (!current.picks.length) throw bad('Nobody is on stage yet — pick who is playing first');

  store.update((state) => {
    commitRound(state.players, current, state.roundIndex);
    state.rounds.push({
      index: state.roundIndex,
      songId: current.songId,
      playedAt: Date.now(),
      picks: current.picks.map(({ instrument, playerId }) => ({ instrument, playerId })),
    });
    state.roundIndex += 1;
    state.current = null;
  });
  return { ok: true };
});

/** Called it, didn't play it. No turns counted. */
route('POST', /^\/api\/host\/skip$/, (ctx) => {
  requireHost(ctx);
  store.update((state) => {
    state.current = null;
  });
  return { ok: true };
});

route('POST', /^\/api\/host\/reset$/, (ctx) => {
  requireHost(ctx);
  const mode = oneOf(ctx.body.mode, ['turns', 'night'], 'turns');
  store.update((state) => {
    state.current = null;
    state.rounds = [];
    state.roundIndex = 0;
    for (const p of state.players) p.stats = { plays: 0, lastRound: null, streak: 0, byInstrument: {} };
    if (mode === 'night') {
      state.players = [];
      state.songs = [];
    }
  });
  return { ok: true };
});

/* --------------------------------------------------------------------- SSE */

const clients = new Set();

store.subscribe((version) => {
  for (const res of clients) {
    // A client that vanished mid-write must not stop the others from being
    // notified — nor bubble a socket error up into the request that made
    // the change.
    try {
      res.write(`data: ${version}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
});

function streamEvents(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\ndata: ${store.liveVersion}\n\n`);
  clients.add(res);

  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  beat.unref?.();
  res.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

/* ------------------------------------------------------------------ static */

const PAGES = { '/': 'index.html', '/host': 'host.html', '/board': 'board.html' };

async function serveStatic(url, res) {
  const rel = PAGES[url] || normalize(decodeURIComponent(url)).replace(/^([/\\.])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, { error: 'Not found' });

  const body = await readFile(file);
  send(res, 200, body, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
}

/* ---------------------------------------------------------------- dispatch */

/**
 * Handle one request.
 *
 * A mutating request may lose a compare-and-set race against another instance
 * on a serverless host. That is not an error — it just means somebody else
 * wrote first, so the whole handler is replayed against the newer state. The
 * handler has not been observed by anyone yet, so replaying is safe.
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/events') {
    if (store.realtime !== 'sse') return send(res, 501, { error: 'Live stream not available here' });
    return streamEvents(res);
  }

  if (path.startsWith('/api/')) {
    const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!match) return send(res, 404, { error: 'Unknown endpoint' });

    let body;
    try {
      body = req.method === 'GET' ? {} : await readBody(req);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }

    const ctx = {
      params: path.match(match.pattern).slice(1),
      body,
      hostToken: req.headers['x-host-token'] || url.searchParams.get('k') || '',
      playerToken: req.headers['x-player-token'] || '',
    };

    try {
      const result = await store.run(() => match.handler(ctx) ?? { ok: true });
      return send(res, 200, result);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: err.message || 'Something went wrong' });
    }
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  return serveStatic(path, res);
}
