import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
it('exercises public Selection preparation and rollback only in filesystem fixtures', () => {
  const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'tests/selection_public_ops_test.py'], { encoding: 'utf8', timeout: 20000 });
  expect(result).toContain('"transactionsSent": 0');
});
