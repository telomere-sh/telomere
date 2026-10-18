import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';

export interface Website {
  handle(request: Request): Promise<Response | undefined>;
  policyFor(request: Request): string | undefined;
}

interface Asset {
  path: string;
  identity: BigIntStats;
  type: string;
}

const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.framercms': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};
const segment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const excludedRoots = new Set(['api', 'v1', 'health', 'mcp', 'x402', 'console', 'app.js', 'styles.css',
  'src', 'scripts', 'docs', 'node_modules', 'website', 'dist']);
const requestPath = z.string().min(1).max(2048);

function publicPath(request: Request): string | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  const parsed = requestPath.safeParse(new URL(request.url).pathname);
  if (!parsed.success || /%(?:2f|5c)/i.test(parsed.data)) return undefined;
  let path: string;
  try { path = decodeURIComponent(parsed.data); } catch { return undefined; }
  if (!path.startsWith('/') || path.includes('//') || path.includes('%')) return undefined;
  const parts = path.slice(1).replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.some(part => !segment.test(part) || reservedName.test(part))) return undefined;
  if (excludedRoots.has(parts[0]?.toLowerCase() ?? '')) return undefined;
  return path;
}

function sameIdentity(actual: BigIntStats, expected: BigIntStats): boolean {
  return actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino
    && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs;
}

async function openAsset(asset: Asset): Promise<FileHandle> {
  if (await realpath(asset.path) !== asset.path) throw new Error('Website asset path changed');
  const file = await open(asset.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameIdentity(await file.stat({ bigint: true }), asset.identity)) throw new Error('Website asset identity changed');
    return file;
  } catch (error) { await file.close(); throw error; }
}

function rangeFor(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

// Framer's exported datastore requests concatenated byte slices using a query,
// rather than HTTP multipart ranges. This applies only to public CMS assets.
function cmsRanges(value: string, size: number): { start: number; end: number }[] | undefined {
  if (value.length > 2048) return undefined;
  const parts = value.split(',');
  if (parts.length < 1 || parts.length > 64) return undefined;
  const result = []; let bytes = 0;
  for (const part of parts) {
    if (!/^\d+-\d+$/.test(part)) return undefined;
    const range = rangeFor('bytes=' + part, size);
    // Reject truncation: the exported client expects the exact requested bytes.
    if (!range || Number(part.split('-')[1]) !== range.end) return undefined;
    bytes += range.end - range.start + 1;
    if (bytes > 512 * 1024) return undefined;
    result.push(range);
  }
  return result;
}

/** Load a finite, read-only deployment inventory. Only small HTML files are read at startup for CSP hashes. */
export async function loadWebsite(directory: string): Promise<Website> {
  const suppliedRoot = resolve(directory);
  const rootIdentity = await lstat(suppliedRoot);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error('Website root must be a regular directory');
  const root = await realpath(suppliedRoot), files = new Map<string, Asset>(), hashes = new Set<string>();
  let entries = 0, bytes = 0n;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('Website directory depth exceeds limit');
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      if (++entries > 2048 || !segment.test(item.name) || reservedName.test(item.name)) throw new Error('Invalid website inventory');
      const local = relative ? relative + '/' + item.name : item.name;
      const path = join(root, local), identity = await lstat(path, { bigint: true });
      if (identity.isSymbolicLink()) throw new Error('Website links are forbidden');
      if (identity.isDirectory()) { await visit(local, depth + 1); continue; }
      // esbuild emits license notices beside its bundle. Serve only that named
      // text sidecar; keep rejecting other unreviewed file types at startup.
      const type = item.name.endsWith('.LEGAL.txt') ? 'text/plain; charset=utf-8' : mimeTypes[extname(item.name).toLowerCase()];
      if (!identity.isFile() || !type || identity.size > 32n * 1024n * 1024n) throw new Error('Invalid website asset');
      bytes += identity.size;
      if (bytes > 256n * 1024n * 1024n) throw new Error('Website size exceeds limit');
      const asset = { path, identity, type };
      files.set('/' + local, asset);
      if (type.startsWith('text/html')) {
        if (identity.size > 2n * 1024n * 1024n) throw new Error('Website HTML exceeds limit');
        const file = await openAsset(asset);
        try {
          const html = await file.readFile({ encoding: 'utf8' });
          for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
            if (match[1]?.trim()) hashes.add("'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
          }
        } finally { await file.close(); }
      }
    }
  }
  await visit('', 0);
  if (!files.has('/index.html') || !files.has('/page.html')) throw new Error('Website entry points are missing');
  // Same-document navigation inserts the original home bootstrap into other pages, so every HTML entry uses the same finite hash set.
  const policy = ["default-src 'self'", "script-src 'self' " + [...hashes].sort().join(' '),
    "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "media-src 'self' blob:", "worker-src 'self' blob:", "connect-src 'self'", "object-src 'none'",
    "base-uri 'self'", "frame-ancestors 'none'"].join('; ');
  function select(request: Request): Asset | undefined {
    const path = publicPath(request);
    if (path === undefined) return undefined;
    const exact = files.get(path) ?? files.get(path.replace(/\/$/, '') + '/index.html');
    if (exact) return exact;
    // Missing scripts, media, dot paths and asset namespaces must never receive an HTML success response.
    if (path.split('/').includes('assets') || path.slice(1).split('/').some(part => part.includes('.'))) return undefined;
    return files.get('/page.html');
  }
  return {
    policyFor(request) { return select(request) ? policy : undefined; },
    async handle(request) {
      const asset = select(request);
      if (!asset) return undefined;
      const file = await openAsset(asset);
      try {
        const size = Number(asset.identity.size);
        const headers = new Headers({ 'Content-Type': asset.type, 'Content-Length': String(size),
          'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes',
          'Last-Modified': new Date(Number(asset.identity.mtimeMs)).toUTCString() });
        const cmsQuery = new URL(request.url).searchParams.getAll('range');
        if (asset.path.endsWith('.framercms') && cmsQuery.length) {
          const ranges = cmsQuery.length === 1 && !request.headers.has('range') ? cmsRanges(cmsQuery[0]!, size) : undefined;
          if (!ranges) {
            await file.close(); headers.set('Content-Range', 'bytes */' + size); headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
          }
          const length = ranges.reduce((sum, item) => sum + item.end - item.start + 1, 0);
          headers.set('Content-Length', String(length));
          if (request.method === 'HEAD') { await file.close(); return new Response(null, { headers }); }
          const bytes = Buffer.alloc(length); let offset = 0;
          for (const item of ranges) {
            let position = item.start;
            while (position <= item.end) {
              const result = await file.read(bytes, offset, item.end - position + 1, position);
              if (result.bytesRead === 0) throw new Error('CMS asset truncated');
              offset += result.bytesRead; position += result.bytesRead;
            }
          }
          await file.close();
          return new Response(new Uint8Array(bytes), { headers });
        }
        if (request.method === 'HEAD') { await file.close(); return new Response(null, { status: 200, headers }); }
        const range = request.headers.get('range');
        let selected: { start: number; end: number } | undefined;
        if (range && !request.headers.has('if-range')) {
          selected = rangeFor(range, size);
          if (!selected) {
            await file.close(); headers.set('Content-Range', 'bytes */' + size); headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
          }
          headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${size}`);
          headers.set('Content-Length', String(selected.end - selected.start + 1));
        }
        const stream = file.createReadStream({ autoClose: true, ...(selected ?? {}) });
        // REASON: Node 22 supplies the native WHATWG byte stream; @types/node and lib.dom disagree only on the optional done-result value.
        const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
        return new Response(body, { status: selected ? 206 : 200, headers });
      } catch (error) { await file.close(); throw error; }
    },
  };
}
