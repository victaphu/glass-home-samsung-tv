#!/bin/sh
# Builds and signs dist/GlassHome.wgt with your Samsung certificate profile.
# Needs scripts/tizen-env.sh (copy it from tizen-env.example.sh).
set -eu
without_photos=false
for arg in "$@"; do
  case "$arg" in
    --without-bundled-photos) without_photos=true ;;
    -h|--help) echo "Usage: scripts/build.sh [--without-bundled-photos]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 64 ;;
  esac
done
root=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$root/scripts/tizen-env.sh" ] || { echo "Copy scripts/tizen-env.example.sh to scripts/tizen-env.sh and fill it in first." >&2; exit 64; }
. "$root/scripts/tizen-env.sh"
command -v tizen >/dev/null || { echo "The Tizen CLI is not on PATH; see docs/INSTALL.md, step 2." >&2; exit 69; }

# The key the app and its service share is made per checkout, never committed.
[ -f "$root/app/js/local-key.js" ] || sh "$root/dev/new-local-key.sh"

rm -rf "$root/app/.buildResult"
tizen build-web -e ".*" -e "*.md" -- "$root/app"
# Change only the generated output: the source photos stay available for the
# next normal build. Keep an empty manifest so the app uses its gradient.
if [ "$without_photos" = true ]; then
  rm -rf "$root/app/.buildResult/wallpapers"
  mkdir -p "$root/app/.buildResult/wallpapers"
  printf '[]\n' > "$root/app/.buildResult/wallpapers/manifest.json"
fi
tizen package -t wgt -s "$PROFILE" -- "$root/app/.buildResult"
mkdir -p "$root/dist"
wgt=$(ls -t "$root/app/.buildResult"/*.wgt | head -1)
cp "$wgt" "$root/dist/GlassHome.wgt"
rm -rf "$root/app/.buildResult"
echo "Built dist/GlassHome.wgt"
