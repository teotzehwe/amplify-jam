/**
 * The Vercel catch-all must not touch the request-scoped `store` proxy
 * before jam context is bound — that threw on every /api/state in production.
 */

import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KV_KEYS = [
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL',
];

// Bind DATA_DIR before importing the app module (directory opens at import).
const dataDir = await mkdtemp(join(tmpdir(), 'amplify-vercel-entry-'));
process.env.DATA_DIR = dataDir;
for (const k of KV_KEYS) delete process.env[k];

const { default: handler } = await import('../api/[...path].js');

let savedEnv;

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = typeof b === 'string' ? b : String(b ?? ''); return this; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(KV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of KV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('vercel entry returns 503 without Redis for normal API paths', async () => {
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/state', headers: {}, query: { path: 'state' } }, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /No key-value store configured/);
});

test('vercel entry lets /api/health through without Redis', async () => {
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/health', headers: {}, query: { path: 'health' } }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.hasKv, false);
  assert.equal(Object.hasOwn(body, 'storeOk'), true);
  assert.doesNotMatch(res.body, /No key-value store configured/);
});

test('vercel entry does not emit missing-store 503 when Redis env is set', async () => {
  process.env.KV_REST_API_URL = 'https://example.invalid';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/health', headers: {}, query: { path: 'health' } }, res);
  assert.doesNotMatch(res.body, /No key-value store configured/);
  const body = JSON.parse(res.body);
  assert.equal(body.hasKv, true);
});
