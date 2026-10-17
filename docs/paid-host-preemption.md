# Paid CPU HostKit preemption seam

Paid preemption is disabled for every existing paid session until its Vault
owner explicitly opts in after admission. The controller authenticates that
owner and signs an opt-in artifact for the exact original HostKit lease. HostKit
verifies the configured controller key, the original signed lease and its full
hash, the run, Vault payer, host key and image digest, then journals the opt-in.
HostKit itself does not verify the human owner's application session.

The controller sends the artifact to
`POST /v1/sessions/preemption/opt-in`. A controller-signed
`paid-preemption-request` goes to
`POST /v1/sessions/preemption/:runId/notices`, or a trusted in-process host
scheduler calls `PaidHostPreemptionService.issueFromHost`. Both require the
same stored opt-in. The host signs one immutable `paid-preemption` notice
with the original lease hash, opt-in hash, run, payer, host, image, issue time
and interruption deadline. `GET /v1/sessions/preemption/:runId/notices`
returns that signed notice. The remote host listener binds to loopback.

The requested notice is 30–120 seconds. It must fit within both the opt-in
expiry and original paid lease expiry, so the maximum 120-second grace is not
generally feasible for a lease that has already started. Stable nonces recover
the original opt-in or notice after an uncertain HTTP response; changing the
notice duration or reason with the same nonce conflicts. A different nonce
cannot create a second notice for one run.

The host watchdog checks persisted notices at startup and every second.
Once due, it stops only the still-owned paid session with the matching lease
hash and records enforcement only after both the paid lease and the Session
Runtime report terminal state and physical cleanup. A cleanup failure remains
unconfirmed for retry; new opt-ins and notices pause until the retry succeeds.
A changed signature, binding or durable notice fails
closed. Restart does not change a notice's original deadline.

This journal records resource cleanup, not a payment receipt or settlement.
The controller must independently pair signed ticks and acknowledgements,
close the original escrow, and fund any later replacement run. The host does
not release new funds or start a replacement Cell.
