import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { openStore } from '../src/store.js';
import { loadWebsite, type Website } from '../src/website.js';

const execFileAsync = promisify(execFile);
const index = '<!doctype html><html><head><script>window.homeReady = true;</script></head><body>original landing</body></html>\r\n';
const fallback = '<!doctype html><html><head><script>window.pageReady = true;</script></head><body>route shell</body></html>\n';
const request = (path: string, init?: RequestInit) => new Request('http://website.test' + path, init);

describe('unchanged website deployment boundary', () => {
  let root: string, site: string, publicRoot: string, website: Website;
  let store: Awaited<ReturnType<typeof openStore>>;
  let app: ReturnType<typeof createApp>, legacy: ReturnType<typeof createApp>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-website-'));
    site = join(root, 'website', 'dist'); publicRoot = join(root, 'public');
    await mkdir(join(site, 'assets'), { recursive: true }); await mkdir(join(site, 'protocol'), { recursive: true });
    await mkdir(publicRoot);
    await Promise.all([
      writeFile(join(site, 'index.html'), index), writeFile(join(site, 'page.html'), fallback),
      writeFile(join(site, 'protocol', 'index.html'), '<!doctype html><html>protocol entry</html>'),
      writeFile(join(site, 'assets', 'film.mp4'), Buffer.from('0123456789')),
      writeFile(join(site, 'site.js'), 'export const unchanged = true;\r\n'),
      writeFile(join(publicRoot, 'index.html'), '<!doctype html><html>backend console</html>'),
      writeFile(join(publicRoot, 'styles.css'), 'body{color:black}'), writeFile(join(publicRoot, 'app.js'), 'export {};'),
    ]);
    website = await loadWebsite(site);
    const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:',
      SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, DEMO_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
      ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666', TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777' });
    store = await openStore(config);
    const service = new Service(store.db, new ChainBridge(config), config, false), auth = new Auth(store.db, config);
    const logger = pino({ enabled: false });
    app = createApp(service, auth, logger, publicRoot,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, website);
    legacy = createApp(service, auth, logger, publicRoot);
  }, 30000);
  afterAll(async () => {
    await store?.close();
    if (root) {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('telomere-website-')) throw new Error('Unsafe website fixture cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves exact entry, direct route and script bytes, with extensionless routing fallback', async () => {
    expect(await (await app.request('/')).text()).toBe(index);
    expect(await (await app.request('/protocol/')).text()).toBe('<!doctype html><html>protocol entry</html>');
    expect(await (await app.request('/protocol')).text()).toBe('<!doctype html><html>protocol entry</html>');
    expect(await (await app.request('/new-public-route/')).text()).toBe(fallback);
    const script = await app.request('/site.js?version=one');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('export const unchanged = true;\r\n');
  });

  it('keeps the original console and assets under strict CSP and retains legacy createApp behavior', async () => {
    for (const path of ['/console', '/console/']) {
      const response = await app.request(path);
      expect(await response.text()).toContain('backend console');
      expect(response.headers.get('content-security-policy')).not.toMatch(/sha256-|unsafe-inline|fonts\.gstatic/);
    }
    expect(await (await app.request('/app.js')).text()).toBe('export {};');
    expect(await (await app.request('/styles.css')).text()).toBe('body{color:black}');
    expect(await (await legacy.request('/')).text()).toContain('backend console');
  });

  it('permits only supplied inline bootstrap hashes on public pages, without script unsafe-inline or unsafe-eval', async () => {
    const response = await app.request('/dashboard/');
    const policy = response.headers.get('content-security-policy') ?? '';
    for (const script of ['window.homeReady = true;', 'window.pageReady = true;']) {
      expect(policy).toContain("'sha256-" + createHash('sha256').update(script).digest('base64') + "'");
    }
    const scriptDirective = policy.split(';').find(part => part.trim().startsWith('script-src '));
    expect(scriptDirective).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("frame-ancestors 'none'");
    const health = await app.request('/health/live');
    expect(health.status).toBe(200);
    expect(health.headers.get('content-security-policy')).not.toMatch(/sha256-|unsafe-inline|fonts\.gstatic/);
  });

  it.each(['/api/missing', '/v1/cells', '/health/missing', '/mcp/missing', '/x402/missing', '/console/missing',
    '/src/main.ts', '/docs/private', '/assets/missing.js', '/assets/missing', '/missing.js', '/.env', '/%2eenv',
    '/assets/%252e%252e/private', '/assets%2ffilm.mp4'])('never falls back to HTML for %s', async path => {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/html');
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  });

  it('does not turn unsupported methods into static successes', async () => {
    const response = await app.request('/protocol/', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  });

  it('supports HEAD without reading or returning the asset body', async () => {
    const response = await app.request('/assets/film.mp4', { method: 'HEAD', headers: { range: 'bytes=0-2' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe('');
  });

  it.each([['bytes=0-3', '0123', 'bytes 0-3/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=7-99', '789', 'bytes 7-9/10'], ['bytes=7-', '789', 'bytes 7-9/10']])('streams valid media range %s', async (range, text, expected) => {
    const response = await app.request('/assets/film.mp4', { headers: { range } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(expected);
    expect(response.headers.get('content-length')).toBe(String(text.length));
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(await response.text()).toBe(text);
  });

  it('refuses malformed, multiple, unsafe and unsatisfiable ranges, and ignores an unvalidated If-Range', async () => {
    for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-', 'bytes=-']) {
      const response = await app.request('/assets/film.mp4', { headers: { range } });
      expect(response.status).toBe(416); expect(response.headers.get('content-range')).toBe('bytes */10');
      expect(await response.text()).toBe('');
    }
    const full = await app.request('/assets/film.mp4', { headers: { range: 'bytes=0-2', 'if-range': 'unknown-validator' } });
    expect(full.status).toBe(200); expect(await full.text()).toBe('0123456789');
  });

  it('does not expose late files and refuses a file replaced after startup inventory', async () => {
    const isolated = join(root, 'mutated'); await mkdir(isolated);
    await Promise.all([writeFile(join(isolated, 'index.html'), index), writeFile(join(isolated, 'page.html'), fallback),
      writeFile(join(isolated, 'asset.js'), 'original')]);
    const loaded = await loadWebsite(isolated);
    await writeFile(join(isolated, 'late.js'), 'not in inventory');
    expect(await loaded.handle(request('/late.js'))).toBeUndefined();
    await writeFile(join(isolated, 'asset.js'), 'changed after startup');
    await expect(loaded.handle(request('/asset.js'))).rejects.toThrow('identity changed');
  });

  it('rejects linked directories at startup instead of exposing external files', async () => {
    const isolated = join(root, 'linked'); await mkdir(isolated);
    await Promise.all([writeFile(join(isolated, 'index.html'), index), writeFile(join(isolated, 'page.html'), fallback)]);
    await symlink(publicRoot, join(isolated, 'linked-assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loadWebsite(isolated)).rejects.toThrow('links are forbidden');
  });

  it('loads the supplied site unchanged and streams its exact landing bytes with a bounded CSP', async () => {
    const supplied = await loadWebsite('website/dist');
    const response = await supplied.handle(request('/'));
    expect(response?.status).toBe(200);
    expect(Buffer.from(await response!.arrayBuffer()).equals(await readFile('website/dist/index.html'))).toBe(true);
    const policy = supplied.policyFor(request('/')) ?? '';
    expect(policy).toContain('sha256-'); expect(Buffer.byteLength(policy)).toBeLessThan(8192);
    expect(policy).not.toContain('unsafe-eval');
  });

  it('copies byte-exact static output without running the frontend build or retaining stale bundles', async () => {
    const buildRoot = join(root, 'build');
    await mkdir(join(buildRoot, 'website', 'dist', 'assets'), { recursive: true });
    await mkdir(join(buildRoot, 'public')); await mkdir(join(buildRoot, 'dist', 'website'), { recursive: true });
    const originals = new Map([['index.html', Buffer.from(index)], ['page.html', Buffer.from(fallback)],
      ['assets/binary.mp4', Buffer.from([0, 13, 10, 255, 30, 0])]]);
    for (const [path, bytes] of originals) await writeFile(join(buildRoot, 'website', 'dist', path), bytes);
    await Promise.all([writeFile(join(buildRoot, 'public', 'index.html'), 'console'), writeFile(join(buildRoot, 'public', 'styles.css'), 'css'),
      writeFile(join(buildRoot, 'dist', 'website', 'stale.js'), 'stale')]);
    const script = resolve('scripts/copy-public.mjs');
    await execFileAsync(process.execPath, [script], { cwd: buildRoot, timeout: 30000 });
    expect(await readdir(join(buildRoot, 'dist', 'website'))).not.toContain('stale.js');
    for (const [path, bytes] of originals) {
      expect((await readFile(join(buildRoot, 'dist', 'website', path))).equals(bytes)).toBe(true);
      expect((await readFile(join(buildRoot, 'website', 'dist', path))).equals(bytes)).toBe(true);
    }
    expect(await readFile(join(buildRoot, 'dist', 'public', 'index.html'), 'utf8')).toBe('console');
    await symlink(publicRoot, join(buildRoot, 'website', 'dist', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(execFileAsync(process.execPath, [script], { cwd: buildRoot, timeout: 30000 })).rejects.toThrow();
    expect((await readFile(join(buildRoot, 'dist', 'website', 'index.html'))).equals(Buffer.from(index))).toBe(true);
  });
});
