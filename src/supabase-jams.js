/**
 * Optional Supabase home for jam session metadata (name, org, archived).
 * Night blobs stay in Redis/files; this table is the catalog admins browse.
 */

import { supabaseConfig } from './supabase-users.js';

const TABLE = 'amplify_jams';

export function openSupabaseJams(env = process.env) {
  const cfg = supabaseConfig(env);
  return cfg ? new SupabaseJams(cfg) : null;
}

function rowFromJam(jam, orgId) {
  return {
    id: jam.id,
    org_id: orgId,
    name: jam.name,
    created_by: jam.createdBy || null,
    created_at: Number(jam.createdAt) || Date.now(),
    archived: Boolean(jam.archived),
  };
}

function jamFromRow(row) {
  if (!row?.id) return null;
  return {
    id: String(row.id),
    name: String(row.name || 'Amplify Open Jam').trim() || 'Amplify Open Jam',
    createdAt: Number(row.created_at) || Date.now(),
    createdBy: row.created_by || null,
    archived: Boolean(row.archived),
  };
}

export class SupabaseJams {
  constructor({ url, key, jamId }) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.orgId = jamId || 'amplify';
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
      signal: AbortSignal.timeout(5000),
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
      console.error(`Supabase jams ${method} ${path} failed:`, detail);
      const err = new Error('Jam catalog is unavailable');
      err.status = 503;
      throw err;
    }
    return data;
  }

  async list() {
    const rows = await this.request(
      `${TABLE}?org_id=eq.${encodeURIComponent(this.orgId)}&select=*&order=created_at.asc`,
    );
    // A malformed 200 must fail closed — [] would look authoritative and
    // the next replaceAll would delete remote jam rows.
    if (!Array.isArray(rows)) {
      const err = new Error('Jam catalog is unavailable');
      err.status = 503;
      throw err;
    }
    return rows.map(jamFromRow).filter(Boolean);
  }

  async replaceAll(jams) {
    const list = Array.isArray(jams) ? jams : [];
    const rows = list.map((j) => rowFromJam(j, this.orgId));

    if (rows.length === 0) {
      await this.request(
        `${TABLE}?org_id=eq.${encodeURIComponent(this.orgId)}`,
        { method: 'DELETE', prefer: 'return=minimal' },
      );
      return;
    }

    const ids = rows.map((r) => r.id);
    const inList = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
    await this.request(
      `${TABLE}?org_id=eq.${encodeURIComponent(this.orgId)}&id=not.in.(${inList})`,
      { method: 'DELETE', prefer: 'return=minimal' },
    );

    await this.request(TABLE, {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  /** Insert/update rows without deleting other remote jams. */
  async upsertAll(jams) {
    const rows = (Array.isArray(jams) ? jams : []).map((j) => rowFromJam(j, this.orgId));
    if (rows.length === 0) return;
    await this.request(TABLE, {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}
