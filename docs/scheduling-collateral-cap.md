# Counted host collateral during scheduling

The original Backend specification limits **host collateral considered for scheduling** to 25,000 six-decimal token units. `selectCapacity` now computes the stake ordering value as `min(bondedCollateral, 25_000_000_000)` atomic units. It applies this value only after eligibility, deadline, budget, effective price, reliability and the five-percent price-band checks. Equal counted stakes retain the existing price/reliability/host-ID tie-break.

The platform quote path reads actual bonded collateral from `HostRegistry.getHost` and passes it to this shared planner. The registry continues to hold, slash and return the full bonded amount. A host can therefore post more than 25,000 tokens, but the excess cannot buy additional scheduling priority. The selected host record still carries the actual amount; the clamp affects only comparison. The other planner callers likewise cannot gain priority from amounts above the cap, though their source-of-stake trust remains a separate integration concern.

The numeric cap assumes the reviewed payment token has six decimals. It does not establish a fiat exchange-rate guarantee. This change does not enforce the separate 2,500-unit Selection Vault custody cap: the Vault can receive direct ERC-20 transfers, which a deposit-method check cannot reject. That cap needs a design accounting for unsolicited transfers and funds already reserved in escrow.

Offline acceptance: `npx vitest run tests/scheduling-collateral-cap.test.ts`. The tests cover the unit immediately below and above the cap, a much larger bond, tie-breaking inside the eligible price band, and preservation of the actual bonded amount.
