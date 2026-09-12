/**
 * Serverless entry point (Vercel).
 *
 * Every /api/* request lands here and is handed to the same application the
 * local `node server.js` runs. A catch-all keeps the original path intact —
 * a single /api function would collapse /api/state and /api/join onto one
 * route — and the path is rebuilt from the segments so routing does not
 * depend on how the platform happens to fill in req.url.
 */

import { handleRequest, store } from '../src/app.js';

export default async function handler(req, res) {
  const segments = req.query?.path;
  if (segments) {
    const rest = Array.isArray(segments) ? segments.join('/') : segments;
    const queryAt = req.url.indexOf('?');
    req.url = `/api/${rest}${queryAt === -1 ? '' : req.url.slice(queryAt)}`;
  }

  // The file backend is the one that reports 'sse'. Reaching it here means the
  // deploy has no key-value store, so every instance would keep its own copy of
  // the night and musicians would see different jams. Say so plainly rather
  // than failing in a way that looks like a bug in the app.
  if (store.realtime === 'sse') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 503;
    return res.end(JSON.stringify({
      error: 'No key-value store configured. Add a Redis integration and set KV_REST_API_URL and KV_REST_API_TOKEN, then redeploy.',
    }));
  }

  return handleRequest(req, res);
}
