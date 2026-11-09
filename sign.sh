#!/usr/bin/env bash
# Signs and uploads a new version of the extension to addons.mozilla.org.
# Credentials come from the environment so they never appear in shell
# history or this file:
#
#   WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… ./sign.sh
#
# Channel: unlisted by default (self-distributed, no public AMO page). Set
# WEB_EXT_CHANNEL=listed to submit a publicly listed version, which requires
# a completed product page and passes human review:
#
#   WEB_EXT_CHANNEL=listed ./sign.sh
#
# Generate credentials at https://addons.mozilla.org/developers/addon/api/key/
# (generating new credentials invalidates previous ones).
#
# Prerequisite: "version" in manifest.json must be newer than the last
# uploaded version.
set -euo pipefail
cd "$(dirname "$0")"

[ -n "${WEB_EXT_API_KEY:-}" ]    || { echo "WEB_EXT_API_KEY is not set" >&2; exit 1; }
[ -n "${WEB_EXT_API_SECRET:-}" ] || { echo "WEB_EXT_API_SECRET is not set" >&2; exit 1; }

# Stage exactly the files that ship — no repo helpers.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp manifest.json content.js popup.html popup.js README.md "$stage/"
cp -r icons "$stage/"

# web-ext reads WEB_EXT_API_KEY / WEB_EXT_API_SECRET on its own.
channel="${WEB_EXT_CHANNEL:-unlisted}"
case "$channel" in unlisted|listed) ;; *) echo "WEB_EXT_CHANNEL must be listed or unlisted" >&2; exit 1 ;; esac
# Listed submissions need add-on metadata (categories, summary, description,
# license, ...). amo-metadata.json is passed through when present.
amo_meta=()
if [ -f amo-metadata.json ]; then amo_meta=(--amo-metadata amo-metadata.json); fi

npx --yes web-ext sign --source-dir "$stage" --channel "$channel" "${amo_meta[@]}"

echo "Signed ($channel) file saved under $PWD/web-ext-artifacts/ — install it via about:addons → Install Add-on From File."
