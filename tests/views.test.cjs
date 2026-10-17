const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { launchApp, mockView, mockWorkspace, newWorkspace, openWorkspaceMenu, testEnv, waitForShell, writeInit } = require('./init.cjs');

test('full screen reclaims the window chrome space above the workspaces', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-full-screen-'));
  const env = testEnv(home);
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    const left = page.locator('.sidebar-left');
    const header = page.locator('.workspace-header');
    await waitForShell(page);
    const headerTop = () => header.evaluate((element) => Math.round(element.getBoundingClientRect().top));
    assert.equal(await left.evaluate((element) => getComputedStyle(element).paddingTop), '36px');
    // 36px chrome + 1px card border + 3px window inset.
    assert.equal(await headerTop(), 40);
    // a real setFullScreen(true) does not enter full screen in this environment, so drive the event the main process forwards
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('enter-full-screen'); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar-left')).paddingTop === '0px');
    assert.equal(await headerTop(), 4);
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('leave-full-screen'); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar-left')).paddingTop === '36px');
    assert.equal(await headerTop(), 40);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('sidebar tabs can be dragged into a new order', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-tab-order-'));
  const env = testEnv(home);
  let desktop;
  let page;
  const errors = [];
  const open = async () => {
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: '切换右侧栏' }).click();
  };
  try {
    mockWorkspace(home);
    mockView(home, 'files', '文件');
    mockView(home, 'terminal', '终端');
    writeInit(home);
    await open();
    for (const name of ['文件', '终端']) {
      await page.getByRole('button', { name: '新建侧栏标签页' }).click();
      await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
      await page.getByRole('tab', { name, exact: true }).waitFor();
    }
    const TAB_ORDER = '.sidebar-tab:not([hidden]) [role=tab]';
    const DROPPED = '.sidebar-tab[data-drop]';
    const tab = (name) => page.locator('.sidebar-tab').filter({ has: page.getByRole('tab', { name, exact: true }) });
    const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [TAB_ORDER, expected.join()]);
    assert.deepEqual(await page.locator(TAB_ORDER).allTextContents(), ['文件', '终端']);
    const source = await tab('文件').boundingBox();
    const target = await tab('终端').boundingBox();
    await page.mouse.move(source.x + 20, source.y + 18);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 18, { steps: 6 });
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 1, DROPPED);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 0, DROPPED);
    await tab('终端').dragTo(tab('文件'), { targetPosition: { x: 4, y: 18 } });
    await settled(['终端', '文件']);
    await tab('终端').dragTo(tab('文件'), { targetPosition: { x: 45, y: 18 } });
    await settled(['文件', '终端']);
    // opening a workspace rebinds these tabs to it, which rewrites their keys
    await newWorkspace(page);
    await tab('终端').dragTo(tab('文件'), { targetPosition: { x: 4, y: 18 } });
    await settled(['终端', '文件']);
    await desktop.close(); desktop = undefined;
    await open();
    await settled(['终端', '文件']);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the workspaces header names what it can open, and a row menu closes or renames it', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-workspace-menu-'));
  const env = testEnv(home);
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await newWorkspace(page);
    const menu = page.locator('#workspace-row-menu');
    const items = () => menu.getByRole('menuitem').allTextContents();
    await openWorkspaceMenu(page);
    assert.deepEqual(await items(), ['新建 本机'], 'what can be opened is named as a creation');
    await page.keyboard.press('Escape');
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click({ button: 'right' });
    assert.deepEqual(await items(), ['重命名', '关闭工作区'], 'a row is renamed or closed from its menu and nothing else');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a workspace is renamed in a dialog, and an empty name is left to the provider', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-workspace-rename-'));
  const env = testEnv(home);
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await newWorkspace(page);
    const LABELS = '[aria-label="工作区"] [role=tab] .name';
    const settled = (expected) => page.waitForFunction(([selector, want]) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join() === want, [LABELS, expected.join()]);
    const dialog = page.getByRole('dialog', { name: '重命名工作区' });
    const input = dialog.getByRole('textbox');
    const openRename = async () => {
      await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
      await dialog.waitFor();
    };
    await settled(['~']);
    await openRename();
    assert.equal(await input.inputValue(), '~', 'the dialog opens on the name the row shows');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await openRename();
    await input.fill('手写的名字');
    await input.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await settled(['手写的名字']);
    await openRename();
    await input.fill('');
    await input.press('Enter');
    await settled(['~']);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the menu bar holds one view menu with the plugin item', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-menu-'));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: [], tabs: [] });
    desktop = await launchApp(home, env);
    await desktop.firstWindow();
    const [labels, viewItems] = await desktop.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu().items;
      return [items.map((item) => item.label), items[1].submenu.items.map((item) => item.label)];
    });
    assert.deepEqual(labels, ['旺财', '视图']);
    assert.deepEqual(viewItems, ['插件']);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a workspace row shows what its agent is doing, and a click clears a finished one', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-agent-state-'));
  const env = testEnv(home);
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await newWorkspace(page);
    await newWorkspace(page);
    const rows = page.getByRole('tablist', { name: '工作区' }).getByRole('tab');
    const badge = (index) => rows.nth(index).locator('.agent-state');
    const color = (index) => badge(index).evaluate((element) => getComputedStyle(element).color);
    // The panel draws a report a moment later, on the row that reported it.
    const drawn = (index, want) => page.waitForFunction(([index, want]) => document.querySelectorAll('.workspace .agent-state')[index]?.dataset.state === want, [index, want]);
    const report = (index, status) => rows.nth(index).evaluate((row, status) => window.wangcai.request('terminal-agent', 'agent-state', { id: row.dataset.workspace, status }), status);
    assert.deepEqual([await badge(0).getAttribute('data-state'), await badge(1).getAttribute('data-state')], ['idle', 'idle'], 'a workspace whose agent has said nothing is idle');
    assert.equal(await color(0), 'rgb(139, 152, 166)', 'idle is drawn in the muted color');
    await report(0, 'working');
    await drawn(0, 'working');
    assert.equal(await color(0), 'rgb(57, 148, 188)', 'work is drawn in the accent');
    assert.notEqual(await badge(0).locator('svg').evaluate((element) => getComputedStyle(element).animationName), 'none', 'the working mark turns');
    await report(0, 'finished');
    await drawn(0, 'finished');
    assert.equal(await color(0), 'rgb(155, 199, 188)', 'a finished run is drawn in green');
    assert.equal(await badge(0).getAttribute('aria-label'), '状态：已完成');
    // The click that clears the mark belongs to the mark, not to the row it sits in.
    await rows.nth(1).click();
    await badge(0).click();
    await drawn(0, 'idle');
    assert.equal(await rows.nth(1).getAttribute('aria-selected'), 'true', 'clearing a mark does not put another workspace in front');
    // Another state clears what the click read, so the same finished is drawn again the next time it is reported.
    await report(0, 'working');
    await drawn(0, 'working');
    await report(0, 'finished');
    await drawn(0, 'finished');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
