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
export TELOMERE_ACCEPTANCE_GVISOR_IMAGE=node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
export TELOMERE_ACCEPTANCE_DECLARED_STATE_CELL=1
npm test -- tests/paid-cyst-file-restore.test.ts
sudo python3 ops/isolated-acceptance/gvisor-daemon.py stop gvisor-review-20261018
```

Use an exit trap or CI `if: always()` for teardown. Stop preserves fixture data and logs. Tests track and remove their own containers; teardown checks the private daemon's actual data root before removing any remaining fixture containers. No orphan cleanup is issued against another daemon.

The bootstrap checks the official release archive SHA-512 and all seven executable SHA-256 pins in `security/gvisor-runtime-pins.json`. A local `--runtime-source /absolute/reviewed/gvisor` may supply the same complete pinned distribution. A lone `runsc` binary is insufficient. Public executable parents remain searchable so gVisor can re-execute sidecars after dropping privileges. Runtime setup follows the [official installation layout](https://gvisor.dev/docs/user_guide/install/); it never invokes `runsc install` or reloads the default daemon.

Tests validate private profile/socket/session paths, the daemon's actual data root, its default runtime, every gVisor executable and the image's repository digest. An environment variable alone cannot substitute a mock, the production socket or an unpinned image.

The native Windows private-file suite is separate: `npm test -- tests/vault-income-private-file.test.ts`. POSIX cases run on Linux; the Windows ACL case runs on Windows. Never count OS-specific skips as successful execution.
