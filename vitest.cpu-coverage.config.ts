import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// Explicit CPU financial/control-plane scope. This is not whole-repository or
// Solidity coverage, and no source lines/branches are annotated away.
export default mergeConfig(base, defineConfig({ test: {
  include: ['tests/contracts.test.ts', 'tests/service.test.ts', 'tests/worker.test.ts',
    'tests/workspace-auth.test.ts', 'tests/workspace-client.test.ts', 'tests/journal-archive.test.ts',
    'tests/chain-gateway.test.ts', 'tests/bridge-circle-usdc.test.ts', 'tests/postgres-admission.test.ts',
    'tests/escrow-stateful.test.ts'],
  coverage: { enabled: true, provider: 'v8',
    include: ['src/auth.ts', 'src/bridge.ts', 'src/service.ts', 'src/worker.ts', 'src/store.ts',
      'src/workspace/**/*.ts', 'src/chain/**/*.ts'],
    reporter: ['text-summary', 'json-summary', 'json', 'html'], reportsDirectory: 'coverage/cpu',
  },
} }));
