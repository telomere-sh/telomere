import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: "/opt/telomere-host-runtime/backend-completion-corrected-20261015-9d9a5993f9d8/.local/vite-cache", test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000, fileParallelism: false } });
