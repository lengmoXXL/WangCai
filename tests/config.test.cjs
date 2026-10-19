const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { appModule, coreModule, installCore, launchApp, mockWorkspace, testEnv, waitForShell, writeInit } = require('./init.cjs');

const { syncSources } = coreModule('main/resources.ts');
const { loadConfig } = appModule('main/config.ts');

/** Where a run under this home reads and writes what these cases touch. */
const paths = (home) => ({ config: join(home, '.config/wangcai'), storage: join(home, '.local/share/wangcai') });

/** init.ts is written for this home and then read back, as a start does. */
function readConfig(home, source) {
  const pathsForHome = paths(home);
  mkdirSync(pathsForHome.config, { recursive: true });
  writeFileSync(join(pathsForHome.config, 'init.ts'), source);
  return loadConfig(pathsForHome);
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

test('the trees an agent reads are copied into the data directory, and only a new version replaces them', () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-sources-'));
  const storage = paths(home).storage;
  installCore(home);
  const sources = join(storage, 'src');
  try {
    syncSources(process.cwd(), storage, '1.0.0');
    const manual = join(sources, 'docs/plugins.md');
    // One probe per kind the list holds: a page an agent reads, the app's source, the kernel's source, and
    // an image such a page links to.
    assert.equal(existsSync(manual), true);
    assert.equal(existsSync(join(sources, 'desktop/main/index.ts')), true);
    assert.equal(existsSync(join(sources, 'core/main/plugins.ts')), true);
    assert.equal(existsSync(join(sources, 'desktop/build/icon.png')), true);
    // The same version does not recopy, so an edit to the copy stands.
    writeFileSync(manual, 'edited\n');
    syncSources(process.cwd(), storage, '1.0.0');
    assert.equal(readFileSync(manual, 'utf8'), 'edited\n');
    // A Core that was rebuilt replaces it as well: those files move without the shell's version changing.
    writeFileSync(join(storage, 'core/commit'), 'a newer core\n');
    syncSources(process.cwd(), storage, '1.0.0');
    assert.notEqual(readFileSync(manual, 'utf8'), 'edited\n');
    writeFileSync(manual, 'edited\n');
    // A version that changes replaces it: what the copy holds is the app's file, not the user's.
    syncSources(process.cwd(), storage, '1.0.1');
    assert.notEqual(readFileSync(manual, 'utf8'), 'edited\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a fresh init.ts points at a document the sources copy carries', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-guide-'));
  try {
    const pathsForHome = paths(home);
    await loadConfig(pathsForHome);
    const init = readFileSync(join(pathsForHome.config, 'init.ts'), 'utf8');
    const named = init.match(/完整说明：(\S+)/)[1];
    assert.equal(named, join(pathsForHome.storage, 'src/README.md'));
    installCore(home);
    syncSources(process.cwd(), pathsForHome.storage, '1.0.0');
    assert.equal(existsSync(named), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a launch leaves the file a fresh init.ts points at in the data directory', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-shipped-'));
  let desktop;
  try {
    mockWorkspace(home);
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    desktop = await launchApp(home, testEnv(home));
    await waitForShell(await desktop.firstWindow());
    assert.equal(existsSync(join(paths(home).storage, 'src/README.md')), true);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
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
  const init = join(paths(home).config, 'init.ts');
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
