/**
 * Persistence, with two interchangeable backends.
 *
 *   file — one JSON file next to the server. A jam survives a laptop lid
 *          closing, and there is nothing to install.
 *   kv   — a hosted Redis over its REST API, for serverless hosts like Vercel
 *          where there is no disk and every request may hit a fresh instance.
 *
 * Handlers stay synchronous. A request loads the night, mutates it in memory,
 * and writes it back; on a serverless host that write is a compare-and-set, so
 * two people tapping "sign up" at the same moment cannot silently clobber each
 * other — the loser simply replays against the newer state.
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

function defaultState(hostKey) {
  return {
    jam: {
      name: 'Open Jam Night',
      createdAt: Date.now(),
      allowSuggestions: true,
      // Requests wait for the host before anyone can sign up for them. On by
      // default: a song reaching the room unvetted is hard to walk back once
      // people have started putting their names against it.
      requireApproval: true,
      slots: [
        { instrument: 'Vocals', count: 1 },
        { instrument: 'Guitar', count: 2 },
        { instrument: 'Bass', count: 1 },
        { instrument: 'Drums', count: 1 },
        { instrument: 'Keys', count: 1 },
      ],
    },
    hostToken: hostKey || newId(),
    players: [],
    songs: [],
    rounds: [],
    current: null,
    roundIndex: 0,
  };
}

/** Settings that belonged to the retired auto-scheduler. Dropped on load. */
const RETIRED_SETTINGS = ['restSongs', 'maxConsecutive', 'maybeCountsAsAvailable'];

/** Fill in anything a hand-edited or older state file is missing. */
function migrate(state, hostKey) {
  const base = defaultState(hostKey);
  const out = { ...base, ...state, jam: { ...base.jam, ...(state.jam || {}) } };
  // A host key given by the environment outranks the stored one. On a hosted
  // deploy the generated key is printed to a log nobody reads and stripped from
  // every response, so setting it is the only way to know what it is.
  out.hostToken = hostKey || state.hostToken || base.hostToken;
  for (const dead of RETIRED_SETTINGS) delete out.jam[dead];

  out.players = (state.players || []).map((p) => ({
    limits: {},
    stances: {},
    picks: {},
    instruments: [],
    present: true,
    removed: false,
    notes: '',
    ...p,
    stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {}, ...(p.stats || {}) },
  }));

  // A song from before approval existed was already visible to the whole room,
  // so it is approved. Hiding songs people had signed up for would be a worse
  // surprise than letting a handful through ungated once.
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

/**
 * The lineup on deck. Older states held one chair per template slot, filled in
 * by the scheduler; a lineup is now just the people the host picked, so the
 * seated names carry over and the empty chairs simply cease to exist.
 */
function migrateLineup(current) {
  if (!current || typeof current !== 'object') return null;
  if (Array.isArray(current.picks)) return current;
  const picks = (current.slots || [])
    .filter((s) => s.playerId)
    .map((s) => ({ playerId: s.playerId, instrument: s.instrument }));
  return { songId: current.songId ?? null, picks, createdAt: current.createdAt || Date.now() };
}

/* ------------------------------------------------------------ file backend */

class FileBackend {
  constructor(file, hostKey = '') {
    this.file = file;
    this.version = 0;
    try {
      mkdirSync(dirname(file), { recursive: true });
      // A single long-lived process owns the file, so it is read once and the
      // in-memory copy is authoritative from then on.
      this.state = existsSync(file)
        ? migrate(JSON.parse(readFileSync(file, 'utf8')), hostKey)
        : defaultState(hostKey);
    } catch (err) {
      // Nowhere to write — a serverless host with no key-value store set up.
      // Construct anyway: this backend reports 'sse', which is the signal the
      // serverless entry point turns into a 503 explaining what to configure.
      // Throwing here instead would kill the function on import, before it
      // could say anything at all.
      if (!['ENOENT', 'EROFS', 'EACCES', 'EPERM'].includes(err.code)) throw err;
      this.state = defaultState(hostKey);
    }
  }

  async load() {
    return { state: this.state, version: this.version };
  }

  async save(state) {
    this.state = state;
    this.version += 1;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
    return true;
  }

  get realtime() {
    return 'sse';
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
  constructor(url, token, prefix = 'amplify', hostKey = '') {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.hostKey = hostKey;
    this.stateKey = `${prefix}:state`;
    this.versionKey = `${prefix}:version`;
  }

  /** Upstash-compatible REST: POST a command array, get back { result }. */
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

  /**
   * Both keys in one command, deliberately.
   *
   * Fetching them separately is not atomic: a writer landing between the two
   * reads hands you an old state carrying a new version number, and the
   * compare-and-set then happily overwrites the newer write. One MGET closes
   * that window — and costs one round trip instead of two.
   */
  async load() {
    const [raw, version] = await this.command('MGET', this.stateKey, this.versionKey);
    if (!raw) return { state: defaultState(this.hostKey), version: 0 };
    return { state: migrate(JSON.parse(raw), this.hostKey), version: Number(version) || 0 };
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
    return 'poll'; // serverless functions cannot hold an event stream open
  }
}

/* -------------------------------------------------------------------- store */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Store {
  constructor(backend) {
    this.backend = backend;
    this.listeners = new Set();
    // Last version known to have been committed. Readable outside a request,
    // which the event stream needs — it has no request context of its own.
    this.liveVersion = 0;
    // Each request gets its own view of the night. Without this the loaded
    // state would live on the shared instance, and two requests in flight at
    // once would overwrite each other's snapshot between load and save —
    // accepting both sign-ups and persisting only one.
    this.context = new AsyncLocalStorage();
  }

  get realtime() {
    return this.backend.realtime;
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

  /** Mutate. Stays synchronous so route handlers read like plain code. */
  update(fn) {
    const ctx = this.current();
    const result = fn(ctx.state);
    ctx.dirty = true;
    return result;
  }

  /**
   * Load the night, run `fn` against it, and write back any change.
   *
   * If somebody else wrote first the save is refused and `fn` is replayed
   * against the newer state — nothing it did has been shown to anyone yet, so
   * replaying is safe. Errors thrown by `fn` propagate untouched.
   */
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

      // Lost the race. Back off with jitter before replaying — when a whole
      // room taps "sign up" at once, retrying in lockstep just collides again.
      await sleep(Math.min(250, 8 * 2 ** attempt) * (0.5 + Math.random()));
    }

    const busy = new Error('The jam is busy right now — try that again');
    busy.status = 409;
    throw busy;
  }

  /** Mark the loaded night as needing a write even if nothing changed. */
  touch() {
    this.current().dirty = true;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * What a browser is allowed to see. The host token never leaves the server;
   * player tokens are stripped so one phone cannot impersonate another.
   */
  publicState() {
    const { hostToken, ...rest } = this.state;
    return {
      ...rest,
      version: this.version,
      players: rest.players.filter((p) => !p.removed).map(({ token, ...p }) => p),
    };
  }

  isHost(token) {
    return Boolean(token) && token === this.state.hostToken;
  }

  playerByToken(token) {
    if (!token) return null;
    return this.state.players.find((p) => p.token === token && !p.removed) || null;
  }
}

/**
 * Pick a backend from the environment: a hosted key-value store when one is
 * configured, otherwise a local file. Vercel's Redis integration and Upstash
 * use different variable names for the same pair, so both are accepted.
 */
export function openStore({ dataDir, env = process.env } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const hostKey = env.HOST_KEY || '';

  if (url && token) {
    return new Store(new KvBackend(url, token, env.KV_PREFIX || 'amplify', hostKey));
  }

  const dir = dataDir || env.DATA_DIR || join(process.cwd(), 'data');
  return new Store(new FileBackend(join(dir, 'jam.json'), hostKey));
}
