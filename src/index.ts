#!/usr/bin/env node
import { run } from './bridge';
import { setup } from './setup';

const command = process.argv[2];

if (command === 'setup') {
  await setup();
} else {
  await run();
}
