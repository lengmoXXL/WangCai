const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { coreWindow, launchApp, testEnv, writeInit } = require('./init.cjs');
const { makeCoreRepo } = require('./core-repo.cjs');

test('a start that finds no Core says what it is doing, and the start after it uses what is already there', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-core-install-'));
  const repository = makeCoreRepo(home);
  const storage = join(home, '.local/share/wangcai');
  let desktop;
  // The repository a Core comes from is the app's own business, so init.ts cannot point it at a local one; a
  // run can, which is what makes the clone and the build of a first start testable without a network. No Core
  // is put in this home first: installing one is exactly what is being watched.
  const launch = (url) => launchApp(home, { ...testEnv(home), WANGCAI_CORE_REPOSITORY: url }, { installed: false });
  try {
    writeInit(home, { workspaces: [], tabs: [] });
    desktop = await launch(repository.directory);
    // A run with no page to draw yet says what the install is doing in a window of its own.
    const installs = await desktop.firstWindow();
    assert.match(installs.url(), /^data:text\/html/);
    await installs.locator('.bar').waitFor();
    assert.match(await installs.locator('#doing').innerText(), /克隆|同步|安装依赖|构建/);
    assert.match(await installs.locator('#detail').innerText(), /^(git clone|npm)/);
    // …and hands over to Core's own page once there is a build.
    const page = await coreWindow(desktop);
    await page.locator('#core-marker').waitFor();
    assert.equal(installs.isClosed(), true, 'the window that reported the install is gone');
    assert.equal(existsSync(join(storage, 'plugins/core/.git')), true);
    assert.equal(existsSync(join(storage, 'plugins/core/dist/main.cjs')), true);
    assert.equal(existsSync(join(storage, 'plugins/core/dist/ui/index.html')), true);
    await desktop.close(); desktop = undefined;
    // A Core that is already built is what runs: the start that follows does not go back to the repository,
    // which is what a path that is not there would fail on.
    desktop = await launch(join(home, 'no-such-repository'));
    await (await coreWindow(desktop)).locator('#core-marker').waitFor();
    assert.equal(desktop.windows().length, 1, 'a start that finds a build says nothing about installing one');
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});