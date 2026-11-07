/**
 * Serverless entry point (Vercel).
 *
 * Every /api/* request lands here and is handed to the same application the
 * local `node server.js` runs. A catch-all keeps the original path intact —
 * a single /api function would collapse /api/state and /api/join onto one
 * route — and the path is rebuilt from the segments so routing does not
 * depend on how the platform happens to fill in req.url.
 */

import { handleRequest } from '../src/app.js';

function hasKvStore(env = process.env) {
  return Boolean(
    (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL)
    && (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN),
  );
}

export default async function handler(req, res) {
  const segments = req.query?.path;
  if (segments) {
    const rest = Array.isArray(segments) ? segments.join('/') : segments;
    const queryAt = req.url.indexOf('?');
    req.url = `/api/${rest}${queryAt === -1 ? '' : req.url.slice(queryAt)}`;
  }

  // Do not touch the request-scoped `store` proxy here — jam context is only
  // bound inside handleRequest. Check Redis env directly instead: without it
  // every Vercel instance would keep its own night file.
  // /api/health is exempt so operators still get storeOk/hasKv diagnostics.
  const pathOnly = String(req.url || '').split('?')[0];
  if (!hasKvStore() && pathOnly !== '/api/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 503;
    return res.end(JSON.stringify({
      error: 'No key-value store configured. Add a Redis integration and set KV_REST_API_URL and KV_REST_API_TOKEN, then redeploy.',
    }));
  }

  return handleRequest(req, res);
}
