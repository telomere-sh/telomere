import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { verifyMessage, type Address, type Hex } from 'viem';
import { nonces, sessions, pruneAuth, type Database } from './store.js';
import { Problem, secretHash } from './common.js';
import type { Config } from './config.js';

export class Auth {
  constructor(private readonly db: Database, private readonly config: Config) {}
  async challenge(address: Address): Promise<{ nonce: string; message: string }> {
    this.requireAllowed(address);
    await pruneAuth(this.db);
    const nonce = randomBytes(24).toString('hex');
    const now = new Date(), expires = new Date(now.getTime() + 5 * 60000);
    const message = `${new URL(this.config.PUBLIC_ORIGIN).host} wants you to sign in to Telomere:\n${address}\n\nAuthorize this browser session. No token transfer.\n\nURI: ${this.config.PUBLIC_ORIGIN}\nVersion: 1\nChain ID: ${this.config.CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expires.toISOString()}`;
    await this.db.insert(nonces).values({ nonce, address: address.toLowerCase(), message, expiresAt: expires });
    return { nonce, message };
  }
  requireAllowed(address: Address): void {
    if (this.config.MODE !== 'demo' && !this.config.PILOT_ALLOWED_OWNERS.split(',').map(item => item.trim().toLowerCase()).includes(address.toLowerCase())) {
      throw new Problem(403, 'pilot_access', 'This wallet is not on the pilot allowlist.');
    }
  }
  async verify(address: Address, nonce: string, signature: Hex): Promise<string> {
    this.requireAllowed(address);
    const where = and(eq(nonces.nonce, nonce), eq(nonces.address, address.toLowerCase()), gt(nonces.expiresAt, new Date()));
    const row = (await this.db.select().from(nonces).where(where).limit(1))[0];
    if (!row || !(await verifyMessage({ address, message: row.message, signature }))) throw new Problem(401, 'invalid_signature', 'Signature is invalid or the challenge expired.');
    const removed = await this.db.delete(nonces).where(where).returning({ nonce: nonces.nonce });
    if (removed.length !== 1) throw new Problem(401, 'challenge_used', 'This sign-in challenge has already been used.');
    return this.session(address);
  }
  async session(address: Address): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.db.insert(sessions).values({ hash: secretHash(token), address: address.toLowerCase(), expiresAt: new Date(Date.now() + 8 * 3600000) });
    return token;
  }
  async owner(token: string | undefined): Promise<Address> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Problem(401, 'sign_in', 'Sign in to continue.');
    const row = (await this.db.select({ address: sessions.address }).from(sessions).where(and(eq(sessions.hash, secretHash(token)), gt(sessions.expiresAt, new Date()))).limit(1))[0];
    if (!row) throw new Problem(401, 'session_expired', 'Your session has expired. Sign in again.');
    // REASON: session addresses originate exclusively from validated EVM addresses.
    const address = row.address as Address;
    this.requireAllowed(address);
    return address;
  }
  async logout(token: string | undefined): Promise<void> {
    if (token) await this.db.delete(sessions).where(eq(sessions.hash, secretHash(token)));
  }
}
