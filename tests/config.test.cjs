const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const { launchApp, mockWorkspace, testEnv, waitForShell, writeInit } = require('./init.cjs');

test('an entry that names no source is read from the official repository of its id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-defaults-'));
  const previousHome = process.env.HOME;
  const previousOverride = process.env.WANGCAI_HOME;
  process.env.HOME = home;
  // A development run names a home of its own, which the reader prefers; this test wants the temporary one.
  process.env.WANGCAI_HOME = '';
  try {
    // The reader takes the home it finds when it loads, so it is compiled once this test has set one.
    const compiled = new Module('config');
    compiled._compile(buildSync({ entryPoints: ['desktop/main/config.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, 'config.cjs');
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    writeFileSync(join(home, '.config/wangcai/init.ts'), "export default { tabs: [{ id: 'files' }, { id: 'here', directory: '/tmp/here' }] };\n");
    const { plugins } = await compiled.exports.loadConfig();
    assert.deepEqual(plugins.map(({ id, repo, directory }) => [id, repo, directory]), [
      ['files', 'https://github.com/lengmoXXL/WangCai-files', undefined],
      ['here', undefined, '/tmp/here'],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousOverride === undefined) delete process.env.WANGCAI_HOME; else process.env.WANGCAI_HOME = previousOverride;
    rmSync(home, { recursive: true, force: true });
  }
});

test('an existing init.ts is never rewritten', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-init-'));
  const env = testEnv(home);
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  const launch = async () => {
    desktop = await launchApp(home, env);
    return desktop.firstWindow();
  };
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    let page = await launch();
    await waitForShell(page);
    writeFileSync(init, `${readFileSync(init, 'utf8')}// 用户改过这个文件\n`);
    await desktop.close(); desktop = undefined;
    page = await launch();
    await waitForShell(page);
    assert.match(readFileSync(init, 'utf8'), /用户改过这个文件/);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
