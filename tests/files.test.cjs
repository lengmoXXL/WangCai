const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

test('view picker browses current terminal directory; file links preview code and Markdown', { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-')));
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
    writeFileSync(markdown, '# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```\n' + 'wide code block '.repeat(80) + '\n```\n\n<script>window.previewScriptRan = true</script>');
    writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
    const sessionId = await page.waitForFunction(async () => (await window.wangcai.request('workspace', 'config')).workspaces[0]?.sessionId).then((handle) => handle.jsonValue());
    const clickLink = async (link, label = link, cwd = home) => {
      const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
      const command = `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${output}'\r`;
      await page.evaluate(({ id, command }) => window.wangcai.request('workspace', 'pty', { id: 'local', op: 'input', params: { session_id: id, data: command } }), { id: sessionId, command });
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
    assert.equal(await page.locator('.sidebar-right').isVisible(), false);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    const directory = page.getByRole('navigation', { name: '当前目录文件' });
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
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
    const terminalBounds = await page.locator('.desktop-main').boundingBox();
    const fileBounds = await page.locator('.sidebar-right').boundingBox();
    assert.ok(fileBounds.x >= terminalBounds.x + terminalBounds.width);
    mkdirSync(join(home, 'sub'));
    await clickLink('../sample.ts:2:3', '../sample.ts:2:3', join(home, 'sub'));
    assert.equal(await page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab').count(), 2);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await clickLink(pathToFileURL(markdown).href, 'MARKDOWN_LINK');
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await page.locator('.markdown-preview strong').innerText(), 'Rendered content');
    assert.equal(await page.locator('.markdown-preview table').count(), 1);
    assert.equal(await page.evaluate(() => window.previewScriptRan), undefined);
    for (const selector of ['.file-directory', '.markdown-preview', '.markdown-preview pre', '.sidebar-tabs']) {
      assert.deepEqual(await page.locator(selector).evaluate(element => {
        const bar = getComputedStyle(element, '::-webkit-scrollbar');
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
        return [bar.width, bar.height, thumb.backgroundColor, thumb.borderRadius,
          getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
          getComputedStyle(element, '::-webkit-scrollbar-button').display];
      }), ['14px', '12px', 'rgba(121, 121, 121, 0.4)', '0px', 'rgba(0, 0, 0, 0)', 'none'], selector);
    }
    assert.equal(await page.locator('.markdown-preview pre').evaluate(element => element.scrollWidth > element.clientWidth), true);
    const fileTabs = page.getByRole('tablist', { name: '侧栏标签页' });
    await fileTabs.getByRole('tab', { name: 'sample.ts', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await fileTabs.getByRole('tab', { name: '说明 file.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    const tabCount = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(markdown).href, 'MARKDOWN_LINK');
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await fileTabs.getByRole('tab').count(), tabCount);

    await page.screenshot({ path: 'tests/dist/screenshots/files-preview.png' });
    await clickLink(pathToFileURL(json).href, 'JSON_LINK');
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'ready' }).waitFor();
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-line span')].map(el => getComputedStyle(el).color)).size > 1);
    await clickLink(pathToFileURL(binary).href, 'BINARY_LINK');
    await page.getByRole('alert').filter({ hasText: '暂不支持二进制' }).waitFor();
    const beforeMissing = await fileTabs.getByRole('tab').count();
    await page.evaluate(() => { window.missingClicks = []; window.wangcai.subscribe('onclick', data => window.missingClicks.push(data)); });
    await clickLink(pathToFileURL(join(home, 'missing.ts')).href, 'MISSING_LINK');
    await page.evaluate(({ sessionId, path }) => window.wangcai.request('workspace', 'click', { id: 'local', sessionId, location: { path } }), { sessionId, path: 'missing.ts' });
    assert.deepEqual(await page.evaluate(() => window.missingClicks), []);
    assert.equal(await fileTabs.getByRole('tab').count(), beforeMissing);
    assert.equal(await page.getByRole('alert').filter({ hasText: 'No such file' }).count(), 0);
    const closeOthers = page.locator('.close-tab:not([aria-label="关闭 文件"])');
    while (await closeOthers.count()) await closeOthers.last().click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await directory.getByRole('button', { name: 'sub/', exact: true }).click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await directory.getByRole('button', { name: '上级目录' }).click();
    await directory.getByRole('button', { name: '说明 file.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    await fileTabs.getByRole('tab', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    assert.equal(await page.locator('.sidebar-right').isVisible(), false);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-browser.png' });
    await page.evaluate(({ id, path }) => window.wangcai.request('workspace', 'pty', { id: 'local', op: 'input', params: { session_id: id, data: `cd '${path}'\r` } }), { id: sessionId, path: join(home, 'sub') });
    await page.waitForFunction(async ({ id, path }) => {
      const result = await window.wangcai.request('files', 'list', { machine: { id: 'local', name: '本机' }, sessionId: id });
      return result.path === path;
    }, { id: sessionId, path: join(home, 'sub') });
    await page.getByRole('tablist', { name: '本机 工作区' }).getByRole('tab').filter({ hasText: 'sub' }).waitFor();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.getByRole('tablist', { name: '本机 工作区' }).getByRole('tab').first().click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-directory.png' });
    writeFileSync(join(home, 'sub', 'inside.md'), '# Directory link preview');
    await clickLink('./sub/');
    await fileTabs.getByRole('tab', { name: 'sub', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'inside.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Directory link preview' }).waitFor();
    await clickLink(pathToFileURL(join(home, 'sub')).href, 'DIRECTORY_LINK');
    assert.equal(await fileTabs.getByRole('tab', { name: 'sub', exact: true }).count(), 1);
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'inside.md', exact: true }).waitFor();
    await fileTabs.getByRole('tab', { name: '文件', exact: true }).click();
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.wangcai.request('workspace', 'config'))).workspaces[0].sessionId, sessionId);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    await desktop.close(); desktop = undefined;
    const { resolveConfig } = await import('electron-vite');
    const { createServer } = await import('vite');
    const { config } = await resolveConfig({ root: resolve('desktop') }, 'serve');
    devServer = await createServer({ ...config.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
    await devServer.listen();
    env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${devServer.httpServer.address().port}`;
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: '机器设置' }).waitFor();
    await page.evaluate(path => window.wangcai.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
  } finally {
    await desktop?.close();
    await devServer?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 5000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
