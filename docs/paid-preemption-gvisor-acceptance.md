# Real gVisor paid HostKit preemption watchdog acceptance

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

Run `scripts/paid-preemption-gvisor-acceptance.ts` from an exact Git source archive on a Linux x86-64 host with Node.js 22+, `npm ci`, Docker CLI, `runsc`, and the reviewed CPU image already loaded into a **separate acceptance daemon**. On the private acceptance VPS, use only `/run/telomere-paid-acceptance-20261013/docker.sock` in the isolated `tlmr-paid-accept-20261013` network namespace and the image pinned in [the 13 October gVisor report](platform-paid-gvisor-20261013.md). Do not point this driver at a live HostKit socket, staging service, shared Docker daemon, wallet, or public RPC.

```sh
node --import tsx scripts/paid-preemption-gvisor-acceptance.ts \
  --image '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe' \
  --docker-socket /run/telomere-paid-acceptance-20261013/docker.sock
```

Record the Git commit, source archive SHA-256, script SHA-256, image ID, and sanitized JSON result together. Confirm the acceptance daemon and reviewed image ID before execution. The script refuses the default shared Docker socket, does not pull images, and creates a fresh HostKit journal, host key, controller key, synthetic owner, and loopback HTTP listener. It opens a real paid session in a `runsc` Cell with an immutable signed lease; no chain or provider is configured.

After admission, the driver confirms the exact Cell ID, `runsc`, read-only root, no network, and session ownership labels, runs a small command inside the Cell, and confirms its ID has not changed. It submits and reads back a controller-signed opt-in for that lease, requests a 30-second notice, and verifies the host signature and complete lease scope. It keeps signed meter acknowledgments flowing, including the terminal tick, while the **timer-driven watchdog** reaches the notice deadline. A passing result requires a stopped paid session before lease expiry, one signed terminal STOPPED tick, paired signed meter evidence, durable preemption enforcement, and physical absence of the original Cell. After two further watchdog cycles, an explicit due sweep must find nothing to enforce and leave the terminal tick and enforcement timestamp unchanged.

The driver closes the disposable listener and journal and checks only containers labeled with its fresh host key. A leftover Cell makes the result fail even if forced cleanup succeeds. The private temporary state is removed at shutdown. stdout contains a bounded JSON report with no private keys. Failures exit nonzero with a stage and safe code.

This acceptance establishes the host-side opt-in, notice, and real gVisor watchdog path for one paid CPU session. It does not establish authenticated Vault owner UI behavior, two-host handoff, paid settlement, Base Chain transactions, GPU execution, or external reliability. Those paths need separate evidence.
