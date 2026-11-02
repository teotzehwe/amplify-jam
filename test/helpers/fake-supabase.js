/**
 * Stand-in for Supabase PostgREST on the amplify_accounts table.
 * Enough of the REST surface for UsersSyncedBackend to exercise seed,
 * list, upsert, and delete-missing without a real project.
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';

export function startFakeSupabase() {
  /** @type {Map<string, object>} key = jam_id + '\\0' + id */
  const rows = new Map();

  function keyOf(jamId, id) {
    return `${jamId}\0${id}`;
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString() || '';
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'invalid json' }));
      }
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/rest/v1/amplify_accounts')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'not found' }));
    }

    const jamEq = url.searchParams.get('jam_id');
    const jamId = jamEq?.startsWith('eq.') ? jamEq.slice(3) : null;
    const select = url.searchParams.get('select');
    const idNotIn = url.searchParams.get('id');
    const limit = url.searchParams.get('limit');

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload == null ? '' : JSON.stringify(payload));
    };

    if (req.method === 'GET') {
      let list = [...rows.values()];
      if (jamId) list = list.filter((r) => r.jam_id === jamId);
      list.sort((a, b) => a.created_at - b.created_at);
      if (limit) list = list.slice(0, Number(limit) || 1);
      if (select === 'id') list = list.map((r) => ({ id: r.id }));
      return json(200, list);
    }

    if (req.method === 'POST') {
      const batch = Array.isArray(body) ? body : [body];
      for (const row of batch) {
        rows.set(keyOf(row.jam_id, row.id), { ...row });
      }
      return json(201, null);
    }

    if (req.method === 'DELETE') {
      if (!jamId) return json(400, { message: 'jam_id required' });
      if (idNotIn?.startsWith('not.in.')) {
        const inner = idNotIn.slice('not.in.'.length);
        // ( "a","b" ) or (a,b)
        const keep = new Set(
          inner
            .replace(/^\(/, '')
            .replace(/\)$/, '')
            .split(',')
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .filter(Boolean),
        );
        for (const [k, row] of rows) {
          if (row.jam_id === jamId && !keep.has(row.id)) rows.delete(k);
        }
        return json(204, null);
      }
      // Delete all for jam
      for (const [k, row] of rows) {
        if (row.jam_id === jamId) rows.delete(k);
      }
      return json(204, null);
    }

    return json(405, { message: 'method not allowed' });
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      key: 'test-service-role',
      rows,
      listJam(jamId) {
        return [...rows.values()].filter((r) => r.jam_id === jamId);
      },
    }));
  });
}
