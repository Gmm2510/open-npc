#!/usr/bin/env bash
# Puts up a GitHub Release for the built jar of one Minecraft version, once: tag v<mod version>-mc<minecraft>, notes from
# CHANGELOG.md. Run from mod/ after the build and tests passed.
#   tools/release.sh <minecraft> <loader> <fabric api> <commit> [automatic]
# DRY_RUN=1 prints what it would do instead.
set -euo pipefail
MC="$1"; LOADER="$2"; API="$3"; SHA="$4"; AUTO="${5:-}"
MODV=$(grep '^mod_version=' gradle.properties | cut -d= -f2 | tr -d '\r')
TAG="v${MODV}-mc${MC}"
JAR="build/libs/open-npc-${MODV}+mc${MC}.jar"
TITLE="Open NPC ${MODV} for Minecraft ${MC}"
test -f "$JAR" || { echo "no $JAR: build it first"; exit 1; }
NOTES=$(mktemp)
node tools/release_notes.mjs "$MODV" "$MC" "$LOADER" "$API" $AUTO > "$NOTES"
if [ -n "${DRY_RUN:-}" ]; then
  echo "would release $TAG ($TITLE) at $SHA with $JAR"; cat "$NOTES"; exit 0
fi
if gh release view "$TAG" >/dev/null 2>&1; then echo "$TAG is out already"; exit 0; fi
gh release create "$TAG" "$JAR" --target "$SHA" --title "$TITLE" --notes-file "$NOTES"
echo "released $TAG"
