#!/bin/bash
set -u
badge_root="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
for badge_node in "${CODEX_BADGE_NODE:-}" \
  "${CODEX_BADGE_APP:-/Applications/Codex.app}/Contents/Resources/cua_node/bin/node" \
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "$HOME/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "$(command -v node 2>/dev/null || true)";
do
  if [ -x "$badge_node" ] && "$badge_node" -e 'if(+process.versions.node.split(".")[0]<24)process.exit(1)' >/dev/null 2>&1; then
    exec "$badge_node" "$badge_root/updater/worker.cjs" "$@"
  fi
done
echo "自动更新暂不可用：未找到 Node.js 24+。" >&2
exit 1
