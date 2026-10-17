import { describe, expect, it } from 'vitest';
import { canonical, secretHash } from '../src/common.js';
import { checkedSessionCommand, checkedSessionEvents } from '../src/platform-runtime/session-client.js';

describe('paid session SDK response checks', () => {
  it('rejects a missing event even when a page claims a larger event count', () => {
    const page = { events: [{ sequence: 0, kind: 'ready' }], nextSequence: 0, eventCount: 2, state: 'stopped' };
    expect(() => checkedSessionEvents(page, -1, 8)).toThrow('changed sequence');
    expect(checkedSessionEvents({ ...page, eventCount: 1 }, -1, 8).events).toHaveLength(1);
  });

  it('checks the returned command input hash as well as the echoed argv', () => {
    const command = { commandId: 'once', argv: ['node', '-e', 'process.exit(0)'] };
    const result = { command, inputHash: secretHash(canonical(command)), state: 'completed', stdout: '', stderr: '',
      exitCode: 0, reason: 'exited', outputBytes: 0 };
    expect(checkedSessionCommand(result, command)).toEqual(result);
    expect(() => checkedSessionCommand({ ...result, inputHash: '0'.repeat(64) }, command)).toThrow('response changed');
  });
});
