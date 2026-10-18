import { parentPort, workerData } from 'node:worker_threads';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { GOLEM_ATTRIBUTION_TABLES, golemAttributionPolicySchema, golemAttributionSchemaHash,
  golemAttributionSnapshotSchema } from './golem-allocation-attribution.js';
import { golemFinanceIdSchema } from './golem-finance-types.js';

const input = z.object({ policy: golemAttributionPolicySchema, paymentId: golemFinanceIdSchema }).strict();
const same = (a: BigIntStats | undefined, b: BigIntStats | undefined, mutable: boolean) => !a && !b || !!a && !!b
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size && (mutable || a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);

try {
  const { policy: p, paymentId } = input.parse(workerData), path = p.databasePath, directory = dirname(path);
  const check = (stat: BigIntStats, isDirectory: boolean, maximum: number) => {
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n
      || stat.size > BigInt(maximum) || stat.size < 0n) || process.platform !== 'win32' && ((stat.mode & 0o077n) !== 0n
      || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) throw new Error('Private source rejected');
  };
  const guard = () => {
    const dir = lstatSync(directory, { bigint: true }); check(dir, true, 0);
    if (dir.dev.toString() !== p.directoryDevice || dir.ino.toString() !== p.directoryInode) throw new Error('Directory changed');
    for (let name = directory;;) {
      const stat = lstatSync(name, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Ancestor changed');
      const parent = dirname(name); if (parent === name) break; name = parent;
    }
    const database = lstatSync(path, { bigint: true }); check(database, false, p.maxDatabaseBytes);
    if (database.size < 100n || database.dev.toString() !== p.databaseDevice || database.ino.toString() !== p.databaseInode) throw new Error('Database changed');
    const sidecar = (suffix: string, maximum: number) => {
      try { const stat = lstatSync(path + suffix, { bigint: true }); check(stat, false, maximum); return stat; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
    };
    const wal = sidecar('-wal', p.maxWalBytes), shm = sidecar('-shm', p.maxShmBytes), journal = sidecar('-journal', 0);
    if (journal || Boolean(wal) !== Boolean(shm)) throw new Error('Incomplete source sidecars');
    return { database, wal, shm };
  };
  const before = guard(), fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW) | (constants.O_NONBLOCK ?? 0));
  let result: unknown;
  try {
    const stat = fstatSync(fd, { bigint: true }); check(stat, false, p.maxDatabaseBytes);
    if (!same(stat, before.database, false)) throw new Error('Opened source changed');
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0'
      || ![1, 2].includes(header[18]!) || header[18] !== header[19] || header[18] === 2 && (!before.wal || !before.shm)) throw new Error('Unsupported source header');
    let db: DatabaseSync | undefined;
    let snapshot: unknown;
    try {
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA mmap_size=0; PRAGMA cache_size=-2048; BEGIN;');
      const schema = db.prepare('SELECT name,type,substr(sql,1,32769) AS sql FROM sqlite_master WHERE name IN (?,?,?,?,?,?,?,?) ORDER BY name').all(...GOLEM_ATTRIBUTION_TABLES);
      if (schema.some(row => typeof row.sql !== 'string' || !/^\s*CREATE\s+TABLE\s+/i.test(row.sql))) throw new Error('Native tables required');
      const schemaHash = golemAttributionSchemaHash(schema);
      if (schemaHash !== p.schemaHash) throw new Error('Source schema pin changed');
      const payments = db.prepare(`SELECT substr(id,1,257) AS id,substr(owner_id,1,257) AS owner_id,substr(peer_id,1,257) AS peer_id,
        substr(payee_addr,1,257) AS payee_addr,substr(payer_addr,1,257) AS payer_addr,substr(payment_platform,1,257) AS payment_platform,
        substr(role,1,257) AS role,substr(amount,1,257) AS amount,substr(timestamp,1,257) AS timestamp,
        CASE WHEN length(details)=32 THEN hex(details) ELSE NULL END AS details_hex
        FROM pay_payment WHERE owner_id=? AND id=? LIMIT 2`).all(p.requestorId, paymentId);
      const items = db.prepare(`SELECT i.order_id,i.owner_id,i.payee_addr,i.allocation_id,i.amount,i.payment_id,i.paid,
        substr(o.platform,1,257) AS platform,substr(o.payer_addr,1,257) AS payer_addr,substr(a.address,1,257) AS allocation_address,
        substr(a.payment_platform,1,257) AS allocation_platform,substr(a.deposit,1,257) AS deposit,substr(a.deposit_status,1,257) AS deposit_status
        FROM pay_batch_order_item i LEFT JOIN pay_batch_order o ON o.owner_id=i.owner_id AND o.id=i.order_id
        LEFT JOIN pay_allocation a ON a.owner_id=i.owner_id AND a.id=i.allocation_id
        WHERE i.owner_id=? AND i.payment_id=? LIMIT 129`).all(p.requestorId, paymentId);
      const documents = db.prepare(`SELECT d.order_id,d.owner_id,d.payee_addr,d.allocation_id,d.agreement_id,d.invoice_id,d.activity_id,d.debit_note_id,d.amount,
        g.role AS agreement_role,g.peer_id,g.payer_addr AS agreement_payer,g.payee_addr AS agreement_payee,g.payment_platform AS agreement_platform,
        ac.role AS activity_role,ac.agreement_id AS activity_agreement
        FROM pay_batch_order_item i LEFT JOIN pay_batch_order_item_document d ON d.owner_id=i.owner_id AND d.order_id=i.order_id
        AND d.payee_addr=i.payee_addr AND d.allocation_id=i.allocation_id
        LEFT JOIN pay_agreement g ON g.owner_id=d.owner_id AND g.id=d.agreement_id
        LEFT JOIN pay_activity ac ON ac.owner_id=d.owner_id AND ac.id=d.activity_id
        WHERE i.owner_id=? AND i.payment_id=? LIMIT 129`).all(p.requestorId, paymentId);
      const paymentDocuments = db.prepare(`SELECT payment_id,owner_id,peer_id,agreement_id,invoice_id,activity_id,debit_note_id,amount
        FROM pay_payment_document WHERE owner_id=? AND payment_id=? LIMIT 65`).all(p.requestorId, paymentId);
      db.exec('COMMIT'); snapshot = { schemaHash, payments, items, documents, paymentDocuments };
    } finally { db?.close(); }
    const after = guard();
    if (!same(before.database, after.database, false) || !same(before.wal, after.wal, false)
      || !same(before.shm, after.shm, true) || !same(fstatSync(fd, { bigint: true }), after.database, false)) throw new Error('Source changed during snapshot');
    // Reject oversized native fields inside this worker before copying any
    // snapshot into the control-plane thread. Close all native handles before
    // exposing success: the parent can immediately terminate an owned worker.
    result = golemAttributionSnapshotSchema.parse(snapshot);
  } finally { closeSync(fd); }
  parentPort?.postMessage(result);
} catch { parentPort?.postMessage({ unavailable: true }); }
