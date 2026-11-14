# @lengmoxxl/wangcai-testkit

插件测试用：替插件起一个真实的旺财窗口（独立的 home、指向被测插件构建的 `init.ts`、已经装好的 Core），
面板的 DOM 和插件自己的约定留在插件仓库里。

## 前提

跑测试的仓库旁边要有两个已构建的 checkout，默认从 `process.cwd()` 解析：

- `../WangCai`：App（`desktop/dist`、`desktop/node/bin/node`、`wangcaicli/dist/debug/wangcai`）
- `../WangCai-Core`：Core（`dist/main.cjs`）

`WANGCAI_CHECKOUT` 与 `WANGCAI_CORE_SOURCE` 换成别的 checkout，比如某个 worktree。

被测插件要先有自己的 `main.cjs`：条目只写 `id` 时到旁边的 `../WangCai-<id>` 取它，缺了构建就抛错；写了 `directory`（如示例）时直接读那个目录，有没有构建好由调用方负责。

`harness.cjs` 直接 `require('playwright-core')`，它是本包唯一的运行时依赖（peerDependency）：从 registry 装会自动带上。

## 用法

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withWindow } = require('@lengmoxxl/wangcai-testkit');

test('the Git tab follows the terminal', { timeout: 180000 }, () => withWindow('wangcai-git', {
  workspaces: ['terminal-agent'],
  tabs: ['files', { id: 'git', directory: __dirname + '/..' }],
}, async ({ page, errors }) => {
  // …在侧栏里开 Git 视图，驱动面板…
  assert.deepEqual(errors, []);
}));
```

body 收到 `{ home, env, page, errors }`：这一例的临时 home 与它的环境变量、窗口页面，以及页面自己报的错（`pageerror` 与 `console.error`，插件抛错就会让它非空）。

`node --test` 每个文件一个进程、文件内的用例依次跑，所以并发度就是文件数，跑的是机器默认的并发；每个用例自己起窗口。用例之间只有一件事是全局的：系统剪贴板。

机器慢或并发高时，窗口启动和渲染会拖长，默认时限可能不够：用 `configure({ timeout, actionTimeout })` 把预算调大一次，对本进程所有用例生效。

一次运行跑完、或按 Ctrl-C 结束，都不会留下它起的 Electron 与 agent 进程。

### 自己看

手动试用另写一个脚本、用 `node` 跑，什么都不判定，最后用 `holdOpen()`。

`holdOpen()` 不返回，所以别把这个脚本放进 `test/*.test.cjs`：那个文件会一直不结束。

```js
const { holdOpen, withHome } = require('@lengmoxxl/wangcai-testkit');

withHome('wangcai-play', {
  workspaces: ['terminal-agent'],
  tabs: ['files', 'terminal-agent'],
}, async ({ home, open }) => {
  const { page } = await open();
  console.log(`${await page.title()} is up on ${home}; Ctrl-C ends it`);
  await holdOpen();
}, true);   // 窗口到前台
```

## 导出

| 成员 | 作用 |
| --- | --- |
| `wangcaiApp()` | 被测 App 的 checkout 路径（`WANGCAI_CHECKOUT` 可换），用来取 `wangcaicli/dist/debug/wangcai` 这类二进制 |
| `configure({ timeout, actionTimeout })` | 改本进程等待的默认预算：`timeout` 是 `until` 的默认时限（60000），`actionTimeout` 是窗口上一步 Playwright 操作的默认时限（15000）。机器慢或并发高时调大一次即可，单个 `until` 仍可自带 `timeout` |
| `until(holds, { act, timeout = 60000, interval = 250 })` | 等到条件成立：给了 `act` 就每轮做一次再等，按时间给预算，判定用结束等待时那次读数 |
| `serveRenderer(env)` | 让之后开在这个 env 上的窗口从 checkout 的 renderer dev server 加载（看 App 自己的界面代码，而不是构建产物）；返回停掉它的函数 |
| `withHome(prefix, lists, body, focused = false)` | 一次运行：临时 home、Core、按 `lists` 写的插件表、收尾；`focused` 为 `true` 时窗口到前台；body 拿到 `{ home, env, open }`，`open()` 返回 `{ desktop, page, close }`，可反复调用来重开窗口。测试进程的 `HOME` 不变；要在测试进程里连这个 home 的 agent（如 `openMachine`），自己传 `env: { HOME: home }` |
| `withWindow(prefix, lists, body)` | 一个用例的单个窗口：临时 home、Core、按 `lists` 写的插件表、收尾；body 拿到 `{ home, env, page, errors }` |
| `holdOpen()` | 把脚本停在那里，直到 Ctrl-C 结束这次运行 |
