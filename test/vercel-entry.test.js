/**
 * The Vercel catch-all must not touch the request-scoped `store` proxy
 * before jam context is bound — that threw on every /api/state in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('vercel entry does not read store.realtime outside jam context', async () => {
  const src = await readFile(join(ROOT, 'api/[...path].js'), 'utf8');
  assert.equal(
    /store\.realtime/.test(src),
    false,
    'api/[...path].js must not access store.realtime (no jam AsyncLocalStorage yet)',
  );
  assert.match(src, /KV_REST_API_URL|UPSTASH_REDIS_REST_URL/,
    'missing-KV gate should check env directly');
});
