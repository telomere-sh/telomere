#!/usr/bin/env bash
# Dependency preparation only. Never installs or starts a Telomere controller.
set -euo pipefail
test "$(id -u)" = 0
test ! -e /opt/telomere-mainnet-pilot
test "$(dpkg --print-architecture)" = amd64
. /etc/os-release
test "$ID" = debian
test "$VERSION_ID" = 12
if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'install ok installed'; then
  printf '%s\n' 'Conflicting docker.io package: review host before continuing.' >&2
  exit 2
fi
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg age nginx certbot python3 iptables iproute2 util-linux
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'DOCKER_APT'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER_APT
apt-get update
docker_version='5:29.8.1-1~debian.12~bookworm'
apt-get install -y --no-install-recommends "docker-ce=$docker_version" "docker-ce-cli=$docker_version" containerd.io
test "$(docker version --format '{{.Client.Version}}')" = 29.8.1
printf '%s\n' 'Dependencies prepared. Telomere files, keys, units, public TLS and DNS are not activated.'
