#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from './bridge.js';
import { setup } from './setup.js';

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
