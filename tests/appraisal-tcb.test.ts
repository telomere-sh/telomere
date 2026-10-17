import { describe, expect, it } from 'vitest';
import { classifyNativeTcb } from '../src/providers/verified/appraisal.js';

const current = () => ({ status: 'UpToDate', advisory_ids: [], qe_status: { status: 'UpToDate', advisory_ids: [] },
  platform_status: { status: 'UpToDate', advisory_ids: [] } });
describe('captured native TCB diagnostics without admission changes', () => {
  it('classifies the actual Gateway verdict as outdated platform, not a schema error', () => {
    const advisories = ['INTEL-SA-01192', 'INTEL-SA-01245', 'INTEL-SA-01312', 'INTEL-SA-01313'];
    expect(classifyNativeTcb({ ...current(), status: 'OutOfDate', advisory_ids: advisories,
      platform_status: { status: 'OutOfDate', advisory_ids: advisories } })).toMatchObject({ strictTcbAccepted: false,
      classification: 'PLATFORM_TCB_OUT_OF_DATE', nativeTcb: { qe: { status: 'UpToDate', advisory_ids: [] }, platform: { status: 'OutOfDate', advisory_ids: advisories } } });
  });
  it('requires all three scopes UpToDate with empty advisory lists', () => {
    expect(classifyNativeTcb(current())).toMatchObject({ strictTcbAccepted: true, classification: 'STRICT_TCB_ACCEPTED' });
    expect(classifyNativeTcb({ ...current(), qe_status: { status: 'Revoked', advisory_ids: [] } })).toMatchObject({ strictTcbAccepted: false, classification: 'TCB_STATUS_REJECTED' });
    expect(classifyNativeTcb({ ...current(), advisory_ids: ['INTEL-SA-01313'] })).toMatchObject({ strictTcbAccepted: false, classification: 'ADVISORIES_PRESENT' });
  });
  it.each([undefined, null, 'UpToDate', { ...current(), qe_status: 'UpToDate' }, { ...current(), platform_status: { status: 'UpToDate' } },
    { ...current(), status: 'private-error-canary' }, { ...current(), advisory_ids: ['private-key-canary'] }])
    ('rejects malformed or missing native fields without echoing raw details', raw => {
      expect(classifyNativeTcb(raw)).toEqual({ strictTcbAccepted: false, classification: 'VERDICT_SCHEMA_INVALID' });
    });
  it('does not expose quote/report payload fields in a successful diagnostic', () => {
    const result = classifyNativeTcb({ ...current(), report: { secret: 'private-report-canary' }, ppid: 'private-platform-id' });
    expect(JSON.stringify(result)).not.toContain('private-'); expect(result).not.toHaveProperty('liveAdmission');
  });
});
