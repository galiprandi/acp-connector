import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.js'],
    },
  },
});
