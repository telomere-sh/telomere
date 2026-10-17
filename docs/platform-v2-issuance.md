# Opt-in complete CPU receipt issuance

The paid Platform runtime can now issue a v2 receipt for a one-shot CPU run. It uses the actual HostKit `/v2/leases` response, the original signed private lease, quote and controller delegation, and the complete persisted signed tick/ACK sequence. The public core commits the signed host admission and a salted output commitment. CPU computation, exit code, output correctness, hardware confidentiality and an independent delegation signing time remain unproven.

The default runtime still issues v1 receipts. Existing rows retain version 1. The new `receipt_version` column defaults to 1; opting in affects newly created CPU quotes only. A v1 financial receipt is never relabeled. A configured v2 pool requires exclusive one-shot HostKit journals. Paid sessions and CPU plus inference use their separate reviewed v1 deployments; inference-only calls can retain their v1 provider billing route.

## Durable ordering

1. Store the exact signed lease and EOA delegation, then the exact v2 admission envelope before its first POST.
2. Receive and verify the signed host admission, store it and read it back before processing ticks.
3. Confirm host cleanup, preserve the first terminal private result, then freeze the original private outcome, salt and canonical opening reference in a draft journal.
4. Verify every signed pair and admission/opening binding; store and read back the canonical redacted core and private salt.
5. Publish the exact core and manifest to both configured stores and read both copies back.
6. Persist the v2 financial settlement. Revalidate original evidence and both copies before recording the financial leaf, settlement broadcast and final outcome reconciliation.

An uncertain store write leaves the first preimage intact. Restart uses the same salt, output, core, object keys and receipt hash. Missing or conflicting copies block financial issuance. A public reader never repairs storage; the private producer can retry the original bytes through immutable conditional writes.

A lost HostKit admission response is recovered from its original envelope only after stopping and confirming cleanup of the original host run. A crash before the first POST cannot cause recovery to dispatch that envelope. If the controller has no host lease, or confirmed cleanup lacks a complete terminal paired history, the run enters explicit no-receipt reconciliation and awaits its original permissionless timeout refund. It does not fabricate ticks, ACKs or a v1 receipt. Unknown cleanup still blocks recovery.

## Operator configuration

Add an explicit `receiptV2` object to the private `PLATFORM_RUNTIME_CONFIG` file after reviewing the host and storage configuration. The configuration shape is:

```json
{
  "receiptV2": {
    "enabled": true,
    "minConfirmations": 12,
    "stores": [
      {
        "identity": "evidence-first",
        "failureDomain": "provider-region-first",
        "endpoint": "https://first-storage.example",
        "bucket": "telomere-evidence-first",
        "region": "us-east-1",
        "credentialsFile": "/run/secrets/evidence-first.json"
      },
      {
        "identity": "evidence-second",
        "failureDomain": "provider-region-second",
        "endpoint": "https://second-storage.example",
        "bucket": "telomere-evidence-second",
        "region": "us-west-1",
        "credentialsFile": "/run/secrets/evidence-second.json"
      }
    ]
  }
}
```

This is a configuration fragment with illustrative endpoints. It does not replace the required reviewed contract pins, signer key file and host definitions. The host must separately run its reviewed v2 exclusive configuration. Each credentials file is a private bounded regular JSON file with `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Credentials never appear in capacity or public evidence. Public networks require at least twelve confirmations; the same reviewed depth is used by the HTTP verifier. Endpoint origins must use HTTPS. Identical identities, declared failure domains, or endpoint/bucket destinations are rejected. Session-enabled hosts cannot share this pool.

The [S3 transport and publication journal](platform-v2-publication.md) use SigV4 and conditional immutable PUT followed by exact readback. This enforces immutability through this API; it does not prove bucket Object Lock, administrative independence or regional resilience. Successful retrieval reports `configuredCopiesVerified: true`, `storageAssurance: "two-operator-declared-domains"` and `independentlyPublished: false`.

## Public retrieval and acceptance

`GET /api/platform/public/v2/runs/<runId>?settlementTransactionHash=<hash>` fetches both configured copies, checks their manifest/core digests, verifies canonical opening and financial settlement/root, and rechecks both copies. It returns the redacted core, publication manifest and verification result. The caller cannot select storage endpoints, chain pins, RPC or confirmation depth. The existing caller-presented `POST /verify` remains available for independently obtained cores. See [API bounds](platform-v2-public-api.md).

`tests/platform-v2-issuance.test.ts` exercises real local Anvil contracts and a HostKit process fixture, a second-copy failure, disk reopen, unchanged receipt/salt and one physical process start, storage failure before financial issuance, canonical settlement and public HTTP retrieval, corruption rejection, and unexecuted timeout refund. These tests are local acceptance. Live gVisor/CPU-host rollout, approved Base contracts and archive RPC, independently verified storage durability/domains, current verified inference, physical-host-loss recovery and funded owner tests remain release gates.
