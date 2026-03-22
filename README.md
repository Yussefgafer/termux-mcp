# termux-mcp

一个运行在 Termux 里的 `Streamable HTTP` MCP 服务。安装完成后，直接在 Termux 里执行：

```sh
termux-mcp
termux-mcp-shutdown
```

## 一行安装

```sh
curl -fsSL https://raw.githubusercontent.com/yuxinjiang218-creator/termux-mcp/main/install.sh | sh
```

如果你的环境没有 `curl`，也可以用：

```sh
wget -qO- https://raw.githubusercontent.com/yuxinjiang218-creator/termux-mcp/main/install.sh | sh
```

安装脚本会自动完成这些事情：

- 安装缺失依赖：`git`、`nodejs`、`npm`
- 克隆或更新仓库到 `~/termux-mcp`
- 执行 `npm install --omit=dev`
- 安装命令入口到 `~/bin`
- 自动把 `~/bin` 加进 `PATH`

安装后重新打开一次 Termux，或者执行：

```sh
source ~/.bashrc
```

## 使用方法

启动服务：

```sh
termux-mcp
```

停止服务：

```sh
termux-mcp-shutdown
```

默认地址：

```text
http://0.0.0.0:8765/mcp
```

## 已提供的 MCP Tools

- `exec_command`
- `start_session`
- `write_session`
- `read_session`
- `kill_session`
- `read_file`
- `list_files`
- `search_text`
- `apply_patch`
- `view_image`

## 可用环境变量

- `TERMUX_MCP_HOST`
- `TERMUX_MCP_PORT`
- `TERMUX_MCP_RUNTIME_DIR`
- `TERMUX_MCP_ALLOWED_ROOTS`
- `TERMUX_MCP_MAX_OUTPUT`
- `TERMUX_MCP_SESSION_IDLE_MS`
- `TERMUX_MCP_HOME`

示例：

```sh
TERMUX_MCP_PORT=9000 termux-mcp
```

## 卸载

仓库里自带卸载脚本：

```sh
~/termux-mcp/uninstall.sh
```
