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
- 分块读取会话输出，避免一次性把大量终端内容灌进上下文
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
- 读取本地图片，并返回真正的图片内容给多模态客户端

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
- `TERMUX_MCP_MAX_SESSION_READ_BYTES`
- `TERMUX_MCP_MAX_IMAGE_BYTES`
- `TERMUX_MCP_SESSION_IDLE_MS`
- `TERMUX_MCP_HOME`

示例：

```sh
TERMUX_MCP_PORT=9000 termux-mcp
```

### `read_session` 现在会做什么

为了避免终端会话把超长输出一次性灌给模型，`read_session` 改成了默认按块读取：

- 默认单次最多返回约 `12KB`
- 会告诉客户端还有多少 `remaining_bytes`
- 如果只是想偷看但不消费缓冲区，可以传 `peek=true`
- 如果输出在你读取前就已经太大，服务会丢弃更早的旧内容，并在结果里标出 `dropped_bytes`

### `view_image` 返回的是什么

`view_image` 不再只返回文件元信息，而是会返回：

- 一段简短文字说明
- 一条原生 MCP `image` content

这样支持多模态的客户端就能把图片真正送进模型上下文，而不只是告诉模型“这里有一张图”。

## 卸载

仓库里自带卸载脚本：

```sh
~/termux-mcp/uninstall.sh
```
