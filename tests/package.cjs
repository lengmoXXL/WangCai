const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('packaged app installs plugins, previews files and preserves user changes', { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-package-'));
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  const bundle = resolve('desktop/dist/package/mac/wangcai.app/Contents');
  try {
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/wangcai'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    const code = join(home, 'packaged.ts');
    writeFileSync(code, 'const packaged = "PACKAGED_PREVIEW";\n');
    await page.evaluate(path => window.wangcai.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'PACKAGED_PREVIEW' }).waitFor();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: 'Git', exact: true }).click();
    await page.getByText('请选择一个已连接的终端', { exact: true }).waitFor();
    assert.match(readFileSync(join(home, '.local/shared/wangcai/plugins/git/main.ts'), 'utf8'), /readGit/);
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => { window.MonacoEnvironment.getWorker('', 'editorWorkerService'); });
    const worker = await workerReady;
    assert.equal(await Promise.race([
      worker.evaluate(() => typeof self.onmessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged worker failed to initialize')), 10000)),
    ]), 'function');
    await page.getByRole('button', { name: '关闭 packaged.ts' }).click();
    await desktop.close(); desktop = undefined;
    const pluginSource = join(home, '.local/shared/wangcai/plugins/workspace/ui.tsx');
    const source = readFileSync(pluginSource, 'utf8');
    writeFileSync(pluginSource, source.replace('机器设置</button>', '本地修改生效</button>'));
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/wangcai'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    try { await page.getByRole('button', { name: '本地修改生效' }).waitFor({ timeout: 15000 }); }
    catch (error) { console.error(await page.locator('body').innerText()); throw error; }
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
    await page.getByRole('tablist', { name: '本机 工作区' }).getByRole('tab').waitFor();
    await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'PACKAGED_%s\\n' success");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.terminal-pane.active .xterm-rows')?.textContent.includes('PACKAGED_success'));
    assert.ok(JSON.parse(readFileSync(join(home, '.config/wangcai/server.json'))).port > 0);
    await desktop.close(); desktop = undefined;
    rmSync(join(home, '.local/shared/wangcai/plugins/workspace'), { recursive: true });
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/wangcai'), args: [`--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
  } finally {
    await desktop?.close();
    try { execFileSync(join(bundle, 'Resources/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
