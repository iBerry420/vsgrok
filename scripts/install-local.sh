#!/usr/bin/env bash
# Build + package + install VSGrok into local VS Code and/or Cursor.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> npm install (extension)"
npm install --silent

echo "==> bridge deps"
(cd bridge && npm ci --omit=dev --silent)

echo "==> build"
npm run build

echo "==> package VSIX"
VER=$(node -p "require('./package.json').version")
npx --yes @vscode/vsce package --no-dependencies >/dev/null
VSIX="$ROOT/vsgrok-${VER}.vsix"
if [[ ! -f "$VSIX" ]]; then
  VSIX=$(ls -1t "$ROOT"/vsgrok-*.vsix 2>/dev/null | head -1)
fi
echo "    $VSIX"

install_one() {
  local bin="$1"
  if command -v "$bin" >/dev/null 2>&1; then
    echo "==> install into $bin"
    "$bin" --install-extension "$VSIX" --force
    echo "    OK: $($bin --list-extensions | grep -i vsgrok || true)"
  else
    echo "==> skip $bin (not on PATH)"
  fi
}

install_one code
install_one cursor

cat <<'EOF'

Done. Next steps:
  1. Reload Window (Command Palette → Developer: Reload Window)
  2. Open the Secondary Side Bar (right) — View → Appearance → Secondary Side Bar
  3. Command Palette → "VSGrok: Open Chat"

If the panel is missing:
  - Extensions → search "@installed vsgrok" → ensure Enabled
  - Output panel → "VSGrok" for bridge errors
  - Ensure Node.js is on PATH (the bridge runs with `node`, not Electron)

EOF
