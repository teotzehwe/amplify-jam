/**
 * Optional Supabase home for registered jam accounts.
 *
 * Night state (songs, roster, lineup) still lives in jam.json / Redis. When
 * SUPABASE_URL and a service-role key are set, account rows are dual-written
 * here so a Redis wipe or night clear does not erase who can sign in.
 *
 * Speaks PostgREST over fetch — same zero-dependency style as the Redis
 * backend. No @supabase/supabase-js package.
 */

const TABLE = 'amplify_accounts';

/** True when both URL and a server key are present. */
export function supabaseUsersConfigured(env = process.env) {
  return Boolean(supabaseConfig(env));
}

export function supabaseConfig(env = process.env) {
  const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '';
  if (!url || !key) return null;
  const jamId = env.SUPABASE_JAM_ID || env.KV_PREFIX || 'amplify';
  return { url, key, jamId };
}

/**
 * @returns {SupabaseUsers | null}
 */
export function openSupabaseUsers(env = process.env) {
  const cfg = supabaseConfig(env);
  return cfg ? new SupabaseUsers(cfg) : null;
}

function rowFromUser(user, jamId) {
  return {
    id: user.id,
    jam_id: jamId,
    username: user.username,
    display_name: user.displayName || user.username,
    password_hash: user.passwordHash,
    password_salt: user.passwordSalt,
    instruments: Array.isArray(user.instruments) ? user.instruments : [],
    role: user.role === 'admin' ? 'admin' : 'player',
    disabled: Boolean(user.disabled),
    created_at: Number(user.createdAt) || Date.now(),
  };
}

function userFromRow(row) {
  if (!row || !row.id || !row.username || !row.password_hash || !row.password_salt) return null;
  return {
    id: String(row.id),
    username: String(row.username).trim(),
    displayName: String(row.display_name || row.username).trim(),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    instruments: Array.isArray(row.instruments) ? row.instruments : [],
    role: row.role === 'admin' ? 'admin' : 'player',
    disabled: Boolean(row.disabled),
    createdAt: Number(row.created_at) || Date.now(),
  };
}

export class SupabaseUsers {
  constructor({ url, key, jamId }) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.jamId = jamId || 'amplify';
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      authorization: `Bearer ${this.key}`,
      'content-type': 'application/json',
      ...extra,
    };
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: this.headers(prefer ? { prefer } : {}),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = typeof data === 'object' && data && (data.message || data.error || data.hint)
        ? (data.message || data.error || data.hint)
        : text || res.status;
      const err = new Error(`Supabase accounts rejected ${method} ${path}: ${detail}`);
      err.status = 503;
      throw err;
    }
    return data;
  }

  /** Cheap liveness: select zero rows for this jam. */
  async ping() {
    await this.request(
      `${TABLE}?jam_id=eq.${encodeURIComponent(this.jamId)}&select=id&limit=1`,
    );
    return true;
  }

  async list() {
    const rows = await this.request(
      `${TABLE}?jam_id=eq.${encodeURIComponent(this.jamId)}&select=*&order=created_at.asc`,
    );
    if (!Array.isArray(rows)) return [];
    return rows.map(userFromRow).filter(Boolean);
  }

  /**
   * Make the remote table match `users` exactly for this jam.
   * Upserts every row, then deletes ids that are no longer present.
   */
  async replaceAll(users) {
    const list = Array.isArray(users) ? users : [];
    const rows = list.map((u) => rowFromUser(u, this.jamId));

    if (rows.length > 0) {
      await this.request(TABLE, {
        method: 'POST',
        body: rows,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }

    if (rows.length === 0) {
      await this.request(
        `${TABLE}?jam_id=eq.${encodeURIComponent(this.jamId)}`,
        { method: 'DELETE', prefer: 'return=minimal' },
      );
      return;
    }

    const ids = rows.map((r) => r.id);
    // PostgREST in=(a,b) — quote each id.
    const inList = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
    await this.request(
      `${TABLE}?jam_id=eq.${encodeURIComponent(this.jamId)}&id=not.in.(${inList})`,
      { method: 'DELETE', prefer: 'return=minimal' },
    );
  }
}

/**
 * Merge local (CAS night blob) and remote (Supabase) account lists.
 * Local rows win on id collision — they rode the compare-and-set that just
 * committed. Remote-only rows are kept so a Redis wipe recovery is not lost
 * when another instance still has a stale empty blob.
 */
export function mergeUsers(localUsers, remoteUsers) {
  const byId = new Map();
  for (const u of remoteUsers || []) {
    if (u?.id) byId.set(u.id, u);
  }
  for (const u of localUsers || []) {
    if (u?.id) byId.set(u.id, u);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Wraps file/KV backends: accounts load/save through Supabase while the rest
 * of the night keeps its existing backend.
 */
export class UsersSyncedBackend {
  constructor(inner, remote) {
    this.inner = inner;
    this.remote = remote;
  }

  get realtime() {
    return this.inner.realtime;
  }

  async ping() {
    const ok = await this.inner.ping();
    if (!ok) return false;
    return this.remote.ping();
  }

  async load() {
    const { state, version } = await this.inner.load();
    let remoteUsers = [];
    try {
      remoteUsers = await this.remote.list();
    } catch (err) {
      // Night can still run from the blob if Supabase is briefly down; sign-in
      // keeps working against whatever the blob last held.
      if (!Array.isArray(state.users)) state.users = [];
      return { state, version };
    }

    const localUsers = Array.isArray(state.users) ? state.users : [];
    if (remoteUsers.length === 0 && localUsers.length > 0) {
      // First connect (or empty project): seed Supabase from the night blob.
      await this.remote.replaceAll(localUsers);
      state.users = localUsers;
      return { state, version };
    }

    const merged = mergeUsers(localUsers, remoteUsers);
    state.users = merged;

    // Heal a prior save where Redis CAS landed but the Supabase push failed.
    if (usersSignature(merged) !== usersSignature(remoteUsers)) {
      try {
        await this.remote.replaceAll(merged);
      } catch {
        // Leave merged in memory for this request; next save retries.
      }
    }
    return { state, version };
  }

  async save(state, expectedVersion) {
    const ok = await this.inner.save(state, expectedVersion);
    if (!ok) return false;
    // Retry a couple of times — night is already committed; healing on the
    // next load covers a hard failure, but succeeding here avoids a window.
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        await this.remote.replaceAll(state.users || []);
        return true;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
    throw lastErr;
  }
}

function usersSignature(users) {
  return (users || [])
    .map((u) => [
      u.id,
      u.username,
      u.displayName,
      u.passwordHash,
      u.passwordSalt,
      u.role,
      u.disabled ? 1 : 0,
      JSON.stringify(u.instruments || []),
    ].join(':'))
    .sort()
    .join('|');
}
