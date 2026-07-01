# termux-mcp

**Note:** This is a fork of the original repository. The installation script below has been updated to point to this fork.

An MCP service running on Streamable HTTP in Termux. After installation, you can execute directly in Termux:

```sh
termux-mcp
termux-mcp-shutdown
```

## One-Line Installation

```sh
curl -fsSL https://raw.githubusercontent.com/Yussefgafer/termux-mcp/main/install.sh | sh
```

If your environment doesn't have `curl`, you can use:

```sh
wget -qO- https://raw.githubusercontent.com/Yussefgafer/termux-mcp/main/install.sh | sh
```

The installation script automatically handles:

- Installing missing dependencies: `git`, `nodejs`, `npm`
- Cloning or updating the repository to `~/termux-mcp`
- Running `npm install --omit=dev`
- Installing command entry points to `~/bin`
- Automatically adding `~/bin` to `PATH`

⚠️⚠️After installation, reopen Termux or execute⚠️⚠️:

```sh
source ~/.bashrc 
```

or 

```sh
source ~/.zshrc
```

if you using Zsh


## Usage

Start the service:

```sh
termux-mcp
```

Stop the service:

```sh
termux-mcp-shutdown
```

Default address:

```text
http://0.0.0.0:8765/mcp
```

## Available MCP Tools

- `exec_command`
  - Execute short, one-off shell commands
- `start_session`
  - Start an interactive terminal session for foreground interactive tasks
- `list_sessions`
  - View current active sessions
- `write_session`
  - Write input to a running shell session; use `raw=true` when raw stdin is needed
- `read_session`
  - Read session output in chunks
- `kill_session`
  - End a session
- `start_background_process`
  - Start a long-running service or background task; preferred tool for running services
- `list_background_processes`
  - List background processes started and tracked by termux-mcp
- `read_process_output`
  - Read stdout/stderr logs from background processes in chunks
- `stop_background_process`
  - Gracefully stop a background process, force-kill if necessary
- `read_file`
  - Read text files
- `list_files`
  - List directory contents
- `search_text`
  - Recursively search text
- `apply_patch`
  - Modify files using patch format

## Tool Selection Rules

- For a quick command that finishes fast, use `exec_command`
- To repeatedly execute foreground commands in the same shell while preserving cwd/environment/interactive state, use `start_session` + `write_session` + `read_session`
- To start HTTP services, dev servers, watchers, bots, or long-running loops, use `start_background_process` directly
- To view logs from background services, use `read_process_output`
- To stop background services, use `stop_background_process`

## What You Can Do After Connecting to a Mobile Client

As long as your phone's AI client supports MCP and can connect to this service address, the AI can directly call your terminal and file capabilities in Termux.

Common use cases include:

- Execute commands directly in Termux
  - For example: `ls`, `pwd`, `git status`, `npm install`, `node xxx.js`
- Read and modify project files
  - View source code, search keywords, edit configs, apply patches
- Perform multi-turn terminal interactions
  - Start a persistent session, continuously read output and send input
- Turn your phone's AI into a truly executable terminal assistant
  - Check logs
  - Fix scripts
  - Run project commands
  - Manage repositories
  - Handle everyday development tasks

In one sentence:

> Turn your MCP-supporting mobile AI client into an executable terminal assistant for your Termux environment.

## Available Environment Variables

- `TERMUX_MCP_HOST`
- `TERMUX_MCP_PORT`
- `TERMUX_MCP_RUNTIME_DIR`
- `TERMUX_MCP_ALLOWED_ROOTS`
- `TERMUX_MCP_MAX_OUTPUT`
- `TERMUX_MCP_MAX_SESSION_READ_BYTES`
- `TERMUX_MCP_MAX_PROCESS_READ_BYTES`
- `TERMUX_MCP_MAX_IMAGE_BYTES`
- `TERMUX_MCP_SESSION_IDLE_MS`
- `TERMUX_MCP_RECENT_SESSION_TTL_MS`
- `TERMUX_MCP_BACKGROUND_STOP_GRACE_MS`
- `TERMUX_MCP_HOME`

Example:

```sh
TERMUX_MCP_PORT=9000 termux-mcp
```

### What `read_session` Does Now

To avoid terminal sessions flooding the model with extremely long output all at once, `read_session` now reads in chunks by default:

- By default, returns approximately `12KB` per read
- Tells the client how many `remaining_bytes` are left
- If you just want to peek without consuming the buffer, pass `peek=true`
- If output becomes too large before you read it, the service discards older content and marks `dropped_bytes` in the result

### How to Use `write_session`

- In default mode, `write_session` appends a newline to the input so shell commands execute normally
- If you're interacting with an interactive program and need raw stdin, pass `raw=true`
- If the command is meant to run continuously (like services, watch mode, polling scripts), don't use `write_session`; use `start_background_process` instead

### How to Run Background Services

It's recommended to use the background process tools for long-running services instead of keeping `exec_command` or foreground sessions running:

- `start_background_process` starts the service and returns a `process_id`
- `list_background_processes` checks if it's still running
- `read_process_output` reads the logs
- `stop_background_process` stops the service

## Uninstall

The repository includes an uninstall script:

```sh
~/termux-mcp/uninstall.sh
```
