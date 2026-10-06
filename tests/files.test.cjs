const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createWorkspace, waitForShell, writeInit } = require('./init.cjs');

test('view picker browses current terminal directory; file links preview code, Markdown, HTML and images', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-files-')));
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let devServer;
  try {
    writeInit(home);
    const code = join(home, 'sample.ts');
    const markdown = join(home, '说明 file.md');
    const binary = join(home, 'binary.bin');
    const html = join(home, 'page.html');
    const image = join(home, 'photo.png');
    const json = join(home, 'settings.json');
    writeFileSync(json, '{"ready":true}');
    writeFileSync(code, 'const first = 1;\nconst second = "CODE_PREVIEW";\n');
    writeFileSync(markdown, '# Markdown preview\n\n**Rendered content**\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n```\n' + 'wide code block '.repeat(80) + '\n```\n\n<script>window.previewScriptRan = true</script>');
    writeFileSync(html, '<!doctype html>\n<!-- HTML_SOURCE -->\n<h1 id="heading">Rendered page</h1>\n<script>document.getElementById("heading").dataset.scripted = "yes"</script>\n');
    writeFileSync(binary, Buffer.from([0, 1, 255, 2]));
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    let page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluate(() => { window.linkClicks = []; window.wangcai.subscribe('onclick', (payload) => window.linkClicks.push(payload)); });
    await createWorkspace(page);
    const sessionId = await page.evaluate(async () => (await window.wangcai.request('terminal-agent', 'config')).workspaces[0].sessionId);
    // A wide or differently styled character gets a span of its own, so the text is looked for one
    // node at a time and the first character of the link is enough for the point.
    const firstChar = (row, label) => row.evaluate((element, label) => {
      const nodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node; node = walker.nextNode();) nodes.push(node);
      const pointAt = (node, index) => {
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      for (const node of nodes) {
        const index = node.textContent.indexOf(label);
        if (index >= 0) return pointAt(node, index);
      }
      for (const node of nodes) {
        const index = node.textContent.indexOf(label[0]);
        if (index >= 0) return pointAt(node, index);
      }
      throw new Error('Link text not found');
    }, label);
    const clickPoint = async (point) => {
      // Away from every link first, so the cursor belongs to this hover and not to the last one.
      await page.mouse.move(500, 500);
      await page.waitForFunction(() => !document.querySelector('.xterm-cursor-pointer'));
      // Forget what earlier clicks published, so the answer read below is this click's.
      await page.evaluate(() => { window.linkClicks = []; });
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(() => !!document.querySelector('.xterm-cursor-pointer'));
      await page.mouse.click(point.x, point.y);
    };
    const printLine = async (text, session, cwd = home) => {
      const command = `cd '${cwd}'; printf '\\033[2J\\033[H%b\\n' '${text}'\r`;
      await page.evaluate(({ id, command }) => window.wangcai.request('terminal-agent', 'pty', { op: 'input', sessionId: id, params: { data: command } }), { id: session, command });
    };
    const clickLink = async (link, { label = link, cwd = home, anchor = label, session = sessionId } = {}) => {
      const output = label === link ? link : `\\033]8;;${link}\\007${label}\\033]8;;\\007`;
      await printLine(output, session, cwd);
      const row = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: label }).first();
      await page.waitForFunction((label) => document.querySelector('.terminal-pane.active .xterm-rows > div')?.textContent.trim() === label, label);
      await clickPoint(await firstChar(row, anchor));
    };
    const lastClick = async () => {
      // The click crosses the plugin channel, so wait for its answer instead of the last one.
      await page.waitForFunction(() => window.linkClicks.length > 0);
      const { type, path, line, column } = await page.evaluate(() => window.linkClicks.at(-1));
      return { type, path, line, column };
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
    const codePanel = page.getByRole('tabpanel', { name: 'sample.ts' });
    assert.equal(await codePanel.locator('.preview-path').innerText(), code);
    assert.equal(await codePanel.locator('.preview-mode').count(), 0);
    assert.equal(await codePanel.locator('.preview-header').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await codePanel.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await page.screenshot({ path: 'tests/dist/screenshots/files-code.png' });
    assert.equal(await page.locator('.file-preview .monaco-editor').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(18, 19, 20)');
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
    await clickLink('../sample.ts:2:3', { cwd: join(home, 'sub') });
    assert.equal(await page.getByRole('tablist', { name: '侧栏标签页' }).getByRole('tab').count(), 2);
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await page.locator('.markdown-preview strong').innerText(), 'Rendered content');
    assert.equal(await page.locator('.markdown-preview table').count(), 1);
    assert.equal(await page.evaluate(() => window.previewScriptRan), undefined);
    const markdownPanel = page.getByRole('tabpanel', { name: '说明 file.md' });
    assert.equal(await markdownPanel.locator('.preview-path').innerText(), markdown);
    await markdownPanel.getByRole('button', { name: 'Markdown 预览', exact: true }).click();
    assert.deepEqual(await markdownPanel.getByRole('menu', { name: '预览方式' }).getByRole('menuitem').allInnerTexts(), ['文本', 'Markdown 预览']);
    await page.screenshot({ path: 'tests/dist/screenshots/files-modes.png' });
    await page.locator('.menu-backdrop').click();
    assert.equal(await markdownPanel.getByRole('menu', { name: '预览方式' }).count(), 0);
    assert.equal(await markdownPanel.locator('.preview-mode').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await markdownPanel.locator('.markdown-preview').evaluate((element) => getComputedStyle(element).fontSize), '13px');
    await markdownPanel.getByRole('button', { name: 'Markdown 预览', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: '文本', exact: true }).click();
    assert.equal(await markdownPanel.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    await markdownPanel.locator('.monaco-editor .view-lines').filter({ hasText: '# Markdown preview' }).waitFor();
    await markdownPanel.getByRole('button', { name: '文本', exact: true }).click();
    await markdownPanel.getByRole('menuitem', { name: 'Markdown 预览', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    // Hovering the sidebar reveals its scrollbar thumbs, so park the pointer before asserting idle panels hide theirs.
    await page.mouse.move(0, 0);
    for (const selector of ['.file-directory', '.markdown-preview', '.markdown-preview pre']) {
      assert.deepEqual(await page.locator(selector).evaluate((element) => {
        const bar = getComputedStyle(element, '::-webkit-scrollbar');
        const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
        return [bar.width, bar.height, thumb.backgroundColor, thumb.borderRadius,
          getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
          getComputedStyle(element, '::-webkit-scrollbar-button').display];
      }), ['10px', '12px', 'rgba(0, 0, 0, 0)', '0px', 'rgba(0, 0, 0, 0)', 'none'], selector);
    }
    const reveal = await page.locator('.markdown-preview pre').evaluate(async (element) => {
      element.scrollLeft = 40;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { scrolling: element.hasAttribute('data-scrolling'), thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor };
    });
    assert.equal(reveal.scrolling, true, 'scrolling marks the panel as scrolling');
    assert.equal(reveal.thumb, 'rgba(121, 121, 121, 0.4)', 'a scrolling panel shows its scrollbar');
    await page.waitForFunction(() => !document.querySelector('.markdown-preview pre').hasAttribute('data-scrolling'));
    assert.equal(await page.locator('.markdown-preview pre').evaluate(element => element.scrollWidth > element.clientWidth), true);
    // The tab strip scrolls with no bar of its own, so an overflowing strip takes no height from its tabs.
    assert.deepEqual(await page.evaluate(async () => {
      const strip = document.querySelector('.sidebar-tabs');
      strip.style.width = '60px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overflow = [strip.scrollWidth > strip.clientWidth, strip.clientHeight, strip.offsetHeight];
      strip.style.width = '';
      return overflow;
    }), [true, 32, 32]);
    const fileTabs = page.getByRole('tablist', { name: '侧栏标签页' });
    await fileTabs.getByRole('tab', { name: 'sample.ts', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' }).waitFor();
    await fileTabs.getByRole('tab', { name: '说明 file.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    const tabCount = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(markdown).href, { label: 'MARKDOWN_LINK' });
    await page.getByRole('heading', { name: 'Markdown preview' }).waitFor();
    assert.equal(await fileTabs.getByRole('tab').count(), tabCount);

    await page.screenshot({ path: 'tests/dist/screenshots/files-preview.png' });
    await clickLink(pathToFileURL(html).href, { label: 'HTML_LINK' });
    const htmlFrame = page.frameLocator('.html-frame');
    await htmlFrame.locator('#heading[data-scripted=yes]').waitFor();
    assert.equal(await htmlFrame.locator('#heading').innerText(), 'Rendered page');
    assert.equal(await page.locator('.html-frame').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await htmlFrame.locator('body').evaluate((element) => getComputedStyle(element).fontSize), '13px');
    assert.match(await htmlFrame.locator('body').evaluate((element) => getComputedStyle(element).fontFamily), /DejaVuSansM Nerd Font Mono/);
    const htmlPanel = page.getByRole('tabpanel', { name: 'page.html' });
    assert.equal(await htmlPanel.locator('.preview-path').innerText(), html);
    await htmlPanel.getByRole('button', { name: 'HTML 预览', exact: true }).click();
    assert.deepEqual(await htmlPanel.getByRole('menu', { name: '预览方式' }).getByRole('menuitem').allInnerTexts(), ['文本', 'HTML 预览']);
    await htmlPanel.getByRole('menuitem', { name: '文本', exact: true }).click();
    await htmlPanel.locator('.monaco-editor .view-lines').filter({ hasText: 'HTML_SOURCE' }).waitFor();
    await htmlPanel.getByRole('button', { name: '文本', exact: true }).click();
    await htmlPanel.getByRole('menuitem', { name: 'HTML 预览', exact: true }).click();
    await htmlFrame.getByRole('heading', { name: 'Rendered page' }).waitFor();
    await clickLink(pathToFileURL(json).href, { label: 'JSON_LINK' });
    await page.locator('.monaco-editor .view-lines').filter({ hasText: 'ready' }).waitFor();
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.monaco-editor .view-line span')].map(el => getComputedStyle(el).color)).size > 1);
    await clickLink(pathToFileURL(binary).href, { label: 'BINARY_LINK' });
    await page.getByRole('alert').filter({ hasText: '暂不支持二进制' }).waitFor();
    const beforeMissing = await fileTabs.getByRole('tab').count();
    await clickLink(pathToFileURL(join(home, 'missing.ts')).href, { label: 'MISSING_LINK' });
    const published = await page.evaluate(() => window.linkClicks.length);
    await page.evaluate(({ sessionId, path }) => window.wangcai.request('terminal-agent', 'click', { sessionId, location: { path } }), { sessionId, path: 'missing.ts' });
    assert.equal(await page.evaluate(() => window.linkClicks.length), published);
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
    await directory.getByRole('button', { name: 'photo.png', exact: true }).click();
    const imagePanel = page.getByRole('tabpanel', { name: 'photo.png' });
    const shownImage = imagePanel.locator('.image-preview img');
    await shownImage.waitFor();
    assert.match(await shownImage.getAttribute('src'), /^data:image\/png;base64,/);
    assert.deepEqual(await shownImage.evaluate(async (element) => { await element.decode(); return [element.naturalWidth, element.naturalHeight]; }), [1, 1]);
    assert.equal(await imagePanel.locator('.preview-mode').count(), 0);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    assert.equal(await page.locator('.sidebar-right').isVisible(), false);
    await page.getByRole('button', { name: '切换右侧栏' }).click();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-browser.png' });
    await page.evaluate(({ id, path }) => window.wangcai.request('terminal-agent', 'pty', { op: 'input', sessionId: id, params: { data: `cd '${path}'\r` } }), { id: sessionId, path: join(home, 'sub') });
    await page.waitForFunction(async ({ id, path }) => {
      const result = await window.wangcai.request('files', 'list', { machine: { id: 'local', name: '本机' }, sessionId: id });
      return result.path === path;
    }, { id: sessionId, path: join(home, 'sub') });
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').filter({ hasText: 'sub' }).waitFor();
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await createWorkspace(page);
    await page.getByRole('button', { name: '新建侧栏标签页' }).click();
    await page.locator('#view-menu').getByRole('button', { name: '文件', exact: true }).click();
    await directory.getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').first().click();
    await page.getByText('空目录', { exact: true }).waitFor();
    await page.screenshot({ path: 'tests/dist/screenshots/files-directory.png' });
    writeFileSync(join(home, 'sub', 'inside.md'), '# Directory link preview');
    await clickLink('./sub/');
    await fileTabs.getByRole('tab', { name: 'sub', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'inside.md', exact: true }).click();
    await page.getByRole('heading', { name: 'Directory link preview' }).waitFor();
    await clickLink(pathToFileURL(join(home, 'sub')).href, { label: 'DIRECTORY_LINK' });
    assert.equal(await fileTabs.getByRole('tab', { name: 'sub', exact: true }).count(), 1);
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'inside.md', exact: true }).waitFor();
    await fileTabs.getByRole('tab', { name: '文件', exact: true }).click();
    await page.getByRole('navigation', { name: '当前目录文件' }).getByRole('button', { name: 'sample.ts', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.wangcai.request('terminal-agent', 'config'))).workspaces[0].sessionId, sessionId);
    // The links below are read from the pane in front, which the active workspace owns.
    const activeSession = await page.evaluate(async () => {
      const config = await window.wangcai.request('terminal-agent', 'config');
      return config.workspaces.find((workspace) => workspace.id === config.active)?.sessionId;
    });
    // A compiler writes a location as path(line,column), a traceback as "path", line 3.
    await clickLink('sample.ts(2,3)', { session: activeSession });
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: 3 });
    await clickLink('"说明 file.md", line 3', { anchor: '说明 file.md', session: activeSession });
    assert.deepEqual(await lastClick(), { type: 'file', path: markdown, line: 3, column: undefined });
    // A web address, and a path that is not there, are left alone: a link opens what the app can
    // show, and the filesystem is what tells a path apart from the words around it.
    for (const text of ['https://example.com/a%20b', 'missing.ts:12']) {
      await printLine(text, activeSession);
      await page.waitForFunction((text) => [...document.querySelectorAll('.terminal-pane.active .xterm-rows > div')].some((row) => row.textContent.trim() === text), text);
      const clicksSoFar = await page.evaluate(() => window.linkClicks.length);
      const point = await firstChar(page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: text }).first(), text);
      await page.mouse.move(500, 500);
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => !!document.querySelector('.xterm-cursor-pointer')), false);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.linkClicks.length), clicksSoFar);
    }
    // The sidebar terminal finds links with the same rules. The picker opens its popover from a
    // click on the element itself; a click through the mouse hangs on it.
    await page.evaluate(() => document.querySelector('button[aria-label="新建侧栏标签页"]').click());
    await page.locator('#view-menu').getByRole('button', { name: '终端', exact: true }).click();
    const sidebar = page.locator('.sidebar-panel:visible .terminal-pane');
    await sidebar.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`cd '${home}'; printf '\\033[2J\\033[Hsample.ts:2\\n'`);
    await page.keyboard.press('Enter');
    const sidebarRow = sidebar.locator('.xterm-rows > div').filter({ hasText: 'sample.ts:2' }).first();
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-panel .xterm-rows > div')].some((row) => row.textContent.trim() === 'sample.ts:2'));
    await clickPoint(await firstChar(sidebarRow, 'sample.ts:2'));
    assert.deepEqual(await lastClick(), { type: 'file', path: code, line: 2, column: undefined });
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
    await waitForShell(page);
    // A plugin subscribes to clicks as it mounts, so the click is repeated until its preview answers.
    const preview = page.locator('.monaco-editor .view-lines').filter({ hasText: 'CODE_PREVIEW' });
    for (let attempt = 0; attempt < 100 && !await preview.count(); attempt++) {
      await page.evaluate(path => window.wangcai.publish('onclick', { type: 'file', machine: { id: 'local', name: '本机' }, path }), code);
      await page.waitForTimeout(100);
    }
    await preview.waitFor();
  } finally {
    await desktop?.close();
    await devServer?.close();
    try { execFileSync(resolve('wangcaicli/dist/debug/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
