const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('user config: init.ts drives the plugins, the UI theme, their own config and the terminal', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-config-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    return desktop.firstWindow();
  };
  // A broken init.ts starts the app without plugins, so there is no machine element to wait for.
  const launchReady = async () => {
    const page = await launch();
    await page.locator('.machine.connected').waitFor();
    return page;
  };
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    writeFileSync(init, `
      export const profiles = {
        day: {
          theme: { background: '#f7f8fa', foreground: '#203040', border: 42 },
          plugins: [
            { id: 'workspace', config: { font: { family: 'Config UI Font' } } },
            { id: 'terminal', config: { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } } },
          ],
        },
      };
      export default profiles.day;
    `);
    let page = await launchReady();
    // The list decides what loads: the plugins it does not list never run.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['terminal', 'workspace']);
    // A plugin's schema fills in what its entry leaves out.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map(({ id, config }) => [id, config])), [
      ['terminal', { font: { family: 'Config Mono', size: 20, lineHeight: 1.5 } }],
      ['workspace', { font: { family: 'Config UI Font', size: 13, lineHeight: 1 } }],
    ]);
    // The shell keeps its own font: the app's config has no say in it.
    assert.deepEqual(await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return [body.backgroundColor, body.color, body.fontFamily, getComputedStyle(document.documentElement).getPropertyValue('--wc-border'), document.documentElement.style.colorScheme];
    }), ['rgb(247, 248, 250)', 'rgb(32, 48, 64)', '"DejaVuSansM Nerd Font Mono", monospace', '#333536', 'light']);
    // A plugin's own font applies to the panel the shell gives it.
    assert.equal(await page.locator('.sidebar-slot[data-plugin=workspace]').evaluate((element) => getComputedStyle(element).fontFamily), '"Config UI Font"');
    await page.locator('.machine.connected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /新建工作区/ }).click();
    await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor === 'rgb(247, 248, 250)');
    // The workspace pane renders its own terminal with the workspace plugin's font.
    assert.deepEqual(await page.evaluate(() => {
      const rows = getComputedStyle(document.querySelector('.xterm-rows'));
      return [rows.fontFamily, rows.fontSize, rows.color];
    }), ['"Config UI Font"', '13px', 'rgb(32, 48, 64)']);
    await desktop.close(); desktop = undefined;

    writeFileSync(init, 'export default { theme: ');
    page = await launch();
    // A broken config file leaves the app with no plugin at all.
    await page.waitForFunction(() => document.querySelector('#root').textContent.trim());
    assert.match(await page.locator('#root').innerText(), /未安装插件/);
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.documentElement.style.colorScheme]), ['rgb(18, 19, 20)', 'dark']);
    // The app's own profile carries no plugin fields: fonts belong to the plugins alone.
    assert.deepEqual(await page.evaluate(async () => Object.keys(await window.wangcai.config()).sort()), ['agent', 'theme']);
    await desktop.close(); desktop = undefined;
    rmSync(init);
    page = await launchReady();
    // A missing init.ts is written once, listing the plugins the app ships.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['files', 'git', 'terminal', 'workspace']);
    const preset = readFileSync(init, 'utf8');
    assert.match(preset, /plugins: \[\n    \{ id: 'workspace' \},\n    \{ id: 'files' \},\n    \{ id: 'git' \},\n    \{ id: 'terminal' \},\n  \],/);
    // The preset never mentions a font: a plugin's schema and its entry's config decide those alone.
    assert.doesNotMatch(preset, /font/);
    assert.match(preset, /plugins \[\{ id, directory, config \}\]/);
    // The reference the preset carries names every theme token the app defaults to.
    for (const token of Object.keys(await page.evaluate(async () => (await window.wangcai.config()).theme))) assert.match(preset, new RegExp(token));
    await desktop.close(); desktop = undefined;
    writeFileSync(init, `${readFileSync(init, 'utf8')}// 用户改过这个文件\n`);
    page = await launchReady();
    // init.ts is only written while it is missing, so the edit survives the restart.
    assert.match(readFileSync(init, 'utf8'), /用户改过这个文件/);
    await desktop.close(); desktop = undefined;
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
