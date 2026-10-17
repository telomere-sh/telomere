#!/bin/sh
# Dedicated private staging only. Existing Enclave resources are never selected.
set -eu
base=/opt/telomere-pilot
if ! id telomere >/dev/null 2>&1; then useradd --system --home-dir "$base" --shell /usr/sbin/nologin telomere; fi
usermod -aG docker telomere
install -d -m 0750 -o telomere -g telomere "$base/app" "$base/config" "$base/data"
if [ ! -f "$base/config/db.env" ]; then
  umask 077
  password=$(openssl rand -hex 32)
  printf 'POSTGRES_USER=telomere\nPOSTGRES_DB=telomere\nPOSTGRES_PASSWORD=%s\n' "$password" > "$base/config/db.env"
  chown root:telomere "$base/config/db.env"
  chmod 0640 "$base/config/db.env"
fi
if ! docker container inspect telomere-staging-postgres >/dev/null 2>&1; then
  docker pull postgres:16-alpine >/dev/null
  pg_image=$(docker image inspect postgres:16-alpine --format '{{index .RepoDigests 0}}')
  docker run -d --name telomere-staging-postgres --restart unless-stopped --cpus 0.5 --memory 512m --pids-limit 128 \
    --security-opt no-new-privileges --env-file "$base/config/db.env" -p 127.0.0.1:15434:5432 \
    --mount type=volume,source=telomere-staging-pg,target=/var/lib/postgresql/data "$pg_image" >/dev/null
else
  docker start telomere-staging-postgres >/dev/null
fi
attempt=0
until docker exec telomere-staging-postgres pg_isready -U telomere -d telomere >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1
done
docker pull node:22-alpine >/dev/null
cpu_image=$(docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}')
set -a
. "$base/config/db.env"
set +a
umask 077
printf 'DATABASE_URL=postgresql://telomere:%s@127.0.0.1:15434/telomere\nCPU_IMAGE=%s\nSTAGING_PROFILE=%s/config/staging.env\n' "$POSTGRES_PASSWORD" "$cpu_image" "$base" > "$base/config/bootstrap.env"
chown telomere:telomere "$base/config/bootstrap.env"
install -m 0644 "$base/app/infra/telomere-staging-chain.service" /etc/systemd/system/telomere-staging-chain.service
install -m 0644 "$base/app/infra/telomere-staging.service" /etc/systemd/system/telomere-staging.service
systemctl daemon-reload
systemctl enable --now telomere-staging-chain.service >/dev/null
cd "$base/app"
if [ ! -f "$base/config/staging.env" ]; then
  runuser -u telomere -- /opt/node-v22.23.3-linux-x64/bin/node --env-file="$base/config/bootstrap.env" --import=./node_modules/tsx/dist/loader.mjs scripts/staging-prepare.ts
fi
if [ -f "$base/app/dist/src/main.js" ]; then systemctl enable --now telomere-staging.service >/dev/null; fi
printf '{"stagingInstalled":true,"loopbackOnly":true,"apiPort":13280,"chainPort":18547,"databasePort":15434}\n'
