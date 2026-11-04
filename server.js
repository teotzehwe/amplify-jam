#!/usr/bin/env node
/**
 * Local listener. `node server.js` and the jam is up — no install step, no
 * internet. On a serverless host `api/index.js` serves the same app instead.
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

import { handleRequest, directory } from './src/app.js';

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
  const { needsSetup, jamCount } = await directory.run(() => {
    if (directory.version === 0) directory.touch();
    return {
      needsSetup: !directory.hasAdmins(),
      jamCount: directory.publicJams().length,
    };
  });
  const host = lanAddress();
  console.log(`
  \u266a  Amplify

     Players sign up   http://${host}:${PORT}/
     Host console      http://${host}:${PORT}/host
     Stage display     http://${host}:${PORT}/board

     ${needsSetup
    ? 'Open the host console and create the first admin account.'
    : `Admins sign in on /host (${jamCount} jam session${jamCount === 1 ? '' : 's'}).`}
     No host key — accounts own the console; admins create jam sessions from there.
     Ready.
`);
});
