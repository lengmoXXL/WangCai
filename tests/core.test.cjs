const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { launchApp, testEnv, writeInit } = require('./init.cjs');
const { makeCoreRepo } = require('./core-repo.cjs');

test('a start that finds no Core installs one, and the start after it uses what is already there', { timeout: 180000 }, async () => {
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
    await (await desktop.firstWindow()).locator('#core-marker').waitFor();
    assert.equal(existsSync(join(storage, 'core-src/.git')), true);
    assert.equal(existsSync(join(storage, 'core/main.cjs')), true);
    assert.equal(existsSync(join(storage, 'core/ui/index.html')), true);
    await desktop.close(); desktop = undefined;
    // A Core that is already built is what runs: the start that follows does not go back to the repository,
    // which is what a path that is not there would fail on.
    desktop = await launch(join(home, 'no-such-repository'));
    await (await desktop.firstWindow()).locator('#core-marker').waitFor();
  } finally {
    await desktop?.close();
    rmSync(home, { recursive: true, force: true });
  }
});