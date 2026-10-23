const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { drawnOrder, firstInsideLine, headerTop, launchApp, launchedWithThree, lineAfter, lineBefore, lineBeforeGroup, makeGroup, mockView, mockWorkspace, newWorkspace, onLine, openWorkspaceMenu, rowId, rowIds, setFullScreen, testEnv, waitForShell, writeInit } = require('./init.cjs');

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

test('a group is made, renamed, folded, moved and remembered', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-workspace-groups-'));
  const env = testEnv(home);
  const stored = () => JSON.parse(readFileSync(join(home, '.local/share/wangcai/groups.json'), 'utf8'));
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, env);
    let page = await desktop.firstWindow();
    await waitForShell(page);
    await newWorkspace(page);
    let group = page.locator('.workspace-group');
    let bar = page.getByRole('button', { name: '分组 一组' });
    let menu = page.locator('#workspace-row-menu');
    let rows = page.locator('.workspaces > .workspace');
    await makeGroup(page, '一组');
    assert.equal(await group.locator('.workspace').count(), 0, 'a fresh group holds nothing');
    // the group's twistie starts at the edge of a row's card
    const leftOf = (locator) => locator.evaluate((element) => element.getBoundingClientRect().left);
    assert.ok(Math.abs((await leftOf(group.locator('.chevron'))) - (await leftOf(rows.first()))) < 1, 'the group icon starts at the edge of a row');
    // folding is the bar's own click, and the rows come back on the next one
    const angle = () => group.locator('.chevron').evaluate((element) => {
      const matrix = getComputedStyle(element).transform;
      if (matrix === 'none') return 0;
      const [a, b] = matrix.match(/-?[\d.]+/g).map(Number);
      return Math.round(Math.atan2(b, a) * 180 / Math.PI);
    });
    assert.equal(await angle(), 0, 'an open group points down at the rows it holds');
    await bar.click();
    assert.equal(await bar.getAttribute('aria-expanded'), 'false', 'a folded group says so');
    assert.equal(await angle(), -90, 'a folded group points right, at where they went');
    assert.equal(await group.locator('.workspace-group-rows').isVisible(), false, 'and its rows are hidden');
    await bar.click();
    assert.equal(await bar.getAttribute('aria-expanded'), 'true', 'the next click opens it again');
    await makeGroup(page, '二组');
    const bars = page.locator('.workspace-group-bar');
    assert.deepEqual(await bars.allTextContents(), ['一组', '二组'], 'the second group is drawn under the first');
    // a group is dragged by its own bar onto the line above another group, and takes that place
    await bars.last().dragTo(await lineBeforeGroup(page, 0), { targetPosition: onLine });
    assert.deepEqual(await bars.allTextContents(), ['二组', '一组'], 'the dragged group moved to the line it was dropped on');
    assert.deepEqual(stored().map((entry) => entry.name), ['二组', '一组'], 'the groups file holds the new order');
    // dropping a group on the line in front of itself leaves the order of the groups alone
    await bars.first().dragTo(await lineBeforeGroup(page, 0), { targetPosition: onLine });
    assert.deepEqual(await bars.allTextContents(), ['二组', '一组'], 'the groups keep their order');
    assert.deepEqual(stored().map((entry) => entry.name), ['二组', '一组'], 'and the file is left as it was');
    const deleteGroup = async (target) => {
      await target.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '删除分组', exact: true }).click();
    };
    const rowMenu = async (name) => {
      await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click({ button: 'right' });
      await menu.getByRole('menuitem', { name, exact: true }).click();
    };
    await deleteGroup(bars.first());
    assert.equal(await bars.count(), 1, 'the group that was deleted is gone');
    // a row joins the group from its own menu, and leaves it the same way
    await rowMenu('移入 一组');
    assert.equal(await group.locator('.workspace').count(), 1, 'the row is drawn under the group');
    assert.equal(await rows.count(), 0, 'and no longer beside it');
    await rowMenu('移出分组');
    assert.equal(await group.locator('.workspace').count(), 0, 'the group is empty again');
    assert.equal(await rows.count(), 1, 'and the row is back in the list');
    // filing a row into a folded group unfolds it, so the row lands where the eye goes
    await bar.click();
    assert.equal(await bar.getAttribute('aria-expanded'), 'false', 'the group is folded to begin with');
    await rowMenu('移入 一组');
    assert.equal(await group.locator('.workspace').count(), 1, 'the row is filed into the folded group');
    assert.equal(await bar.getAttribute('aria-expanded'), 'true', 'and filing it in unfolds the group');
    // renaming a group from its own menu keeps an empty name in the dialog and writes the new one down
    await bar.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '重命名分组', exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名分组' });
    const typed = rename.getByRole('textbox');
    assert.equal(await typed.inputValue(), '一组', 'the dialog opens on the name the group has');
    await typed.fill('');
    await typed.press('Enter');
    assert.equal(await rename.getByRole('alert').textContent(), '分组名称不能为空', 'an empty name is refused with a note');
    assert.equal(await rename.isVisible(), true, 'an empty name keeps the dialog open');
    await typed.fill('改名组');
    await typed.press('Enter');
    await rename.waitFor({ state: 'hidden' });
    assert.equal(await stored()[0].name, '改名组', 'the new name is what the groups file holds');
    await desktop.close(); desktop = undefined;
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await waitForShell(page);
    group = page.locator('.workspace-group');
    bar = page.getByRole('button', { name: '分组 改名组' });
    menu = page.locator('#workspace-row-menu');
    rows = page.locator('.workspaces > .workspace');
    await bar.waitFor();
    // A provider that restarts serves its rows afresh, so the two it served before are made again: the group keeps
    // the row it held, and the other one is beside it again.
    for (const _ of [1, 2]) await newWorkspace(page);
    assert.equal(await group.locator('.workspace').count(), 1, 'the group is drawn with the row it holds');
    assert.equal(await rows.count(), 1, 'one row is left beside the group');
    // a group that goes away gives its rows back to the list
    await deleteGroup(bar);
    assert.equal(await group.count(), 0, 'the deleted group is gone');
    assert.equal(await rows.count(), 2, 'and both rows are back in the list');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a group dropped on the line that closes the list comes last', { timeout: 180000 }, async () => {
  const { home, desktop, page } = await launchedWithThree();
  const stored = () => JSON.parse(readFileSync(join(home, '.local/share/wangcai/groups.json'), 'utf8')).map((group) => group.name);
  try {
    await makeGroup(page, '甲');
    await makeGroup(page, '乙');
    const bars = page.locator('.workspace-group-bar');
    assert.deepEqual(await bars.allTextContents(), ['甲', '乙'], 'the groups stand in the order they were made');
    await bars.first().dragTo(page.locator('.workspaces > :last-child'), { targetPosition: onLine });
    assert.deepEqual(await bars.allTextContents(), ['乙', '甲'], 'the dragged group ends the list');
    assert.deepEqual(await stored(), ['乙', '甲'], 'and the groups file holds that order');
  } finally {
    await desktop.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a group dropped on the line above a row stands after the groups at that place', { timeout: 180000 }, async () => {
  const { home, desktop, page, rows } = await launchedWithThree();
  const stored = () => JSON.parse(readFileSync(join(home, '.local/share/wangcai/groups.json'), 'utf8')).map((group) => group.name);
  try {
    await makeGroup(page, '甲');
    await makeGroup(page, '乙');
    // Both groups are put in the same place, the one in front of the second row.
    await page.getByRole('button', { name: '分组 乙' }).dragTo(await lineBefore(page, rows.nth(1)), { targetPosition: onLine });
    await page.getByRole('button', { name: '分组 甲' }).dragTo(await lineBefore(page, rows.nth(1)), { targetPosition: onLine });
    assert.deepEqual(await drawnOrder(page), ['row', '乙', '甲', 'row', 'row'], 'the group put there last stands after the one already there');
    assert.deepEqual(await stored(), ['乙', '甲'], 'and the groups file holds that order');
  } finally {
    await desktop.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('workspaces are dragged onto the lines of the list', { timeout: 180000 }, async () => {
  const { home, desktop, page, rows, groups } = await launchedWithThree();
  try {
    // a row dropped on the line under itself keeps its place
    const kept = await rowIds(rows);
    await rows.first().dragTo(await lineAfter(page, rows.first()), { targetPosition: onLine });
    assert.deepEqual(await rowIds(rows), kept, 'the row keeps its place');
    await makeGroup(page, '甲');
    const first = groups.first();
    // a row dropped on the line under a group's bar joins it
    await rows.first().dragTo(firstInsideLine(first), { targetPosition: onLine });
    assert.equal(await first.locator('.workspace').count(), 1, 'the row joined the group');
    assert.equal(await rows.count(), 2, 'and left the list');
    // a second row filed the same way becomes the group's first row
    await rows.first().dragTo(firstInsideLine(first), { targetPosition: onLine });
    const filed = await rowIds(first.locator('.workspace'));
    assert.equal(filed.length, 2, 'the group holds both rows');
    await first.locator('.workspace').last().dragTo(firstInsideLine(first), { targetPosition: onLine });
    assert.deepEqual(await rowIds(first.locator('.workspace')), [filed[1], filed[0]], 'the row moved above the one it was dropped on');
    // the line that closes the list takes a row back out of its group
    const out = await rowId(first.locator('.workspace'));
    await first.locator('.workspace').first().dragTo(page.locator('.workspaces > :last-child'), { targetPosition: onLine });
    assert.equal(await first.locator('.workspace').count(), 1, 'the row left its group');
    assert.equal(await rows.count(), 2, 'and stands in the list');
    assert.equal(await rowId(rows.last()), out, 'at the end of it');
    // the line at the top stands a row above every group
    const up = await rowId(first.locator('.workspace'));
    await first.locator('.workspace').first().dragTo(page.locator('.workspaces > :first-child'), { targetPosition: onLine });
    assert.equal(await rowId(rows), up, 'the row took the top of the list');
    assert.equal(await first.locator('.workspace').count(), 0, 'and left the group empty');
    assert.deepEqual(await drawnOrder(page), ['row', '甲', 'row', 'row'], 'with the group drawn under the row that went above it');
  } finally {
    await desktop.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a workspace dropped on a line between two groups keeps that place, and one moved onto another group joins it', { timeout: 180000 }, async () => {
  const { home, desktop, page, rows, groups } = await launchedWithThree();
  try {
    await makeGroup(page, '甲');
    await makeGroup(page, '乙');
    const first = groups.first();
    // the first group takes two rows, and one row is left beside the two empty groups
    await rows.first().dragTo(firstInsideLine(first), { targetPosition: onLine });
    await rows.first().dragTo(firstInsideLine(first), { targetPosition: onLine });
    assert.equal(await first.locator('.workspace').count(), 2, 'both rows joined the first group');
    assert.equal(await rows.count(), 1, 'one row is left beside the groups');
    const leftOver = await rowId(rows);
    assert.deepEqual(await drawnOrder(page), ['row', '甲', '乙'], 'the row is drawn above both groups');
    // dropping that row on the line between the two groups puts it between them
    const between = await lineBeforeGroup(page, -1);
    await rows.first().dragTo(between, { targetPosition: onLine });
    assert.deepEqual(await drawnOrder(page), ['甲', 'row', '乙'], 'the row stands between the two groups');
    assert.equal(await rowId(rows), leftOver, 'and it is the row that was dragged');
    // a row dragged from one group onto the line of another group joins that group
    const second = groups.last();
    const fromFirst = await rowId(first.locator('.workspace'));
    await first.locator('.workspace').first().dragTo(firstInsideLine(second), { targetPosition: onLine });
    assert.equal(await first.locator('.workspace').count(), 1, 'the row left its group');
    assert.deepEqual(await rowIds(second.locator('.workspace')), [fromFirst], 'and joined the group it was dropped on');
  } finally {
    await desktop.close();
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
    assert.equal(appItems.includes('更新核心组件'), false);
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
    assert.equal(await installs.isVisible(), false, 'the page is closed until it is asked for');
    await tell(pluginPageTopic);
    await installs.waitFor();
    await tell(installStatusesTopic, [{ id: coreId, stage: 'building', message: 'npm run build' }]);
    await page.locator('.installs .core[data-stage=building]').waitFor();
    assert.equal(await core.locator('.install-id').innerText(), '核心组件');
    assert.equal(await core.locator('.install-stage').innerText(), '构建中');
    assert.equal(await core.locator('.install-message').innerText(), 'npm run build');
    assert.equal(await update.isDisabled(), true, 'a rebuild in flight is not asked for twice');
    assert.equal(await installs.locator('li').count(), 0, 'Core is a row of the page, not one of the plugin list');
    // A row with something left to do opens the page, and one that is done leaves it as it was found.
    await installs.locator('header button', { hasText: '关闭' }).click();
    await installs.waitFor({ state: 'hidden' });
    await tell(installStatusesTopic, [{ id: coreId, stage: 'ready', message: '已是最新' }, { id: 'files', stage: 'ready' }]);
    assert.equal(await installs.isVisible(), false, 'a finished install leaves the page closed');
    assert.equal(await update.isDisabled(), false);
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
    const report = (index, status) => rows.nth(index).evaluate((row, status) => window.wangcai.call('request', 'terminal-agent', 'agent-state', { id: row.dataset.workspace, status }), status);
    const shapes = (index) => badge(index).evaluate((element) => [...element.querySelectorAll('.ring, .dot, .check')].filter((shape) => getComputedStyle(shape).display !== 'none').map((shape) => shape.getAttribute('class')));
    assert.deepEqual([await badge(0).getAttribute('data-state'), await badge(1).getAttribute('data-state')], ['idle', 'idle'], 'a workspace whose agent has said nothing is idle');
    assert.equal(await color(0), 'rgb(139, 152, 166)', 'idle is drawn in the muted color');
    assert.deepEqual(await shapes(0), ['dot'], 'an idle row draws only the dot');
    await report(0, 'working');
    await drawn(0, 'working');
    assert.equal(await color(0), 'rgb(57, 148, 188)', 'work is drawn in the accent');
    assert.deepEqual(await shapes(0), ['ring'], 'a working row draws the ring, not the dot');
    assert.notEqual(await badge(0).evaluate((element) => getComputedStyle(element, '::before').animationName), 'none', 'the working mark turns');
    await report(0, 'finished');
    await drawn(0, 'finished');
    assert.equal(await color(0), 'rgb(155, 199, 188)', 'a finished run is drawn in green');
    assert.deepEqual(await shapes(0), ['check'], 'a finished row draws only the check');
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
    // Looking at a workspace clears what it reported, and brings it to the front.
    await rows.nth(0).click();
    await drawn(0, 'idle');
    assert.equal(await rows.nth(0).getAttribute('aria-selected'), 'true', 'looking at a workspace brings it to the front');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
