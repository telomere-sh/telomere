import { createHash } from 'node:crypto';
let input = '', bytes = 0;
process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes > 131072) process.exit(2); input += chunk; });
process.stdin.on('end', () => {
  try {
    const task = JSON.parse(input); let result;
    if (task.kind === 'sha256' && typeof task.text === 'string' && Buffer.byteLength(task.text) <= 8192) {
      result = { sha256: createHash('sha256').update(task.text).digest('hex') };
    } else if (task.kind === 'hash_chain' && typeof task.text === 'string' && Buffer.byteLength(task.text) <= 8192
      && Number.isSafeInteger(task.iterations) && task.iterations >= 1 && task.iterations <= 2000000) {
      let hash = createHash('sha256').update(task.text).digest();
      for (let index = 1; index < task.iterations; index++) hash = createHash('sha256').update(hash).digest();
      result = { hash: hash.toString('hex'), iterations: task.iterations };
    } else if (task.kind === 'sort' && Array.isArray(task.numbers) && task.numbers.length <= 10000
      && task.numbers.every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000000)) {
      const values = [...task.numbers].sort((a,b) => a-b), json = JSON.stringify(values);
      result = Buffer.byteLength(json) <= 16000 ? { numbers: values } : { count: values.length, first: values.slice(0,20), last: values.slice(-20), sha256: createHash('sha256').update(json).digest('hex') };
    } else if (task.kind === 'primes' && Number.isSafeInteger(task.limit) && task.limit >= 2 && task.limit <= 2000000) {
      const composite = new Uint8Array(task.limit+1), values = [];
      for (let n=2;n<=task.limit;n++) if (!composite[n]) { values.push(n); for (let j=n*n;j<=task.limit;j+=n) composite[j]=1; }
      const json = JSON.stringify(values);
      result = Buffer.byteLength(json) <= 16000 ? { primes: values } : { limit: task.limit, count: values.length, first: values.slice(0,20), last: values.slice(-20), sha256: createHash('sha256').update(json).digest('hex') };
    } else throw new Error('Rejected task');
    const output = JSON.stringify(result); if (Buffer.byteLength(output) > 16384) throw new Error('Output limit'); process.stdout.write(output);
  } catch { process.stderr.write('TASK_REJECTED'); process.exitCode = 2; }
});
