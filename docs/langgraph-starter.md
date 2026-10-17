# LangGraph paid CPU Cell starter

Current network target: Base 8453 / Base Sepolia 84532 with native USDC. Dated acceptance and linked JSON evidence retain their original network/source scope; see [migration record](base-usdc-migration-2026-10-14.md).

`python/examples/langgraph_paid_cpu.py` is a runnable, deterministic [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) workflow for one bounded Telomere SHA-256 CPU run. It uses the checked Python SDK to verify the deployment pins, operator quote signature, workload, tariff, ceiling and exact `openRun` calldata. A [LangGraph interrupt](https://docs.langchain.com/oss/python/langgraph/interrupts) stops **before** any paid run is admitted. The owner reviews and sends the displayed unsigned transaction in an external wallet, then supplies the original confirmed transaction hash. The graph resumes, admits that reservation and polls the run status. No model API credential is needed because the example is a tool workflow, not an LLM agent.

The optional dependencies are pinned in `python/examples/requirements-langgraph.txt` (`langgraph==1.2.12`, `eth-account==0.13.7`). From the repository root on Windows:

```powershell
python -m venv .local/langgraph-venv
.local\langgraph-venv\Scripts\python.exe -m pip install -e .\python -r .\python\examples\requirements-langgraph.txt
$env:TELOMERE_LANGGRAPH_PYTHON=(Resolve-Path '.local\langgraph-venv\Scripts\python.exe').Path
npx vitest run tests/langgraph-starter.test.ts
```

On POSIX, use `.local/langgraph-venv/bin/python` for the install and `TELOMERE_LANGGRAPH_PYTHON="$PWD/.local/langgraph-venv/bin/python" npx vitest run tests/langgraph-starter.test.ts`. The smoke test starts a disposable Anvil chain and real controller, funds an owner Leash, launches the Python graph, confirms that it pauses with an unsigned intent, sends **exactly that intent** from the separate test wallet, and resumes to a completed run. Its temporary owner key is confined to the TypeScript test fixture. The Python process receives no owner/operator private key.

To run against an existing controller, first use an owner wallet to fund the escrow and create a confirmed Leash. Obtain chain ID, escrow, token and receipt-signer pins from the reviewed deployment record independently of the API. For a remote controller, use its HTTPS origin. Then run, replacing every placeholder:

```powershell
.local\langgraph-venv\Scripts\python.exe python\examples\langgraph_paid_cpu.py `
  --origin https://your-reviewed-telomere-origin.example `
  --chain-id 84532 `
  --escrow-address 0xREVIEWED_ESCROW `
  --token-address 0xREVIEWED_USDC `
  --receipt-signer 0xREVIEWED_RECEIPT_SIGNER `
  --leash-id 0xCONFIRMED_LEASH_ID `
  --idempotency-key your-durable-run-key-001 `
  --text "hello from LangGraph" --max-seconds 5 `
  --owner-address 0xYOUR_OWNER_WALLET
```

The CLI prints the scoped login challenge on stderr. Sign that message in the external owner wallet and paste its signature. It then emits one JSON `wallet_action` line on stdout containing the verified chain, target, calldata, maximum cost and quote expiry. Review and send that exact `openRun` transaction in the same wallet; **wait for confirmation** and paste its hash at the prompt. The second JSON line contains the admission and latest run status. A pending status can be checked again through the owner SDK or `/api/runs/{runId}`. The CLI never signs or broadcasts a payment.

For a disposable local demo with a separately controlled demo owner wallet, replace `--owner-address` with `--demo-auth`; this works only on loopback chain 31337 and still requires that external wallet to send `openRun`. The automated smoke above is the reproducible local path that provisions that wallet, deposit and Leash.

The example uses an in-memory LangGraph checkpointer and keeps the SDK's verified quote in the same process during the wallet pause. Keep the process alive while confirming payment. If it exits after broadcast or a transaction result is uncertain, reconcile the **original** run ID and transaction with the wallet/explorer and controller before retrying; do not create a new payment or idempotency key to guess an outcome. The quote expires after five minutes, the CPU limit is 120 seconds, and this graph does not perform lifecycle, GPU, arbitrary code execution, x402 payment or durable cross-process recovery. The output is application data, not a trusted instruction.
