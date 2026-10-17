/** Fixed operator-owned program. Task data enters ONLY through stdin, never code/argv. */
export const TASK_PROGRAM = String.raw`
'use strict';
const { createHash } = require('node:crypto');
let input = '', bytes = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 131072) { process.stderr.write('INPUT_LIMIT'); process.exit(2); }
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const task = JSON.parse(input);
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw Error();
    let result;
    if (task.kind === 'sha256' && Object.keys(task).sort().join(',') === 'kind,text'
        && typeof task.text === 'string' && Buffer.byteLength(task.text) <= 8192) {
      result = { sha256: createHash('sha256').update(task.text).digest('hex') };
    } else if (task.kind === 'hash_chain' && Object.keys(task).sort().join(',') === 'iterations,kind,text'
        && typeof task.text === 'string' && Buffer.byteLength(task.text) <= 8192
        && Number.isSafeInteger(task.iterations) && task.iterations >= 1 && task.iterations <= 2000000) {
      let hash = createHash('sha256').update(task.text).digest();
      // Each subsequent iteration hashes the prior 32 digest bytes, not its hex representation.
      for (let iteration = 1; iteration < task.iterations; iteration++) hash = createHash('sha256').update(hash).digest();
      result = { hash: hash.toString('hex'), iterations: task.iterations };
    } else if (task.kind === 'sort' && Object.keys(task).sort().join(',') === 'kind,numbers'
        && Array.isArray(task.numbers) && task.numbers.length <= 10000
        && task.numbers.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1000000000)) {
      const sorted = task.numbers.slice().sort((a, b) => a - b), serialized = JSON.stringify(sorted);
      result = Buffer.byteLength(serialized) <= 16000 ? { numbers: sorted } : {
        count: sorted.length, first: sorted.slice(0, 20), last: sorted.slice(-20),
        sha256: createHash('sha256').update(serialized).digest('hex')
      };
    } else if (task.kind === 'primes' && Object.keys(task).sort().join(',') === 'kind,limit'
        && Number.isSafeInteger(task.limit) && task.limit >= 2 && task.limit <= 2000000) {
      const composite = new Uint8Array(task.limit + 1), primes = [];
      for (let n = 2; n <= task.limit; n++) {
        if (!composite[n]) { primes.push(n); for (let j = n * n; j <= task.limit; j += n) composite[j] = 1; }
      }
      const serialized = JSON.stringify(primes);
      result = Buffer.byteLength(serialized) <= 16000 ? { primes } : {
        limit: task.limit, count: primes.length, first: primes.slice(0, 20), last: primes.slice(-20),
        sha256: createHash('sha256').update(serialized).digest('hex')
      };
    } else { throw Error(); }
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 16384) throw Error();
    process.stdout.write(output);
  } catch { process.stderr.write('TASK_REJECTED'); process.exitCode = 2; }
});
process.stdin.on('error', () => { process.exitCode = 2; });
`;
