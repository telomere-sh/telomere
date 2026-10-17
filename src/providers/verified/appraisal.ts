import { z } from 'zod';

const tcbStatusSchema = z.enum(['UpToDate', 'OutOfDate', 'ConfigurationNeeded', 'OutOfDateConfigurationNeeded',
  'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded', 'Revoked']);
const statusSchema = z.object({ status: tcbStatusSchema, advisory_ids: z.array(z.string().regex(/^INTEL-SA-\d{5}$/)).max(64) });
const verdictSchema = z.object({ status: tcbStatusSchema, advisory_ids: statusSchema.shape.advisory_ids,
  qe_status: statusSchema, platform_status: statusSchema });
export type NativeTcbStatus = z.infer<typeof statusSchema>;
export type NativeTcbDiagnostic = { strictTcbAccepted: boolean;
  classification: 'STRICT_TCB_ACCEPTED' | 'PLATFORM_TCB_OUT_OF_DATE' | 'TCB_STATUS_REJECTED' | 'ADVISORIES_PRESENT' | 'VERDICT_SCHEMA_INVALID';
  nativeTcb?: { overall: NativeTcbStatus; qe: NativeTcbStatus; platform: NativeTcbStatus }; };

/** Safe metadata from an already cryptographically verified native verdict. This diagnostic never authorizes a provider session. */
export function classifyNativeTcb(raw: unknown): NativeTcbDiagnostic {
  const result = verdictSchema.safeParse(raw);
  if (!result.success) return { strictTcbAccepted: false, classification: 'VERDICT_SCHEMA_INVALID' };
  const data = result.data, nativeTcb = { overall: { status: data.status, advisory_ids: data.advisory_ids }, qe: data.qe_status, platform: data.platform_status };
  const statuses = Object.values(nativeTcb);
  const accepted = statuses.every(item => item.status === 'UpToDate' && item.advisory_ids.length === 0);
  const classification = accepted ? 'STRICT_TCB_ACCEPTED' : ['OutOfDate', 'OutOfDateConfigurationNeeded'].includes(nativeTcb.platform.status)
    ? 'PLATFORM_TCB_OUT_OF_DATE' : statuses.some(item => item.status !== 'UpToDate') ? 'TCB_STATUS_REJECTED' : 'ADVISORIES_PRESENT';
  return { strictTcbAccepted: accepted, classification, nativeTcb };
}
