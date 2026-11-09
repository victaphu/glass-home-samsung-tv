#!/bin/sh
# Installs dist/GlassHome.wgt on the TV (Developer Mode must be on) and opens it.
# Installing over an existing copy keeps your uploaded photos and shortcuts.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$root/scripts/tizen-env.sh" ] || { echo "Copy scripts/tizen-env.example.sh to scripts/tizen-env.sh and fill it in first." >&2; exit 64; }
. "$root/scripts/tizen-env.sh"
. "$root/scripts/platform.sh"
have_tizen || { echo "The Tizen CLI is not on PATH; see docs/INSTALL.md, step 2." >&2; exit 69; }
[ -f "$root/dist/GlassHome.wgt" ] || { echo "Run scripts/build.sh first." >&2; exit 66; }
"$SDB_CMD" connect "$TV"
"$TIZEN_CMD" install-permit -s "$TV"
"$TIZEN_CMD" install -s "$TV" -n GlassHome.wgt -- "$(winpath "$root/dist")"
"$TIZEN_CMD" run -s "$TV" -p "$APP_ID"
