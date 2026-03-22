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
- 执行一次性 shell 命令
- `start_session`
- 启动一个可持续交互的终端会话
- `write_session`
- 向会话写入输入内容
- `read_session`
- 读取会话输出
- `kill_session`
- 结束会话
- `read_file`
- 读取文本文件
- `list_files`
- 列出目录内容
- `search_text`
- 递归搜索文本
- `apply_patch`
- 以 patch 方式修改文件
- `view_image`
- 查看本地图片文件信息

## 接入手机客户端后能做什么

只要你的手机 AI 客户端支持 MCP，并且能连接这个服务地址，AI 就可以直接调用你在 Termux 里的终端和文件能力。

常见用途包括：

- 在 Termux 里直接执行命令
  - 例如 `ls`、`pwd`、`git status`、`npm install`、`node xxx.js`
- 读取和修改项目文件
  - 查看源码、搜索关键字、改配置、打补丁
- 进行多轮终端交互
  - 启动一个持续 session，连续读取输出并继续输入
- 让手机里的 AI 变成真正可执行的终端助手
  - 查日志
  - 修脚本
  - 跑项目命令
  - 管理仓库
  - 处理日常开发任务

一句话概括：

> 把支持 MCP 的手机 AI 客户端，直接变成你在 Termux 上的可执行终端助手。

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
