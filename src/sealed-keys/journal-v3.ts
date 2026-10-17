import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrivateSupplierJournal } from '../suppliers/private-journal.js';
import { sealedHash, sealedJournalV3Schema, type SealedJournalV3State } from './protocol-v3.js';

const wireSchema = z.object({ version: z.literal(3), nonce: z.string().regex(/^[0-9a-f]{24}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/), ciphertext: z.string().min(2).max(524_288).regex(/^(?:[0-9a-f]{2})+$/) }).strict();
type Wire = z.infer<typeof wireSchema>;
/** Owner/guest-local encrypted protocol metadata, never source recovery keys.
 * Whole-store rollback/deletion is not protected: independently current policy,
 * boot/lease and registry observations remain mandatory after every restart.
 */
export class SealedHandoffJournalV3 {
  private readonly key: Buffer;
  private readonly store: PrivateSupplierJournal<Wire>;
  private readonly aad: Buffer;
  private closed = false;
  private active = 0;
  constructor(options: { path: string; masterKey: Uint8Array; role: 'owner' | 'recipient'; scopeHash: string }) {
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.byteLength !== 32
      || options.masterKey.every(value => value === 0)) throw new Error('Supply an external sealed journal master key');
    this.key = Buffer.from(options.masterKey);
    this.aad = Buffer.from(JSON.stringify(['telomere.sealed-handoff-journal.v3', options.role, options.scopeHash]));
    this.store = new PrivateSupplierJournal({ path: options.path, kind: 'sealed-cyst-handoff-v3-' + options.role,
      schema: wireSchema, maximum: 525_000, binding: this.aad.toString('utf8') });
    this.role = options.role; this.scopeHash = options.scopeHash;
  }
  readonly role: 'owner' | 'recipient';
  readonly scopeHash: string;
  close(): void { if (this.active) throw new Error('Sealed journal still active'); this.closed = true; this.key.fill(0); }
  private encrypt(raw: SealedJournalV3State): Wire {
    const value = sealedJournalV3Schema.parse(raw), bytes = Buffer.from(JSON.stringify(value));
    try {
      if (bytes.length > 262_144) throw new Error('Sealed journal state limit');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(this.aad);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return { version: 3, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
    } finally { bytes.fill(0); }
  }
  private decrypt(wire: Wire): SealedJournalV3State {
    const value = wireSchema.parse(wire), cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.nonce, 'hex'));
    cipher.setAAD(this.aad); cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    let partial: Buffer | undefined, bytes: Buffer | undefined;
    try {
      partial = cipher.update(Buffer.from(value.ciphertext, 'hex')); bytes = Buffer.concat([partial, cipher.final()]);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), state = sealedJournalV3Schema.parse(JSON.parse(text));
      if (JSON.stringify(state) !== text || state.role !== this.role || state.scopeHash !== this.scopeHash) throw new Error('Sealed journal scope changed');
      return state;
    } finally { partial?.fill(0); bytes?.fill(0); }
  }
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Sealed journal closed'); this.active++;
    try { return await operation(); } finally { this.active--; }
  }
  initializeFresh(): Promise<void> {
    return this.guard(() => this.store.initializeFresh(this.encrypt({ version: 3, role: this.role, scopeHash: sealedHash.parse(this.scopeHash),
      policyGeneration: 0, policyHash: null, policyTransitions: 0, fences: [], activeRecipient: null, activeAppraiser: null,
      retiredRecipients: [], retiredAppraisers: [], entries: [], writes: 0, lifetimeBytes: 0 })));
  }
  read(): Promise<SealedJournalV3State> { return this.guard(async () => this.decrypt(await this.store.read())); }
  /** Linearize a narrow trusted local key/crypto operation against rotation.
   * Collector and owner-signing callbacks must remain outside this lock.
   */
  authorize<T>(check: (state: SealedJournalV3State) => void, operation: () => Promise<T>): Promise<T> {
    return this.guard(() => this.store.transact(async wire => {
      check(this.decrypt(wire)); return operation();
    }));
  }
  transact<T>(change: (state: SealedJournalV3State) => T): Promise<T> {
    return this.guard(() => this.store.transact(wire => {
      const state = this.decrypt(wire), result = change(state);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new Error('Sealed journal transitions must be synchronous');
      }
      // Conservative retained lifetime-write budget; rotation never resets it.
      state.writes++;
      state.lifetimeBytes += (Buffer.byteLength(JSON.stringify(state)) + 8192) * 2;
      Object.assign(wire, this.encrypt(state)); return result;
    }));
  }
}
