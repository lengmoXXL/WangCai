# @lengmoxxl/wangcai-testkit

插件测试用：替插件起一个真实的旺财窗口（独立的 home、指向被测插件构建的 `init.ts`、已经装好的 Core），
面板的 DOM 和插件自己的约定留在插件仓库里。

## 前提

跑测试的仓库旁边要有两个已构建的 checkout，默认从 `process.cwd()` 解析：

- `../WangCai`：App（`desktop/dist`、`desktop/node/bin/node`、`wangcaicli/dist/debug/wangcai`）
- `../WangCai-Core`：Core（`dist/main.cjs`）

`WANGCAI_CHECKOUT` 与 `WANGCAI_CORE_SOURCE` 换成别的 checkout，比如某个 worktree。

被测插件要先有自己的 `main.cjs`：条目只写 `id` 时，`withWindow` 到旁边的 `../WangCai-<id>` 取它，缺了构建就抛错；写了 `directory`（如示例）时直接读那个目录，有没有构建好由调用方负责。

`harness.cjs` 直接 `require('playwright-core')`，它是本包唯一的运行时依赖（peerDependency）：从 registry 装会自动带上，以 `file:` 链接时用 `../WangCai` 里装好的那份，所以那个 checkout 要 `npm install` 过。

## 用法

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withWindow, openView } = require('@lengmoxxl/wangcai-testkit');

test('the Git tab follows the terminal', { timeout: 180000 }, () => withWindow('wangcai-git', {
  workspaces: ['terminal-agent'],
  tabs: ['files', { id: 'git', directory: __dirname + '/..' }],
}, async ({ page, errors }) => {
  await openView(page, 'Git');
  // …驱动面板…
  assert.deepEqual(errors, []);
}));
```

body 收到 `{ home, env, page, errors }`：这一例的临时 home 与它的环境变量、窗口页面，以及页面自己报的错（`pageerror` 与 `console.error`，插件抛错就会让它非空）。

用例的窗口不抢焦点，跑完或中断都不会留下 Electron 与 agent 进程。

每条用例都起一个 Electron，所以用 `node --test --test-concurrency=1` 串行跑。

## 导出

| 成员 | 作用 |
| --- | --- |
| `withWindow(prefix, lists, body)` | 一个用例：临时 home、Core、按 `lists` 写的插件表、窗口、收尾 |
| `openView(page, name)` | 在右侧栏里新开一个插件视图，需要时先把侧栏显示出来 |
| `viewTabs(page)` | 侧栏上显示着的那些标签页，可用来计数 |
| `closeView(page)` | 关掉当前选中的那个侧栏标签页 |
| `createWorkspace(page)` | 开一个本机工作区；返回时它的终端已经画出 shell |
| `terminalShows(page, text)` | 等当前终端把那段文字画出来 |
| `run(page, line)` | 往当前终端敲一行并回车 |
