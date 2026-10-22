# App 架构与通信

旺财由 Electron 界面与插件、SDK、CLI 和机器上的 Rust 后台进程组成：界面展示与交互，
后台进程执行终端、文件与子进程，SDK 连接两者。

代码里的 terminal node / Node 指 Rust 后台进程，不是 Node.js；agent 指业务内核装到远端的那份
`wangcai`，不是编码 agent。

## 壳与 Core

App（本仓库）只是壳：起窗口、装 preload 桥、打包，读 `init.ts` 把插件装好，再确保 Core 已经装好。业务
内核在 [WangCai-Core](https://github.com/lengmoXXL/WangCai-Core)：机器连接（含远端 agent）、工作区与标签、
整个窗口的界面都是它。壳把主题、出网方式和装好的插件清单交给 Core；凡是 Electron 独有的能力——窗口、协议、
session、系统——壳都通过 `CoreHost` 借给 Core。两边共享的桥接契约（scheme、topic、channel、`contractVersion`
与跨桥的类型）在 [@lengmoxxl/sdk](https://www.npmjs.com/package/@lengmoxxl/sdk) 的 `bridge` 模块。

发布时壳不再随包带 Core。启动的第一件事是确认数据目录里有没有构建好的 Core：没有就 clone 仓库、用壳自带的
Node 构建到数据目录（`core-src` 是那份 clone），重启后生效；已经有了就用现成那份，只有插件页里 Core 那一行的
「更新」才会回到仓库重新拉取重建——所以换业务逻辑既不需要发布 App，也不需要每次启动都联网。安装与重建的进度、
结果都画在那一行上，触发它的按钮也在那里。

## 进程与通信全景

```text
App 所在机器
  壳 Electron Main（窗口、preload 桥、打包、读 init.ts、装插件、Core 加载与重建）
        | CoreHost：协议、session、系统、配置与插件
  Core Main（插件 main.cjs、连接池、agent 安装）
        | preload + Electron IPC：请求、结果与事件
  Core Renderer（窗口内容、工作区、插件 ui.js）
        | SDK
        +-- 本机 WebSocket ------> 本机 Rust 后台进程（PTY / 文件 / 子进程）
        +-- 本地转发端口 -- SSH --> 远端 Rust 后台进程（PTY / 文件 / 子进程）
CLI：启动后台进程，或经 WebSocket 查询状态、停止服务、列出并接管终端
```

## 通信

前端 `context.ui.request` 经 preload 与 Electron IPC 到达本插件后端的 `context.ui.handle`，
返回值或错误再传回；后端 `context.ui.publish` 对应前端 `context.ui.subscribe`。

`context.global` 是跨插件总线：工作区 provider 用它发布活动工作区，文件视图等插件据此切换内容。

控制请求用 JSON，以请求 id 对应结果或错误；终端快照与输出用二进制消息，快照重建屏幕，
后续输出按序更新终端模拟器。

终端视图也可从后端取得本地端口，直接连接 WebSocket 消费输出，不必把每块输出都经 Electron
IPC 转发；后台只监听 loopback。

## 本机与 SSH 机器

本机：SDK 连接 Rust 后台进程的 loopback WebSocket 端口，
后续 PTY、文件与子进程操作都走这条连接。

SSH 远端：Core 下载匹配远端平台的 agent 并按发布时随附的 sha256 校验，经 SSH 写入安装目录，
SDK 通过 SSH 执行远端 CLI，系统 SSH 用 `-L` 把本地 loopback 端口转发到远端 loopback 端口，
SDK 连接本地转发端口后使用与本机相同的机器 API。

## CLI 后台与终端生命周期

`wangcai` 节点由 Core 管理，App 不随包带它：Core 按自己钉的版本从 `agent-v<版本>` release 下载，本机
装到数据目录的 `bin/wangcai`，远端经 SSH 写到 `~/.local/bin/wangcai`，两边都按同名 `.sha256` 校验。
换节点因此不需要发 App，Core 更新即可。

`wangcai server start --json` 复用可用的当前版本后台，或启动独立后台进程；`status` 与
`stop` 用发现信息连接后台服务。发现信息含 pid、端口、实例标识与协议版本，用于定位和
校验服务，不保存 shell 或 PTY 状态。

后台进程持有 shell 与 PTY，屏幕状态在内存中：关闭窗口或释放 SDK 连接不会结束会话，
重新连接可取得屏幕快照；关闭某个 PTY 结束该会话，`server stop` 或机器重启则结束后台的
所有会话。

`wangcai terminal attach` 连的就是 SDK 连接的那个 loopback WebSocket 端口：输入与尺寸变化送到
PTY，输出回送到本地终端。
