const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openWorkspaceMenu, until } = require('@lengmoxxl/wangcai-testkit');
const { headerTop, launchApp, mockWorkspace, newWorkspace, setFullScreen, testEnv, waitForShell, writeInit } = require('./init.cjs');

const { coreId, installStatusesTopic, link, pluginPageTopic } = require('@lengmoxxl/sdk/bridge');

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
    await waitForShell(page);
    assert.equal(await left.evaluate((element) => getComputedStyle(element).paddingTop), '36px');
    // 36px chrome + 1px card border + 3px window inset.
    assert.equal(await headerTop(page), 40);
    // What this covers is the change the main process forwards, so this drives the event that carries it.
    await setFullScreen(desktop, page, true);
    assert.equal(await headerTop(page), 4);
    await setFullScreen(desktop, page, false);
    assert.equal(await headerTop(page), 40);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a plugin update that loads the page again keeps the workspaces in the full screen', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-full-screen-reload-'));
  const env = testEnv(home);
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    await setFullScreen(desktop, page, true);
    await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu.items).find((item) => item.label === '插件').click());
    await page.locator('.installs').waitFor();
    // An update loads the page again, and what comes back is a page that has nothing left to report.
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reload(); });
    await waitForShell(page);
    await page.locator('.installs').waitFor({ state: 'hidden' });
    // The full screen keeps the workspaces at the 3px window inset and the 1px card border.
    assert.equal(await headerTop(page), 4);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the workspaces header names what it can open and what it can group, and a row menu closes or renames it', { timeout: 180000 }, async () => {
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
    assert.deepEqual(await items(), ['新建 本机', '新建分组'], 'what can be opened is named as a creation, and a group is made beside it');
    await page.keyboard.press('Escape');
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click({ button: 'right' });
    assert.deepEqual(await items(), ['重命名', '关闭工作区'], 'with no groups, a row is renamed or closed from its menu');
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
    const settled = (expected) => until(async () => (await page.locator('[aria-label="工作区"] [role=tab] .name').allTextContents()).join() === expected.join());
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

test('the app menu holds no Core entry of its own, and the view menu holds the plugin page', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-menu-'));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: [], tabs: [] });
    desktop = await launchApp(home, env);
    await desktop.firstWindow();
    const [labels, appItems, viewItems] = await desktop.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu().items;
      return [
        items.map((item) => item.label),
        items[0].submenu.items.map((item) => item.label),
        items[1].submenu.items.map((item) => item.label),
      ];
    });
    assert.deepEqual(labels, ['旺财', '视图']);
    // The Core the app installs itself is a row of the plugin page, so the app menu carries nothing about it;
    // the view menu holds pages.
    assert.ok(!appItems.includes('更新核心组件'));
    assert.deepEqual(viewItems, ['插件']);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the plugin page draws Core above its plugins, and holds the button that asks for a rebuild', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-core-row-'));
  const env = testEnv(home);
  let desktop;
  try {
    writeInit(home, { workspaces: [], tabs: [] });
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await waitForShell(page);
    const installs = page.locator('.installs');
    const core = installs.locator('.core');
    const update = core.locator('button');
    // What the app says over the bridge is what the page draws, so the topics are sent by hand. Core is a row of
    // the same list the plugins are rows of, so one report carries both.
    const tell = (topic, data) => desktop.evaluate(({ BrowserWindow }, [channel, topic, data]) => {
      BrowserWindow.getAllWindows()[0].webContents.send(channel, topic, data);
    }, [link.channel, topic, data]);
    assert.ok(await installs.isHidden(), 'the page is closed until it is asked for');
    await tell(pluginPageTopic);
    await installs.waitFor();
    await tell(installStatusesTopic, [{ id: coreId, stage: 'building', message: 'npm run build' }]);
    await page.locator('.installs .core[data-stage=building]').waitFor();
    assert.equal(await core.locator('.install-id').innerText(), '核心组件');
    assert.equal(await core.locator('.install-stage').innerText(), '构建中');
    assert.equal(await core.locator('.install-message').innerText(), 'npm run build');
    assert.ok(await update.isDisabled(), 'a rebuild in flight is not asked for twice');
    assert.equal(await installs.locator('li').count(), 0, 'Core is a row of the page, not one of the plugin list');
    // A row with something left to do opens the page, and one that is done leaves it as it was found.
    await installs.locator('header button', { hasText: '关闭' }).click();
    await installs.waitFor({ state: 'hidden' });
    await tell(installStatusesTopic, [{ id: coreId, stage: 'ready', message: '已是最新' }, { id: 'files', stage: 'ready' }]);
    assert.ok(await installs.isHidden(), 'a finished install leaves the page closed');
    assert.ok(await update.isEnabled());
    assert.equal(await update.innerText(), '更新');
    assert.deepEqual(await page.locator('.installs li .install-id').allInnerTexts(), ['files']);
    await tell(installStatusesTopic, [{ id: coreId, stage: 'failed', message: 'git clone 失败' }]);
    await installs.waitFor();
    await page.locator('.installs .core[data-stage=failed]').waitFor();
    assert.equal(await update.innerText(), '重试');
    assert.equal(await core.locator('.install-message').innerText(), 'git clone 失败');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
