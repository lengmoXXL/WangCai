const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('user config: init.ts drives the UI theme, the fonts and the terminal', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-config-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    return page;
  };
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    writeFileSync(init, `
      export const profiles = {
        day: {
          font: { ui: { family: 'Config UI Font' }, terminal: { family: 'Config Mono', size: 20, lineHeight: 1.5 } },
          theme: { background: '#f7f8fa', foreground: '#203040', border: 42 },
        },
      };
      export default profiles.day;
    `);
    let page = await launch();
    assert.deepEqual(await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return [body.backgroundColor, body.color, body.fontFamily, getComputedStyle(document.documentElement).getPropertyValue('--wc-border'), document.documentElement.style.colorScheme];
    }), ['rgb(247, 248, 250)', 'rgb(32, 48, 64)', '"Config UI Font"', '#252c35', 'light']);
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
    await page.locator('.terminal-pane.active .xterm-helper-textarea').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor === 'rgb(247, 248, 250)');
    assert.deepEqual(await page.evaluate(() => {
      const rows = getComputedStyle(document.querySelector('.xterm-rows'));
      return [rows.fontFamily, rows.fontSize, rows.color];
    }), ['"Config Mono"', '20px', 'rgb(32, 48, 64)']);
    await desktop.close(); desktop = undefined;

    writeFileSync(init, 'export default { theme: ');
    page = await launch();
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.documentElement.style.colorScheme]), ['rgb(17, 21, 27)', 'dark']);
    assert.equal(await page.evaluate(async () => (await window.wangcai.config()).font.terminal.lineHeight), 1);
    await desktop.close(); desktop = undefined;
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});