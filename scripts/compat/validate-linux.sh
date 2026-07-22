#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/compat/versions.env"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/proxyhub-compat"
rm -rf "$WORK"
mkdir -p "$WORK/bin" "$WORK/config" "$WORK/mihomo-home"

curl --fail --location --silent --show-error \
  "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${MIHOMO_LINUX_ASSET}" \
  --output "$WORK/$MIHOMO_LINUX_ASSET"
echo "$MIHOMO_LINUX_SHA256  $WORK/$MIHOMO_LINUX_ASSET" | sha256sum --check --status
gzip --decompress --stdout "$WORK/$MIHOMO_LINUX_ASSET" > "$WORK/bin/mihomo"
chmod +x "$WORK/bin/mihomo"

curl --fail --location --silent --show-error \
  "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${SING_BOX_LINUX_ASSET}" \
  --output "$WORK/$SING_BOX_LINUX_ASSET"
echo "$SING_BOX_LINUX_SHA256  $WORK/$SING_BOX_LINUX_ASSET" | sha256sum --check --status
tar --extract --gzip --file "$WORK/$SING_BOX_LINUX_ASSET" --directory "$WORK"
cp "$WORK/sing-box-${SING_BOX_VERSION}-linux-amd64/sing-box" "$WORK/bin/sing-box"
chmod +x "$WORK/bin/sing-box"

cd "$ROOT"
pnpm compat:generate --output "$WORK/config"
"$WORK/bin/mihomo" -v
"$WORK/bin/sing-box" version
"$WORK/bin/mihomo" -t -f "$WORK/config/mihomo.yaml" -d "$WORK/mihomo-home"
"$WORK/bin/sing-box" check -c "$WORK/config/sing-box.json"
echo "Validated against Mihomo ${MIHOMO_VERSION} and sing-box ${SING_BOX_VERSION}."
