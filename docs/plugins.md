# 插件开发手册

插件是一个目录：App 负责安装与更新，Core 负责加载、布局与机器连接，插件只实现自己的功能。

完整进程图、CLI 后台进程与通信方式见 [架构说明](architecture.md)。

## 插件入口与生命周期

| 文件 / 导出 | 要求 | 作用 |
| --- | --- | --- |
| `main.cjs` 的 `activate(context)` | 必须 | 接收 MainContext，注册后端功能 |
| `main.cjs` 的 `config` | 可选 | 声明插件配置 schema |
| `ui.js` 的 `mount(container, context)` | 有 UI 时必须 | 接收 UiContext，挂载主视图或初始化侧栏插件 |
| `ui.js` 的 `open(context, record?)` | 可选 | 侧栏菜单或恢复标签页时调用 |
| `ui.js` 的 `title` | 可选 | 侧栏菜单名称，缺省使用插件 id |
| `ui.css` | 可选 | 插件样式；由宿主加载，注意限定 CSS 作用范围 |

完整参数、返回值和事件约定见 [SDK 参考](../sdk/README.md)。

`open` 存在时，宿主隐藏该插件的主视图容器，并在侧栏菜单中列出它。

侧栏插件仍需导出 `mount`；仅靠 `open` 展示时，`mount` 可以为空。

`context` 由宿主传入：

- **后端 MainContext**：注册 `ui.handle`，访问 Node API、机器连接及数据目录，订阅机器上的文件变化。
- **前端 UiContext**：调用 `ui.request`、订阅事件、创建侧栏标签页。
- **两端 global**：跨插件的公共事件总线，适合工作区与文件点击等协作。

后端插件是可信代码，拥有 Node.js 权限，不是隔离沙箱。

`activate` 与 `mount` 可返回清理函数，也可异步返回；返回时应取消 handler / 订阅、
清理计时器与 UI，并归还自己取得的机器连接。不要用关闭 App 代替这些资源清理。

## Tutorial：目录浏览插件

示例位于 [examples/directory-plugin](../examples/directory-plugin)。

### 1. 准备与构建

开发环境需要 Node.js 22+ 与 npm。

```sh
cd examples/directory-plugin
npm install
npm run typecheck
npm run build
```

构建产物直接落在插件目录根部。

### 2. 后端：schema、请求与 SDK

`host` 留空表示本机，填写 SSH 别名表示远端。
`directory` 是该机器上的绝对路径。

[main.ts](../examples/directory-plugin/main.ts) 声明 `config` schema，在 `activate` 里用
`context.ui.handle<{ path: string }>('list', …)` 响应请求：`context.connect` 取得机器，
`machine.fs.readDirectory` 读目录，`context.ui.publish('listed', …)` 通知前端。

`handle<{ path: string }>` 描述传入参数，handler 的返回值成为
`context.ui.request` 的结果。泛型只提供 TypeScript 检查，
不会对运行时数据做校验；面向不受信任输入时需要插件自己验证。

### 3. 前端：请求、事件与标签页

前端只用 `import type` 引入 SDK 类型，不把 Node SDK 打包到浏览器。

[ui.ts](../examples/directory-plugin/ui.ts) 导出 `title` 与 `mount`，在 `open` 里用 `context.host.tabs` 开标签页：
`mount(panel)` 画按钮与输出区，`context.ui.subscribe` 订阅后端事件，按钮里用 `context.ui.request('list', …)` 取结果。

### 4. 构建方式

宿主按 CommonJS 加载 `main.cjs`，按 ES module 加载 `ui.js`。[build.mjs](../examples/directory-plugin/build.mjs)
用 esbuild 分别产出这两份：`platform` 一个取 `node`、一个取 `browser`。

浏览器依赖、worker、字体等资源必须留在插件目录中，并能被相对引用。

### 5. 接入 App

在 [init.ts 的 `tabs`](../README.md#配置) 中保留原有条目，再添加：

```ts
{
  id: 'directory-demo',
  directory: '/absolute/path/WangCai/examples/directory-plugin',
  config: { host: '', directory: '/' },
}
```

把条目里的 `directory` 替换为你实际克隆目录的绝对路径。

重新构建插件并重启 App，然后用侧栏 `+` 选择 **Directory**，
点击 **Read directory** 后应出现目录条目。

验证远端时，将 `config.host` 改为已配置免交互认证的 SSH 别名，
`config.directory` 也要改为远端存在的绝对目录。

若要从本仓库运行宿主，在仓库根目录执行：

```sh
npm ci
npm run build
WANGCAI_HOME=/tmp/wangcai-plugin-demo npm start
```

首次启动会在 `/tmp/wangcai-plugin-demo/.config/wangcai/init.ts` 生成入口；这一回启动要先装好 Core
（见 [壳与 Core](architecture.md#壳与-core)，因此要走网络、也慢些），把同一条目加进去，再重启 App
即可看到该插件。

## 发布与扩展

发布到 Git 仓库时，提供能写出 `main.cjs` 的 `npm run build`，
再用 `{ id, repo }` 接入。首次安装执行 clone、npm install 和 build；
更新产生新构建时，App 装好后由 Core 重新加载插件。

也可以分发预构建目录，让用户以仅含 `directory` 的条目接入。
