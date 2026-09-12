/**
 * A stand-in that speaks the same REST protocol as Upstash/Vercel Redis — a
 * POSTed command array in, `{ result }` out, including the EVAL used for
 * compare-and-set. No network, no account, but the code path exercised is the
 * one that runs on Vercel.
 *
 * Shared by the tests that need a hosted backend, so there is one
 * implementation of the protocol rather than two that can drift apart.
 */

import { createServer } from 'node:http';

export function startFakeRedis() {
  const data = new Map();
  let delayNextWrite = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const args = JSON.parse(Buffer.concat(chunks).toString() || '[]');
    const [cmd, ...rest] = args;

    // Latency belongs on the wire, not inside the command. Redis runs a Lua
    // script atomically, so nothing can slip between the compare and the write.
    if (delayNextWrite) await new Promise((r) => setTimeout(r, delayNextWrite));

    let result = null;
    if (cmd === 'GET') {
      result = data.has(rest[0]) ? data.get(rest[0]) : null;
    } else if (cmd === 'MGET') {
      // Atomic in real Redis, so it is atomic here: one snapshot, both keys.
      result = rest.map((k) => (data.has(k) ? data.get(k) : null));
    } else if (cmd === 'SET') {
      data.set(rest[0], rest[1]);
      result = 'OK';
    } else if (cmd === 'EVAL') {
      // EVAL <script> 2 stateKey versionKey expected state nextVersion
      const [, , stateKey, versionKey, expected, nextState, nextVersion] = rest;
      const current = data.has(versionKey) ? data.get(versionKey) : false;
      const matches = current === expected || (current === false && expected === '0');
      if (matches) {
        data.set(stateKey, nextState);
        data.set(versionKey, nextVersion);
        result = 1;
      } else {
        result = 0;
      }
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `unsupported command ${cmd}` }));
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      data,
      setWriteDelay: (ms) => { delayNextWrite = ms; },
    }));
  });
}
