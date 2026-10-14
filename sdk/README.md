# @lengmoxxl/sdk：接口参考

本参考对应 SDK `0.1.5`：连接本机或 SSH 机器上的旺财后台进程，提供终端、文件与子进程
操作。插件入口与生命周期见 [插件开发手册](../docs/plugins.md)，进程关系见
[架构说明](../docs/architecture.md)。

## 插件上下文

| 成员 | 说明 |
| --- | --- |
| `global` | 公共 `Bus`，跨插件与前后端通信 |
| `ui.handle<T>(method, handler)` | 后端注册方法，返回取消注册的 `Dispose` |
| `ui.publish(topic, data)` | 后端向本插件 UI 发事件，对应前端 `ui.subscribe` |
| `ui.subscribe<T>(topic, callback)` | 前端订阅本插件后端事件，返回取消订阅的函数 |
| `ui.request<T>(method, params?)` | 前端调用本插件后端方法，返回 `Promise<T>` |
| `connect(machine, signal?)` | 后端借用机器连接：`{ host?, env? }`，可带 `AbortSignal` |
| `host.dataDirectory` / `host.config` | 插件私有数据目录 / 本插件设置 |
| `host.tabs(options)` / `host.open(url)` | 前端开侧栏标签页 / 用系统浏览器打开 http、https |
| `host.preview` | `{ url, message }`，HTML 预览 frame 的地址与握手消息 |

请求与事件传可结构化克隆的数据，不传函数、DOM、Pty 或连接实例。

`ui.handle` 注册的方法名不能含 `:`；`ui.publish` 与 `ui.subscribe` 的主题由宿主加插件 id 前缀，
`global` 用原始主题，自定义主题要自己加命名空间（如 `directory-demo:opened`）。

`connect({})` 连接本机，`connect({ host })` 连接 SSH；`env` 是那台机器上节点启动时的环境。

宿主为相同机器复用连接并计数，每次取得连接对应一次 `disconnect()`。

`Dispose = () => void | Promise<void>`，卸载时清理资源，不要关闭用户仍要保留的 PTY。

`Bus`：`publish(topic, data): Promise<void>`、`subscribe<T>(topic, callback): () => void`。

`host.dataDirectory` 默认 `~/.local/share/wangcai/data/<plugin-id>`。

`host.config` 是浅合并，避免把自定义字段命名为 `theme`，配色键见
[README 主题参数](../README.md#主题参数)。

## 标签页

`host.tabs({ id, title, tooltip?, workspaceId?, onClose?, mount })`：`id`、`title` 必填，
`tooltip?` 是标签上的悬停提示（缺省用 `title`），`workspaceId` 缺省用当前工作区；
`mount(container)` 返回的 `TabContent.dispose` 必填，`onSelect?` 在选中、工作区刷新或侧栏重新显示时
都可能调用，`onClose?` 在移除标签页时先于 `dispose` 调用。

相同插件 id、工作区 id、标签 id 再次调用 `host.tabs` 会复用并选中；尚无工作区时打开的标签页
会在第一个工作区激活时绑定到它。

`TabRecord = { plugin, id, workspaceId? }` 只保存身份，插件的 `open(context, record)` 据此恢复
内容，资源必须仍在。

## 预览

用 `host.preview.url` 建 iframe，设 `sandbox="allow-scripts"`，不要加
`allow-same-origin`；收到来源为该 frame、`event.data === host.preview.message` 的消息后
`postMessage(html, '*')`。预览会执行其中脚本。

## 插件配置

插件 `config` 是嵌套对象，叶子声明 `type` 与可选 `default`；宿主只保留 schema 声明的键，
缺失或类型不符时取 default，`array` 内部条目由插件自己验证。

## 工作区协议

放入 init.ts `workspaces` 的插件用 `ui.handle` 提供：`workspaces()`（`WorkspaceRow[]`，
按显示顺序）、`workspace-menu()`（`WorkspaceMenuItem[]`）、`workspace-create({ key })`
（返回 `{ id }`）、`workspace-select({ id })`、`workspace-close({ id })`、
`workspace-rename({ id, name })`（名字为空表示交回 provider 自己跟随的名字）、
`workspace-move({ id, before? })`（`before` 是目标工作区 id，不是索引；省略为末尾，且只
允许同一 provider 内拖动）。

provider 要保证工作区 id 在所有 provider 的行中唯一识别；`error` 由 provider 给出并在重试成功后清除，
宿主不禁用带 `error` 的菜单项。

约定的公共主题：`workspaces`（行变化，App 重新请求列表）、`workspace:active`
（`WorkspaceActive | null`，provider 发布）、`workspace:query`（视图请求 provider 再发布
当前工作区）、`onclick`（`FileClick`）。

字段类型见 SDK 导出的 `WorkspaceRow`、`WorkspaceMenuItem`、`Machine`、`WorkspaceActive`
与 `FileClick`，定义在 `sdk/types.ts`。

## 机器、终端与子进程

`MachineConnection`：`ready`（首次连接就绪）、`state`、`port`（本地 loopback 端口，SSH 时
为转发端口）、`onState(callback)`、`retain()`（连接层使用）、`disconnect()`，以及 `pty`、`fs`、
`subprocess`。

`MachineState` 含 `status`、`error?`、`sessions`、`generation`。

断线会自动重连并重新 attach 已挂载的终端与进程，失败的请求与输入不自动重放，后台进程重启时旧 Pty 与进程失效。

`connection.pty`：`list()`、`cwd(id)`、`create(size?, cwd?)`（默认 24 行 80 列；cwd 用绝对目录，
省略时在后台进程的 HOME 下启动）、`attach(id)`（复用句柄）、`close(id)`（结束 shell 与后台子孙进程）。

`Size` 用整数：rows 2–300，cols 2–500。

`Session` 有 `id, title`、`pid, rows, cols`、`exit_code: number | null`。

`Pty`：`id`、`onSnapshot(callback)`、`onData(callback)`、`write(data)`、`resize(size)`、
`detach()`（停止挂载，不关闭 shell）。

`Output = { data: Uint8Array; seq: number }`，`Snapshot` 额外有 `rows, cols`。

字节含终端控制序列，交给终端模拟器，不要把快照当键盘输入重发。

`receive` 与 `release(error?)` 由连接层使用。

`connection.fs`：`stat(path)` 返回 `{ isDirectory: boolean } | null`、`readDirectory(path)` 返回
`DirectoryEntry[]`（`{ name, isDirectory }`）、`readFile(path)` 返回原始字节。

路径为绝对路径，`readFile` 上限 16 MiB；SDK 不提供写入、删除或上传接口。

`connection.subprocess.exec(program, args, options)`：`args` 是独立 argv（不经 shell 展开），
`options.cwd` 是绝对工作目录，`options.env` 覆盖继承的环境变量；返回
`{ stdout: Uint8Array; stderr: Uint8Array; code: number }`。非零退出码仍返回结果，无法启动、
超时、输出超限或被信号终止时 reject；stdin 关闭，长时间或交互用 `subprocess.spawn` 或 PTY。

执行上限 15 秒，SDK 等待响应上限 20 秒，stdout 与 stderr 各最多 8 MiB，断线取消未完成的 exec。

`connection.subprocess.spawn(program, args, options)`（`options` 同 `exec`）启动一个
长期存活的进程，stdin、stdout、stderr 都是管道，返回 `ProcessInfo = { id, pid, exit_code }`；
`attach(id)` 复用句柄（未 attach 前不接收输出），`close(id)` 结束进程及其进程组；进程归后台进程所有，不 `close` 就一直留着。

`Process`：`id`、`onData(callback)`、`onExit(callback)`、`write(data)`。

`ProcessOutput = { data: Uint8Array; seq: number; stream: 'stdout' | 'stderr' }`，两路输出各自按序到达，
`seq` 单调递增，跨两路的先后以 `seq` 为准。

`onExit` 给出退出码（被信号结束时按 shell 的 128+signal），节点来不及投递时给出 `undefined`，此时
输出流已不可信，进程可能仍在运行，请重新 `spawn`。

`write` 按 32 KiB 分片、按序应用，进程退出后 reject；先 `attach` 再写。

`receive` 与 `release(error?)` 由连接层使用。

## 独立 Node 客户端

App 插件用 `context.connect`；插件之外才调用 `openMachine`：

```ts
import { openMachine } from '@lengmoxxl/sdk';

const connection = await openMachine({ type: 'local', binary: '/path/to/wangcai' });
await connection.fs.readDirectory('/');
connection.disconnect();
```

`openMachine` 返回 `Promise<MachineConnection>`。`type` 为 `'local'` 或 `'ssh'`；local 可给
`binary`，ssh 必须给 `host`（系统 ssh 目标或别名）与可选 `agent`（`InstallAgent`），两者
都可给 `env`（节点启动时带上的环境，值里的 `$NAME` 用运行节点那台机器的环境展开）与 `signal`。
不传 `agent` 时 SDK 不下载二进制；连接用 BatchMode SSH。

`agentCommand(command, env)` 返回拼接后的 shell 命令：在 PATH 前加入远端 `$HOME/.local/bin`，
再带上当前进程的 WANGCAI_HOME 与配置要求的环境；值里的 `$NAME` 留给远端 shell 展开。命令本身
不转义，只传可信内容。
