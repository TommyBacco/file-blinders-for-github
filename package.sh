#!/usr/bin/env bash
# Rebuilds the installable file-blinders-for-github.xpi.
# Unsigned: load it as a temporary add-on (about:debugging) or sign it with
# your own AMO account for a permanent install.
set -euo pipefail
cd "$(dirname "$0")"

rm -f file-blinders-for-github.xpi
python3 - <<'PY'
import zipfile
with zipfile.ZipFile('file-blinders-for-github.xpi', 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('manifest.json', 'content.js', 'popup.html', 'popup.js', 'README.md'):
        z.write(name)
PY
printf 'Created %s\n' "$PWD/file-blinders-for-github.xpi"
