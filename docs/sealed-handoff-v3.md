# Owner-authenticated sealed Cyst handoff, version3

This separate SDK protocol authenticates an owner-authorized encrypted Cyst key
packet and fences its cooperative recipient against replay and policy rotation.
It preserves the existing v2 release/open API, which **does not authenticate the
packet sender**. No public route, sealed runtime, TDX host or hardware verifier
is enabled by this addition.

The independently installed policy pins the owner, agent/agentId/Vault, registry
deployment, application schema, generation/window, run/host, boot identity,
lease hash/fence/expiry, recipient key and appraiser key/measurement/policy hashes.
The packet cannot select its own trust policy. The owner is verified using direct
recoverable EOA EIP712 signatures; ERC1271 owners are unsupported. The signature
domain binds the independently pinned registry contract and Base chain8453/84532;
chain31337 is available for explicit disposable fixtures only.

The owner API has three stages:

1. `prepareIntent(releaseId,{operationId,checkpoint})` accepts completed **public
   metadata**, checks the independently configured Cyst registry and canonical
   owner/agent/Vault/current-Cyst binding, then durably reserves an immutable
   context. It returns `SealedReleaseIntent(contextHash)` for external signing.
   No checkpoint-vault method is invoked. Metadata lookup through the existing
   FileVault is deliberately excluded here: that lookup also authenticates its
   stored recovery key.
2. `preparePacket(releaseId,ownerIntentSignature,signal)` verifies that signature
   first and commits `preparing`. Before collecting evidence it retains the exact
   challenge digest. The existing signed appraiser must validate and authenticate
   its verdict. Only then may the checkpoint vault be entered. Its actual latest
   operation and full metadata must match the signed context before wrapping.
   The produced ciphertext is retained unchanged as `prepared`, before returning
   `SealedPacketAuthorization(intentHash,packetHash)` for a second owner signature.
3. `complete(releaseId,ownerPacketSignature)` verifies both authorizations and
   current context again, commits the full version3 envelope, then returns it.
   The second signature commits to the complete original v2 ciphertext and header.

Owner keys are supplied solely through an external `signTypedData` callback in
`releaseAuthenticatedSealedCystV3`; no owner private key is stored. The callback
is invoked twice only for a fresh attempt. Retained attempts return their existing
phase. `preparing` after an interrupted/unknown collector, verifier or encryption
operation cannot recollect, generate a new challenge or re-encrypt under that ID.
An exact `prepared` ciphertext can be recovered explicitly; it never becomes a
new authorization. Old IDs/bindings are never evicted or refreshed on expiry.

The version3 context hash is encoded in the existing v2 request's audience as
`telomere.sealed-handoff/v3/<hash>`. Consequently its owner/agent/Vault, checkpoint
revision, boot/lease/fence and policy fields are committed through the unchanged
64-byte report-data protocol. The recipient recomputes the audience and complete
report-data value. Intel documents REPORTDATA as a 64-byte user field covered by
the quote signature; calculating the expected bytes is not evidence that a real
quote authenticated them. See [Intel's quote-library API](https://download.01.org/intel-sgx/sgx-dcap/1.20/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf).

`SealedCystHandoffRecipientV3.accept` checks the independently installed context,
fresh canonical Cyst binding, both owner signatures and the complete packet before
any ECDH. It durably marks release and binding consumed **before** opening the key.
A narrow journal lock linearizes source-key/recipient-crypto authority against
policy rotation. Registry, cancellation and expiry checks run again before return;
a derived key is cleared if any final check or durable commit fails. A crash after
consumption cannot return that key a second time. Expiry is the effective minimum
of the original intent/lease/policy window and the original signed appraisal;
no AEAD header is truncated, renewed or re-encrypted for signing latency.

`activatePolicy()` installs a separately configured higher generation. Durable
state retains per-run fence high-water values and retired recipient/appraiser
fingerprints. A public recipient key cannot cross run/boot contexts; higher
generations do not re-enable retired keys. Same-run/same-boot renewal may retain
its key. These checks cannot revoke a key that was already disclosed.

`SealedHandoffJournalV3` encrypts bounded protocol metadata with an independently
supplied AES256-GCM journal key, using the existing private atomic-file primitive
under its own kind/path/scope. Explicit `initializeFresh` is required; missing,
half-initialized, tampered or wrongly keyed stores fail closed. The journal holds
contexts, ciphertexts and signatures, never a source Cyst recovery key, owner
signing key or ephemeral agreement secret. It bounds retained releases to64,
policy transitions/run fences to16, state to256KiB, transitions to512 and the
conservative lifetime state-write budget to64MiB. Rotation does not reset limits.
POSIX permissions are0700/0600; Windows ACL provisioning remains operator-owned.

Local generations and files are **not rollback-proof**. Restoring/deleting every
journal/marker/config trust anchor is outside supported recovery. Every use still
requires an independently current policy, actual boot/lease context and canonical
Cyst reader. The existing runtime advertises only `sealed:false`; this module
does not obtain a live sealed lease or establish that a supplied boot ID is a
measured guest. Software non-exportable X25519 keys are not a TEE.

Acceptance uses actual EOA/Ed25519/X25519/HKDF/AEAD operations, encrypted file
journals and an actual CystCheckpointFileVault. The appraisals are deliberately
signed **fixtures**, with synthetic quote bytes and registry observations. They
prove protocol/storage behavior, not TDX authenticity or live registry access.
Initial scope is a CPU context, classic application Cysts up to2MiB and direct EOA
owner signatures. Real measured boot/key generation, DCAP appraisal, per-boot
receipt digests, sealed-run authority, guest transport and hardware restore remain
open M7 requirements. GPU Cells remain outside this slice.
