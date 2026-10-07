const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { launchApp, mockPlugin, testEnv, writeInit } = require('./init.cjs');

test('the app keeps one connection per machine for every plugin that asks for it', { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-machines-'));
  const env = testEnv(home);
  // Two plugins that each hold whatever the app hands them. What they were handed is kept on the process
  // they share, so either of them can say whether they were handed one connection or two.
  const plugin = `
    exports.activate = (context) => {
      const seen = globalThis.fixtureMachines ??= [];
      const held = [];
      context.ui.handle('hold', async () => {
        const machine = await context.connect({});
        const again = seen.includes(machine);
        seen.push(machine);
        held.push(machine);
        return [machine.state.status, again];
      });
      context.ui.handle('shared', () => seen.length === 2 && seen[0] === seen[1]);
      context.ui.handle('release', () => { for (const machine of held.splice(0)) machine.disconnect(); });
    };
  `;
  mockPlugin(home, 'holder', { main: plugin });
  mockPlugin(home, 'other', { main: plugin });
  writeInit(home, { tabs: ['holder', 'other'] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    const request = (id, method) => page.evaluate(([plugin, name]) => window.wangcai.request(plugin, name), [id, method]);
    // Both plugins ask before either has a connection: the second one waits for the connection the first
    // one is opening rather than opening its own.
    const [first, second] = await Promise.all([request('holder', 'hold'), request('other', 'hold')]);
    assert.deepEqual([first[0], second[0]], ['connected', 'connected']);
    assert.equal(await request('holder', 'shared'), true);
    // The plugin that let go did not close what the other one still holds.
    await request('other', 'release');
    assert.deepEqual(await request('holder', 'hold'), ['connected', true]);
    // The last holder closed it, so the next ask opens a new connection.
    await request('holder', 'release');
    assert.deepEqual(await request('holder', 'hold'), ['connected', false]);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
