const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

test('file links open code and Markdown on the right; errors and close preserve terminal', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shu-files-')));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let devServer;
  try {
    const code = join(home, 'sample.ts');
    const markdown = join(home, '说明 file.md');
    const binary = join(home, 'binary.bin');
    const json = join(home, 'settings.json');
    writeFileSync(json, '{"ready":true}');
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\n');
    writeFileSync(markdown, '# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n<script>window.previewScriptRan = true</script>');
    writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    const session = (await page.evaluate(() => window.shu.request('terminal', 'terminal', { id: 'local', op: 'list', params: {} })))[0];
    const clickLink = async (link, label = link, cwd = home) => {
      const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
      const command = `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${output}'\r`;
      await page.evaluate(({ id, command }) => window.shu.request('terminal', 'terminal', { id: 'local', op: 'input', params: { session_id: id, data: command } }), { id: session.id, command });
      const row = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: label }).first();
      await page.waitForFunction(label => document.querySelector('.terminal-pane.active .xterm-rows > div')?.textContent.trim() === label, label);
      const point = await row.evaluate((element, label) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node; node = walker.nextNode();) {
          const index = node.textContent.indexOf(label);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
        throw new Error('Link text not found');
      }, label);
      await page.mouse.move(500, 500);
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(() => !!document.querySelector('.xterm-cursor-pointer'));
      await page.mouse.click(point.x, point.y);
    };
    assert.equal(await page.locator('[data-plugin=files]').isVisible(), false);
    await clickLink(`${code}:2:3`);
    await page.getByLabel('文件预览', { exact: true }).waitFor();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    const workerReady = page.waitForEvent('worker');
    await page.evaluate(() => { window.MonacoEnvironment.getWorker('', 'editorWorkerService'); });
    const worker = await workerReady;
    assert.equal(await Promise.race([worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (typeof self.onmessage === 'function') return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('Preview worker failed to initialize')), 10000))]), true);
    const codeView = page.locator('.monaco-editor .view-lines');
    const beforeEdit = await codeView.innerText();
    await codeView.click();
    await page.keyboard.type('SHOULD_NOT_EDIT');
    assert.equal(await codeView.innerText(), beforeEdit);
    const terminalBounds = await page.locator('[data-plugin=terminal]').boundingBox();
    const fileBounds = await page.locator('[data-plugin=files]').boundingBox();
    assert.ok(fileBounds.x >= terminalBounds.x + terminalBounds.width);
    mkdirSync(join(home, 'sub'));
    await clickLink('../sample.ts:2:3', '../sample.ts:2:3', join(home, 'sub'));
    assert.equal(await page.getByRole('tablist', { name: '文件标签页' }).getByRole('tab').count(), 1);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await clickLink(pathToFileURL(markdown).href, 'MARKDOWN_LINK');
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await page.locator('.markdown-preview strong').innerText(), 'Rendered content');
    assert.equal(await page.locator('.markdown-preview table').count(), 1);
    assert.equal(await page.evaluate(() => window.previewScriptRan), undefined);
    const fileTabs = page.getByRole('tablist', { name: '文件标签页' });
    await fileTabs.getByRole('tab', { name: 'sample.ts', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await fileTabs.getByRole('tab', { name: '说明 file.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    const tabCount = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(markdown).href, 'MARKDOWN_LINK');
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await fileTabs.getByRole('tab').count(), tabCount);

    mkdirSync('tests/dist/screenshots', { recursive: true });
    await page.screenshot({ path: 'tests/dist/screenshots/files-preview.png' });
    await clickLink(pathToFileURL(json).href, 'JSON_LINK');
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'ready' }).waitFor();
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-line span')].map(el => getComputedStyle(el).color)).size > 1);
    await clickLink(pathToFileURL(binary).href, 'BINARY_LINK');
    await page.getByRole('alert').filter({ hasText: '暂不支持二进制' }).waitFor();
    await clickLink(pathToFileURL(join(home, 'missing.ts')).href, 'MISSING_LINK');
    await page.getByRole('alert').filter({ hasText: 'No such file' }).waitFor();
    while (await page.locator('.close-file').count()) await page.locator('.close-file').last().click();
    assert.equal(await page.locator('[data-plugin=files]').isVisible(), false);
    assert.equal((await page.evaluate(() => window.shu.request('terminal', 'terminal', { id: 'local', op: 'list', params: {} })))[0].id, session.id);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    await desktop.close(); desktop = undefined;
    const { resolveConfig } = await import('electron-vite');
    const { createServer } = await import('vite');
    const { config } = await resolveConfig({ root: resolve('desktop'), configFile: resolve('desktop/electron.vite.config.ts') }, 'serve');
    devServer = await createServer({ ...config.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    await page.evaluate(path => window.shu.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
  } finally {
    await desktop?.close();
    await devServer?.close();
    try { execFileSync(resolve('shucli/dist/debug/shu'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
