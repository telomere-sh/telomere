# Update 02: verified refund dashboard

Status: prepared locally, not deployed or pushed. Enable only with
`POSTLAUNCH_FEATURES=refunds` after deploying its source commit. The existing
public verifier is unaffected. Public page `/refunds/`; aggregate endpoint
`GET /api/public/insights/refunds?period=24h|7d|all`. Default OFF returns no feature
endpoint; the page reports that this deployment has not enabled the tool.

All totals come from final controller-recorded runs verified against signed
receipts and canonical escrow events. There is no fixed total-history cutoff:
25-row pages and two concurrent readers progressively scan every candidate.
Only fixed totals and up to 90 daily buckets per period are held in memory.
A rebuildable PostgreSQL read model supports later bounded accounting reads;
it is not an authority for balances or settlement. Source scope, complete/partial
coverage, excluded records, UTC timestamp and chart window are displayed.

Successful unused reservations, failed/cancelled/timed-out settled-run returns,
direct timeout refunds and unknown signed outcomes are separate. Empty data is
distinct from an unavailable source. ETH gas is excluded. Amounts use atomic
integer arithmetic; displayed timing is reservation-to-return from block time,
not claimed failure-processing latency. Returns release escrow funds; withdrawals
to wallets are not counted. A period with no records shows no data.

The source excludes unfunded expired quotes. Missing hashes, invalid receipts,
wrong token/payer/workload, incorrect event amounts, unconfirmed/noncanonical
transactions and unavailable RPC never become confirmed totals. A chain anchor
is checked again before a cached complete snapshot is served. Cache refresh is
shared and limited to once a minute. While a refresh is in progress the page
shows partial coverage; the first zero-record accumulator is not shown as a
measured zero. The browser polls only while its cached SPA page is visible and
aborts on navigation. No owner, run payload or output appears in public reports.

Older wallet-origin timeout refunds may lack a locally stored transaction hash.
Their owner can attach confirmed evidence through authenticated
`POST /api/insights/refund-evidence` with `{runId,transactionHash}`. This only saves
a verified chain-event reference and broadcasts nothing. Other owners are rejected.

Validation includes exact large amounts, >2000 records without truncation,
bounded aggregate memory, category separation, date windows, changed history,
RPC/reorg failures, owner filtering, flags and query bounds. A disposable real
escrow verifies successful returns and wallet-triggered timeout refunds. A separate
read-only production acceptance collected 8 verified Base settlements: total
returned 0.0363 USDC, including 0.0362 successful unused funds and 0.0001 from a
failed run. No production service/configuration change or transaction was made.
