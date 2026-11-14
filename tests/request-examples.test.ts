import { createServer, type IncomingHttpHeaders } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRequestExamples, type RequestExampleContext } from '../src/updates/request-examples.js';

const base: RequestExampleContext = {serverOrigin: 'https://my-telomere.com', leashId: '0x' + 'ab'.repeat(32), taskText: 'hello', maxSeconds: 10, idempotencyKey: 'quote_test_123'};
const session = 'a'.repeat(64);
const python = process.platform === 'win32' ? 'python' : 'python3';
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
function run(command: string, args: string[], cwd: string, token = session): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env: {...process.env, TELOMERE_SESSION: token}, windowsHide: true});
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { error += String(chunk); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Snippet timed out')); }, 10_000);
    child.on('error', problem => { clearTimeout(timeout); reject(problem); });
    child.on('close', code => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error(`Snippet exited ${code}: ${error}`)); });
  });
}

describe('Legacy quote request examples', () => {
  it.each([
    {serverOrigin: 'https://example.com'}, {serverOrigin: 'https://my-telomere.com.evil.test'},
    {serverOrigin: 'http://my-telomere.com'}, {serverOrigin: 'https://my-telomere.com:443'},
    {serverOrigin: 'https://user@my-telomere.com'}, {serverOrigin: 'https://my-telomere.com/api'},
    {serverOrigin: 'http://127.1'}, {serverOrigin: 'https://my-telomere.com?x=1'},
    {leashId: '0x1234'}, {maxSeconds: 0}, {maxSeconds: 121}, {maxSeconds: 1.5},
    {runtimeMaxSeconds: 121}, {runtimeMaxSeconds: 0}, {runtimeMaxSeconds: 5, maxSeconds: 6},
    {idempotencyKey: 'short'}, {idempotencyKey: 'quote\nInjected: x'},
    {taskText: '😀'.repeat(2049)}, {taskText: '\ud800'},
  ])('rejects invalid or untrusted context %j', change => {
    expect(() => buildRequestExamples({...base, ...change})).toThrow();
  });

  it('accepts exact UTF-8 limits and loopback configuration without changing task data', () => {
    const result = buildRequestExamples({...base, serverOrigin: 'http://[::1]:9876', taskText: '😀'.repeat(2048), runtimeMaxSeconds: 3, maxSeconds: 3});
    expect(JSON.parse(result.bodyJson)).toEqual({...result.body});
    expect(result.body.task.text).toBe('😀'.repeat(2048));
    expect(result.body.maxSeconds).toBe(3);
    expect(result.curl).toContain('/api/quotes');
  });

  it('runs Node, Python and POSIX curl against a disposable server with identical JSON and required headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-examples-'));
    const requests: {url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: unknown}[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({url: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown});
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end('{"fixture":true}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    const hostile = "'; touch injected-marker; #\n$(touch injected-marker)\n`touch injected-marker`\n\"\\ 😀\r\t\u0000\u2028";
    try {
      const result = buildRequestExamples({...base, serverOrigin: origin, taskText: hostile});
      await writeFile(join(directory, 'quote.mjs'), result.typescript);
      await writeFile(join(directory, 'quote.ts'), result.typescript);
      await writeFile(join(directory, 'quote.py'), result.python);
      await writeFile(join(directory, 'quote.sh'), result.curl);
      await run(process.execPath, ['--check', 'quote.mjs'], directory);
      await run(process.execPath, ['--experimental-strip-types', '--check', 'quote.ts'], directory);
      await run(python, ['-m', 'py_compile', 'quote.py'], directory);
      expect(await run(process.execPath, ['quote.mjs'], directory)).toContain('fixture');
      expect(await run(python, ['quote.py'], directory)).toContain('fixture');
      if (existsSync(shell)) {
        expect(await run(shell, ['quote.sh'], directory)).toContain('fixture');
      }
      expect(requests).toHaveLength(existsSync(shell) ? 3 : 2);
      for (const request of requests) {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/api/quotes');
        expect(request.body).toEqual(result.body);
        expect(request.headers['origin']).toBe(origin);
        expect(request.headers['content-type']).toBe('application/json');
        expect(request.headers['idempotency-key']).toBe(base.idempotencyKey);
        expect(request.headers['cookie']).toBe('telomere_session=' + session);
      }
      await expect(access(join(directory, 'injected-marker'))).rejects.toThrow();
      await expect(run(process.execPath, ['quote.mjs'], directory, 'bad\r\nheader')).rejects.toThrow();
      await expect(run(python, ['quote.py'], directory, 'bad\r\nheader')).rejects.toThrow();
      if (existsSync(shell)) await expect(run(shell, ['quote.sh'], directory, 'bad\r\nheader')).rejects.toThrow();
      expect(requests).toHaveLength(existsSync(shell) ? 3 : 2);
      expect(await readFile(join(directory, 'quote.mjs'), 'utf8')).not.toContain(session);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, {recursive: true, force: true});
    }
  }, 30_000);
});
