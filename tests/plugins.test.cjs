const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('local plugin loader: TSX, IPC isolation, cleanup and source reload', { timeout: 45000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'shu-plugins-'));
  const env = { ...process.env, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  const launch = async () => {
    desktop = await electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });
    return desktop.firstWindow();
  };
  try {
    const terminal = join(home, '.local/shared/shu/plugins/terminal');
    mkdirSync(terminal, { recursive: true });
    writeFileSync(join(terminal, 'main.ts'), 'export function activate() {}');
    let page;
    for (const name of ['alpha', 'beta']) {
      const path = join(home, '.local/shared/shu/plugins', name);
      mkdirSync(path, { recursive: true });
      symlinkSync(resolve('plugins/terminal/node_modules'), join(path, 'node_modules'), 'dir');
      writeFileSync(join(path, 'main.ts'), `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        export function activate(context) {
          writeFileSync(join(context.logDirectory, 'plugin.log'), '${name}');
          context.handle('echo', (data: string) => { context.emit('echo', data); return '${name}:' + data; });
          return () => writeFileSync(join(context.dataDirectory, 'cleaned'), 'yes');
        }
      `);
      writeFileSync(join(path, 'renderer.tsx'), `
        import { createRoot } from 'react-dom/client';
        import './style.css';
        export function mount(container, context) {
          const root = createRoot(container);
          const off = context.on('echo', (text) => container.dataset.event = text);
          root.render(<button onClick={async () => container.dataset.reply = await context.request('echo', 'hello')}>${name} v1</button>);
          return () => { off(); root.unmount(); };
        }
      `);
      writeFileSync(join(path, 'style.css'), 'button { color: rgb(1, 2, 3); }');
    }
    const broken = join(home, '.local/shared/shu/plugins/broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'main.ts'), 'export function activate() { throw new Error("intentional failure"); }');
    page = await launch();
    await page.getByText('alpha v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=alpha]')?.getAttribute('data-reply') === 'alpha:hello');
    assert.equal(await page.locator('[data-plugin=beta]').getAttribute('data-event'), null);
    await page.getByText('beta v1', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=beta]')?.getAttribute('data-reply') === 'beta:hello');
    assert.equal(await page.getByText('alpha v1', { exact: true }).evaluate((el) => getComputedStyle(el).color), 'rgb(1, 2, 3)');
    await page.getByText('broken: intentional failure', { exact: true }).waitFor();
    await desktop.close(); desktop = undefined;
    for (const name of ['alpha', 'beta']) {
      assert.equal(readFileSync(join(home, '.local/shared/shu/data', name, 'cleaned'), 'utf8'), 'yes');
      assert.equal(readFileSync(join(home, '.local/shared/shu/logs', name, 'plugin.log'), 'utf8'), name);
    }
    const source = join(home, '.local/shared/shu/plugins/alpha/renderer.tsx');
    writeFileSync(source, readFileSync(source, 'utf8').replace('alpha v1', 'alpha v2'));
    writeFileSync(join(broken, 'main.ts'), 'export function activate( {');
    page = await launch();
    await page.getByText('alpha v2', { exact: true }).waitFor();
    await page.getByText('beta v1', { exact: true }).waitFor();
    await page.locator('[data-plugin=broken]').filter({ hasText: 'Build failed' }).waitFor();
    assert.equal(await page.getByText('alpha v1', { exact: true }).count(), 0);
    assert.equal(existsSync(join(home, '.config/shu/server.json')), false);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
