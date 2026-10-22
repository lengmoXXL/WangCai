# @lengmoxxl/sdk：接口参考

SDK 连接本机或 SSH 机器上的旺财后台进程，提供终端、文件与子进程操作。插件入口与生命周期见
[插件开发手册](../docs/plugins.md)，进程关系见 [架构说明](../docs/architecture.md)。

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

`Bus`：`publish(topic, data): Promise<void>`、`subscribe<T>(topic, callback): () => void`。

`Dispose = () => void | Promise<void>`，卸载时清理资源，不要关闭用户仍要保留的 PTY。

`connect({})` 连接本机，`connect({ host })` 连接 SSH；`env` 是那台机器上节点启动时的环境。
宿主为相同机器复用连接并计数，每次取得连接对应一次 `disconnect()`。

`host.dataDirectory` 默认 `~/.local/share/wangcai/data/<plugin-id>`。

## 标签页

`host.tabs({ id, title, tooltip?, workspaceId?, onClose?, mount })`：`id`、`title` 必填。
`tooltip` 是标签上的悬停提示，缺省用 `title`；`workspaceId` 缺省用当前工作区。

`mount(container)` 返回的 `TabContent.dispose` 必填，用于清理标签页资源。
`onClose?` 在移除标签页时先于 `dispose` 调用。

`onSelect?` 在选中、工作区刷新或侧栏重新显示时都可能调用。

相同插件 id、工作区 id、标签 id 再次调用 `host.tabs` 会复用并选中；尚无工作区时打开的标签页
会在第一个工作区激活时绑定到它。

`TabRecord = { plugin, id, workspaceId? }` 只保存身份，插件的 `open(context, record)` 据此恢复
内容，资源必须仍在。

## 预览

用 `host.preview.url` 建 iframe，设 `sandbox="allow-scripts"`，不要加
`allow-same-origin`；收到来源为该 frame、`event.data === host.preview.message` 的消息后
`postMessage(html, '*')`。预览会执行其中脚本。

## 插件配置

`host.config` 是浅合并，避免把自定义字段命名为 `theme`，配色键见
[README 主题参数](../README.md#主题参数)。

插件 `config` 是嵌套对象，叶子声明 `type` 与可选 `default`；宿主只保留 schema 声明的键，
缺失或类型不符时取 default，`array` 内部条目由插件自己验证。

## 工作区协议

放入 init.ts `workspaces` 的插件用 `ui.handle` 提供以下方法：

| 方法 | 返回值或约定 |
| --- | --- |
| `workspaces()` | 返回 `WorkspaceRow[]`，按显示顺序；宿主分组后，组内仍保持此顺序 |
| `workspace-menu()` | 返回 `WorkspaceMenuItem[]` |
| `workspace-create({ key })` | 返回 `{ id }` |
| `workspace-select({ id })` | 选中工作区 |
| `workspace-close({ id })` | 关闭工作区 |
| `workspace-rename({ id, name })` | 名字为空表示交回 provider 自己跟随的名字 |
| `workspace-move({ id, before? })` | `before` 是目标工作区 id，不是索引；省略为末尾，只允许同一 provider 内拖动 |

provider 要保证工作区 id 在所有 provider 的行中唯一识别。

`error` 由 provider 给出并在重试成功后清除，宿主不禁用带 `error` 的菜单项。

`WorkspaceRow.status` 是工作区里 agent 的状态，取 `'idle'`、`'working'` 或 `'finished'`，
缺省为 `'idle'`，宿主在行末显示状态图标。

点击工作区行或行末图标，只会在窗口里将状态清成 `'idle'`，不修改 provider 的状态。
该工作区报出其他状态后，再报 `'finished'` 才会重新显示完成状态。

公共主题约定如下：

| 主题 | 数据或约定 |
| --- | --- |
| `workspaces` | 行变化时发布，App 重新请求列表 |
| `workspace:active` | provider 发布 `WorkspaceActive \| null` |
| `workspace:query` | 视图请求 provider 再发布当前工作区 |
| `onclick` | `FileClick` |

字段类型见 SDK 导出的 `WorkspaceRow`、`WorkspaceStatus`、`WorkspaceMenuItem`、`Machine`、
`WorkspaceActive` 与 `FileClick`，定义在 `sdk/types.ts`。

## 机器接口

### 连接与重连

`MachineConnection`：`ready`（首次连接就绪）、`state`、`port`（本地 loopback 端口，SSH 时
为转发端口）、`onState(callback)`、`retain()`（连接层使用）、`disconnect()`，以及 `pty`、`fs`、
`subprocess`。

`MachineState` 含 `status`、`error?`、`sessions`、`generation`。

断线会自动重连并重新 attach 已挂载的终端、进程与文件订阅，失败的请求与输入不自动重放，后台进程重启时
旧 Pty 与进程失效。

### 终端（PTY）

`connection.pty` 提供以下方法：

| 方法 | 作用 |
| --- | --- |
| `list()` | 列出会话 |
| `cwd(id)` | 查询会话工作目录 |
| `create(size?, options?)` | 创建终端会话 |
| `attach(id)` | 挂载会话，复用句柄 |
| `close(id)` | 结束 shell 与后台子孙进程 |

`create` 默认使用 24 行 80 列。`size` 使用 `Size`，字段为整数：rows 2–300，cols 2–500。

`options.cwd` 使用绝对目录，省略时在后台进程的 HOME 下启动；
`options.env` 是额外给这个 shell 的环境变量，值都是字符串；
`options.label` 是调用方给这个会话起的名字。

`Session` 有 `id, title, label`、`pid, rows, cols`、`exit_code: number | null`；
`title` 是后台按 shell 与 pid 起的默认名，显示时用 `label ?? title`。

`Pty`：`id`、`onSnapshot(callback)`、`onData(callback)`、`write(data)`、`resize(size)`、
`detach()`（停止挂载，不关闭 shell）。

`Output = { data: Uint8Array; seq: number }`，`Snapshot` 额外有 `rows, cols`。

字节含终端控制序列，交给终端模拟器，不要把快照当键盘输入重发。

`receive` 与 `release(error?)` 由连接层使用。

### 文件

`connection.fs`：`stat(path)` 返回 `{ isDirectory: boolean } | null`、`readDirectory(path)` 返回
`DirectoryEntry[]`（`{ name, isDirectory }`）、`readFile(path)` 返回原始字节。

路径为绝对路径，`readFile` 上限 16 MiB；SDK 不提供写入、删除或上传接口。

`connection.fs.watch(path, options, callback)` 订阅该路径的变化，`options.recursive` 决定是否含子目录。
返回的 `() => void` 关闭订阅；连接彻底关闭（最后一个持有者 `disconnect()`）时，订阅也随之结束。

回调收到 `FileChanges = { created, modified, removed }`，路径按订阅时给的根路径书写。
事件按安静窗口批量投递：约 200ms 没有新事件时发出一批，最长等待 2 秒。

macOS 使用 FSEvents，创建与删除多数时候报成 `modified`；Linux 使用 inotify，三类事件齐全。

### 短期命令（exec）

`connection.subprocess.exec(program, args, options)`：`args` 是独立 argv，不经 shell 展开；
`options.cwd` 是绝对工作目录，`options.env` 覆盖继承的环境变量。

返回 `{ stdout: Uint8Array; stderr: Uint8Array; code: number }`，非零退出码仍返回结果。
无法启动、超时、输出超限或被信号终止时 reject。

stdin 关闭，执行上限 15 秒，SDK 等待响应上限 20 秒，stdout 与 stderr 各最多 8 MiB；
断线取消未完成的 exec。长时间或交互操作用 `subprocess.spawn` 或 PTY。

### 长期进程（spawn）

`connection.subprocess.spawn(program, args, options)`（`options` 同 `exec`）启动一个
长期存活的进程，stdin、stdout、stderr 都是管道，返回 `ProcessInfo = { id, pid, exit_code }`。

`attach(id)` 复用句柄，未 attach 前不接收输出；`close(id)` 结束进程及其进程组。

进程归后台进程所有。除显式 `close` 外，只有启动它或最后 attach 它的那条连接断开后，
60 秒内没有任何连接再 attach，该进程才会被节点自动回收。

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

## 壳与内核的约定

`@lengmoxxl/sdk/bridge` 是壳（App）与业务内核共享的那份契约：窗口的三个 scheme、桥的两个 channel、
壳向窗口发的 topic、界面字体、安装阶段与跨桥的类型，以及 `contractVersion` —— 内核启动时把它报给壳，
壳据此拒绝一个面向旧契约的构建。壳与内核各取一份 SDK，所以改这份契约要发新版本，两边对不上时靠这个
版本号发现。插件不需要它：插件用到的是上文列出的上下文。
