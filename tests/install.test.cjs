const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const { launchApp, mockWorkspace, testEnv, writeInit } = require('./init.cjs');
const { makePluginRepo } = require('./plugin-repo.cjs');

const compiled = new Module('install');
compiled._compile(buildSync({ entryPoints: ['desktop/main/install.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, 'install.cjs');
const { repositoryUrls } = compiled.exports;

test('a GitHub repository lists mirrors to retry through, and other repositories are used as they are', () => {
  const urls = repositoryUrls('https://github.com/lengmoXXL/WangCai-git');
  assert.equal(urls[0], 'https://github.com/lengmoXXL/WangCai-git');
  assert.match(urls[1], /^https:\/\/ghfast\.top\//);
  for (const url of urls.slice(1)) assert.match(url, /^https:\/\/[^/]+\/https:\/\/github\.com\/lengmoXXL\/WangCai-git$/);
  // Only an https GitHub URL has mirrors to prefix it: a local path and an ssh remote are used as they are.
  assert.deepEqual(repositoryUrls('/Users/someone/plugin'), ['/Users/someone/plugin']);
  assert.deepEqual(repositoryUrls('git@github.com:owner/repo.git'), ['git@github.com:owner/repo.git']);
});

test('repository plugins are cloned, built and rebuilt when their commit moves', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-install-')));
  const env = testEnv(home);
  const good = makePluginRepo(home, 'good');
  const plugin = join(home, '.local/share/wangcai/plugins/good');
  const init = join(home, '.config/wangcai/init.ts');
  let desktop;
  let page;
  const launch = async () => {
    desktop = await launchApp(home, env);
    page = await desktop.firstWindow();
    await page.waitForFunction(() => document.querySelector('[data-plugin=good]')?.dataset.revision);
  };
  const stages = () => page.locator('.installs li').evaluateAll((rows) => rows.map((row) => [row.querySelector('.install-id').textContent, row.dataset.stage]));
  try {
    writeInit(home, { tabs: [{ id: 'good', repo: good.directory, commit: good.commit }] });
    await launch();
    // The clone and its build land in the user's plugin directory.
    assert.equal(existsSync(join(plugin, 'main.cjs')), true);
    assert.match(readFileSync(join(plugin, 'main.cjs'), 'utf8'), /good one/);
    assert.equal(await page.locator('[data-plugin=good]').getAttribute('data-revision'), 'good one');
    assert.equal(await page.locator('.installs').isVisible(), true);
    await desktop.close(); desktop = undefined;

    // A start with nothing to install opens nothing.
    await launch();
    assert.equal(await page.locator('.installs').isVisible(), false);
    assert.deepEqual(await stages(), [['good', 'ready']]);
    await desktop.close(); desktop = undefined;

    // A commit init.ts moves to is fetched, built and loaded in its place.
    const moved = good.revise('good two');
    writeFileSync(init, readFileSync(init, 'utf8').replace(good.commit, moved));
    await launch();
    assert.match(readFileSync(join(plugin, 'main.cjs'), 'utf8'), /good two/);
    assert.equal(await page.locator('[data-plugin=good]').getAttribute('data-revision'), 'good two');
    await desktop.close(); desktop = undefined;

    // A commit the repository does not have stops that plugin and is reported with the reason.
    mockWorkspace(home);
    writeInit(home, {
      workspaces: [{ id: 'terminal-agent' }],
      tabs: [
        { id: 'good', repo: good.directory, commit: moved },
        { id: 'broken', repo: good.directory, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      ],
    });
    await launch();
    assert.deepEqual(await stages(), [['terminal-agent', 'ready'], ['good', 'ready'], ['broken', 'failed']]);
    assert.match(await page.locator('.installs li[data-stage=failed] .install-message').innerText(), /deadbeef/);
    // The plugin that did not install is not loaded at all: no error panel, and the rest of the app runs.
    assert.deepEqual(await page.evaluate(async () => (await window.wangcai.plugins()).map(({ id, error }) => [id, Boolean(error)])), [['good', false], ['terminal-agent', false]]);
    assert.equal(await page.locator('.plugin-error').count(), 0);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the plugin page is styled by the app theme while a plugin is still installing', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-install-page-')));
  const env = testEnv(home);
  const slow = makePluginRepo(home, 'slow', 4000);
  writeInit(home, { tabs: [{ id: 'slow', repo: slow.directory, commit: slow.commit }] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    // The shell's theme is the app's, so the page has it before any plugin has loaded.
    await page.locator('.installs li[data-stage=building]').waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 19, 20)');
    assert.equal(await page.locator('.installs li').evaluate((row) => getComputedStyle(row).backgroundColor), 'rgb(25, 26, 27)');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a plugin that failed is installed again from the entry its row offers', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-retry-')));
  const env = testEnv(home);
  // The repository init.ts names is not there yet, so the plugin fails and the page offers to try it again;
  // nothing but the repository on disk changes before the entry is used.
  writeInit(home, { tabs: [{ id: 'later', repo: join(home, 'later-repository'), commit: 'main' }] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await page.locator('.installs li[data-stage=failed]').waitFor();
    assert.match(await page.locator('.installs .install-message').innerText(), /later-repository/);
    // The helper's directory for an id is `<id>-repository`, which is the path the entry names.
    makePluginRepo(home, 'later');
    await page.locator('.installs li[data-stage=failed] button').click();
    // The clone, the build and the reload that follows it bring the plugin in.
    await page.locator('[data-plugin=later]').waitFor();
    assert.equal(await page.locator('[data-plugin=later]').getAttribute('data-revision'), 'later one');
    assert.equal(await page.locator('.installs').isVisible(), false);
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a plugin already at the commit init.ts pins reports that there is nothing to do', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-pinned-')));
  const env = testEnv(home);
  const pinned = makePluginRepo(home, 'pinned');
  // The commit is what makes this entry a pinned one.
  writeInit(home, { tabs: [{ id: 'pinned', repo: pinned.directory, commit: pinned.commit }] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await page.locator('[data-plugin=pinned]').waitFor();
    await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu.items).find((item) => item.label === '插件').click());
    const row = page.locator('.installs li[data-stage=ready]');
    await row.waitFor();
    await row.getByRole('button', { name: '更新' }).click();
    await row.locator('.install-message').filter({ hasText: '无需更新' }).waitFor();
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a plugin entry without a commit follows its branch when its row is updated', { timeout: 180000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-update-')));
  const env = testEnv(home);
  const moving = makePluginRepo(home, 'moving');
  // No commit, so the entry follows the branch: a start installs it, and the page moves it on afterwards.
  writeInit(home, { tabs: [{ id: 'moving', repo: moving.directory }] });
  let desktop;
  try {
    desktop = await launchApp(home, env);
    const page = await desktop.firstWindow();
    await page.locator('[data-plugin=moving]').waitFor();
    assert.equal(await page.locator('[data-plugin=moving]').getAttribute('data-revision'), 'moving one');
    // The page opens on its own only while a plugin has something to do, so the menu opens it here.
    await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu.items).find((item) => item.label === '插件').click());
    const update = page.locator('.installs li[data-stage=ready] button');
    await update.waitFor();
    assert.equal(await update.innerText(), '更新');
    moving.revise('moving two');
    await update.click();
    await page.waitForFunction(() => document.querySelector('[data-plugin=moving]')?.dataset.revision === 'moving two');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
