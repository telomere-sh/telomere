# Opt-in paid Vault CPU preemption and application-state continuation

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

This owner-side path connects an already admitted Vault-paid CPU session, its
original signed HostKit lease, a signed host preemption notice, a bounded Cyst
checkpoint, the source's canonical escrow settlement, and a **separately
funded** paid target session on another reviewed host. It never sends a wallet
transaction. The owner or agent explicitly obtains, pays for and admits the
target after source settlement. It carries at most 4,096 bytes of application
state; it does not migrate a process, memory image, socket or GPU context.
For a target quote, the agent can pass `excludedHostIds: [sourceHostId]` to the
mounted Platform quote endpoint. The server filters these host IDs before
ranking same-region capacity, and the Node and Python SDKs reject a returned
signed quote whose `hostId` is excluded. This optional field leaves older
quote identities unchanged. It selects a different reviewed host without
claiming a distinct physical failure domain; operator provisioning must prove
that separately.
The adapter enforces settlement before target restore dispatch. Generic Vault
quote and admission endpoints remain independently callable, so an external
caller can fund a target early; the recommended owner workflow stages funding
after source settlement, as the mounted test does.

The Vault owner opts the original running paid lease in through authenticated
`POST /api/platform/vaults/:vault/runs/:runId/preemption-opt-in` with `{}` and a
stable `Idempotency-Key`. The agent cannot opt in. The controller verifies the
current Vault, Leash and canonical admission, signs authority for the exact
original lease hash, and HostKit persists it. A host scheduler may then issue
one signed 30–120-second notice. Authenticated owner and agent reads can get
the original signed lease and host notice through `GET .../lease` and
`GET .../preemption-notice`. A lost opt-in response can be replayed with the
same key after source cleanup; HostKit refuses a new late opt-in or a changed
nonce. There is no different price or interruptible market lane in the signed
quote: this is an operational post-admission stop policy.

`PaidPreemptionHandoff.capture(sourceRunId, maxSpend, deadline)` requires the
live source, independently pinned controller and host keys, the original
controller-signed owner opt-in artifact whose hash appears in the host-signed
notice, and the exact original lease. It saves an immutable encrypted owner intent binding the
notice, budget and deadline before invoking the guest. The guest's reviewed checkpoint command must quiesce and
flush state before the signed interruption deadline, and leave it frozen until
source removal. The owner-side Cyst coordinator derives a deterministic
operation ID from the source and notice, encrypts the bounded application
bytes, uploads the Cyst, and saves a notice-bound marker in the private owner
vault. A crash after upload but before marker save recovers the same operation
without a second guest capture. An unrelated pending or earlier checkpoint is
never accepted merely because it completed after the notice.

After HostKit cleanup, the controller can put the original run in
`receipt_pending`. The source must reach `completed` with a canonical
fee-inclusive settlement and conservation of charged plus refunded funds
before this adapter can restore into a target. Because receipt roots close by
hour, this wait can be much longer than a paid Cell's 120-second maximum. The Cyst holds
application state during the wait. `PaidPreemptionHandoff.restore` requires
the exact original notice and owner-vault marker, a terminal `cancelled`
source result, its audited settlement transaction, and a distinct paid target
on another independently pinned host with the same reviewed image. The
source charge plus target reservation must stay within `maxSpend` and a new
restore must fit the owner-supplied deadline. The operation binding, including
source settlement transaction, notice, checkpoint, target lease and image, is
encrypted and saved before dispatch. A separate durable per-notice claim
permits one target and one restore operation; a second target or operation
under the same notice is rejected even if each reservation alone fits the
budget. The existing paid handoff sends the
exact same command ID, argv and stdin on retry and verifies the signed command
receipt plus the guest's application-level output.

The original host notice proves an authority and deadline. A cancelled and
settled source proves terminal cleanup and accounting under the controller's
signed evidence checks. The owner adapter does **not** independently prove
that the watchdog, rather than another valid stop cause, initiated the stop.
The original host-signed terminal tick must report `STOPPED` no later than
five seconds after the notice deadline. This bounds observed physical cleanup
time without attributing its cause to the watchdog.
It cannot roll back an application side effect if the chain reorganizes after
an accepted dispatch. The guest checkpoint and restore executables remain
application-reviewed; a successful command receipt alone does not prove
semantic state reconstruction. The target restore stdin contains base64
**plaintext** in the existing controller and HostKit command journal. The
Cyst controller stores ciphertext. Do not put secrets in this state until a
separately reviewed confidential ingress path exists.

`tests/paid-vault-preemption-handoff.test.ts` mounts real local Anvil contracts,
authenticated Vault and Cyst HTTP routes, two independent HostKit local-process
fixtures, signed opt-in/notice/tick/receipt traffic, and a separately paid
target. It covers lost marker and lost restore responses, one source capture,
terminal opt-in replay, changed binding rejection, target state read-back,
and encrypted Cyst storage. This is local fixture acceptance. It does not
establish a production gVisor/Kata deployment, NEAR custom CVM entitlement,
public Base funding, or general 2 GiB Cyst restoration.
