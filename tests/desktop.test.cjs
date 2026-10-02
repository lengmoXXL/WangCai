const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('Electron: local terminal, reconnect, machine add/remove and relaunch', { timeout: 60000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-desktop-test-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let devServer;
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron-data')}`], env });
    const page = await desktop.firstWindow();
    page.on('pageerror', (error) => console.error('UI error:', error));
    await page.locator('.machine.connected').waitFor();
    assert.equal(await page.title(), '旺财');
    assert.equal(await desktop.evaluate(({ app }) => app.getName()), '旺财');
    return page;
  };
  try {
    let page = await launch();
    const localTabs = page.getByRole('tablist', { name: '本机 工作区', exact: true });
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await localTabs.getByRole('tab').filter({ hasText: '~' }).waitFor();
    await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'DESKTOP_%s\\n' success");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('DESKTOP_success'));
    await page.keyboard.type("printf 'X%.0s' {1..400}; echo");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].some((element) => element.textContent.length > 60 && /^X+$/.test(element.textContent)));
    const overhang = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].map((element) => (element.lastElementChild?.getBoundingClientRect().right ?? 0) - element.getBoundingClientRect().right)));
    assert.ok(overhang <= 0.5, `terminal rows clip their last column by ${overhang.toFixed(2)}px`);
    const terminal = await page.evaluate(() => {
      const surface = document.querySelector('.terminal-pane.active .terminal-surface');
      const bar = surface.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
      const ruler = surface.querySelector('.xterm-decoration-overview-ruler');
      return {
        bar: [getComputedStyle(bar).width, getComputedStyle(bar.querySelector('.slider')).width],
        overlap: surface.querySelector('.xterm-screen').offsetWidth - surface.querySelector('.xterm-viewport').clientWidth,
        outline: [...ruler.getContext('2d').getImageData(0, 0, 1, 1).data],
      };
    });
    assert.deepEqual(terminal.bar, ['10px', '10px'], 'the terminal scrollbar is 10px wide');
    assert.ok(terminal.overlap <= 0, `the terminal grid runs ${terminal.overlap}px under the viewport scrollbar`);
    assert.deepEqual(terminal.outline, [11, 14, 19, 255], 'the overview ruler outline hides in the terminal background');
    const workspaces = (await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces;
    assert.equal(workspaces.length, 1);
    assert.equal(await localTabs.getByRole('tab').count(), 1);
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await localTabs.getByRole('tab').nth(1).waitFor();
    await localTabs.getByRole('tab').nth(0).click();
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('DESKTOP_success'));
    await localTabs.getByRole('tab').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wangcai-workspace [role=tab]').length === 1);
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '连接 本机', exact: true }).click();
    await page.locator('.machine.connected').waitFor();
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('DESKTOP_success'));
    assert.equal((await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces[0].sessionId, workspaces[0].sessionId);
    await page.getByText('工作区', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '添加机器…', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('测试服务器');
    await page.getByLabel('SSH Host', { exact: true }).fill('dev-server');
    await page.getByRole('button', { name: '添加机器', exact: true }).click();
    await page.getByRole('button', { name: '测试服务器', exact: true }).waitFor();
    const stored = JSON.parse(readFileSync(join(home, '.local/shared/wangcai/data/workspace/config.json'), 'utf8'));
    assert.equal(stored.machines[1].host, 'dev-server');
    assert.equal(stored.workspaces[0].sessionId, workspaces[0].sessionId);
    assert.equal(existsSync(join(home, '.local/shared/wangcai/logs/workspace')), true);
    await page.getByRole('button', { name: '测试服务器', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('[aria-label="本机 工作区"] .workspace.running'));
    await page.getByRole('button', { name: '本机', exact: true }).click();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).waitFor();
    const storedTabs = JSON.parse(readFileSync(join(home, 'electron-data/tabs.json'), 'utf8'));
    assert.deepEqual(storedTabs, [{ plugin: 'files', id: 'directory', workspaceId: workspaces[0].id }]);
    await page.screenshot({ path: 'tests/dist/screenshots/desktop.png' });
    await desktop.close(); desktop = undefined;
    page = await launch();
    await page.getByRole('tablist', { name: '本机 工作区', exact: true }).getByRole('tab').filter({ hasText: '~' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('DESKTOP_success'));
    assert.equal((await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces[0].sessionId, workspaces[0].sessionId);
    await page.getByRole('tab', { name: '文件', exact: true }).waitFor();
    await page.getByRole('button', { name: '测试服务器', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移除机器…', exact: true }).click();
    assert.equal((await page.evaluate(() => window.wangcai.request('workspace', 'config'))).machines.length, 1);
    await page.getByRole('tab', { name: '~', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wangcai-workspace [role=tab]').length === 0);
    assert.deepEqual((await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces, []);
    await desktop.close(); desktop = undefined;
    const { resolveConfig } = await import('electron-vite');
    const { createServer } = await import('vite');
    const { config: viteConfig } = await resolveConfig({ root: resolve('desktop') }, 'serve');
    devServer = await createServer({ ...viteConfig.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    page = await launch();
    await page.waitForFunction(() => document.querySelectorAll('.wangcai-workspace [role=tab]').length === 0);
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await devServer?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('workspaces can be dragged into a new order', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-workspace-order-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let page;
  const open = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.locator('.machine.connected').waitFor();
  };
  const WORKSPACE_NAMES = '[aria-label="本机 工作区"] [role=tab] .name';
  const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [WORKSPACE_NAMES, expected.join()]);
  const cd = async (index, directory) => {
    const sessionId = (await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces[index].sessionId;
    await page.evaluate(({ sessionId, directory }) => window.wangcai.request('workspace', 'pty', { id: 'local', op: 'input', params: { session_id: sessionId, data: `cd ${directory}\r` } }), { sessionId, directory });
  };
  try {
    for (const name of ['alpha', 'beta', 'gamma']) mkdirSync(join(home, name));
    await open();
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await settled(['~']);
    await cd(0, 'alpha');
    await settled(['alpha']);
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await settled(['alpha', '~']);
    await cd(1, 'beta');
    await settled(['alpha', 'beta']);
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await settled(['alpha', 'beta', '~']);
    await cd(2, 'gamma');
    await settled(['alpha', 'beta', 'gamma']);
    await page.getByRole('tab', { name: 'beta' }).dragTo(page.getByRole('tab', { name: 'alpha' }), { targetPosition: { x: 40, y: 4 } });
    await settled(['beta', 'alpha', 'gamma']);
    // dropping a row below the row in front of it must leave it where it is
    await page.getByRole('tab', { name: 'alpha' }).dragTo(page.getByRole('tab', { name: 'beta' }), { targetPosition: { x: 40, y: 20 } });
    await page.waitForTimeout(500);
    assert.deepEqual(await page.locator(WORKSPACE_NAMES).allTextContents(), ['beta', 'alpha', 'gamma']);
    await desktop.close(); desktop = undefined;
    await open();
    await settled(['beta', 'alpha', 'gamma']);
  } finally {
    await desktop?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
