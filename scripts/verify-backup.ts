import { parseArgs } from 'node:util';
import { z } from 'zod';
import { verifyBackup } from '../src/operator/backup.js';

try {
  const { values } = parseArgs({ options: { directory: { type: 'string' } }, strict: true, allowPositionals: false });
  const manifest = await verifyBackup(z.string().min(1).parse(values.directory));
  process.stdout.write(JSON.stringify({ status: 'verified_backup', createdAt: manifest.createdAt, chainId: manifest.chainId,
    escrow: manifest.escrow, token: manifest.token, signer: manifest.signer, checksumVerifiedFiles: manifest.files.length,
    archiveStructure: 'checksum_and_header_checked', restored: false }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ status: 'backup_invalid', detail: 'Check the manifest, checksums, private file permissions and matching staging profile. Nothing was restored.' }) + '\n');
  process.exitCode = 1;
}
