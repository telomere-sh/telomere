import { lookup } from 'node:dns/promises';
import { request as requestHttp, type ClientRequest } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Problem } from '../../common.js';
import { incomeHashSchema, incomeUrlSchema } from './types.js';
import { incomeStrictJson } from './json.js';

const denied4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied4.addSubnet(address, prefix, 'ipv4');
const public6 = new BlockList(); public6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) denied6.addSubnet(address, prefix, 'ipv6');
/** Fail closed for special-use ranges, mapped IPv4, tunnels and non-global IPv6. */
export function isPublicIncomeEndpointAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied4.check(address, 'ipv4') : family === 6 && public6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
}
export type IncomeProbePolicy = { allowedOrigins: readonly string[]; localFixture: boolean; timeoutMs?: number };
export function assertIncomeEndpointUrl(raw: string, policy: IncomeProbePolicy): URL {
  const url = new URL(incomeUrlSchema.parse(raw)), loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (!policy.allowedOrigins.includes(url.origin) || url.protocol !== 'https:' && !(policy.localFixture && loopback && url.protocol === 'http:')) {
    throw new Problem(422, 'income_endpoint_blocked', 'The endpoint must use an exact reviewed origin.');
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicIncomeEndpointAddress(url.hostname.replace(/^\[|\]$/g, '')) && !(policy.localFixture && loopback)) {
    throw new Problem(422, 'income_endpoint_blocked', 'The endpoint address is not public.');
  }
  return url;
}
/** Explicit owner-triggered GET only. DNS answers are all checked; the connection uses only one checked address. */
export async function probeIncomeEndpoint(rawUrl: string, rawNonce: string, policy: IncomeProbePolicy): Promise<{ status: number; body: unknown; paymentRequired: unknown }> {
  const url = assertIncomeEndpointUrl(rawUrl, policy), nonce = incomeHashSchema.parse(rawNonce), timeout = policy.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 5000) throw new Error('Invalid income endpoint deadline');
  let request: ClientRequest | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = () => new Problem(503, 'income_endpoint_unavailable', 'The endpoint verification did not complete.');
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(unavailable()); request?.destroy(); }, timeout); });
  try {
    const host = url.hostname.replace(/^\[|\]$/g, ''), family = isIP(host);
    const answers = family ? [{ address: host, family }] : await Promise.race([lookup(host, { all: true, verbatim: true }), deadline]);
    const local = policy.localFixture && ['127.0.0.1', '::1'].includes(host);
    if (!answers.length || answers.length > 32 || answers.some(answer => !isPublicIncomeEndpointAddress(answer.address) && !local)) {
      throw new Problem(422, 'income_endpoint_blocked', 'The endpoint DNS addresses are not public.');
    }
    const selected = answers[0]; if (!selected) throw unavailable();
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
    };
    return await Promise.race([new Promise<{ status: number; body: unknown; paymentRequired: unknown }>((resolve, reject) => {
      const createRequest = url.protocol === 'https:' ? requestHttps : requestHttp;
      request = createRequest(url, { method: 'GET', agent: false, lookup: pinnedLookup, maxHeaderSize: 8192,
        ...(url.protocol === 'https:' ? { servername: host, rejectUnauthorized: true } : {}),
        headers: { Accept: 'application/json', 'X-Telomere-Verification-Nonce': nonce } }, response => {
        const invalid = () => new Problem(422, 'income_endpoint_response_invalid', 'The endpoint must return bounded UTF-8 JSON and one x402 offer.');
        let settled = false;
        const fail = (error: unknown) => { if (settled) return; settled = true; response.destroy(); reject(error); };
        const status = response.statusCode ?? 0;
        if (status !== 402 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity'
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers['content-type'] ?? '')) { fail(invalid()); return; }
        const lengths = response.rawHeaders.filter((_value, index) => index % 2 === 0).map(value => value.toLowerCase());
        if (lengths.filter(value => value === 'payment-required').length > 1 || lengths.filter(value => value === 'content-type').length !== 1) { fail(invalid()); return; }
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32768)) { fail(invalid()); return; }
        let size = response.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value), 0);
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { size += chunk.byteLength; if (size > 32768) { fail(invalid()); return; } chunks.push(chunk); });
        response.on('error', () => fail(unavailable())); response.on('aborted', () => fail(unavailable()));
        response.on('end', () => {
          if (settled) return;
          try {
            const body = incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            const header = response.headers['payment-required']; let paymentRequired: unknown;
            if (header !== undefined) {
              if (typeof header !== 'string' || header.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw invalid();
              paymentRequired = incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(header, 'base64')));
            }
            settled = true; resolve({ status, body, paymentRequired });
          } catch { fail(invalid()); }
        });
      });
      request.on('error', () => reject(unavailable())); request.end();
    }), deadline]);
  } finally { clearTimeout(timer); request?.destroy(); }
}
