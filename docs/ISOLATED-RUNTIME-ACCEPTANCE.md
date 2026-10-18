# Isolated CPU runtime acceptance

The opt-in HostKit and session tests can use a separate, explicitly reviewed daemon instead of a particular operator installation. No default Docker configuration, production service or production socket is changed. The normal portable test command still does not start Docker.

Run on Linux x86_64 with Docker, systemd and root access. From a clean checkout:

```sh
sudo python3 ops/isolated-acceptance/gvisor-daemon.py start gvisor-review-20261018
export TELOMERE_ISOLATED_GVISOR_MANIFEST=/var/tmp/telomere-audit-gvisor-review-20261018/manifest.json
export TELOMERE_HOST_ADMISSION_DOCKER_ACCEPTANCE=1
export TELOMERE_HOST_STARTUP_DOCKER_ACCEPTANCE=1
export TELOMERE_SESSION_DOCKER_ACCEPTANCE=1
npm test -- tests/host-kit-admission-docker.test.ts tests/host-kit-startup-docker.test.ts tests/session-runtime-docker.test.ts
export TELOMERE_ACCEPTANCE_GVISOR_SOCKET=/run/telomere-audit-gvisor-review-20261018/docker.sock
sudo env PATH="$PATH" python3 ops/isolated-acceptance/declared-image.py gvisor-review-20261018
export TELOMERE_ACCEPTANCE_DECLARED_STATE_IMAGE_REPORT=/var/tmp/telomere-audit-gvisor-review-20261018/declared-image.json
export TELOMERE_ACCEPTANCE_GVISOR_IMAGE=$(sudo python3 -c 'import json; print(json.load(open("/var/tmp/telomere-audit-gvisor-review-20261018/declared-image.json"))["image"])')
export TELOMERE_ACCEPTANCE_DECLARED_STATE_CELL=1
npm test -- tests/paid-cyst-file-restore.test.ts
sudo python3 ops/isolated-acceptance/gvisor-daemon.py stop gvisor-review-20261018
```

Use an exit trap or CI `if: always()` for teardown. Stop preserves fixture data and logs. Tests track and remove their own containers; teardown checks the private daemon's actual data root before removing any remaining fixture containers. No orphan cleanup is issued against another daemon.

The declared-state scenario requires an extension image containing the current Cell adapters; the plain Node image is sufficient for session tests. The builder records the clean source commit, Dockerfile and both bundle hashes. Its temporary registry binds only `127.0.0.1` inside the isolated daemon, stores the image locally and is removed after the build. It performs no push to a public registry. The test checks the actual image's adapter bytes before opening a paid fixture reservation. A missing hook is a configuration error, not a reason to weaken the acknowledgement check.

The bootstrap checks the official release archive SHA-512 and all seven executable SHA-256 pins in `security/gvisor-runtime-pins.json`. A local `--runtime-source /absolute/reviewed/gvisor` may supply the same complete pinned distribution. A lone `runsc` binary is insufficient. Public executable parents remain searchable so gVisor can re-execute sidecars after dropping privileges. Runtime setup follows the [official installation layout](https://gvisor.dev/docs/user_guide/install/); it never invokes `runsc install` or reloads the default daemon.

Tests validate private profile/socket/session paths, the daemon's actual data root, its default runtime, every gVisor executable and the image's repository digest. An environment variable alone cannot substitute a mock, the production socket or an unpinned image.

The native Windows private-file suite is separate: `npm test -- tests/vault-income-private-file.test.ts`. POSIX cases run on Linux; the Windows ACL case runs on Windows. Never count OS-specific skips as successful execution.

## Additional offline acceptance

`TELOMERE_LIFECYCLE_V3_CAPACITY_ACCEPTANCE=1 npm test -- tests/paid-lifecycle-vault-v3.test.ts` runs the actual 960-hop, 20,000+ immutable-record fixture with journal reopen and recovery. These are logical lifecycle hops, not hours of wall-clock soak or paid transactions.

`TELOMERE_ESCROW_EXTENDED_ACCEPTANCE=1 npm test -- tests/escrow-stateful.test.ts` runs 16 fixed seeds with 512 scheduled steps each. It retains separate success/failure traces in `.local/audit-remediation/stateful-extended/`, including actual transaction/revert counts; the default three shorter campaigns remain available. A failed campaign never reports a zero final escrow balance.

For the LangGraph starter, create a dedicated Python 3.11 environment and install `python/examples/requirements-langgraph.lock` with `--only-binary=:all: --require-hashes`. Set `PYTHONPATH=python/src` and `TELOMERE_LANGGRAPH_PYTHON` to its interpreter, then run `npm test -- tests/langgraph-starter.test.ts`. Tracing is disabled in the fixture. It exercises the real wallet interrupt against local disposable Anvil accounts, without model-provider calls or real funds.
