const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { mockPlugin, testEnv, waitForShell, writeInit } = require('./init.cjs');
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

test('packaged app loads the plugins its config names and carries the node they build with', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-package-'));
  const env = testEnv(home);
  let desktop;
  // electron-builder names the directory after the architecture it was told to build, and the plain
  // `mac` one only when it was told nothing.
  const bundle = resolve(process.env.WANGCAI_APP_DIR ?? 'desktop/dist/package/mac', '旺财.app/Contents');
  let page;
  const launch = async (environment = env) => {
    desktop = await electron.launch({ executablePath: join(bundle, 'MacOS/旺财'), args: [`--user-data-dir=${join(home, 'electron')}`], env: environment });
    return desktop.firstWindow();
  };
  const spacing = () => page.locator('[data-plugin=terminal-agent] .probe').evaluate((element) => getComputedStyle(element).letterSpacing);
  try {
    // The plugin the config names, with a stylesheet of its own, in the directory an id is read from.
    const directory = mockPlugin(home, 'terminal-agent', {
      main: "exports.activate = ({ ui }) => { ui.handle('workspaces', () => []); };\n",
      ui: "export function mount(container) { const probe = document.createElement('div'); probe.className = 'probe'; probe.textContent = '插件'; container.append(probe); }\n",
      css: '.probe { letter-spacing: 3px; }\n',
    });
    writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
    assert.equal(execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', join(bundle, 'Info.plist')], { encoding: 'utf8' }).trim(), '旺财');
    // The app carries no plugin at all: init.ts names what to load, and nothing the app ships is a copy
    // of one.
    assert.equal(existsSync(join(bundle, 'Resources/plugins')), false);
    page = await launch();
    await waitForShell(page);
    await page.locator('[data-plugin=terminal-agent] .probe').waitFor();
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map((plugin) => plugin.id)), ['terminal-agent']);
    assert.equal(await spacing(), '3px');
    // The app carries the node and npm a repository plugin builds with.
    assert.equal(existsSync(join(bundle, 'Resources/node/bin/node')), true);
    assert.equal(existsSync(join(bundle, 'Resources/node/lib/node_modules/npm/bin/npm-cli.js')), true);
    // A plugin is read from its directory on every start: what changes there is what runs.
    writeFileSync(join(directory, 'ui.css'), '.probe { letter-spacing: 7px; }\n');
    await desktop.close(); desktop = undefined;
    page = await launch();
    await waitForShell(page);
    await page.locator('[data-plugin=terminal-agent] .probe').waitFor();
    assert.equal(await spacing(), '7px');
    assert.equal(existsSync(join(home, '.cache/wangcai')), false);
    await desktop.close(); desktop = undefined;
    // A fresh install has no init.ts: the app writes the default one, which names each plugin's repository
    // and the commit to build. GitHub is pointed at a path that is not there, so what runs here is the
    // config file alone rather than three clones.
    rmSync(join(home, '.config/wangcai/init.ts'));
    writeFileSync(join(home, 'gitconfig'), '[url "file:///nonexistent/"]\n\tinsteadOf = https://github.com/\n');
    page = await launch({ ...env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig') });
    const preset = readFileSync(join(home, '.config/wangcai/init.ts'), 'utf8');
    assert.match(preset, /workspaces: \[\n    \{ id: 'terminal-agent', repo: 'https:\/\/github\.com\/lengmoXXL\/WangCai-terminal-agent', commit: '[0-9a-f]{40}' \},\n  \],\n  tabs: \[\n    \{ id: 'files', repo: 'https:\/\/github\.com\/lengmoXXL\/WangCai-files', commit: '[0-9a-f]{40}' \},\n    \{ id: 'terminal', repo: 'https:\/\/github\.com\/lengmoXXL\/WangCai-terminal', commit: '[0-9a-f]{40}' \},\n  \],/);
    // The preset never mentions a font: a plugin's schema and its entry's config decide those alone.
    assert.doesNotMatch(preset, /font/);
  } finally {
    await desktop?.close();
    try { execFileSync(join(bundle, 'Resources/wangcai'), ['server', 'stop'], { env, stdio: 'ignore', timeout: 15000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
