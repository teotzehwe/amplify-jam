/**
 * Persistence for one jam *night* (songs, roster, lineup).
 *
 * Accounts and host sessions live in `directory.js`, not here. Each jam id
 * gets its own Redis keys / file so admins can run many sessions from one
 * deploy without a shared HOST_KEY.
 *
 *   file — data/jams/{id}.json (local)
 *   kv   — {prefix}:jam:{id}:state (+ version) on Redis
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_INSTRUMENTS = [
  'Vocals', 'Guitar', 'Bass', 'Drums', 'Keys', 'Sax', 'Trumpet',
  'Violin', 'Harmonica', 'Percussion', 'Flute', 'Cello', 'Banjo', 'Ukulele',
];

export function newId(prefix = '') {
  return prefix + randomBytes(8).toString('hex');
}

function defaultState(name = 'Amplify Open Jam') {
  return {
    jam: {
      name,
      createdAt: Date.now(),
      allowSuggestions: true,
      requireApproval: true,
      slots: [
        { instrument: 'Vocals', count: 1 },
        { instrument: 'Guitar', count: 2 },
        { instrument: 'Bass', count: 1 },
        { instrument: 'Drums', count: 1 },
        { instrument: 'Keys', count: 1 },
      ],
    },
    players: [],
    songs: [],
    rounds: [],
    current: null,
    roundIndex: 0,
  };
}

/** Settings that belonged to the retired auto-scheduler. Dropped on load. */
const RETIRED_SETTINGS = ['restSongs', 'maxConsecutive', 'maybeCountsAsAvailable'];

/**
 * Fill in anything a hand-edited or older state file is missing.
 * Account fields from legacy single-blob nights are ignored here — the
 * directory lifts them once at boot.
 */
export function migrate(state, jamName) {
  const base = defaultState(jamName);
  const out = { ...base, ...state, jam: { ...base.jam, ...(state.jam || {}) } };
  for (const dead of RETIRED_SETTINGS) delete out.jam[dead];

  // Strip account / host-key leftovers so night blobs stay night-only.
  delete out.hostToken;
  delete out.hostSessions;
  delete out.users;
  delete out.deletedUserIds;

  out.players = (state.players || []).map((p) => ({
    limits: {},
    stances: {},
    picks: {},
    instruments: [],
    present: true,
    removed: false,
    notes: '',
    userId: null,
    ...p,
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {}, ...(p.stats || {}) },
  }));

  out.songs = (state.songs || []).map((s) => ({
    key: '',
    notes: '',
    slots: null,
    status: 'approved',
    ...s,
  }));

  out.current = migrateLineup(out.current);
  return out;
}

function migrateLineup(current) {
  if (!current || typeof current !== 'object') return null;
  if (Array.isArray(current.picks)) return current;
  const picks = (current.slots || [])
    .filter((s) => s.playerId)
    .map((s) => ({ playerId: s.playerId, instrument: s.instrument }));
  return { songId: current.songId ?? null, picks, createdAt: current.createdAt || Date.now() };
}

function parseLegacyNightJson(raw, label = 'legacy night') {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    const e = new Error(`${label} JSON is invalid`);
    e.status = 503;
    throw e;
  }
  // null / arrays / primitives parse successfully but are not a night blob.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const e = new Error(`${label} JSON root must be an object`);
    e.status = 503;
    throw e;
  }
  return parsed;
}

/* ------------------------------------------------------------ file backend */

class FileBackend {
  constructor(file, jamName = 'Amplify Open Jam', { adoptLegacy = false, legacyFile = null } = {}) {
    this.file = file;
    this.jamName = jamName;
    this.version = 0;
    let readingLegacy = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        this.state = migrate(JSON.parse(readFileSync(file, 'utf8')), jamName);
      } else if (adoptLegacy && legacyFile && existsSync(legacyFile)) {
        // Lifted jam only: adopt the pre-multi-jam night file once.
        // Propagate read/parse failures — never cache defaults over a real blob.
        readingLegacy = true;
        this.state = migrate(
          parseLegacyNightJson(readFileSync(legacyFile, 'utf8')),
          jamName,
        );
      } else {
        this.state = defaultState(jamName);
      }
    } catch (err) {
      if (readingLegacy || !['ENOENT', 'EROFS', 'EACCES', 'EPERM'].includes(err.code)) throw err;
      this.state = defaultState(jamName);
    }
  }

  async load() {
    return { state: this.state, version: this.version };
  }

  async save(state) {
    this.state = state;
    this.version += 1;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      if (['ENOENT', 'EROFS', 'EACCES', 'EPERM'].includes(err.code) || process.env.VERCEL) {
        const e = new Error(
          'Cannot save jam state on this host. Add Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN) and redeploy.',
        );
        e.status = 503;
        throw e;
      }
      throw err;
    }
    return true;
  }

  get realtime() {
    return 'sse';
  }

  async ping() {
    return true;
  }
}

/* -------------------------------------------------------------- kv backend */

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[2])
if current == ARGV[1] or (current == false and ARGV[1] == '0') then
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[3])
  return 1
end
return 0`;

class KvBackend {
  constructor(url, token, prefix, jamId, jamName = 'Amplify Open Jam', { adoptLegacy = false } = {}) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.jamName = jamName;
    this.stateKey = `${prefix}:jam:${jamId}:state`;
    this.versionKey = `${prefix}:jam:${jamId}:version`;
    // Legacy single-blob keys — only the lifted jam may adopt them.
    this.legacyStateKey = `${prefix}:state`;
    this.legacyVersionKey = `${prefix}:version`;
    this.adoptLegacy = adoptLegacy;
    this.migratedLegacy = false;
  }

  async command(...args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(`Key-value store rejected ${args[0]}: ${body.error || res.status}`);
    }
    return body.result;
  }

  async load() {
    const [raw, version] = await this.command('MGET', this.stateKey, this.versionKey);
    if (raw) {
      return { state: migrate(JSON.parse(raw), this.jamName), version: Number(version) || 0 };
    }

    // Lifted jam only: keep returning the legacy blob until a CAS save writes
    // the per-jam key. Version is 0 so that first save succeeds. Do not mark
    // migrated until the legacy key is confirmed empty (a failed MGET must
    // leave the flag unset so the next load retries).
    if (this.adoptLegacy && !this.migratedLegacy) {
      const [legacyRaw] = await this.command(
        'MGET', this.legacyStateKey, this.legacyVersionKey,
      );
      if (legacyRaw) {
        const state = migrate(parseLegacyNightJson(legacyRaw), this.jamName);
        return { state, version: 0 };
      }
      this.migratedLegacy = true;
    }

    return { state: defaultState(this.jamName), version: 0 };
  }

  async save(state, expectedVersion) {
    const ok = await this.command(
      'EVAL', CAS_SCRIPT, 2,
      this.stateKey, this.versionKey,
      String(expectedVersion), JSON.stringify(state), String(expectedVersion + 1),
    );
    return Number(ok) === 1;
  }

  get realtime() {
    return 'poll';
  }

  async ping() {
    const pong = await this.command('PING');
    return pong === 'PONG' || pong === true || pong === 'pong';
  }
}

/* -------------------------------------------------------------------- store */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Store {
  constructor(backend) {
    this.backend = backend;
    this.listeners = new Set();
    this.liveVersion = 0;
    this.context = new AsyncLocalStorage();
  }

  get realtime() {
    return this.backend.realtime;
  }

  ping() {
    return this.backend.ping();
  }

  current() {
    const ctx = this.context.getStore();
    if (!ctx) throw new Error('The jam state was read outside of a request');
    return ctx;
  }

  get state() {
    return this.current().state;
  }

  get version() {
    return this.current().version;
  }

  update(fn) {
    const ctx = this.current();
    const result = fn(ctx.state);
    ctx.dirty = true;
    return result;
  }

  async run(fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { state, version } = await this.backend.load();
      if (version > this.liveVersion) this.liveVersion = version;
      const ctx = { state, version, dirty: false };

      const result = await this.context.run(ctx, async () => fn());
      if (!ctx.dirty) return result;

      if (await this.backend.save(ctx.state, ctx.version)) {
        this.liveVersion = ctx.version + 1;
        for (const listener of this.listeners) listener(this.liveVersion);
        return result;
      }

      await sleep(Math.min(250, 8 * 2 ** attempt) * (0.5 + Math.random()));
    }

    const busy = new Error('The jam is busy right now — try that again');
    busy.status = 409;
    throw busy;
  }

  touch() {
    this.current().dirty = true;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publicState() {
    const { lastHostExportAt, ...rest } = this.state;
    return {
      ...rest,
      version: this.version,
      players: (rest.players || []).filter((p) => !p.removed).map(({ token, ...p }) => p),
    };
  }

  playerByToken(token) {
    if (!token) return null;
    return this.state.players.find((p) => p.token === token && !p.removed) || null;
  }
}

/**
 * Peek a legacy single-blob night (pre multi-jam) without opening a Store.
 * Used once to lift accounts into the directory.
 */
export async function loadLegacyNightBlob({ dataDir, env = process.env } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = env.KV_PREFIX || 'amplify';

  if (url && token) {
    const res = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(['GET', `${prefix}:state`]),
    });
    const body = await res.json().catch(() => ({}));
    // Distinguish a missing key (null → no legacy night) from a failed read
    // (throw → caller leaves legacyLiftDone unset and retries).
    if (!res.ok || body.error) {
      const err = new Error(`legacy night read failed: ${body.error || res.status}`);
      err.status = 503;
      throw err;
    }
    if (body.result == null) return null;
    return parseLegacyNightJson(body.result);
  }

  const dir = dataDir || env.DATA_DIR || join(process.cwd(), 'data');
  const file = join(dir, 'jam.json');
  if (!existsSync(file)) return null;
  // An existing file that cannot be read or parsed is a failed read, not an
  // absent night — throw so ensureLegacyLifted leaves legacyLiftDone unset.
  try {
    return parseLegacyNightJson(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.status) throw err;
    const e = new Error(`legacy night read failed: ${err.code || err.message}`);
    e.status = 503;
    throw e;
  }
}

const jamStoreCache = new Map();

export function openJamStore(jamId, {
  dataDir, env = process.env, jamName, adoptLegacy = false,
} = {}) {
  if (!jamId) throw new Error('jam id required');
  const cacheKey = `${env.KV_PREFIX || 'amplify'}:${jamId}`;
  if (jamStoreCache.has(cacheKey)) return jamStoreCache.get(cacheKey);

  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = env.KV_PREFIX || 'amplify';
  const name = jamName || 'Amplify Open Jam';

  let backend;
  if (url && token) {
    backend = new KvBackend(url, token, prefix, jamId, name, { adoptLegacy });
  } else {
    const dir = dataDir || env.DATA_DIR || join(process.cwd(), 'data');
    backend = new FileBackend(join(dir, 'jams', `${jamId}.json`), name, {
      adoptLegacy,
      legacyFile: join(dir, 'jam.json'),
    });
  }

  const store = new Store(backend);
  jamStoreCache.set(cacheKey, store);
  return store;
}

/**
 * @deprecated Prefer openJamStore + openDirectory. Kept for a few tests that
 * still open a single night file without a jam id.
 */
export function openStore(opts = {}) {
  return openJamStore('default', opts);
}
