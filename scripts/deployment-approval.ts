import { keccak256, stringToHex, type Hex } from 'viem';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('Deployment plan contains a non-JSON value');
}

/** The digest covers every plan field, including roles, asset pins, reference and exact creation bytes. */
export function legacyDeploymentPlanDigest(plan: Record<string, unknown>): Hex {
  const { reviewDigest: _storedDigest, ...content } = plan;
  return keccak256(stringToHex(canonicalJson(content)));
}
