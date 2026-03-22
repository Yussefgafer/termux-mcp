# termux-mcp

Streamable HTTP MCP server for Termux.

## Commands

```sh
termux-mcp
termux-mcp-shutdown
```

Default endpoint:

```text
http://0.0.0.0:8765/mcp
```

## Tools

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

## Environment

- `TERMUX_MCP_HOST`
- `TERMUX_MCP_PORT`
- `TERMUX_MCP_RUNTIME_DIR`
- `TERMUX_MCP_ALLOWED_ROOTS`
- `TERMUX_MCP_MAX_OUTPUT`
- `TERMUX_MCP_SESSION_IDLE_MS`
