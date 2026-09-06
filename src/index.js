#!/usr/bin/env node
import { run } from './bridge.js';
import { setup } from './setup.js';

const command = process.argv[2];

if (command === 'setup') {
  await setup();
} else {
  await run();
}
