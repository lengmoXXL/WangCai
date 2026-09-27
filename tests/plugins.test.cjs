const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('local plugin loader: TSX, IPC isolation, cleanup and source reload', { timeout: 45000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-plugins-'));
  const env = { ...process.env, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    return desktop.firstWindow();
  };
  try {
    const workspace = join(home, '.local/shared/wangcai/plugins/workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'main.ts'), 'export function activate() {}');
    for (const name of ['alpha', 'beta']) {
      const path = join(home, '.local/shared/wangcai/plugins', name);
      mkdirSync(path);
      symlinkSync(resolve('plugins/workspace/node_modules'), join(path, 'node_modules'), 'dir');
      writeFileSync(join(path, 'main.ts'), `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        export function activate(context) {
          writeFileSync(join(context.logDirectory, 'plugin.log'), '${name}');
          const received = [];
          const off = context.subscribe('onclick', data => received.push(data));
          context.handle('received', () => received);
          context.handle('unsubscribe', off);
          context.handle('stop', () => context.emit('stop'));
          context.handle('publish', data => context.publish('onclick', data));
          context.handle('echo', (data: string) => { context.emit('echo', data); return '${name}:' + data; });
          return () => writeFileSync(join(context.dataDirectory, 'cleaned'), 'yes');
        }
      `);
      writeFileSync(join(path, 'ui.tsx'), `
        import { createRoot } from 'react-dom/client';
        import './style.css';
        export function mount(container, context) {
          const root = createRoot(container);
          const stop = context.subscribe('onclick', data => container.dataset.channel = data);
          context.on('stop', stop);
          const off = context.on('echo', (text) => container.dataset.event = text);
          root.render(<button onClick={async () => { container.dataset.reply = await context.request('echo', 'hello'); await context.publish('onclick', '${name}'); }}>${name} v1</button>);
          return () => { off(); root.unmount(); };
        }
      `);
      writeFileSync(join(path, 'style.css'), 'button { color: rgb(1, 2, 3); }');
    }
    const broken = join(home, '.local/shared/wangcai/plugins/broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'main.ts'), `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; export function activate(context) { context.subscribe('onclick', () => writeFileSync(join(context.dataDirectory, 'leaked'), 'yes')); throw new Error('intentional failure'); }`);
    const failedUI = join(home, '.local/shared/wangcai/plugins/failed-ui');
    mkdirSync(failedUI);
    writeFileSync(join(failedUI, 'main.ts'), 'export function activate() {}');
    writeFileSync(join(failedUI, 'ui.tsx'), `export function mount(container, context) { container.hidden = true; context.subscribe('onclick', () => document.body.dataset.leaked = 'yes'); throw new Error('UI failure'); }`);
    let page = await launch();
    await page.getByText('alpha v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=alpha]')?.getAttribute('data-reply') === 'alpha:hello');
    assert.equal(await page.locator('[data-plugin=beta]').getAttribute('data-event'), null);
    await page.getByText('beta v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=beta]')?.getAttribute('data-reply') === 'beta:hello');
    assert.equal(await page.getByText('alpha v1', { exact: true }).evaluate((el) => getComputedStyle(el).color), 'rgb(1, 2, 3)');
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
    await desktop.close(); desktop = undefined;
    for (const name of ['alpha', 'beta']) {
      assert.equal(readFileSync(join(home, '.local/shared/wangcai/data', name, 'cleaned'), 'utf8'), 'yes');
      assert.equal(readFileSync(join(home, '.local/shared/wangcai/logs', name, 'plugin.log'), 'utf8'), name);
    }
    const source = join(home, '.local/shared/wangcai/plugins/alpha/ui.tsx');
    writeFileSync(source, readFileSync(source, 'utf8').replace('alpha v1', 'alpha v2'));
    writeFileSync(join(broken, 'main.ts'), 'export function activate( {');
    page = await launch();
    await page.getByText('alpha v2', { exact: true }).waitFor();
    await page.getByText('beta v1', { exact: true }).waitFor();
    await page.locator('[data-plugin=broken]').filter({ hasText: 'Build failed' }).waitFor();
    assert.equal(await page.getByText('alpha v1', { exact: true }).count(), 0);
    assert.equal(existsSync(join(home, '.config/wangcai/server.json')), false);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
