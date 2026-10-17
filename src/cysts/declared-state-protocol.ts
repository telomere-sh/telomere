import { z } from 'zod';

export const DECLARED_STATE_MAGIC = Buffer.from('TLMRDS1\n', 'ascii');
export const DECLARED_STATE_PREFIX_BYTES = 12;
export const DECLARED_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const DECLARED_STATE_MAX_MANIFEST_BYTES = 65_536;
export const DECLARED_STATE_MAX_ENTRIES = 128;
export const DECLARED_STATE_CELL_DIRECTORY = '/tmp/telomere-declared-state';
export const DECLARED_STATE_RECEIPT = '.telomere-declared-state.json';

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const declaredStatePathSchema = z.string().min(1).max(240).refine(value => {
  const parts = value.split('/');
  return parts.length <= 16 && parts.every(part => /^[A-Za-z0-9_.-]{1,64}$/.test(part)
    && part !== '.' && part !== '..' && !part.endsWith('.') && !reserved.test(part)
    && part.toLowerCase() !== DECLARED_STATE_RECEIPT);
}, 'A portable relative state path is required');

const fileSchema = z.object({ path: declaredStatePathSchema,
  bytes: z.number().int().nonnegative().max(DECLARED_STATE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const declaredStateManifestSchema = z.object({ protocol: z.literal('telomere-declared-state-v1'),
  directories: z.array(declaredStatePathSchema).max(DECLARED_STATE_MAX_ENTRIES),
  files: z.array(fileSchema).max(DECLARED_STATE_MAX_ENTRIES),
  payloadBytes: z.number().int().nonnegative().max(DECLARED_STATE_MAX_BYTES),
}).strict().superRefine((manifest, context) => {
  const all = [...manifest.directories, ...manifest.files.map(file => file.path)], folded = new Set<string>();
  const directories = new Set(manifest.directories);
  for (const path of all) {
    const key = path.toLowerCase();
    if (folded.has(key)) context.addIssue({ code: 'custom', message: 'State paths alias or overlap' });
    folded.add(key);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (!directories.has(parts.slice(0, index).join('/'))) context.addIssue({ code: 'custom', message: 'State parent directory is undeclared' });
    }
  }
  const ordered = (values: string[]) => values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (!ordered(manifest.directories) || !ordered(manifest.files.map(file => file.path))
    || manifest.files.reduce((sum, file) => sum + file.bytes, 0) !== manifest.payloadBytes) {
    context.addIssue({ code: 'custom', message: 'State manifest order or total differs' });
  }
});
export type DeclaredStateManifest = z.infer<typeof declaredStateManifestSchema>;

export function encodeDeclaredStateManifest(raw: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(declaredStateManifestSchema.parse(raw)), 'utf8');
  if (bytes.length > DECLARED_STATE_MAX_MANIFEST_BYTES) throw new Error('Declared state manifest exceeds its bound');
  return bytes;
}

export function decodeDeclaredStateManifest(prefix: Uint8Array, bytes: Uint8Array): DeclaredStateManifest {
  const header = Buffer.from(prefix);
  if (header.length !== DECLARED_STATE_PREFIX_BYTES || !header.subarray(0, 8).equals(DECLARED_STATE_MAGIC)
    || header.readUInt32LE(8) !== bytes.length || bytes.length < 1 || bytes.length > DECLARED_STATE_MAX_MANIFEST_BYTES) {
    throw new Error('Declared state header differs');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = declaredStateManifestSchema.parse(JSON.parse(text));
  if (!encodeDeclaredStateManifest(value).equals(Buffer.from(bytes))
    || header.length + bytes.length + value.payloadBytes > DECLARED_STATE_MAX_BYTES) {
    throw new Error('Declared state encoding or total differs');
  }
  return value;
}
