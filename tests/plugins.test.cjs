const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openWorkspaceMenu, until } = require('@lengmoxxl/wangcai-testkit');
const { launchApp, mockPlugin, testEnv, writeInit } = require('./init.cjs');

test('plugin loader: prebuilt plugins, IPC isolation and cleanup', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-plugins-'));
  const env = testEnv(home);
  const main = (name) => `
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    exports.config = { font: { family: { type: 'string', default: '${name} Font' }, size: { type: 'number', default: 10 } } };
    exports.activate = (context) => {
      globalThis.fixtureConnect ??= context.connect;
      context.ui.handle('sharedConnect', () => globalThis.fixtureConnect === context.connect);
      writeFileSync(${JSON.stringify(join(home, `${name}-data-directory`))}, context.host.dataDirectory);
      writeFileSync(join(context.host.dataDirectory, 'name.txt'), '${name}');
      writeFileSync(join(context.host.dataDirectory, 'settings.json'), JSON.stringify(context.host.config));
      const received = [];
      const off = context.global.subscribe('onclick', (data) => received.push(data));
      context.ui.handle('received', () => received);
      context.ui.handle('unsubscribe', off);
      context.ui.handle('stop', () => context.ui.publish('stop'));
      context.ui.handle('publish', (data) => context.global.publish('onclick', data));
      context.ui.handle('echo', (data) => { context.ui.publish('echo', data); return '${name}:' + data; });
      return () => writeFileSync(join(context.host.dataDirectory, 'cleaned'), 'yes');
    };
  `;
  const ui = (name) => `
    export function mount(container, context) {
      container.dataset.font = JSON.stringify(context.host.config.font);
      const stop = context.global.subscribe('onclick', (data) => { container.dataset.channel = data; });
      context.ui.subscribe('stop', stop);
      const off = context.ui.subscribe('echo', (text) => { container.dataset.event = text; });
      const button = document.createElement('button');
      button.textContent = '${name} v1';
      button.onclick = async () => {
        container.dataset.reply = await context.ui.request('echo', 'hello');
        await context.global.publish('onclick', '${name}');
      };
      container.append(button);
      return () => { off(); button.remove(); };
    }
  `;
  let desktop;
  try {
    const alphaDirectory = mockPlugin(home, 'alpha', { main: main('alpha'), ui: ui('alpha'), css: 'button { color: rgb(1, 2, 3); }' });
    mockPlugin(home, 'beta', { main: main('beta'), ui: ui('beta') });
    mockPlugin(home, 'broken', { main: `
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      exports.activate = (context) => {
        writeFileSync(${JSON.stringify(join(home, 'broken-data-directory'))}, context.host.dataDirectory);
        context.global.subscribe('onclick', () => writeFileSync(join(context.host.dataDirectory, 'leaked'), 'yes'));
        throw new Error('intentional failure');
      };
    ` });
    mockPlugin(home, 'failed-ui', {
      ui: 'export function mount(container, context) { container.hidden = true; context.global.subscribe("onclick", () => { document.body.dataset.leaked = "yes"; }); throw new Error("UI failure"); }',
    });
    mockPlugin(home, 'syntax', { main: 'exports.activate = (;' });
    writeInit(home, {
      tabs: [
        { id: 'alpha', config: { font: { size: 30 }, junk: 'dropped' } },
        { id: 'beta', config: { font: { family: 42, size: 'thirty' } } },
        { id: 'absent', directory: join(home, 'not-a-plugin') },
        'broken', 'failed-ui', 'syntax', 'missing',
      ],
    });
    desktop = await launchApp(home, env);
    let page = await desktop.firstWindow();
    // A plugin sets what its element carries a round trip after the case asks it to, so the case waits for the value.
    const untilAttribute = (id, name, want) => until(async () => (await page.locator(`[data-plugin=${id}]`).getAttribute(name)) === want);
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.call('plugins')).map((plugin) => plugin.id)),
      ['absent', 'alpha', 'beta', 'broken', 'failed-ui', 'missing', 'syntax']);
    assert.ok(await page.evaluate(() => window.wangcai.call('request', 'alpha', 'sharedConnect')));
    assert.ok(await page.evaluate(() => window.wangcai.call('request', 'beta', 'sharedConnect')));
    await untilAttribute('alpha', 'data-font', '{"family":"alpha Font","size":30}');
    await untilAttribute('beta', 'data-font', '{"family":"beta Font","size":10}');
    assert.equal(await page.getByText('alpha v1', { exact: true }).evaluate((element) => getComputedStyle(element).color), 'rgb(1, 2, 3)');
    await page.getByText('alpha v1', { exact: true }).click();
    await untilAttribute('alpha', 'data-reply', 'alpha:hello');
    assert.equal(await page.locator('[data-plugin=beta]').getAttribute('data-event'), null);
    await page.getByText('beta v1', { exact: true }).click();
    await untilAttribute('beta', 'data-reply', 'beta:hello');
    await untilAttribute('alpha', 'data-channel', 'beta');
    assert.deepEqual(await page.evaluate(() => window.wangcai.call('request', 'beta', 'received')), ['alpha', 'beta']);
    await page.evaluate(() => window.wangcai.call('request', 'alpha', 'unsubscribe'));
    await page.evaluate(() => window.wangcai.call('request', 'beta', 'publish', 'main-event'));
    await untilAttribute('beta', 'data-channel', 'main-event');
    assert.deepEqual(await page.evaluate(() => window.wangcai.call('request', 'alpha', 'received')), ['alpha', 'beta']);
    assert.deepEqual(await page.evaluate(() => window.wangcai.call('request', 'beta', 'received')), ['alpha', 'beta', 'main-event']);
    await page.evaluate(() => window.wangcai.call('request', 'alpha', 'stop'));
    await page.evaluate(() => window.wangcai.call('publish', 'onclick', 'after-unsubscribe'));
    await untilAttribute('beta', 'data-channel', 'after-unsubscribe');
    assert.equal(await page.locator('[data-plugin=alpha]').getAttribute('data-channel'), 'main-event');
    assert.ok(!existsSync(join(readFileSync(join(home, 'broken-data-directory'), 'utf8'), 'leaked')));
    assert.equal(await page.evaluate(() => document.body.dataset.leaked), undefined);
    await page.getByText('broken: intentional failure', { exact: true }).waitFor();
    await page.getByText('failed-ui: UI failure', { exact: true }).waitFor();
    await page.getByText('missing: Plugin is not installed', { exact: true }).waitFor();
    await page.getByText('absent: Plugin is not installed', { exact: true }).waitFor();
    assert.equal(await page.locator('.plugin-error[data-plugin=syntax]').count(), 1);
    await openWorkspaceMenu(page);
    await page.locator('#workspace-row-menu').getByText('没有可用的工作区', { exact: true }).waitFor();
    await desktop.close(); desktop = undefined;
    for (const name of ['alpha', 'beta']) {
      const dataDirectory = readFileSync(join(home, `${name}-data-directory`), 'utf8');
      assert.equal(readFileSync(join(dataDirectory, 'cleaned'), 'utf8'), 'yes');
      assert.equal(readFileSync(join(dataDirectory, 'name.txt'), 'utf8'), name);
      const settings = JSON.parse(readFileSync(join(dataDirectory, 'settings.json'), 'utf8'));
      assert.equal(settings.theme.background, '#121314');
      assert.equal(settings.junk, undefined);
      assert.deepEqual(settings.font, name === 'alpha' ? { family: 'alpha Font', size: 30 } : { family: 'beta Font', size: 10 });
    }
    const source = join(alphaDirectory, 'ui.js');
    writeFileSync(source, readFileSync(source, 'utf8').replace('alpha v1', 'alpha v2'));
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await page.getByText('alpha v2', { exact: true }).waitFor();
    await page.getByText('beta v1', { exact: true }).waitFor();
    assert.equal(await page.getByText('alpha v1', { exact: true }).count(), 0);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a plugin opens a web link in the browser, and nothing else reaches it', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-links-'));
  const env = testEnv(home);
  // The browser belongs to the computer the app runs on: a test cannot open one.
  mockPlugin(home, 'links', { ui: `export function mount(_container, context) {
  globalThis.links = (url) => context.host.open(url);
}` });
  writeInit(home, { tabs: ['links'] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await until(() => page.evaluate(() => Boolean(globalThis.links)));
    await desktop.evaluate(({ shell }) => {
      globalThis.opened = [];
      shell.openExternal = async (url) => { globalThis.opened.push(url); };
    });
    await page.evaluate(() => globalThis.links('https://example.com/page'));
    const refused = await page.evaluate(() => globalThis.links('file:///etc/passwd').then(() => 'opened', (error) => error.message));
    assert.match(refused, /Only http and https links open in a browser/);
    assert.deepEqual(await desktop.evaluate(() => globalThis.opened), ['https://example.com/page']);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
