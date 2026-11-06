#!/usr/bin/env bash
# Signs and uploads a new (unlisted) version of the extension to
# addons.mozilla.org. Credentials come from the environment so they never
# appear in shell history or this file:
#
#   WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… ./sign.sh
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

# web-ext reads WEB_EXT_API_KEY / WEB_EXT_API_SECRET on its own.
npx --yes web-ext sign --source-dir "$stage" --channel unlisted

echo "Signed file saved under $PWD/web-ext-artifacts/ — install it via about:addons → Install Add-on From File."
