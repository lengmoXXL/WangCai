const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

test('plugin cache tracks source, styles, workers, dependencies and failed builds', async () => {
  const { buildPlugin, isPluginBuildCurrent } = await import('../desktop/main/plugin-build.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wangcai-plugin-build-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  const dependencies = join(source, 'node_modules');
  try {
    mkdirSync(join(dependencies, 'fixture'), { recursive: true });
    writeFileSync(join(dependencies, 'fixture/package.json'), '{"name":"fixture","main":"index.js"}');
    writeFileSync(join(dependencies, 'fixture/index.js'), 'module.exports = "dependency-v1";');
    writeFileSync(join(source, 'main.ts'), 'import value from "fixture"; export function activate() { return value; }');
    writeFileSync(join(source, 'ui.tsx'), 'import "./style.css"; export function mount() { return "ui-v1"; }');
    writeFileSync(join(source, 'style.css'), 'body { color: red; }');
    await buildPlugin(source, output, '1', dependencies);
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), true);
    assert.equal(isPluginBuildCurrent(source, output, '2', dependencies), false);
    assert.match(readFileSync(join(output, 'ui.js'), 'utf8'), /sourceMappingURL=ui.js.map/);
    assert.doesNotMatch(readFileSync(join(output, 'ui.js'), 'utf8'), /sourceMappingURL=data:/);
    assert.equal(existsSync(join(output, 'ui.js.map')), true);

    writeFileSync(join(source, 'style.css'), 'body { color: blue; }');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    await buildPlugin(source, output, '1', dependencies);
    assert.match(readFileSync(join(output, 'ui.css'), 'utf8'), /blue/);
    writeFileSync(join(source, 'ui.worker.ts'), 'self.onmessage = () => self.postMessage("worker-v1");');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    await buildPlugin(source, output, '1', dependencies);
    assert.match(readFileSync(join(output, 'ui.worker.js'), 'utf8'), /worker-v1/);

    writeFileSync(join(dependencies, 'fixture/index.js'), 'module.exports = "dependency-v2";');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    await buildPlugin(source, output, '1', dependencies);
    assert.match(readFileSync(join(output, 'main.cjs'), 'utf8'), /dependency-v2/);
    writeFileSync(join(dependencies, 'fixture/new.js'), 'module.exports = "dependency-v3";');
    writeFileSync(join(dependencies, 'fixture/package.json'), '{"name":"fixture","main":"new.js"}');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    await buildPlugin(source, output, '1', dependencies);
    assert.match(readFileSync(join(output, 'main.cjs'), 'utf8'), /dependency-v3/);

    const previous = readFileSync(join(output, 'main.cjs'), 'utf8');
    writeFileSync(join(source, 'main.ts'), 'export function activate( {');
    await assert.rejects(buildPlugin(source, output, '1', dependencies), /Build failed/);
    assert.equal(readFileSync(join(output, 'main.cjs'), 'utf8'), previous);
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    writeFileSync(join(source, 'main.ts'), 'export function activate() {}');
    rmSync(join(source, 'ui.tsx'));
    await buildPlugin(source, output, '1', dependencies);
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), true);
    assert.equal(existsSync(join(output, 'ui.js')), false);
    assert.equal(existsSync(join(output, 'ui.css')), false);
    assert.equal(existsSync(join(output, 'ui.worker.js')), false);
    rmSync(join(output, 'main.cjs'));
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prebuilt plugins can relocate and use shared or private dependencies', async () => {
  const { buildPlugin, isPluginBuildCurrent } = await import('../desktop/main/plugin-build.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wangcai-plugin-build-'));
  const bundled = join(root, 'bundled');
  const relocated = join(root, 'relocated');
  const source = join(root, 'user');
  try {
    mkdirSync(join(bundled, 'node_modules/fixture'), { recursive: true });
    writeFileSync(join(bundled, 'node_modules/fixture/package.json'), '{"name":"fixture","main":"index.js"}');
    writeFileSync(join(bundled, 'node_modules/fixture/index.js'), 'module.exports = "shared";');
    writeFileSync(join(bundled, 'package.json'), '{"name":"plugin"}');
    writeFileSync(join(bundled, 'main.ts'), 'import value from "fixture"; import * as sdk from "@wangcai/sdk"; export function activate() { return [value, sdk]; }');
    await buildPlugin(bundled, join(bundled, '.compiled'), '1', join(bundled, 'node_modules'));
    cpSync(bundled, relocated, { recursive: true });
    cpSync(bundled, source, { recursive: true, filter: path => path !== join(bundled, 'node_modules') && path !== join(bundled, '.compiled') });
    rmSync(bundled, { recursive: true });
    const output = join(relocated, '.compiled');
    const dependencies = join(relocated, 'node_modules');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), true);
    const compiled = readFileSync(join(output, 'main.cjs'), 'utf8');
    assert.match(compiled, /require\("@wangcai\/sdk"\)/);
    assert.ok(!compiled.includes(bundled));

    mkdirSync(join(source, 'node_modules/fixture'), { recursive: true });
    writeFileSync(join(source, 'node_modules/fixture/package.json'), '{"name":"fixture","main":"index.js"}');
    writeFileSync(join(source, 'node_modules/fixture/index.js'), 'module.exports = "private";');
    assert.equal(isPluginBuildCurrent(source, output, '1', dependencies), false);
    const cache = join(root, 'cache');
    await buildPlugin(source, cache, '1', dependencies);
    assert.equal(isPluginBuildCurrent(source, cache, '1', dependencies), true);
    assert.match(readFileSync(join(cache, 'main.cjs'), 'utf8'), /private/);
    rmSync(join(source, 'node_modules'), { recursive: true });
    assert.equal(isPluginBuildCurrent(source, cache, '1', dependencies), false);
    await buildPlugin(source, cache, '1', dependencies);
    assert.match(readFileSync(join(cache, 'main.cjs'), 'utf8'), /shared/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
