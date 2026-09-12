#!/usr/bin/env node
/**
 * Local listener. `node server.js` and the jam is up — no install step, no
 * internet. On a serverless host `api/index.js` serves the same app instead.
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { handleRequest, store } from './src/app.js';

const PORT = Number(process.env.PORT) || 3000;

/** The address other people on the venue wifi should type. */
function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

const server = createServer(handleRequest);

server.listen(PORT, async () => {
  const { key, name } = await store.run(() => {
    // Nothing stored yet: persist now so the host key survives a restart.
    if (store.version === 0) store.touch();
    return { key: store.state.hostToken, name: store.state.jam.name };
  });
  const host = lanAddress();
  console.log(`
  \u266a  Amplify \u2014 ${name}

     Players sign up   http://${host}:${PORT}/
     Host console      http://${host}:${PORT}/host?k=${key}
     Stage display     http://${host}:${PORT}/board

     Host key: ${key}
     Share the sign-up link; keep the host link to yourself.
`);
});
