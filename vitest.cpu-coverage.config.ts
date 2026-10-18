import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// Explicit CPU financial/control-plane scope. This is not whole-repository or
// Solidity coverage, and no source lines/branches are annotated away.
// Execute the complete portable suite inherited from base; measure only the
// declared source scope, including matched files not reached by a test.
export default mergeConfig(base, defineConfig({ test: {
  coverage: { enabled: true, provider: 'v8',
    include: ['src/auth.ts', 'src/bridge.ts', 'src/service.ts', 'src/worker.ts', 'src/store.ts',
      'src/workspace/**/*.ts', 'src/chain/**/*.ts'],
    reporter: ['text-summary', 'json-summary', 'json', 'html'], reportsDirectory: 'coverage/cpu',
  },
} }));
