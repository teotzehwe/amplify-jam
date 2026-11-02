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
  const { key, name, needsSetup } = await store.run(() => {
    // Nothing stored yet: persist now so the night survives a restart.
    if (store.version === 0) store.touch();
    return {
      key: store.state.hostToken,
      name: store.state.jam.name,
      needsSetup: !store.hasAdmins(),
    };
  });
  const host = lanAddress();
  console.log(`
  \u266a  Amplify \u2014 ${name}

     Players sign up   http://${host}:${PORT}/
     Host console      http://${host}:${PORT}/host
     Stage display     http://${host}:${PORT}/board

     ${needsSetup
    ? 'Open the host console and create the first admin account.'
    : 'Admins sign in on /host with their username and password.'}
     Share the sign-up link with the room; keep the host console to yourself.
     Host key: ${key}
`);
});
