# Two CPU lane offers on one physical host

Backend §3 allows a host to publish a price for each lane. The mounted Platform CPU runtime and paid Vault jobs now support both `standard` and `interruptible` offers on the **same physical HostKit host**, with independent full/lean/torpor CPU rates. The optional catalogue uses `telomere-cpu-lane-offers-v1`.

The public `capacity` list still contains one row per physical host. A host retains one registered host ID, Ed25519 key, transport, image, region and shared admission slot. Nested offers do not create another host, a free reservation or concurrent capacity. The reviewed catalogue remains bounded to sixteen physical hosts and at most two offers per host.

An operator may add this field to an existing reviewed session host:

```json
{
  "lane": "standard",
  "pricePerSecond": "200",
  "sessionPrices": { "full": "200", "lean": "120", "torpor": "60" },
  "laneOffers": {
    "protocol": "telomere-cpu-lane-offers-v1",
    "offers": [
      {
        "lane": "standard",
        "pricePerSecond": "200",
        "sessionPrices": { "full": "200", "lean": "120", "torpor": "60" }
      },
      {
        "lane": "interruptible",
        "pricePerSecond": "100",
        "sessionPrices": { "full": "100", "lean": "80", "torpor": "40" },
        "interruptible": {
          "protocol": "telomere-paid-preemption/v1",
          "minimumNoticeSeconds": 30,
          "hostOptInRequired": true
        }
      }
    ]
  }
}
```

Prices are integer micro-USDC per billable second before the applicable escrow fee. The versioned list must contain the exact existing base offer, including any profile rates and capability. Duplicate lanes, zero prices, a mismatched full price, another physical identity inside an offer, absent session support or an interruptible offer without explicit preemption capability are refused. Omitting `laneOffers` preserves the previous single-lane configuration and public response.

Placement expands the reviewed offers internally and checks each against the original Leash, deadline, region/image filters, total fee-inclusive budget, canonical pending liabilities and actual signed HostKit capacity. Staking weights remain one observation per physical host; reliability remains scoped to the particular lane. Excluding a physical host excludes both offers, including during replacement after preemption.

The selected lane remains in the existing optional `cpuScheduling` workload commitment. The selected price is fixed by the original controller-signed quote, and the CPU resource profile remains in the signed session task and HostKit lease. Dispatch rechecks the exact selected lane and profile rate. A missing reduced-quota price never falls back to the other lane's rate. Existing quote domains, contracts and omitted-field workload hashes are unchanged.

The Node EOA/Vault SDKs and Python SDK independently validate the nested catalogue and the exact requested lane/profile before returning an unsigned payment plan. A retained plan is not silently repriced if an offer is withdrawn. Ordinary standard-lane quotes still use the original omitted-field workload; interruptible Vault work still requires explicit owner consent and durable HostKit opt-in. Payment, replacement approval and application restoration retain their existing external-owner actions.

The actual local acceptance uses Anvil, authenticated HTTP, two HostKit child-process session fixtures, a signed thirty-second notice, encrypted application checkpoint/restore, canonical source and target settlements and lost-response recovery. The source publishes standard `200` and interruptible `100` under one host ID; its active reservation makes a new standard-lane quote unavailable through the same physical slot. After cleanup, standard full/lean/torpor quotes retain rates `200`/`120`/`60`. The public receipt-derived CPU price board continues to report only the settled original lane/rate.

The author acceptance above uses `LocalSessionFixtureBackend`, which provides no sandbox or TEE isolation. The later [actual Linux/gVisor cohort](evidence/backend-completion-linux-20261015/completion-gvisor-acceptance.json) separately passed the same complete CPU acceptance case, together with all 166 other cases in its 15-file cohort, with no failures or skips. It uses test revision `36d8a7f` and the d448 reviewed declared-state image; test-only continuity preserves the CPU production implementation. Source and target HostKit identities run real owned gVisor Cells on one physical VPS. They do not establish physical-host independence, hardware attestation, public Base payment, dynamic host price submission, GPU classes, a supplier marketplace, arbitrary-length deadline work or autonomous funding. See the [completion record](backend-completion-2026-10-15.md) for immutable source/image boundaries and retained failed attempts.
