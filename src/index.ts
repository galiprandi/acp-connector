#!/usr/bin/env node

// Prefer IPv4 on DNS resolution — on hosts with broken/half-configured
// IPv6 the default order produces AggregateError storms against
// api.telegram.org and other endpoints.
import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';

setDefaultResultOrder('ipv4first');

import { run } from './bridge.js';
import { log } from './logger.js';
import { setup } from './setup.js';

// A long-lived bridge must never die on a stray rejected promise
// (e.g. a fire-and-forget Telegram API call during a network blip).
process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection (kept alive):', (err as Error)?.stack || err);
});

const command = process.argv[2];

if (command === 'setup') {
  await setup();
} else if (command === '-v' || command === '--version' || command === 'version') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  console.log(pkg.version);
} else {
  await run();
}
