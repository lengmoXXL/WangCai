const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('view menu switches plugins and handles empty, disconnected and closed terminals', { timeout: 60000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shu-views-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  try {
    const other = join(home, '.local/shared/shu/plugins/other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'main.ts'), 'export function activate() {}');
    writeFileSync(join(other, 'ui.tsx'), `
      export const title = '测试视图';
      export function mount() {}
      export function open(context) { context.tabs.open({ id: 'other', title: '测试视图', mount(container) {
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
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    const toggle = page.getByRole('button', { name: '切换右侧栏' });
    await toggle.click();
    const picker = page.getByRole('button', { name: '新建侧栏标签页' });
    const menu = page.locator('#view-menu');
    await picker.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
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
    assert.equal(await page.locator('.desktop-main [data-plugin=terminal]').isVisible(), true);
    assert.equal(await page.locator('.sidebar-panel:visible').count(), 1);
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    const directory = page.getByRole('navigation', { name: '当前目录文件' });
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    assert.equal(await directory.getByRole('button', { name: '.hidden.md', exact: true }).locator('svg[data-kind=file]').count(), 1);
    assert.equal(await directory.getByRole('button', { name: '子目录 with spaces/', exact: true }).locator('svg[data-kind=folder]').count(), 1);
    for (const [side, label, delta, minimum, shrink] of [
      ['left', '调整左侧栏宽度', 60, 140, -600],
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
    await page.getByRole('button', { name: '结束终端 1', exact: true }).click();
    await page.getByRole('tablist', { name: '本机 终端' }).getByRole('tab').waitFor({ state: 'detached' });
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '断开', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    assert.equal(await directory.isVisible(), false);
    await page.getByRole('button', { name: '本机', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '连接', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.sidebar-right').hidden);
    await toggle.click();
    await picker.click();
    await menu.getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: '.hidden.md', exact: true }).waitFor();
    mkdirSync('tests/dist/screenshots', { recursive: true });
    await page.screenshot({ path: 'tests/dist/screenshots/sidebar-layout.png' });
    while (await page.locator('.close-tab').count()) await page.locator('.close-tab').last().click();
    await page.locator('.sidebar-right').waitFor({ state: 'hidden' });
    assert.equal(await picker.isVisible(), false);
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    assert.equal(await picker.isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    try { execFileSync(resolve('shucli/dist/debug/shu'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
