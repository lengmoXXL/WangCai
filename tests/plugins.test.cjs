const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { writeInit } = require('./init.cjs');

test('plugin loader: prebuilt plugins, IPC isolation and cleanup', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-plugins-'));
  const env = { ...process.env, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const plugins = join(home, '.config/wangcai/plugins');
  const write = (id, files) => {
    mkdirSync(join(plugins, id), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(plugins, id, name), body);
  };
  const main = (name) => `
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { connect } = require('@wangcai/sdk');
    exports.activate = async (context) => {
      globalThis.fixtureConnect ??= connect;
      context.ui.handle('sharedSDK', () => globalThis.fixtureConnect === require('@wangcai/sdk').connect);
      writeFileSync(join(await context.host.request('logDirectory'), 'plugin.log'), '${name}');
      writeFileSync(join(await context.host.request('logDirectory'), 'config.log'), (await context.host.request('config')).theme.background);
      const received = [];
      const off = context.global.subscribe('onclick', (data) => received.push(data));
      context.ui.handle('received', () => received);
      context.ui.handle('unsubscribe', off);
      context.ui.handle('stop', () => context.ui.publish('stop'));
      context.ui.handle('publish', (data) => context.global.publish('onclick', data));
      context.ui.handle('echo', (data) => { context.ui.publish('echo', data); return '${name}:' + data; });
      return async () => writeFileSync(join(await context.host.request('dataDirectory'), 'cleaned'), 'yes');
    };
  `;
  const ui = (name) => `
    export function mount(container, context) {
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
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    return desktop.firstWindow();
  };
  try {
    write('alpha', { 'main.cjs': main('alpha'), 'ui.js': ui('alpha'), 'ui.css': 'button { color: rgb(1, 2, 3); }' });
    write('beta', { 'main.cjs': main('beta'), 'ui.js': ui('beta') });
    write('broken', { 'main.cjs': `
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      exports.activate = async (context) => {
        context.global.subscribe('onclick', async () => writeFileSync(join(await context.host.request('dataDirectory'), 'leaked'), 'yes'));
        throw new Error('intentional failure');
      };
    ` });
    write('failed-ui', {
      'main.cjs': 'exports.activate = () => {};',
      'ui.js': 'export function mount(container, context) { container.hidden = true; context.global.subscribe("onclick", () => { document.body.dataset.leaked = "yes"; }); throw new Error("UI failure"); }',
    });
    write('syntax', { 'main.cjs': 'exports.activate = (;' });
    writeInit(home, ['alpha', 'beta', 'broken', 'failed-ui', 'syntax', 'missing']);
    let page = await launch();
    // Only the listed plugins load, in id order; one of them cannot start and one is not installed.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)),
      ['alpha', 'beta', 'broken', 'failed-ui', 'missing', 'syntax']);
    assert.equal(await page.evaluate(() => window.wangcai.request('alpha', 'sharedSDK')), true);
    assert.equal(await page.evaluate(() => window.wangcai.request('beta', 'sharedSDK')), true);
    assert.equal(await page.getByText('alpha v1', { exact: true }).evaluate((element) => getComputedStyle(element).color), 'rgb(1, 2, 3)');
    await page.getByText('alpha v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=alpha]')?.getAttribute('data-reply') === 'alpha:hello');
    assert.equal(await page.locator('[data-plugin=beta]').getAttribute('data-event'), null);
    await page.getByText('beta v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=beta]')?.getAttribute('data-reply') === 'beta:hello');
    await page.waitForFunction(() => document.querySelector('[data-plugin=alpha]')?.getAttribute('data-channel') === 'beta');
    assert.deepEqual(await page.evaluate(() => window.wangcai.request('beta', 'received')), ['alpha', 'beta']);
    await page.evaluate(() => window.wangcai.request('alpha', 'unsubscribe'));
    await page.evaluate(() => window.wangcai.request('beta', 'publish', 'main-event'));
    await page.waitForFunction(() => document.querySelector('[data-plugin=beta]')?.getAttribute('data-channel') === 'main-event');
    assert.deepEqual(await page.evaluate(() => window.wangcai.request('alpha', 'received')), ['alpha', 'beta']);
    assert.deepEqual(await page.evaluate(() => window.wangcai.request('beta', 'received')), ['alpha', 'beta', 'main-event']);
    await page.evaluate(() => window.wangcai.request('alpha', 'stop'));
    await page.evaluate(() => window.wangcai.publish('onclick', 'after-unsubscribe'));
    await page.waitForFunction(() => document.querySelector('[data-plugin=beta]')?.getAttribute('data-channel') === 'after-unsubscribe');
    assert.equal(await page.locator('[data-plugin=alpha]').getAttribute('data-channel'), 'main-event');
    assert.equal(existsSync(join(home, '.local/shared/wangcai/data/broken/leaked')), false);
    assert.equal(await page.evaluate(() => document.body.dataset.leaked), undefined);
    await page.getByText('broken: intentional failure', { exact: true }).waitFor();
    await page.getByText('failed-ui: UI failure', { exact: true }).waitFor();
    await page.getByText('missing: Plugin is not installed', { exact: true }).waitFor();
    assert.equal(await page.locator('.plugin-error[data-plugin=syntax]').count(), 1);
    await desktop.close(); desktop = undefined;
    for (const name of ['alpha', 'beta']) {
      assert.equal(readFileSync(join(home, '.local/shared/wangcai/data', name, 'cleaned'), 'utf8'), 'yes');
      assert.equal(readFileSync(join(home, '.local/shared/wangcai/logs', name, 'plugin.log'), 'utf8'), name);
      assert.equal(readFileSync(join(home, '.local/shared/wangcai/logs', name, 'config.log'), 'utf8'), '#121314');
    }
    // A plugin is a set of files that the app loads; nothing here is compiled or cached.
    assert.equal(existsSync(join(home, '.cache/wangcai')), false);
    const source = join(plugins, 'alpha/ui.js');
    writeFileSync(source, readFileSync(source, 'utf8').replace('alpha v1', 'alpha v2'));
    page = await launch();
    await page.getByText('alpha v2', { exact: true }).waitFor();
    await page.getByText('beta v1', { exact: true }).waitFor();
    assert.equal(await page.getByText('alpha v1', { exact: true }).count(), 0);
    assert.equal(existsSync(join(home, '.config/wangcai/server.json')), false);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
