const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('view menu switches plugins and handles empty, disconnected and closed terminals', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-views-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  try {
    const other = join(home, '.local/shared/wangcai/plugins/other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'main.ts'), 'export function activate() {}');
    writeFileSync(join(other, 'ui.tsx'), `
      export const title = '测试视图';
      export function mount() {}
      export function open(context) { void context.host.request('tabs', { id: 'other', title: '测试视图', mount(container) {
        const input = document.createElement('input');
        input.setAttribute('aria-label', '视图内容');
        container.append(input);
        return { dispose: () => input.remove() };
      } }); }
    `);
    mkdirSync(join(home, '子目录 with spaces'));
    writeFileSync(join(home, '子目录 with spaces', '空 格.md'), '# Nested preview');
    writeFileSync(join(home, '.hidden.md'), '# Hidden preview');
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('.machine.connected').waitFor();
    const toggle = page.getByRole('button', { name: '切换右侧栏' });
    await toggle.click();
    const picker = page.getByRole('button', { name: '新建侧栏标签页' });
    const menu = page.locator('#view-menu');
    const noTerminal = page.locator('.sidebar-panel:visible').getByText('请选择一个已连接的终端', { exact: true });
    await picker.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await noTerminal.waitFor();
    assert.equal(await page.locator('.sidebar-panel:visible').count(), 1);
    await picker.click();
    await menu.getByRole('button', { name: '测试视图', exact: true }).click();
    await page.getByLabel('视图内容').fill('preserved');
    const lastTab = await page.locator('.sidebar-tab').last().boundingBox();
    const plus = await picker.boundingBox();
    const toggleBounds = await toggle.boundingBox();
    assert.ok(plus.x >= lastTab.x + lastTab.width);
    assert.ok(plus.x - lastTab.x - lastTab.width < 10);
    assert.ok(toggleBounds.x > plus.x + plus.width);
    assert.equal(await page.locator('.sidebar-panel[data-plugin=files]').isVisible(), false);
    assert.equal(await page.locator('.desktop-main [data-plugin=workspace]').isVisible(), true);
    assert.equal(await page.locator('.sidebar-panel:visible').count(), 1);
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    const directory = page.getByRole('navigation', { name: '当前目录文件' });
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    assert.equal(await directory.getByRole('button', { name: '.hidden.md', exact: true }).locator('svg[data-kind=file]').count(), 1);
    assert.equal(await directory.getByRole('button', { name: '子目录 with spaces/', exact: true }).locator('svg[data-kind=folder]').count(), 1);
    for (const [side, label, delta, minimum, shrink] of [
      ['left', '调整左侧栏宽度', 60, 120, -600],
      ['right', '调整右侧栏宽度', -80, 260, 800],
    ]) {
      const pane = page.locator(`.sidebar-${side}`);
      const handle = page.getByRole('separator', { name: label });
      const before = (await pane.boundingBox()).width;
      let box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.ok(Math.abs((await pane.boundingBox()).width - before - Math.abs(delta)) < 2);
      box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + shrink, box.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.equal(Math.round((await pane.boundingBox()).width), minimum);
      assert.ok((await page.locator('.desktop-main').boundingBox()).width >= 240);
    }
    const measure = () => page.evaluate(() => ({ inner: innerWidth, left: document.querySelector('.sidebar-left').getBoundingClientRect().width, right: document.querySelector('.sidebar-right').getBoundingClientRect().width }));
    const beforeResize = await measure();
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width + 300, height);
    });
    await page.waitForFunction((left) => document.querySelector('.sidebar-left').getBoundingClientRect().width > left, beforeResize.left);
    const afterResize = await measure();
    assert.ok(afterResize.inner > beforeResize.inner);
    assert.ok(Math.abs(afterResize.left / afterResize.inner - beforeResize.left / beforeResize.inner) < 0.01);
    assert.ok(Math.abs(afterResize.right / afterResize.inner - beforeResize.right / beforeResize.inner) < 0.01);
    await page.getByRole('button', { name: '关闭 文件', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: '文件', exact: true }).count(), 0);
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Hidden preview' }).waitFor();
    await page.getByRole('button', { name: '关闭 .hidden.md', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: '子目录 with spaces/', exact: true }).click();
    await directory.getByRole('button', { name: '空 格.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Nested preview' }).waitFor();
    await page.getByRole('button', { name: '关闭 空 格.md', exact: true }).click();
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await page.getByRole('tab', { name: '测试视图', exact: true }).click();
    assert.equal(await page.getByLabel('视图内容').inputValue(), 'preserved');
    assert.equal(await directory.isVisible(), false);
    await page.getByRole('tab', { name: '~', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '关闭工作区', exact: true }).click();
    await page.getByRole('tablist', { name: '本机 工作区' }).getByRole('tab').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.sidebar-panel[data-plugin=files]').count(), 0);
    const existing = await page.evaluate(async () => (await window.wangcai.request('workspace', 'config')).workspaces.map((workspace) => workspace.id));
    const stored = JSON.parse(readFileSync(join(home, 'electron', 'tabs.json'), 'utf8'));
    assert.deepEqual(stored.filter((record) => record.workspaceId && !existing.includes(record.workspaceId)), []);
    if (!(await page.locator('.sidebar-right').isVisible())) await toggle.click();
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await noTerminal.waitFor();
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    const sessionId = await page.evaluate(async () => (await window.wangcai.request('workspace', 'config')).workspaces.at(-1).sessionId);
    await page.evaluate((id) => window.wangcai.request('workspace', 'pty', { id: 'local', op: 'input', params: { session_id: id, data: 'exit\r' } }), sessionId);
    const restart = page.getByRole('button', { name: '重新打开终端', exact: true });
    await restart.waitFor();
    await restart.click();
    await restart.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await noTerminal.waitFor();
    assert.equal(await directory.isVisible(), false);
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '连接 本机', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.sidebar-right').hidden);
    await toggle.click();
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/sidebar-layout.png' });
    const closeVisible = page.locator('.sidebar-tab:visible .close-tab');
    while (await closeVisible.count()) await closeVisible.last().click();
    await page.locator('.sidebar-right').waitFor({ state: 'hidden' });
    assert.equal(await picker.isVisible(), false);
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    assert.equal(await picker.isVisible(), true);
    assert.deepEqual(errors, []);
    const ratios = await page.evaluate(() => JSON.parse(localStorage.getItem('sidebar-ratios')));
    const windowWidth = await page.evaluate(() => innerWidth);
    await desktop.close(); desktop = undefined;
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const left = page.locator('.sidebar-left');
    const right = page.locator('.sidebar-right');
    await left.waitFor();
    await right.waitFor();
    const inner = await page.evaluate(() => innerWidth);
    assert.ok(Math.abs(inner - windowWidth) < 2);
    assert.ok(Math.abs((await left.boundingBox()).width - ratios.left * inner) < 1);
    assert.ok(Math.abs((await right.boundingBox()).width - ratios.right * inner) < 1);
  } finally {
    await desktop?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('full screen reclaims the window chrome space above the workspaces', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-full-screen-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  try {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    const page = await desktop.firstWindow();
    const left = page.locator('.sidebar-left');
    const header = page.locator('.wangcai-workspace .sidebar-header');
    await page.locator('.machine.connected').waitFor();
    const padding = () => left.evaluate((element) => getComputedStyle(element).paddingTop);
    const headerTop = () => header.evaluate((element) => Math.round(element.getBoundingClientRect().top));
    assert.equal(await padding(), '36px');
    assert.equal(await headerTop(), 37);
    // a real setFullScreen(true) does not enter full screen in this environment, so drive the event the main process forwards
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('enter-full-screen'); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar-left')).paddingTop === '0px');
    assert.equal(await headerTop(), 1);
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('leave-full-screen'); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar-left')).paddingTop === '36px');
    assert.equal(await headerTop(), 37);
  } finally {
    await desktop?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('sidebar tabs can be dragged into a new order', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-tab-order-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let page;
  const errors = [];
  const open = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: '切换右侧栏' }).click();
  };
  try {
    await open();
    for (const name of ['文件', 'Git', '终端']) {
      await page.getByRole('button', { name: '新建侧栏标签页' }).click();
      await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
      await page.getByRole('tab', { name, exact: true }).waitFor();
    }
    const TAB_ORDER = '.sidebar-tab:not([hidden]) [role=tab]';
    const DROPPED = '.sidebar-tab[data-drop]';
    const tab = (name) => page.locator('.sidebar-tab').filter({ has: page.getByRole('tab', { name, exact: true }) });
    const order = () => page.locator(TAB_ORDER).allTextContents();
    const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [TAB_ORDER, expected.join()]);
    assert.deepEqual(await order(), ['文件', 'Git', '终端']);
    const source = await tab('文件').boundingBox();
    const target = await tab('Git').boundingBox();
    await page.mouse.move(source.x + 20, source.y + 18);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 18, { steps: 6 });
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 1, DROPPED);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 0, DROPPED);
    await tab('Git').dragTo(tab('文件'), { targetPosition: { x: 4, y: 18 } });
    await settled(['Git', '文件', '终端']);
    // dropping a tab after the tab in front of it must leave it where it is
    await tab('文件').dragTo(tab('Git'), { targetPosition: { x: 45, y: 18 } });
    await page.waitForTimeout(500);
    assert.deepEqual(await order(), ['Git', '文件', '终端']);
    await tab('终端').dragTo(tab('Git'), { targetPosition: { x: 4, y: 18 } });
    await settled(['终端', 'Git', '文件']);
    // opening a workspace rebinds these tabs to it, which rewrites their keys
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await page.getByRole('tab', { name: '~' }).waitFor();
    await tab('文件').dragTo(tab('终端'), { targetPosition: { x: 4, y: 18 } });
    await settled(['文件', '终端', 'Git']);
    await desktop.close(); desktop = undefined;
    await open();
    await settled(['文件', '终端', 'Git']);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
