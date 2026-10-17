import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: '.local/vite-cache', test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000, fileParallelism: false, pool: 'forks', maxWorkers: 1, isolate: true } });
