/**
 * Org directory: accounts, host console sessions, and jam session list.
 *
 * Separate from tonight's night blob so accounts are not owned by a night and
 * no shared HOST_KEY is required to bootstrap. When Supabase is configured,
 * accounts dual-write there (see supabase-users.js); jam rows optionally too.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { randomBytes } from 'node:crypto';

import { openSupabaseUsers, mergeUsers } from './supabase-users.js';
import { openSupabaseJams } from './supabase-jams.js';

function newId(prefix = '') {
  return prefix + randomBytes(8).toString('hex');
}

function defaultDirectory() {
  return {
    users: [],
    hostSessions: [],
    deletedUserIds: [],
    jams: [],
  };
}

export function migrateDirectory(raw) {
  const base = defaultDirectory();
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    users: (state.users || []).map((u) => ({
      id: u.id,
      username: String(u.username || '').trim(),
      displayName: String(u.displayName || u.username || '').trim(),
      passwordHash: u.passwordHash || '',
      passwordSalt: u.passwordSalt || '',
      instruments: Array.isArray(u.instruments) ? u.instruments : [],
      role: u.role === 'admin' ? 'admin' : 'player',
      disabled: Boolean(u.disabled),
      createdAt: u.createdAt || Date.now(),
    })).filter((u) => u.id && u.username && u.passwordHash && u.passwordSalt),
    hostSessions: (state.hostSessions || []).map((s) => ({
      id: s.id,
      userId: s.userId,
      token: s.token,
      createdAt: s.createdAt || Date.now(),
    })).filter((s) => s.id && s.userId && s.token),
    deletedUserIds: [...new Set(
      (state.deletedUserIds || []).map((id) => String(id || '').trim()).filter(Boolean),
    )].slice(0, 500),
    jams: (state.jams || []).map((j) => ({
      id: String(j.id || '').trim(),
      name: String(j.name || 'Amplify Open Jam').trim() || 'Amplify Open Jam',
      createdAt: Number(j.createdAt) || Date.now(),
      createdBy: j.createdBy || null,
      archived: Boolean(j.archived),
      legacyNight: Boolean(j.legacyNight),
    })).filter((j) => j.id),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[2])
if current == ARGV[1] or (current == false and ARGV[1] == '0') then
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[3])
  return 1
end
return 0`;

class FileDirectoryBackend {
  constructor(file) {
    this.file = file;
    this.version = 0;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (err) {
      // Read-only hosts may not allow mkdir; continue so a missing file can
      // still start from defaults. An existing file must still load below.
      if (!['ENOENT', 'EROFS', 'EACCES', 'EPERM'].includes(err.code)) throw err;
    }
    // An existing file must load or fail startup. Never replace it with
    // defaults — that would let anonymous /api/host/setup wipe accounts.
    if (!existsSync(file)) {
      this.state = defaultDirectory();
      return;
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} does not contain a directory object`);
    }
    this.state = migrateDirectory(parsed);
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
          'Cannot save accounts on this host. Add Upstash Redis and redeploy.',
        );
        e.status = 503;
        throw e;
      }
      throw err;
    }
    return true;
  }

  async ping() {
    return true;
  }
}

class KvDirectoryBackend {
  constructor(url, token, prefix = 'amplify') {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.stateKey = `${prefix}:directory`;
    this.versionKey = `${prefix}:directory:version`;
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
    if (!raw) return { state: defaultDirectory(), version: 0 };
    return { state: migrateDirectory(JSON.parse(raw)), version: Number(version) || 0 };
  }

  async save(state, expectedVersion) {
    const ok = await this.command(
      'EVAL', CAS_SCRIPT, 2,
      this.stateKey, this.versionKey,
      String(expectedVersion), JSON.stringify(state), String(expectedVersion + 1),
    );
    return Number(ok) === 1;
  }

  async ping() {
    const pong = await this.command('PING');
    return pong === 'PONG' || pong === true || pong === 'pong';
  }
}

/**
 * Accounts sync through Supabase; jam list stays on the directory blob and is
 * mirrored when a Supabase jam client is attached.
 */
class DirectorySyncedBackend {
  constructor(inner, remoteUsers, remoteJams = null) {
    this.inner = inner;
    this.remoteUsers = remoteUsers;
    this.remoteJams = remoteJams;
    // States whose remote jam list could not be read — skip replaceAll on save
    // so a transient Supabase error cannot wipe the catalog.
    this.untrustedJams = new WeakSet();
  }

  /** True when this load's jam catalog may be treated as authoritative. */
  jamsListTrusted(state) {
    if (!this.remoteJams) return true;
    return !this.untrustedJams.has(state);
  }

  async ping() {
    const ok = await this.inner.ping();
    if (!ok) return false;
    if (this.remoteUsers) await this.remoteUsers.ping();
    return true;
  }

  async load() {
    const { state, version } = await this.inner.load();
    if (!this.remoteUsers) return { state, version };

    let remoteUsers = [];
    try {
      remoteUsers = await this.remoteUsers.list();
    } catch {
      if (!Array.isArray(state.users)) state.users = [];
      if (state.users.length === 0) {
        // Never treat an unreachable account store as "no accounts":
        // that would reopen first-admin setup to anyone.
        const e = new Error('Accounts are unavailable right now — try again shortly');
        e.status = 503;
        throw e;
      }
      // We never reached a successful jam list read on this load.
      if (this.remoteJams) this.untrustedJams.add(state);
      return { state, version };
    }

    const localUsers = Array.isArray(state.users) ? state.users : [];
    const deletedIds = Array.isArray(state.deletedUserIds) ? state.deletedUserIds : [];
    if (remoteUsers.length === 0 && localUsers.length > 0) {
      try { await this.remoteUsers.replaceAll(localUsers); } catch { /* retry later */ }
      state.users = localUsers;
    } else {
      const merged = mergeUsers(localUsers, remoteUsers, deletedIds);
      state.users = merged;
      if (usersSignature(merged) !== usersSignature(remoteUsers)) {
        try {
          await this.remoteUsers.replaceAll(merged);
          state.deletedUserIds = [];
        } catch { /* leave merged in memory */ }
      }
    }

    if (this.remoteJams) {
      try {
        const remoteJams = await this.remoteJams.list();
        if (remoteJams.length > 0) {
          state.jams = mergeJams(state.jams, remoteJams);
          this.untrustedJams.delete(state);
        } else if ((state.jams || []).length > 0) {
          // Seed remote from local — only clear the marker after seeding works.
          await this.remoteJams.replaceAll(state.jams);
          this.untrustedJams.delete(state);
        } else {
          this.untrustedJams.delete(state);
        }
      } catch {
        // Keep local jams, but do not mirror them until a later load succeeds.
        this.untrustedJams.add(state);
      }
    }

    return { state, version };
  }

  async save(state, expectedVersion) {
    const ok = await this.inner.save(state, expectedVersion);
    if (!ok) return false;
    if (this.remoteUsers) {
      for (let i = 0; i < 3; i++) {
        try {
          await this.remoteUsers.replaceAll(state.users || []);
          break;
        } catch (err) {
          if (i === 2) console.error('Supabase accounts sync failed:', err?.message);
          else await sleep(20 * (i + 1));
        }
      }
    }
    if (this.remoteJams && !this.untrustedJams.has(state)) {
      try { await this.remoteJams.replaceAll(state.jams || []); } catch { /* soft */ }
    }
    return true;
  }
}

function usersSignature(users) {
  return (users || [])
    .map((u) => [
      u.id, u.username, u.displayName, u.passwordHash, u.passwordSalt,
      u.role, u.disabled ? 1 : 0, JSON.stringify(u.instruments || []),
    ].join(':'))
    .sort()
    .join('|');
}

function mergeJams(local, remote) {
  const byId = new Map();
  for (const j of remote || []) if (j?.id) byId.set(j.id, j);
  for (const j of local || []) if (j?.id) byId.set(j.id, j);
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export class Directory {
  constructor(backend) {
    this.backend = backend;
    this.liveVersion = 0;
    this.context = new AsyncLocalStorage();
  }

  ping() {
    return this.backend.ping();
  }

  current() {
    const ctx = this.context.getStore();
    if (!ctx) throw new Error('The directory was read outside of a request');
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

  touch() {
    this.current().dirty = true;
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
        return result;
      }
      await sleep(Math.min(250, 8 * 2 ** attempt) * (0.5 + Math.random()));
    }
    const busy = new Error('Accounts are busy right now — try that again');
    busy.status = 409;
    throw busy;
  }

  publicMeta() {
    const users = this.state.users || [];
    const active = users.filter((u) => !u.disabled);
    const jams = (this.state.jams || []).filter((j) => !j.archived);
    const legacy = (this.state.jams || []).find((j) => j.legacyNight && !j.archived);
    return {
      hasUsers: active.length > 0,
      needsHostSetup: !active.some((u) => u.role === 'admin'),
      // Host key is gone — first admin is always open when nobody can sign in.
      setupRequiresHostKey: false,
      jamCount: jams.length,
      // Lets the client migrate pre-multi-jam localStorage player tokens only
      // onto the jam that adopted the legacy night blob.
      legacyJamId: legacy?.id || null,
    };
  }

  publicJams() {
    return (this.state.jams || [])
      .filter((j) => !j.archived)
      .map(({ id, name, createdAt, createdBy }) => ({ id, name, createdAt, createdBy }));
  }

  isHost(token) {
    if (!token) return false;
    const session = (this.state.hostSessions || []).find((s) => s.token === token);
    if (!session) return false;
    const user = this.userById(session.userId);
    return Boolean(user && user.role === 'admin' && !user.disabled);
  }

  hostSession(token) {
    if (!token) return null;
    const session = (this.state.hostSessions || []).find((s) => s.token === token) || null;
    if (!session) return null;
    const user = this.userById(session.userId);
    if (!user || user.role !== 'admin' || user.disabled) return null;
    return session;
  }

  userByUsername(username) {
    const key = String(username || '').trim().toLowerCase();
    if (!key) return null;
    return (this.state.users || []).find((u) => u.username.toLowerCase() === key) || null;
  }

  userById(id) {
    return (this.state.users || []).find((u) => u.id === id) || null;
  }

  adminUsers() {
    return (this.state.users || []).filter((u) => u.role === 'admin' && !u.disabled);
  }

  hasAdmins() {
    return this.adminUsers().length > 0;
  }

  jamById(id) {
    return (this.state.jams || []).find((j) => j.id === id && !j.archived) || null;
  }

  /**
   * Whether the jam catalog from this load is trusted (successful remote read,
   * or no remote jam client). Empty + untrusted means "do not invent a legacy jam".
   */
  jamsCatalogTrusted() {
    if (typeof this.backend.jamsListTrusted === 'function') {
      return this.backend.jamsListTrusted(this.state);
    }
    return true;
  }
}

/**
 * Lift users / sessions out of a legacy single night blob into the directory,
 * and ensure at least one jam row exists for that night's data.
 */
export function liftLegacyNight(directoryState, nightState, { defaultName = 'Amplify Open Jam' } = {}) {
  const dir = migrateDirectory(directoryState);
  // Union tombstones so a legacy-deleted account cannot reappear after lift.
  dir.deletedUserIds = [...new Set([
    ...(dir.deletedUserIds || []),
    ...(Array.isArray(nightState?.deletedUserIds) ? nightState.deletedUserIds : []),
  ].map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 500);
  const deleted = new Set(dir.deletedUserIds);
  // Merge legacy accounts by id — keep directory records, skip tombstones and
  // username collisions (usernames are unique; a retained duplicate could
  // authenticate after the directory account is deleted).
  if (Array.isArray(nightState?.users) && nightState.users.length) {
    const byId = new Map((dir.users || []).map((u) => [u.id, u]));
    const takenNames = new Set(
      (dir.users || []).map((u) => String(u.username || '').trim().toLowerCase()).filter(Boolean),
    );
    for (const u of nightState.users) {
      if (!u?.id || deleted.has(u.id) || byId.has(u.id)) continue;
      const name = String(u.username || '').trim().toLowerCase();
      if (name && takenNames.has(name)) continue;
      byId.set(u.id, u);
      if (name) takenNames.add(name);
    }
    dir.users = [...byId.values()];
  }
  // Never import legacy host sessions — tokens may outlive demoted/disabled
  // admins. Require a fresh login; also drop any stale non-admin sessions.
  const adminIds = new Set(
    (dir.users || []).filter((u) => u.role === 'admin' && !u.disabled).map((u) => u.id),
  );
  dir.hostSessions = (dir.hostSessions || []).filter((s) => adminIds.has(s.userId));
  if ((dir.jams || []).length === 0) {
    dir.jams.push({
      id: newId('jam'),
      name: nightState?.jam?.name || defaultName,
      createdAt: nightState?.jam?.createdAt || Date.now(),
      createdBy: null,
      archived: false,
      // Only this jam may adopt the legacy single-blob night on first open.
      legacyNight: true,
    });
  }
  return dir;
}

export function openDirectory({ dataDir, env = process.env } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = env.KV_PREFIX || 'amplify';

  let backend;
  if (url && token) {
    backend = new KvDirectoryBackend(url, token, prefix);
  } else {
    const dir = dataDir || env.DATA_DIR || join(process.cwd(), 'data');
    backend = new FileDirectoryBackend(join(dir, 'directory.json'));
  }

  const remoteUsers = openSupabaseUsers(env);
  const remoteJams = openSupabaseJams(env);
  if (remoteUsers || remoteJams) {
    backend = new DirectorySyncedBackend(backend, remoteUsers, remoteJams);
  }

  return new Directory(backend);
}
