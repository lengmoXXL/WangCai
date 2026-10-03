const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

test('plugin build writes the files the app loads', async () => {
  const { buildPlugin } = await import('../desktop/tools/plugin-build.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wangcai-plugin-build-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  try {
    mkdirSync(source);
    writeFileSync(join(source, 'main.ts'), 'import { connect } from "@wangcai/sdk"; export function activate() { return connect; }');
    writeFileSync(join(source, 'ui.tsx'), 'import "./style.css"; export function mount() { return "ui"; }');
    writeFileSync(join(source, 'style.css'), 'body { color: red; }');
    writeFileSync(join(source, 'ui.worker.ts'), 'self.onmessage = () => self.postMessage("worker");');
    await buildPlugin(source, output);
    // The SDK stays a require of the running app, so every plugin shares one connection pool.
    assert.match(readFileSync(join(output, 'main.cjs'), 'utf8'), /require\("@wangcai\/sdk"\)/);
    assert.equal(existsSync(join(output, 'main.cjs.map')), true);
    assert.match(readFileSync(join(output, 'ui.css'), 'utf8'), /red/);
    assert.match(readFileSync(join(output, 'ui.js'), 'utf8'), /sourceMappingURL=ui.js.map/);
    assert.doesNotMatch(readFileSync(join(output, 'ui.js'), 'utf8'), /sourceMappingURL=data:/);
    assert.match(readFileSync(join(output, 'ui.worker.js'), 'utf8'), /worker/);

    writeFileSync(join(source, 'ui.tsx'), 'import { connect } from "@wangcai/sdk"; export function mount() { return connect; }');
    await assert.rejects(buildPlugin(source, output), /@wangcai\/sdk is only available in main.ts/);

    writeFileSync(join(source, 'ui.tsx'), 'export function mount() { return "ui"; }');
    rmSync(join(source, 'ui.worker.ts'));
    await buildPlugin(source, output);
    assert.equal(existsSync(join(output, 'ui.js')), true);
    assert.equal(existsSync(join(output, 'ui.worker.js')), false);

    rmSync(join(source, 'ui.tsx'));
    await buildPlugin(source, output);
    assert.equal(existsSync(join(output, 'ui.js')), false);
    assert.equal(existsSync(join(output, 'ui.css')), false);
    assert.equal(existsSync(join(output, 'ui.js.map')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
