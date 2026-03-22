#!/data/data/com.termux/files/usr/bin/sh

set -eu

INSTALL_DIR="${TERMUX_MCP_HOME:-$HOME/termux-mcp}"
RUNTIME_DIR="${TERMUX_MCP_RUNTIME_DIR:-$HOME/.termux-mcp}"
BIN_DIR="$HOME/bin"
PROFILE_BASHRC="$HOME/.bashrc"
PROFILE_BASH_PROFILE="$HOME/.bash_profile"
PATH_BLOCK_START="# >>> termux-mcp >>>"
PATH_BLOCK_END="# <<< termux-mcp <<<"

remove_path_block() {
  target="$1"
  if [ ! -f "$target" ]; then
    return 0
  fi

  tmp_file="$(mktemp)"
  awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
    $0 == start { skip=1; next }
    $0 == end { skip=0; next }
    !skip { print }
  ' "$target" >"$tmp_file"
  mv "$tmp_file" "$target"
}

if [ -x "$INSTALL_DIR/bin/termux-mcp-shutdown" ]; then
  "$INSTALL_DIR/bin/termux-mcp-shutdown" >/dev/null 2>&1 || true
fi

rm -f "$BIN_DIR/termux-mcp" "$BIN_DIR/termux-mcp-shutdown"
rm -rf "$INSTALL_DIR" "$RUNTIME_DIR"

remove_path_block "$PROFILE_BASHRC"
remove_path_block "$PROFILE_BASH_PROFILE"

echo "termux-mcp 已卸载。"
