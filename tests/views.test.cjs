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
