import { privateBackupPath } from '/opt/telomere-pilot/releases/354fe7af62ea6701faafc3b04522abb1b4524d2d-launch01/dist/src/operator/backup.js';
const first = '/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch01/snapshot';
const second = '/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/.local/snapshot';
const cutover = '/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/.local/cutover-snapshot';
const cysts = '/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/clone/.local/cysts';
let oldRejected = false;
try { privateBackupPath(first); } catch (error) {
  if (error instanceof Error && error.message === 'Backups must be stored in a private ignored directory') oldRejected = true;
}
if (!oldRejected || privateBackupPath(second) !== second || privateBackupPath(cutover) !== cutover || privateBackupPath(cysts) !== cysts) throw new Error('path_contract_mismatch');
process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'passed', platform: process.platform,
  originalWorkSnapshotRejected: true, attempt2PrivateSnapshotAccepted: true, attempt2PrivateCutoverSnapshotAccepted: true,
  attempt2RestoredCystsPathAccepted: true,
  filesystemWrites: 0, profileRead: false, servicesChanged: false }) + '\n');
