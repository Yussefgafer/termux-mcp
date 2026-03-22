#!/data/data/com.termux/files/usr/bin/sh

set -eu

REPO_URL="${TERMUX_MCP_REPO_URL:-https://github.com/yuxinjiang218-creator/termux-mcp.git}"
INSTALL_DIR="${TERMUX_MCP_HOME:-$HOME/termux-mcp}"
BIN_DIR="$HOME/bin"
PROFILE_BASHRC="$HOME/.bashrc"
PROFILE_BASH_PROFILE="$HOME/.bash_profile"
PATH_BLOCK_START="# >>> termux-mcp >>>"
PATH_BLOCK_END="# <<< termux-mcp <<<"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

append_path_block() {
  target="$1"
  if [ ! -f "$target" ]; then
    : >"$target"
  fi

  if grep -Fq "$PATH_BLOCK_START" "$target"; then
    return 0
  fi

  cat >>"$target" <<EOF
$PATH_BLOCK_START
export PATH="\$HOME/bin:\$PATH"
$PATH_BLOCK_END
EOF
}

install_wrappers() {
  mkdir -p "$BIN_DIR"

  cat >"$BIN_DIR/termux-mcp" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
exec "\$HOME/termux-mcp/bin/termux-mcp" "\$@"
EOF

  cat >"$BIN_DIR/termux-mcp-shutdown" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
exec "\$HOME/termux-mcp/bin/termux-mcp-shutdown" "\$@"
EOF

  chmod +x "$BIN_DIR/termux-mcp" "$BIN_DIR/termux-mcp-shutdown"
}

echo "[1/5] 检查依赖"
MISSING_PACKAGES=""
need_cmd git || MISSING_PACKAGES="$MISSING_PACKAGES git"
need_cmd node || MISSING_PACKAGES="$MISSING_PACKAGES nodejs"
need_cmd npm || MISSING_PACKAGES="$MISSING_PACKAGES nodejs"

if [ -n "$MISSING_PACKAGES" ]; then
  pkg update -y
  pkg install -y $MISSING_PACKAGES
fi

echo "[2/5] 安装或更新仓库"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  echo "安装目录已存在但不是 git 仓库: $INSTALL_DIR"
  exit 1
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "[3/5] 安装 Node 依赖"
cd "$INSTALL_DIR"
npm install --omit=dev
chmod +x "$INSTALL_DIR/bin/termux-mcp" "$INSTALL_DIR/bin/termux-mcp-shutdown"

echo "[4/5] 安装命令入口"
install_wrappers

echo "[5/5] 配置 PATH"
append_path_block "$PROFILE_BASHRC"
append_path_block "$PROFILE_BASH_PROFILE"

echo
echo "安装完成。"
echo "重新打开一次 Termux，或执行: source ~/.bashrc"
echo "启动命令: termux-mcp"
echo "停止命令: termux-mcp-shutdown"
