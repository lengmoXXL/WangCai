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

```ts
import type { MainContext } from '@lengmoxxl/sdk/channel';

export const config = {
  host: { type: 'string', default: '' },
  directory: { type: 'string', default: '/' },
};

export function activate(context: MainContext) {
  return context.ui.handle<{ path: string }>('list', async ({ path }) => {
    const machine = await context.connect({
      host: context.host.config.host || undefined,
    });
    try {
      const entries = await machine.fs.readDirectory(path);
      context.ui.publish('listed', { path, count: entries.length });
      return entries;
    } finally {
      machine.disconnect();
    }
  });
}
```

`handle<{ path: string }>` 描述传入参数，handler 的返回值成为
`context.ui.request` 的结果。泛型只提供 TypeScript 检查，
不会对运行时数据做校验；面向不受信任输入时需要插件自己验证。

### 3. 前端：请求、事件与标签页

前端只用 `import type` 引入 SDK 类型，不把 Node SDK 打包到浏览器。

```ts
import type { DirectoryEntry } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';

export const title = 'Directory';

export function mount() {}

export function open(context: UiContext, record?: TabRecord) {
  const path = record?.id ?? context.host.config.directory;
  context.host.tabs({
    id: path,
    title,
    tooltip: path,
    workspaceId: record?.workspaceId,
    mount(panel) {
      const button = document.createElement('button');
      button.textContent = 'Read directory';
      const status = document.createElement('p');
      const output = document.createElement('pre');
      panel.append(button, status, output);

      const off = context.ui.subscribe<{ path: string; count: number }>(
        'listed',
        (value) => { status.textContent = `${value.path}: ${value.count} entries`; },
      );
      button.onclick = async () => {
        button.disabled = true;
        try {
          const entries = await context.ui.request<DirectoryEntry[]>(
            'list', { path },
          );
          output.textContent = entries.map(
            (entry) => entry.name + (entry.isDirectory ? '/' : ''),
          ).join('\n');
        } catch (error) {
          output.textContent = error instanceof Error
            ? error.message : String(error);
        } finally {
          button.disabled = false;
        }
      };

      return {
        dispose: off,
        onSelect() { button.focus(); },
      };
    },
  });
}
```

### 4. 构建方式

宿主按 CommonJS 加载 `main.cjs`，按 ES module 加载 `ui.js`。

```js
import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['main.ts'], outfile: 'main.cjs',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  }),
  build({
    entryPoints: ['ui.ts'], outfile: 'ui.js',
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  }),
]);
```

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

首次启动会在 `/tmp/wangcai-plugin-demo/.config/wangcai/init.ts` 生成入口；它会先在数据目录里 clone 并构建
Core（本仓库不再带 Core，这一回启动因此要走网络、也慢些；已经装好就直接用），把同一条目加进去，再重启 App
即可看到该插件。

## 发布与扩展

发布到 Git 仓库时，提供能写出 `main.cjs` 的 `npm run build`，
再用 `{ id, repo }` 接入。首次安装执行 clone、npm install 和 build；
更新产生新构建时，App 装好后由 Core 重新加载插件。

也可以分发预构建目录，让用户以仅含 `directory` 的条目接入。
