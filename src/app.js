/**
 * The application: routing, validation and the REST API.
 *
 * Kept separate from the listener so the same handler serves both a plain
 * `node server.js` on a laptop and a serverless function on a host like
 * Vercel. Zero dependencies either way.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openJamStore, newId, DEFAULT_INSTRUMENTS, migrate, loadLegacyNightBlob,
} from './store.js';
import { openDirectory, liftLegacyNight } from './directory.js';
import { supabaseUsersConfigured } from './supabase-users.js';
import { commitRound, instrumentFor, mayPlay, signupsFor, STANCES, LEVELS } from './signups.js';
import { buildPdf } from './pdf.js';
import { buildSessionReport } from './report.js';
import {
  DUMMY_CREDENTIAL,
  hashPassword,
  publicUser,
  verifyPasswordAsync,
} from './passwords.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');

/** Org directory: accounts + host sessions + jam catalog. */
export const directory = openDirectory();

/** Jam night store bound to the current request (not a module global). */
const jamContext = new AsyncLocalStorage();
const activeJam = () => jamContext.getStore() || null;
let legacyLiftDone = false;

/** Open a jam night store, adopting a legacy blob only for the lifted jam. */
function nightStoreFor(jam) {
  return openJamStore(jam.id, {
    jamName: jam.name,
    adoptLegacy: Boolean(jam.legacyNight),
  });
}

/**
 * Night store proxy so existing handlers keep saying `store.*`.
 * Account helpers live on `directory`; night ops use the selected jam.
 */
export const store = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'hasAdmins') return (...a) => directory.hasAdmins(...a);
    if (prop === 'adminUsers') return (...a) => directory.adminUsers(...a);
    if (prop === 'userByUsername') return (...a) => directory.userByUsername(...a);
    if (prop === 'userById') return (...a) => directory.userById(...a);
    if (prop === 'isHost') return (...a) => directory.isHost(...a);
    const activeJamStore = activeJam();
    if (!activeJamStore) {
      throw new Error('No jam session selected for this request');
    }
    const val = activeJamStore[prop];
    return typeof val === 'function' ? val.bind(activeJamStore) : val;
  },
});

const DIRECTORY_ONLY = new Set([
  '/api/health',
  '/api/host/setup',
  '/api/host/login',
  '/api/host/auth',
  '/api/host/users',
  '/api/jams',
]);

function isDirectoryOnly(path) {
  if (DIRECTORY_ONLY.has(path)) return true;
  if (/^\/api\/host\/users\/[\w-]+$/.test(path)) return true;
  if (path === '/api/jams' || /^\/api\/jams\/[\w-]+$/.test(path)) return true;
  return false;
}

async function ensureLegacyLifted() {
  if (legacyLiftDone) return;
  // Only mark done after a successful read. A Redis failure must leave the
  // flag unset so the next request retries the lift.
  const legacy = await loadLegacyNightBlob();
  legacyLiftDone = true;
  if (!legacy) return;
  const hasAccounts = Array.isArray(legacy.users) && legacy.users.length > 0;
  const emptyDir = (directory.state.users || []).length === 0
    && (directory.state.jams || []).length === 0;
  if (!emptyDir && !hasAccounts) return;
  if (!emptyDir) return;
  directory.update((state) => {
    const lifted = liftLegacyNight(state, legacy);
    state.users = lifted.users;
    state.hostSessions = lifted.hostSessions;
    state.deletedUserIds = lifted.deletedUserIds;
    state.jams = lifted.jams;
  });
}

function resolveJamId(ctx) {
  const fromHeader = String(ctx.jamId || '').trim();
  const jams = directory.publicJams();
  // Accept a supplied id only when it names an open jam — stale localStorage
  // / archived ids fall through to the default jam instead of hard-failing.
  if (fromHeader && jams.some((jam) => jam.id === fromHeader)) return fromHeader;
  // Default to the oldest open jam so single-night deploys and tests keep
  // working without an x-jam-id header. Multi-jam UIs always send the header.
  if (jams.length >= 1) return jams[0].id;
  return '';
}

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

/** Host console routes require an admin session token (x-host-token). */
function requireHost(ctx) {
  if (!directory.isHost(ctx.hostToken)) throw new HttpError(403, 'Sign in as an admin first');
}

route('GET', /^\/api\/state$/, (ctx) => {
  const meta = directory.publicMeta();
  const jamId = resolveJamId(ctx);
  const jam = jamId ? directory.jamById(jamId) : null;
  if (!jam) {
    return {
      ...meta,
      jamId: null,
      jams: directory.isHost(ctx.hostToken) ? directory.publicJams() : undefined,
      jam: { name: 'Amplify', allowSuggestions: true, requireApproval: true, slots: [] },
      players: [],
      songs: [],
      rounds: [],
      current: null,
      roundIndex: 0,
      version: directory.version,
      presets: DEFAULT_INSTRUMENTS,
      realtime: activeJam()?.realtime || 'poll',
      youId: null,
      isHost: directory.isHost(ctx.hostToken),
      signups: {},
    };
  }
  const me = store.playerByToken(ctx.playerToken);
  return {
    ...store.publicState(),
    ...meta,
    jamId: jam.id,
    jams: directory.isHost(ctx.hostToken) ? directory.publicJams() : undefined,
    presets: DEFAULT_INSTRUMENTS,
    realtime: store.realtime,
    youId: me?.id || null,
    isHost: directory.isHost(ctx.hostToken),
    signups: Object.fromEntries(
      store.state.songs
        .filter((s) => s.status === 'approved' || s.status === 'pending')
        .map((s) => [s.id, signupsFor(store.state.players, s)]),
    ),
  };
});

route('POST', /^\/api\/join$/, (ctx) => {
  const name = str(ctx.body.name, { max: 60, field: 'Name', required: true });
  const player = {
    id: newId('u'),
    token: newId(),
    name,
    userId: null,
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

/** Username: 3–32 chars, letters/digits/._- — unique case-insensitively. */
function parseUsername(value) {
  const username = str(value, { max: 32, field: 'Username', required: true });
  if (username.length < 3) throw bad('Username must be at least 3 characters');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw bad('Username can only use letters, numbers, dots, underscores and hyphens');
  }
  return username;
}

function parseNewPassword(value) {
  const password = String(value ?? '');
  if (password.length < 6) throw bad('Password must be at least 6 characters');
  if (password.length > 72) throw bad('Password is too long');
  return password;
}

/**
 * In-memory login throttle: per client IP, and per IP+username pair.
 * Username alone is never a key — that would let strangers lock out accounts.
 *
 * Row shape: { count, until, lockouts, touched }
 * `lockouts` survives a finished backoff so the next lockout doubles.
 */
const loginAttempts = new Map();
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_BACKOFF_BASE_MS = 30_000;
const LOGIN_BACKOFF_CAP_MS = 15 * 60 * 1000;
/** Drop idle failure tallies that never reached a lockout. */
const LOGIN_IDLE_RESET_MS = 15 * 60 * 1000;

function clientIp(ctx) {
  const forwarded = String(ctx.ip || '').split(',')[0].trim();
  return forwarded || 'unknown';
}

function loginKeys(ip, username) {
  const user = String(username).toLowerCase();
  return [`ip:${ip}`, `ipuser:${ip}:${user}`];
}

/** `lockouts` is how many lockouts have already completed (0 = first lock). */
function loginBackoffMs(lockouts) {
  const n = Math.min(Math.max(0, lockouts || 0), 5);
  return Math.min(LOGIN_BACKOFF_CAP_MS, LOGIN_BACKOFF_BASE_MS * (2 ** n));
}

function pruneLoginAttempts(now = Date.now()) {
  for (const [key, row] of loginAttempts) {
    if (row.until && row.until <= now) {
      // Backoff over — keep strike history so the next lockout escalates.
      loginAttempts.set(key, {
        count: 0,
        until: 0,
        lockouts: row.lockouts || 0,
        touched: now,
      });
      continue;
    }
    if (!row.until && now - (row.touched || 0) > LOGIN_IDLE_RESET_MS) {
      loginAttempts.delete(key);
    }
  }
}

/**
 * Sync gate before the awaited scrypt verify. Checks every key first, then
 * reserves on all of them, so a locked pair cannot burn a shared IP slot.
 */
function beginLoginAttempt(ip, username) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const keys = loginKeys(ip, username);

  for (const key of keys) {
    const row = loginAttempts.get(key);
    if (row?.until > now) {
      throw new HttpError(429, 'Too many sign-in attempts — try again in a moment');
    }
    if ((row?.count || 0) >= LOGIN_FAIL_LIMIT) {
      const next = {
        count: row.count,
        until: now + loginBackoffMs(row.lockouts || 0),
        lockouts: (row.lockouts || 0) + 1,
        touched: now,
      };
      loginAttempts.set(key, next);
      throw new HttpError(429, 'Too many sign-in attempts — try again in a moment');
    }
  }

  for (const key of keys) {
    const prev = loginAttempts.get(key);
    loginAttempts.set(key, {
      count: (prev?.count || 0) + 1,
      until: 0,
      lockouts: prev?.lockouts || 0,
      touched: now,
    });
  }
}

/** After a failed verify — count was already reserved; apply lockout if needed. */
function finishLoginFailure(ip, username) {
  const now = Date.now();
  for (const key of loginKeys(ip, username)) {
    const row = loginAttempts.get(key);
    if (!row) continue;
    row.touched = now;
    if (row.count >= LOGIN_FAIL_LIMIT && !(row.until > now)) {
      row.until = now + loginBackoffMs(row.lockouts || 0);
      row.lockouts = (row.lockouts || 0) + 1;
    }
    loginAttempts.set(key, row);
  }
}

function clearLoginFailures(ip, username) {
  for (const key of loginKeys(ip, username)) loginAttempts.delete(key);
}

/**
 * Shared password check with throttle + dummy-hash timing.
 * Returns the user when credentials match an enabled account.
 * Pass `roles` (e.g. ['admin']) to require a role without revealing why a
 * valid musician password still fails host sign-in.
 */
async function authenticateAccount(ctx, usernameRaw, passwordRaw, { roles = null } = {}) {
  const username = parseUsername(usernameRaw);
  const password = String(passwordRaw ?? '');
  const ip = clientIp(ctx);
  beginLoginAttempt(ip, username);

  const user = directory.userByUsername(username);
  // Always pay scrypt cost (dummy salt/hash when unknown) so timing cannot
  // enumerate which usernames exist — including disabled accounts.
  const salt = user?.passwordSalt || DUMMY_CREDENTIAL.salt;
  const hash = user?.passwordHash || DUMMY_CREDENTIAL.hash;
  const passwordOk = await verifyPasswordAsync(password, salt, hash);
  const roleOk = !roles || (user && roles.includes(user.role));
  if (!user || user.disabled || !passwordOk || !roleOk) {
    finishLoginFailure(ip, username);
    throw new HttpError(401, 'Username or password is wrong');
  }
  clearLoginFailures(ip, username);
  return user;
}

function parseRole(value, fallback = 'player') {
  if (value == null || value === '') return fallback;
  const role = String(value).toLowerCase();
  if (role !== 'admin' && role !== 'player') throw bad('Role must be admin or player');
  return role;
}

function assertNotLastAdmin(user, { removing = false, demoting = false, disabling = false } = {}) {
  if (user.role !== 'admin' || user.disabled) return;
  const others = directory.adminUsers().filter((u) => u.id !== user.id);
  if (others.length > 0) return;
  if (removing) throw bad('Create another admin before removing this one');
  if (demoting) throw bad('Create another admin before demoting this one');
  if (disabling) throw bad('Create another admin before disabling this one');
}

/** Issue a per-admin console session (returned as x-host-token after login/setup). */
function issueHostSession(state, userId) {
  if (!Array.isArray(state.hostSessions)) state.hostSessions = [];
  const session = {
    id: newId('hs'),
    userId,
    token: newId(),
    createdAt: Date.now(),
  };
  state.hostSessions.push(session);
  return session.token;
}

/** Drop console sessions for an admin who lost access. */
function revokeAdminHostAccess(state, userId) {
  state.hostSessions = (state.hostSessions || []).filter((s) => s.userId !== userId);
}

function createJamRecord(state, { name, createdBy }) {
  if (!Array.isArray(state.jams)) state.jams = [];
  const jam = {
    id: newId('jam'),
    name: name || 'Amplify Open Jam',
    createdAt: Date.now(),
    createdBy: createdBy || null,
    archived: false,
  };
  state.jams.push(jam);
  return jam;
}

/**
 * Sign in with a host-created account. Resumes tonight's player seat for that
 * user (or opens a fresh one) and rotates the session token.
 */
route('POST', /^\/api\/auth\/login$/, async (ctx) => {
  const user = await authenticateAccount(ctx, ctx.body.username, ctx.body.password);

  let playerId;
  let token;
  store.update((state) => {
    let player = state.players.find((p) => p.userId === user.id && !p.removed);
    if (!player) {
      player = {
        id: newId('u'),
        token: newId(),
        name: user.displayName || user.username,
        userId: user.id,
        joinedAt: Date.now(),
        present: true,
        removed: false,
        instruments: Array.isArray(user.instruments) && user.instruments.length
          ? structuredClone(user.instruments)
          : [{ name: 'Vocals', level: 'comfortable' }],
        stances: {},
        picks: {},
        limits: {},
        notes: '',
        stats: { plays: 0, lastRound: null, streak: 0, byInstrument: {} },
      };
      state.players.push(player);
    } else {
      player.token = newId();
      player.present = true;
      if (!player.name) player.name = user.displayName || user.username;
    }
    playerId = player.id;
    token = player.token;
  });
  return { id: playerId, token, userId: user.id, username: user.username };
});

/**
 * First-time host setup: create the initial admin when none exist yet.
 * No shared host key — accounts are the source of truth.
 * Also creates the first jam session so the console has somewhere to land.
 *
 * If any accounts already exist (even with every admin disabled), setup
 * requires a live host session — same gate as before HOST_KEY was removed.
 * Recovery for a locked-out deploy is to re-enable an admin in the directory
 * / Supabase `amplify_accounts` row, not to reopen anonymous setup.
 */
route('POST', /^\/api\/host\/setup$/, (ctx) => {
  if (directory.hasAdmins()) {
    throw bad('An admin account already exists — sign in instead');
  }
  const hasExistingUsers = (directory.state.users || []).length > 0;
  if (hasExistingUsers) requireHost(ctx);
  const username = parseUsername(ctx.body.username);
  if (directory.userByUsername(username)) throw bad('That username is already taken');
  const displayName = str(ctx.body.displayName || username, { max: 60, field: 'Display name', required: true });
  const password = parseNewPassword(ctx.body.password);
  const { salt, hash } = hashPassword(password);
  const user = {
    id: newId('usr'),
    username,
    displayName,
    passwordHash: hash,
    passwordSalt: salt,
    instruments: [],
    role: 'admin',
    disabled: false,
    createdAt: Date.now(),
  };
  let sessionToken;
  let jam;
  directory.update((state) => {
    if (!Array.isArray(state.users)) state.users = [];
    state.users.push(user);
    sessionToken = issueHostSession(state, user.id);
    if (!(state.jams || []).some((j) => !j.archived)) {
      jam = createJamRecord(state, { name: 'Amplify Open Jam', createdBy: user.id });
    } else {
      jam = state.jams.find((j) => !j.archived);
    }
  });
  return {
    token: sessionToken,
    user: publicUser(user),
    jam: jam ? { id: jam.id, name: jam.name } : null,
  };
});

/** Admin sign-in for the host console. Returns a per-admin session token. */
route('POST', /^\/api\/host\/login$/, async (ctx) => {
  const user = await authenticateAccount(ctx, ctx.body.username, ctx.body.password, {
    roles: ['admin'],
  });
  let sessionToken;
  directory.update((state) => {
    sessionToken = issueHostSession(state, user.id);
  });
  return {
    token: sessionToken,
    username: user.username,
    displayName: user.displayName,
    userId: user.id,
    jams: directory.publicJams(),
  };
});

route('GET', /^\/api\/jams$/, (ctx) => {
  requireHost(ctx);
  return { jams: directory.publicJams() };
});

route('POST', /^\/api\/jams$/, async (ctx) => {
  requireHost(ctx);
  const session = directory.hostSession(ctx.hostToken);
  const name = str(ctx.body.name || 'Amplify Open Jam', { max: 60, field: 'Name', required: true });
  let jam;
  directory.update((state) => {
    jam = createJamRecord(state, { name, createdBy: session?.userId || null });
  });
  // Touch the night blob so the jam exists on disk/Redis immediately.
  const night = nightStoreFor(jam);
  await night.run(() => {
    night.update((state) => {
      state.jam.name = jam.name;
    });
  });
  return { jam: { id: jam.id, name: jam.name, createdAt: jam.createdAt, createdBy: jam.createdBy } };
});

route('GET', /^\/api\/host\/users$/, (ctx) => {
  requireHost(ctx);
  return {
    users: (directory.state.users || []).map(publicUser),
  };
});

route('POST', /^\/api\/host\/users$/, (ctx) => {
  requireHost(ctx);
  const username = parseUsername(ctx.body.username);
  if (directory.userByUsername(username)) throw bad('That username is already taken');
  const displayName = str(ctx.body.displayName || username, { max: 60, field: 'Display name', required: true });
  const password = parseNewPassword(ctx.body.password);
  const role = parseRole(ctx.body.role, 'player');
  const instruments = ctx.body.instruments != null
    ? parseInstruments(ctx.body.instruments)
    : [];
  const { salt, hash } = hashPassword(password);
  const user = {
    id: newId('usr'),
    username,
    displayName,
    passwordHash: hash,
    passwordSalt: salt,
    instruments,
    role,
    disabled: false,
    createdAt: Date.now(),
  };
  directory.update((state) => {
    if (!Array.isArray(state.users)) state.users = [];
    state.users.push(user);
    state.deletedUserIds = (state.deletedUserIds || []).filter((id) => id !== user.id);
  });
  return { user: publicUser(user) };
});

route('PATCH', /^\/api\/host\/users\/([\w-]+)$/, (ctx) => {
  requireHost(ctx);
  const user = directory.userById(ctx.params[0]);
  if (!user) throw new HttpError(404, 'User not found');
  const body = ctx.body || {};

  if (body.username != null) {
    const username = parseUsername(body.username);
    const clash = directory.userByUsername(username);
    if (clash && clash.id !== user.id) throw bad('That username is already taken');
  }

  const nextRole = body.role != null ? parseRole(body.role, user.role) : user.role;
  const nextDisabled = body.disabled != null ? Boolean(body.disabled) : user.disabled;
  const demoting = user.role === 'admin' && nextRole !== 'admin';
  const disabling = !user.disabled && nextDisabled;
  assertNotLastAdmin(user, { demoting, disabling });

  directory.update((state) => {
    if (body.username != null) user.username = parseUsername(body.username);
    if (body.displayName != null) {
      user.displayName = str(body.displayName, { max: 60, field: 'Display name', required: true });
    }
    if (body.instruments != null) user.instruments = parseInstruments(body.instruments);
    if (body.role != null) user.role = nextRole;
    if (body.disabled != null) user.disabled = nextDisabled;
    if (body.password != null && body.password !== '') {
      const { salt, hash } = hashPassword(parseNewPassword(body.password));
      user.passwordSalt = salt;
      user.passwordHash = hash;
    }
    if (demoting || disabling) revokeAdminHostAccess(state, user.id);
  });
  return { user: publicUser(user) };
});

route('DELETE', /^\/api\/host\/users\/([\w-]+)$/, async (ctx) => {
  requireHost(ctx);
  const user = directory.userById(ctx.params[0]);
  if (!user) throw new HttpError(404, 'User not found');
  assertNotLastAdmin(user, { removing: true });
  const wasAdmin = user.role === 'admin' && !user.disabled;
  directory.update((state) => {
    state.users = (state.users || []).filter((u) => u.id !== user.id);
    if (!Array.isArray(state.deletedUserIds)) state.deletedUserIds = [];
    if (!state.deletedUserIds.includes(user.id)) state.deletedUserIds.push(user.id);
    if (wasAdmin) revokeAdminHostAccess(state, user.id);
  });
  // Unlink the account from every jam roster (directory-only path has no
  // request jam context). Use jamById so legacyNight adoption flags survive.
  for (const pub of directory.publicJams()) {
    const jam = directory.jamById(pub.id);
    if (!jam) continue;
    const jamStore = nightStoreFor(jam);
    await jamStore.run(() => {
      jamStore.update((state) => {
        for (const p of state.players) {
          if (p.userId === user.id) p.userId = null;
        }
      });
    });
  }
  return { ok: true };
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
  // Host setlist add: explicit `hostAdd` from the console, or a host-only
  // session with no player token. Everything else is a room request — including
  // when the same browser also holds the host key (host testing both roles on
  // one phone), which used to auto-approve and put songs on the sign-up sheet
  // before anyone vetted them.
  const hostAdd = isHost && (ctx.body?.hostAdd === true || !me);

  if (!hostAdd && !store.state.jam.allowSuggestions) throw new HttpError(403, 'Suggestions are closed');
  if (!hostAdd && !me) throw new HttpError(403, 'Sign up before suggesting songs');
  if (ctx.body?.hostAdd && !isHost) throw new HttpError(403, 'Host key required');

  const status = hostAdd || !store.state.jam.requireApproval ? 'approved' : 'pending';

  const song = {
    id: newId('s'),
    title: str(ctx.body.title, { max: 80, field: 'Title', required: true }),
    artist: str(ctx.body.artist, { max: 80 }),
    key: str(ctx.body.key, { max: 12 }),
    notes: str(ctx.body.notes, { max: 200 }),
    slots: Array.isArray(ctx.body.slots) ? parseSlots(ctx.body.slots, null) : null,
    status,
    suggestedBy: hostAdd ? null : me.id,
    addedAt: Date.now(),
  };
  store.update((state) => state.songs.push(song));
  return { id: song.id, status };
});

/**
 * Let a request into the setlist. Declining keeps a short note for the person
 * who asked (status `declined`) instead of vanishing without a word.
 */
route('POST', /^\/api\/host\/songs\/([\w-]+)\/approve$/, (ctx) => {
  requireHost(ctx);
  const song = store.state.songs.find((s) => s.id === ctx.params[0]);
  if (!song) throw new HttpError(404, 'Song not found');
  // Same gate as decline: only a waiting request can be waved through. A
  // declined title stays declined unless the host removes it and someone asks
  // again — approve must not quietly resurrect a "no".
  if (song.status !== 'pending') throw bad('Only pending requests can be approved this way');
  store.update(() => {
    song.status = 'approved';
    song.approvedAt = Date.now();
    delete song.declinedAt;
    delete song.declineReason;
  });
  return { ok: true };
});

route('POST', /^\/api\/host\/songs\/([\w-]+)\/decline$/, (ctx) => {
  requireHost(ctx);
  const song = store.state.songs.find((s) => s.id === ctx.params[0]);
  if (!song) throw new HttpError(404, 'Song not found');
  if (song.status !== 'pending') throw bad('Only pending requests can be declined this way');
  const reason = str(ctx.body?.reason, { max: 200 });
  store.update(() => {
    song.status = 'declined';
    song.declinedAt = Date.now();
    song.declineReason = reason;
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
  if (!directory.isHost(ctx.body.token)) throw new HttpError(403, 'That key does not match');
  const jamId = resolveJamId(ctx);
  const jam = jamId ? directory.jamById(jamId) : null;
  return {
    ok: true,
    jam: jam?.name || null,
    jamId: jam?.id || null,
    jams: directory.publicJams(),
  };
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
    const song = state.songs.find((s) => s.id === current.songId) || null;
    // Snapshot display fields so reports stay readable after songs/players change.
    state.rounds.push({
      index: state.roundIndex,
      songId: current.songId,
      songTitle: song?.title ?? null,
      songArtist: song?.artist ?? null,
      playedAt: Date.now(),
      picks: current.picks.map(({ instrument, playerId }) => {
        const player = state.players.find((p) => p.id === playerId);
        return {
          instrument,
          playerId,
          playerName: player?.name || null,
        };
      }),
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

/** How recently the host must have exported before a night wipe is allowed. */
const BACKUP_MAX_AGE_MS = 15 * 60 * 1000;

route('POST', /^\/api\/host\/reset$/, (ctx) => {
  requireHost(ctx);
  const mode = oneOf(ctx.body.mode, ['turns', 'night'], 'turns');
  // Clearing the night is irreversible and there is no Redis undo. The UI
  // downloads a backup first; the API also requires a recent /host/export so a
  // raw curl with confirmBackup:true cannot wipe a busy room.
  if (mode === 'night') {
    if (ctx.body.confirmBackup !== true) {
      throw bad('Download a backup first, then clear the night');
    }
    const hasAnything = store.state.players.length > 0 || store.state.songs.length > 0;
    const exportedAt = store.state.lastHostExportAt || 0;
    if (hasAnything && Date.now() - exportedAt > BACKUP_MAX_AGE_MS) {
      throw bad('Download a backup first, then clear the night');
    }
  }
  store.update((state) => {
    state.current = null;
    state.rounds = [];
    state.roundIndex = 0;
    for (const p of state.players) p.stats = { plays: 0, lastRound: null, streak: 0, byInstrument: {} };
    if (mode === 'night') {
      state.players = [];
      state.songs = [];
      delete state.lastHostExportAt;
    }
  });
  return { ok: true };
});

/**
 * Full night snapshot for the host — includes player tokens so a restore puts
 * phones back where they were. Never expose this without a host key.
 */
route('GET', /^\/api\/host\/export$/, (ctx) => {
  requireHost(ctx);
  const exportedAt = Date.now();
  store.update((state) => {
    state.lastHostExportAt = exportedAt;
  });
  const snap = structuredClone(store.state);
  delete snap.lastHostExportAt;
  delete snap.hostToken;
  delete snap.hostSessions;
  // Include accounts so a full restore can rebuild the org directory.
  snap.users = structuredClone(directory.state.users || []);
  return {
    format: 'amplify-night-v1',
    exportedAt,
    version: store.version,
    jamId: resolveJamId(ctx) || null,
    night: snap,
  };
});

/**
 * Shareable day-of PDF: roster, setlist, who played. No session tokens.
 * Distinct from /host/export, which is a restore backup.
 */
route('GET', /^\/api\/host\/report$/, (ctx) => {
  requireHost(ctx);
  const report = buildSessionReport(store.state);
  const pdf = buildPdf(report);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (store.state.jam?.name || 'amplify-session')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'amplify-session';
  return {
    __pdf: pdf,
    filename: `${slug}-${stamp}.pdf`,
  };
});

const SONG_STATUSES = new Set(['pending', 'approved', 'declined']);
const BACKUP_MAX_ROWS = 500;

/** Shape-check a night backup before it replaces the live room. */
function assertNightBackup(night) {
  if (!night || typeof night !== 'object' || Array.isArray(night)) {
    throw bad('That file does not look like an Amplify night backup');
  }
  if (!night.jam || typeof night.jam !== 'object' || Array.isArray(night.jam)) {
    throw bad('That file does not look like an Amplify night backup');
  }
  if (!Array.isArray(night.players) || !Array.isArray(night.songs)) {
    throw bad('That file does not look like an Amplify night backup');
  }
  if (night.players.length > BACKUP_MAX_ROWS || night.songs.length > BACKUP_MAX_ROWS) {
    throw bad('That backup is too large to restore');
  }
  if (night.users != null) {
    if (!Array.isArray(night.users)) throw bad('That file does not look like an Amplify night backup');
    if (night.users.length > BACKUP_MAX_ROWS) throw bad('That backup is too large to restore');
  }
  if (night.rounds != null && !Array.isArray(night.rounds)) {
    throw bad('That file does not look like an Amplify night backup');
  }
  for (const p of night.players) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.token !== 'string' || typeof p.name !== 'string') {
      throw bad('A player in that backup is incomplete');
    }
  }
  for (const s of night.songs) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.title !== 'string') {
      throw bad('A song in that backup is incomplete');
    }
    if (s.status != null && !SONG_STATUSES.has(s.status)) {
      throw bad('A song in that backup has an unknown status');
    }
  }
  for (const u of night.users || []) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || typeof u.username !== 'string') {
      throw bad('A user in that backup is incomplete');
    }
    if (typeof u.passwordHash !== 'string' || typeof u.passwordSalt !== 'string') {
      throw bad('A user in that backup is missing its password credentials');
    }
  }
}

/** Replace the live night with a previously exported snapshot. */
route('POST', /^\/api\/host\/import$/, (ctx) => {
  requireHost(ctx);
  const body = ctx.body || {};
  const night = body.night || body;
  assertNightBackup(night);
  const backupUsers = Array.isArray(night.users) ? structuredClone(night.users) : null;
  let mergedUsers = null;
  if (backupUsers) {
    const restored = backupUsers.map((u) => ({
      id: u.id,
      username: String(u.username || '').trim(),
      displayName: String(u.displayName || u.username || '').trim(),
      passwordHash: u.passwordHash || '',
      passwordSalt: u.passwordSalt || '',
      instruments: Array.isArray(u.instruments) ? u.instruments : [],
      role: u.role === 'admin' ? 'admin' : 'player',
      disabled: Boolean(u.disabled),
      createdAt: u.createdAt || Date.now(),
    })).filter((u) => u.id && u.username && u.passwordHash && u.passwordSalt);
    // Keep live accounts on ID conflict; only add missing backup users.
    const byId = new Map((directory.state.users || []).map((u) => [u.id, u]));
    for (const u of restored) if (!byId.has(u.id)) byId.set(u.id, u);
    mergedUsers = [...byId.values()];
    if (!mergedUsers.some((u) => u.role === 'admin' && !u.disabled)) {
      throw bad('That backup would leave no admin account');
    }
  }
  store.update((state) => {
    const backup = structuredClone(night);
    delete backup.hostSessions;
    delete backup.hostToken;
    delete backup.users;
    delete backup.deletedUserIds;
    const next = migrate(backup);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  });
  if (mergedUsers) {
    directory.update((state) => {
      state.users = mergedUsers;
      const admins = new Set(
        mergedUsers.filter((u) => u.role === 'admin' && !u.disabled).map((u) => u.id),
      );
      state.hostSessions = (state.hostSessions || []).filter((s) => admins.has(s.userId));
    });
  }
  return { ok: true, jam: store.state.jam.name };
});

/* --------------------------------------------------------------------- SSE */

/** @type {Set<{ res: import('node:http').ServerResponse, jamId: string }>} */
const clients = new Set();

function attachJamListeners(jamStore, jamId) {
  if (jamStore.__amplifySseAttached) return;
  jamStore.__amplifySseAttached = true;
  jamStore.subscribe((version) => {
    for (const client of clients) {
      if (client.jamId !== jamId) continue;
      try {
        client.res.write(`data: ${version}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  });
}

function streamEvents(res, jamStore, jamId) {
  attachJamListeners(jamStore, jamId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\ndata: ${jamStore.liveVersion}\n\n`);
  const client = { res, jamId };
  clients.add(client);

  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  beat.unref?.();
  res.on('close', () => {
    clearInterval(beat);
    clients.delete(client);
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

  if (path.startsWith('/api/')) {
    // Ops probe — available even when the jam is misconfigured.
    if (path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      const urlKv = Boolean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
      const tokenKv = Boolean(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
      const hasKv = urlKv && tokenKv;
      let storeOk = true;
      try {
        storeOk = await directory.ping();
      } catch {
        storeOk = false;
      }
      const ok = storeOk && (!process.env.VERCEL || hasKv);
      return send(res, ok ? 200 : 503, {
        ok,
        storeOk,
        realtime: hasKv ? 'poll' : 'sse',
        hasKv,
        hasSupabaseUsers: supabaseUsersConfigured(),
        vercel: Boolean(process.env.VERCEL),
      });
    }

    // On Vercel the file backend cannot persist (read-only /var/task).
    if (process.env.VERCEL && !(
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
      && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    )) {
      return send(res, 503, {
        error: 'No key-value store configured. In Vercel → Storage, add Upstash Redis (sets KV_REST_API_URL and KV_REST_API_TOKEN), then redeploy.',
      });
    }

    const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!match && path !== '/api/events') return send(res, 404, { error: 'Unknown endpoint' });

    let body;
    try {
      body = (req.method === 'GET' || path === '/api/events') ? {} : await readBody(req);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message });
    }

    const forwarded = req.headers['x-forwarded-for'];
    const trustProxy = Boolean(process.env.VERCEL) || process.env.AMPLIFY_TRUST_PROXY === '1';
    const forwardedIp = trustProxy && typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : '';
    const ctx = {
      params: match ? path.match(match.pattern).slice(1) : [],
      body,
      hostToken: req.headers['x-host-token'] || '',
      playerToken: req.headers['x-player-token'] || '',
      jamId: req.headers['x-jam-id'] || url.searchParams.get('jam') || '',
      ip: forwardedIp || req.socket?.remoteAddress || '',
    };

    try {
      const result = await directory.run(async () => {
        await ensureLegacyLifted();

        if (path === '/api/events') {
          const jamId = resolveJamId(ctx);
          const jam = jamId ? directory.jamById(jamId) : null;
          if (!jam) {
            const err = new HttpError(400, 'Pick a jam session first');
            throw err;
          }
          const jamStore = nightStoreFor(jam);
          if (jamStore.realtime !== 'sse') {
            const err = new HttpError(501, 'Live stream not available here');
            throw err;
          }
          streamEvents(res, jamStore, jam.id);
          return { __streamed: true };
        }

        const dirOnly = isDirectoryOnly(path)
          || (path === '/api/state' && !resolveJamId(ctx) && !directory.publicJams().length);
        // /api/state with a resolvable jam still needs the night blob.
        const needsNight = !dirOnly && !(path === '/api/host/setup' || path === '/api/host/login'
          || path === '/api/host/auth' || path === '/api/jams'
          || path === '/api/host/users' || /^\/api\/host\/users\//.test(path));

        if (!needsNight && path !== '/api/state') {
          return match.handler(ctx) ?? { ok: true };
        }

        // /api/state without a jam: directory meta only (gate / picker).
        if (path === '/api/state' && !resolveJamId(ctx)) {
          return match.handler(ctx) ?? { ok: true };
        }

        const jamId = resolveJamId(ctx);
        const jam = jamId ? directory.jamById(jamId) : null;
        if (!jam) throw new HttpError(400, 'Pick a jam session first');
        const jamStore = nightStoreFor(jam);
        return jamContext.run(jamStore,
          () => jamStore.run(() => match.handler(ctx) ?? { ok: true }));
      });

      if (result?.__streamed) return undefined;
      if (result && Buffer.isBuffer(result.__pdf)) {
        const name = String(result.filename || 'session-report.pdf').replace(/[^\w.-]+/g, '-');
        return send(res, 200, result.__pdf, {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${name}"`,
        });
      }
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
