const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const { launchApp, mockWorkspace, testEnv, waitForShell, writeInit } = require('./init.cjs');

/** config.ts fixes its home when it loads, so a reader for a temporary home is compiled after that home is set. */
async function readConfig(home, source) {
  const previous = { HOME: process.env.HOME, WANGCAI_HOME: process.env.WANGCAI_HOME };
  process.env.HOME = home;
  // A development run names a home of its own, which the reader prefers; these tests want the temporary one.
  process.env.WANGCAI_HOME = '';
  try {
    mkdirSync(join(home, '.config/wangcai'), { recursive: true });
    writeFileSync(join(home, '.config/wangcai/init.ts'), source);
    const compiled = new Module('config');
    compiled._compile(buildSync({ entryPoints: ['desktop/main/config.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, 'config.cjs');
    return await compiled.exports.loadConfig();
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.WANGCAI_HOME === undefined) delete process.env.WANGCAI_HOME; else process.env.WANGCAI_HOME = previous.WANGCAI_HOME;
  }
}

test('an entry that names no source is read from the official repository of its id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-defaults-'));
  try {
    const { plugins } = await readConfig(home, "export default { tabs: [{ id: 'files' }, { id: 'here', directory: '/tmp/here' }] };\n");
    assert.deepEqual(plugins.map(({ id, repo, directory }) => [id, repo, directory]), [
      ['files', 'https://github.com/lengmoXXL/WangCai-files', undefined],
      ['here', undefined, '/tmp/here'],
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the network init.ts names is read for the spellings the app and the tools it runs accept', async () => {
  // init.ts is imported by path, so a second config needs a home of its own.
  const read = async (name, source) => {
    const home = mkdtempSync(join(tmpdir(), `wangcai-network-${name}-`));
    try { return (await readConfig(home, source)).network; }
    finally { rmSync(home, { recursive: true, force: true }); }
  };
  assert.deepEqual(await read('socks', "export default { network: { proxy: 'socks://127.0.0.1:1080', mirror: 'https://ghfast.top' } };\n"),
    { proxy: 'socks5://127.0.0.1:1080', mirror: 'https://ghfast.top/' });
  // A bare address is the http proxy every reader of it takes it for.
  assert.deepEqual(await read('bare', "export default { network: { proxy: '127.0.0.1:7890' } };\n"), { proxy: 'http://127.0.0.1:7890', mirror: undefined });
  assert.deepEqual(await read('none', 'export default {};\n'), { proxy: undefined, mirror: undefined });
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
