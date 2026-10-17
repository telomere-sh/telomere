import { readFile, writeFile } from 'node:fs/promises';
import { Ed25519Identity, HostKitClient, HostMeterVerifier, verifyHostMessage } from '../../dist/src/host-kit/index.js';
import { randomId } from '../../dist/src/common.js';
const control = new Ed25519Identity(await readFile(process.env.HOST_KIT_CONTROL_PEM, 'utf8'));
const client = new HostKitClient(process.env.HOST_KIT_URL ?? 'http://127.0.0.1:13290', process.env.HOST_KIT_HOST_KEY, control);
const issuedAt = Date.now();
const body = { version: 1, hostKey: client.hostKey, runId: randomId(), owner: '0x1111111111111111111111111111111111111111',
  image: process.env.HOST_KIT_ACCEPTANCE_IMAGE, argv: ['/usr/local/bin/node', '-e', 'setTimeout(()=>process.stdout.write("hostkit-gvisor-acceptance"),14000)'],
  issuedAt, expiresAt: issuedAt + 30000, maxSeconds: 30, nonce: randomId() };
const lease = control.sign('lease', body), meter = new HostMeterVerifier(body, control); let state = await client.admit(lease), sequence = 0;
try {
  for (;;) {
    for (const tick of state.ticks.slice(sequence)) { state = await client.command(lease, 'ack', meter.accept(tick)); sequence++; }
    if (!['starting','running'].includes(state.state)) break;
    if (Date.now() > issuedAt + 35000) throw new Error('Host acceptance exceeded its bounded deadline');
    await new Promise(resolve => setTimeout(resolve,250)); state = await client.command(lease,'status');
  }
  if (state.state !== 'completed' || !state.cleanupConfirmed || state.output !== 'hostkit-gvisor-acceptance' || state.isolation !== 'gvisor'
    || state.billableSeconds !== meter.billableSeconds || state.billableSeconds < 3 || state.billableSeconds > 14
    || !state.acks.every(ack => verifyHostMessage(control.publicKey,'ack',ack))) throw new Error('Host acceptance evidence is incomplete');
  const report = { status: 'passed', observedAt: new Date().toISOString(), isolation: state.isolation, runId: body.runId,
    image: body.image, ticks: state.ticks.length, acknowledgements: state.acks.length, billableSeconds: meter.billableSeconds,
    outputMatched: true, privateKeysIncluded: false, publicTransactions: 0, paidProviderRequests: 0 };
  if (process.env.HOST_KIT_REPORT_FILE) await writeFile(process.env.HOST_KIT_REPORT_FILE, JSON.stringify(report,null,2)+'\n', {mode:0o600});
  process.stdout.write(JSON.stringify(report)+'\n');
} catch(error) { try { await client.command(lease,'stop'); } catch {} throw error; }
