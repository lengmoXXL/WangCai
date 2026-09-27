const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('packaged app installs, preserves and restores the terminal plugin', { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'shu-package-'));
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  const bundle = resolve('desktop/dist/package/mac/shu.app/Contents');
  try {
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/shu'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    await desktop.close(); desktop = undefined;
    const pluginSource = join(home, '.local/shared/shu/plugins/terminal/ui.tsx');
    const source = readFileSync(pluginSource, 'utf8');
    writeFileSync(pluginSource, source.replace('机器设置</button>', '本地修改生效</button>'));
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/shu'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    try { await page.getByRole('button', { name: '本地修改生效' }).waitFor({ timeout: 15000 }); }
    catch (error) { console.error(await page.locator('body').innerText()); throw error; }
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await page.getByRole('tab', { name: /终端 1/ }).waitFor();
    await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'PACKAGED_%s\\n' success");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('PACKAGED_success'));
    assert.ok(JSON.parse(readFileSync(join(home, '.config/shu/server.json'))).port > 0);
    await desktop.close(); desktop = undefined;
    rmSync(join(home, '.local/shared/shu/plugins/terminal'), { recursive: true });
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/shu'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
  } finally {
    await desktop?.close();
    try { execFileSync(join(bundle, 'Resources/shu'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
