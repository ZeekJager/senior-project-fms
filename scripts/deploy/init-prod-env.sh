#!/usr/bin/env bash
# Makes prod.env from prod.env.example with a fresh secret for every change-me (FMS-164, docs/deployment.md).
#
#   scripts/deploy/init-prod-env.sh fleet.example.com ops@example.com <image tag>
#
# Refuses to touch an existing prod.env: its DATA_ENCRYPTION_KEY encrypts data already stored, and a new one
# would make that data unreadable. The file is written readable by its owner only (600). Nothing is printed
# but the names of the values it generated.
set -euo pipefail

cd "$(dirname "$0")/../.."
domain="${1:?usage: $0 <domain> <lets-encrypt e-mail or internal> <image tag>}"
issuer="${2:?usage: $0 <domain> <lets-encrypt e-mail or internal> <image tag>}"
tag="${3:?usage: $0 <domain> <lets-encrypt e-mail or internal> <image tag>}"

if [ -e prod.env ]; then
  echo "prod.env already exists; not changed (its DATA_ENCRYPTION_KEY protects stored data)." >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is needed to generate the secrets" >&2; exit 1; }

secret() { openssl rand -base64 64 | tr -d '/+=\n' | head -c 48; }

umask 077
tmp="$(mktemp prod.env.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}" # a checkout with Windows line endings
  case "$line" in
    FMS_DOMAIN=*) echo "FMS_DOMAIN=$domain" ;;
    FMS_TLS_ISSUER=*) echo "FMS_TLS_ISSUER=$issuer" ;;
    FMS_IMAGE_TAG=*) echo "FMS_IMAGE_TAG=$tag" ;;
    *=change-me) name="${line%%=*}"; echo "$name=$(secret)"; echo "  generated $name" >&2 ;;
    *) echo "$line" ;;
  esac
done < prod.env.example > "$tmp"
mv "$tmp" prod.env
trap - EXIT
chmod 600 prod.env
echo "prod.env written (mode 600). Copy DATA_ENCRYPTION_KEY somewhere off this server now." >&2
