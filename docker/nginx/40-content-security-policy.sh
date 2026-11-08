#!/bin/sh
# Writes the web app's Content-Security-Policy header (FMS-103, docs/security.md) when the container starts, from its environment.
# Runs before nginx, from /docker-entrypoint.d, as the unprivileged user. The result is included by every location
# (security-headers.conf), because an add_header in a location replaces the server-level ones.
#
#   CSP_MODE         report-only (default): the browser reports what the policy would block, in its console, and blocks nothing.
#                    enforce: it blocks. off: no header.
#   CSP_IMG_SOURCES  where images may come from besides this site, data: and blob: (default: OpenStreetMap's tile server, which the map
#                    uses). Set it to the host of VITE_MAP_TILE_URL if the build changed it.
set -eu

out=/etc/nginx/snippets/csp.conf
mode="${CSP_MODE:-report-only}"
images="${CSP_IMG_SOURCES:-https://tile.openstreetmap.org}"

case "$mode" in
  report-only) header=Content-Security-Policy-Report-Only ;;
  enforce) header=Content-Security-Policy ;;
  off)
    : >"$out"
    exit 0
    ;;
  *)
    echo "CSP_MODE must be report-only, enforce or off (is: $mode)" >&2
    exit 1
    ;;
esac

# The value goes into an nginx string: only host-source characters, so it cannot end the string or the policy.
case "$images" in
  *[!A-Za-z0-9:/.*_\ -]*)
    echo "CSP_IMG_SOURCES may hold only letters, digits and : / . * _ - and spaces" >&2
    exit 1
    ;;
esac

# Scripts, fonts, workers and connections (the API, and its Socket.IO) only from this site; styles may be inline (React and Leaflet set
# style attributes); the page may not be framed, nor embed plugins, nor submit a form elsewhere.
policy="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${images}; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

printf 'add_header %s "%s" always;\n' "$header" "$policy" >"$out"
echo "content security policy: $mode"
