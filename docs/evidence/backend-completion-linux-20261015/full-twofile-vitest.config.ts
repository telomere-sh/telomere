import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: "/opt/telomere-host-runtime/full-twofile-corrected-20261015-3ed17e69fc55/.local/vite-cache", test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000, fileParallelism: false } });
