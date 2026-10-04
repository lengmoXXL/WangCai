const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { createWorkspace, waitForShell, writeInit } = require('./init.cjs');
const { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('packaged app carries its plugins, previews files and prefers plugins from the config directory', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-package-'));
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  const bundle = resolve('desktop/dist/package/mac/旺财.app/Contents');
  let page;
  const launch = async () => {
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/旺财'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    return desktop.firstWindow();
  };
  try {
    writeInit(home);
    assert.equal(execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', join(bundle, 'Info.plist')], { encoding: 'utf8' }).trim(), '旺财');
    page = await launch();
    await waitForShell(page);
    const baseSpacing = await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).letterSpacing);
    // The app carries prebuilt plugins and never installs or compiles them into the user's home.
    assert.equal(existsSync(join(home, '.local/shared/wangcai/plugins')), false);
    for (const id of ['terminal-agent', 'files', 'terminal']) {
      assert.equal(existsSync(join(bundle, 'Resources/plugins', id, 'main.cjs')), true);
      assert.equal(existsSync(join(bundle, 'Resources/plugins', id, 'ui.js')), true);
    }
    // Repository plugins build with the node and npm the app carries.
    assert.equal(existsSync(join(bundle, 'Resources/node/bin/node')), true);
    assert.equal(existsSync(join(bundle, 'Resources/node/lib/node_modules/npm/bin/npm-cli.js')), true);
    const code = join(home, 'packaged.ts');
    writeFileSync(code, 'const packaged = "PACKAGED_PREVIEW";\n');
    await page.evaluate(path => window.wangcai.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'PACKAGED_PREVIEW' }).waitFor();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => { window.MonacoEnvironment.getWorker('', 'editorWorkerService'); });
    const worker = await workerReady;
    assert.equal(await Promise.race([
      worker.evaluate(() => typeof self.onmessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged worker failed to initialize')), 10000)),
    ]), 'function');
    await page.getByRole('button', { name: '关闭 packaged.ts' }).click();
    await desktop.close(); desktop = undefined;
    // A plugin in the config directory wins over the one the app ships.
    const override = join(home, '.config/wangcai/plugins/terminal-agent');
    cpSync(join(bundle, 'Resources/plugins/terminal-agent'), override, { recursive: true });
    writeFileSync(join(override, 'ui.css'), `${readFileSync(join(override, 'ui.css'), 'utf8')}\n.desktop-main .plugin[data-plugin=terminal-agent] { letter-spacing: 7px; }\n`);
    page = await launch();
    assert.equal(await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).letterSpacing), '7px');
    assert.equal(existsSync(join(home, '.cache/wangcai')), false);
    await createWorkspace(page);
    await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'PACKAGED_%s\\n' success");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('PACKAGED_success'));
    assert.ok(JSON.parse(readFileSync(join(home, '.config/wangcai/server.json'))).port > 0);
    await desktop.close(); desktop = undefined;
    rmSync(override, { recursive: true });
    page = await launch();
    await waitForShell(page);
    assert.equal(await page.locator('.desktop-main .plugin[data-plugin=terminal-agent]').evaluate((element) => getComputedStyle(element).letterSpacing), baseSpacing);
    await desktop.close(); desktop = undefined;
    // A fresh install has no init.ts: the app writes the default one and loads its own plugins with it.
    rmSync(join(home, '.config/wangcai/init.ts'));
    page = await launch();
    await waitForShell(page);
    assert.match(readFileSync(join(home, '.config/wangcai/init.ts'), 'utf8'), /workspaces: \[\n    \{ id: 'terminal-agent' \}/);
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['files', 'terminal', 'terminal-agent']);
    assert.equal(await page.locator('.plugin-error').count(), 0);
  } finally {
    await desktop?.close();
    try { execFileSync(join(bundle, 'Resources/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
