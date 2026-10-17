import { z } from 'zod';
import { ApiTransport } from '../src/sdk/transport.js';
import { CystClient, decryptCheckpoint, encryptCheckpoint, exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';
import type { CystEnvelope, CystMetadata } from '../src/cysts/types.js';

const recoveryFile = z.object({ version: z.literal(1), purpose: z.literal('telomere.application-cyst.recovery'),
  owner: z.string().regex(/^0x[0-9a-f]{40}$/), checkpointId: z.string().regex(/^0x[0-9a-f]{64}$/),
  recoveryKey: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function download(bytes: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class CystPanel {
  private readonly client = new CystClient(new ApiTransport(location.origin));
  private pending: { envelope: CystEnvelope; recoveryKey: Uint8Array; idempotencyKey: string } | undefined;
  private owner: string | undefined;
  private selectedId: string | undefined;
  private exported = false;
  private working = false;
  private checkpoints: CystMetadata[] = [];
  private nextCursor: string | undefined;
  constructor(private readonly context: { owner(): string | undefined; enabled(): boolean; notice(message: string): void }) {
    element('checkpoint-form').addEventListener('submit', event => { event.preventDefault(); void this.perform('prepare-checkpoint', () => this.prepare()); });
    element('checkpoint-key').addEventListener('click', () => this.exportKey());
    element('checkpoint-key-saved').addEventListener('change', () => this.availability());
    element('upload-checkpoint').addEventListener('click', () => void this.perform('upload-checkpoint', () => this.upload()));
    element('discard-checkpoint').addEventListener('click', () => this.clearPending());
    element('refresh-checkpoints').addEventListener('click', () => void this.perform('refresh-checkpoints', () => this.refresh()));
    element('more-checkpoints').addEventListener('click', () => void this.perform('more-checkpoints', () => this.loadMore()));
    element('checkpoint-list').addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-restore-cyst]');
      if (!button?.dataset.restoreCyst) return;
      this.selectedId = button.dataset.restoreCyst;
      element<HTMLInputElement>('restore-key-file').value = ''; element('restore-checkpoint-error').textContent = '';
      element<HTMLDialogElement>('checkpoint-restore-dialog').showModal();
    });
    element('restore-checkpoint-form').addEventListener('submit', event => { event.preventDefault(); void this.perform('restore-checkpoint', () => this.restore(), 'restore-checkpoint-error'); });
    element('cancel-checkpoint-restore').addEventListener('click', () => element<HTMLDialogElement>('checkpoint-restore-dialog').close());
    element('checkpoint-restore-dialog').addEventListener('close', () => {
      const id = this.selectedId; this.selectedId = undefined; element<HTMLInputElement>('restore-key-file').value = '';
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-restore-cyst]')).find(button => button.dataset.restoreCyst === id)?.focus();
    });
  }
  sync() {
    const owner = this.context.owner()?.toLowerCase();
    if (owner !== this.owner) {
      this.clearPending(); this.owner = owner;
      element<HTMLInputElement>('checkpoint-file').value = '';
      element<HTMLDialogElement>('checkpoint-restore-dialog').close();
      element('checkpoint-list').replaceChildren(); element('checkpoint-usage').textContent = '';
      this.checkpoints = []; this.nextCursor = undefined;
    }
    element('checkpoints-section').hidden = !this.context.enabled();
    element('checkpoint-sign-in').hidden = Boolean(owner);
    this.availability();
  }
  private availability() {
    for (const id of ['prepare-checkpoint', 'refresh-checkpoints']) element<HTMLButtonElement>(id).disabled = !this.owner || this.working;
    element<HTMLButtonElement>('upload-checkpoint').disabled = !this.owner || this.working || !this.pending || !this.exported || !element<HTMLInputElement>('checkpoint-key-saved').checked;
    element<HTMLButtonElement>('checkpoint-key').disabled = this.working || !this.pending;
    element<HTMLButtonElement>('discard-checkpoint').disabled = this.working;
    element('checkpoint-prepared').hidden = !this.pending;
    element<HTMLButtonElement>('more-checkpoints').disabled = this.working || !this.nextCursor;
    element('more-checkpoints').hidden = !this.nextCursor;
  }
  private clearPending() {
    this.pending?.recoveryKey.fill(0); this.pending = undefined; this.exported = false;
    element<HTMLInputElement>('checkpoint-key-saved').checked = false; this.availability();
  }
  private async perform(buttonId: string, operation: () => Promise<void>, errorId = 'checkpoint-error') {
    if (this.working) return;
    this.working = true; this.availability(); const button = element<HTMLButtonElement>(buttonId);
    button.disabled = true; button.setAttribute('aria-busy', 'true'); element(errorId).textContent = '';
    try { await operation(); }
    catch (error) { element(errorId).textContent = error instanceof Error ? error.message : 'Unable to complete this checkpoint action.'; }
    finally { this.working = false; button.removeAttribute('aria-busy'); button.disabled = false; this.availability(); }
  }
  private requireOwner(): string {
    const current = this.context.owner()?.toLowerCase();
    if (!this.owner || current !== this.owner) throw new Error('Sign in again before using checkpoints.');
    return this.owner;
  }
  private async prepare() {
    const owner = this.requireOwner(); const file = element<HTMLInputElement>('checkpoint-file').files?.[0];
    if (!file || file.size < 1 || file.size > 2 * 1024 * 1024) throw new Error('Choose an application state file between 1 byte and 2 MiB.');
    const applicationSchema = element<HTMLInputElement>('checkpoint-schema').value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(applicationSchema)) throw new Error('Use a format name up to 64 characters, such as agent-state/v1.');
    const bytes = new Uint8Array(await file.arrayBuffer()); this.clearPending();
    try {
      const encrypted = await encryptCheckpoint(bytes, { owner, applicationSchema });
      if (this.context.owner()?.toLowerCase() !== owner || this.owner !== owner) { encrypted.recoveryKey.fill(0); throw new Error('The account changed. Prepare the checkpoint again.'); }
      this.pending = { ...encrypted, idempotencyKey: crypto.randomUUID() };
      element('checkpoint-prepared-summary').textContent = `${file.size.toLocaleString()} bytes encrypted in this browser. Save the recovery key before uploading.`;
    } finally { bytes.fill(0); }
  }
  private exportKey() {
    const pending = this.pending; if (!pending || this.working) return;
    download(JSON.stringify({ version: 1, purpose: 'telomere.application-cyst.recovery', owner: pending.envelope.owner,
      checkpointId: pending.envelope.id, recoveryKey: exportCystRecoveryKey(pending.recoveryKey) }, null, 2),
    `telomere-${pending.envelope.id}-recovery.json`, 'application/json');
    this.exported = true; this.availability();
  }
  private async upload() {
    const owner = this.requireOwner(); const pending = this.pending;
    if (!pending || pending.envelope.owner !== owner || !this.exported || !element<HTMLInputElement>('checkpoint-key-saved').checked) throw new Error('Save your recovery key before uploading.');
    await this.client.upload(pending.envelope, pending.idempotencyKey);
    this.clearPending(); element<HTMLInputElement>('checkpoint-file').value = '';
    await this.refresh(); this.context.notice('Encrypted checkpoint saved. Keep the recovery key to restore it.');
  }
  async refresh() {
    if (!this.context.enabled() || !this.owner) return;
    const owner = this.requireOwner(); const result = await this.client.list();
    if (this.context.owner()?.toLowerCase() !== owner) return;
    if (result.checkpoints.some(item => item.owner !== owner)) throw new Error('Checkpoint owner differs from the signed-in account.');
    element('checkpoint-usage').textContent = `${result.usage.checkpoints} checkpoints · ${(result.usage.bytes / 1024).toFixed(1)} KiB encrypted · 32 MiB limit`;
    this.checkpoints = result.checkpoints; this.nextCursor = result.nextCursor; this.render();
  }
  private async loadMore() {
    const owner = this.requireOwner(); const cursor = this.nextCursor; if (!cursor) return;
    const result = await this.client.list({ cursor });
    if (this.context.owner()?.toLowerCase() !== owner) return;
    if (result.checkpoints.some(item => item.owner !== owner || item.id <= cursor) || this.checkpoints.length + result.checkpoints.length > 512) throw new Error('Unexpected checkpoint page. Refresh and try again.');
    this.checkpoints.push(...result.checkpoints); this.nextCursor = result.nextCursor; this.render();
  }
  private render() {
    const focusId = (document.activeElement as HTMLElement | null)?.dataset.restoreCyst;
    element('checkpoint-list').innerHTML = this.checkpoints.length ? this.checkpoints.map(item => `<li class="checkpoint-row"><div><strong>${escape(item.applicationSchema)}</strong><p class="hint mono">${escape(item.id.slice(0, 12))}… · ${item.plaintextBytes.toLocaleString()} bytes · ${escape(item.state)}</p></div><button type="button" class="text-button" data-restore-cyst="${escape(item.id)}" ${item.state !== 'ready' ? 'disabled' : ''}>Restore file</button></li>`).join('') : '<li class="empty-copy">No checkpoints saved.</li>';
    if (focusId) Array.from(document.querySelectorAll<HTMLButtonElement>('[data-restore-cyst]')).find(button => button.dataset.restoreCyst === focusId)?.focus({ preventScroll: true });
    this.availability();
  }
  private async restore() {
    const owner = this.requireOwner(); const id = this.selectedId;
    const file = element<HTMLInputElement>('restore-key-file').files?.[0];
    if (!id || !file || file.size < 1 || file.size > 4096) throw new Error('Choose the recovery key file for this checkpoint.');
    let parsed: z.infer<typeof recoveryFile>;
    try { parsed = recoveryFile.parse(JSON.parse(await file.text())); } catch { throw new Error('This is not a valid checkpoint recovery key file.'); }
    if (parsed.owner !== owner || parsed.checkpointId !== id) throw new Error('The recovery key belongs to a different checkpoint or account.');
    const key = importCystRecoveryKey(parsed.recoveryKey);
    try {
      const envelope = await this.client.download(id, { owner });
      const plaintext = await decryptCheckpoint(envelope, key);
      try {
        if (this.requireOwner() !== owner || this.selectedId !== id) throw new Error('The account or selected checkpoint changed.');
        download(Uint8Array.from(plaintext).buffer, `telomere-${id}-state.bin`, 'application/octet-stream');
      } finally { plaintext.fill(0); }
      element<HTMLDialogElement>('checkpoint-restore-dialog').close(); this.context.notice('Checkpoint authenticated and restored in this browser.');
    } finally { key.fill(0); element<HTMLInputElement>('restore-key-file').value = ''; }
  }
}
