const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const compiled = new Module('terminal-links');
compiled._compile(buildSync({ entryPoints: ['plugins/terminal/links.ts'], bundle: true, platform: 'node', write: false }).outputFiles[0].text, 'terminal-links.cjs');
const { fileLocation, registerFileLinks } = compiled.exports;

test('file links: absolute paths, file URLs, line/column and wrapped Unicode cells', async () => {
  assert.deepEqual(fileLocation('/tmp/test.ts:42:8'), { path: '/tmp/test.ts', line: 42, column: 8 });
  assert.deepEqual(fileLocation('file://vm149/tmp/a%20b.md'), { path: '/tmp/a b.md', line: undefined, column: undefined });
  assert.deepEqual(fileLocation('src/relative.ts:12'), { path: 'src/relative.ts', line: 12, column: undefined });
  assert.equal(fileLocation('../README.md').path, '../README.md');
  assert.equal(fileLocation('./main.rs').path, './main.rs');
  assert.equal(fileLocation('https://example.com/a.ts'), undefined);
  assert.equal(fileLocation('file:///%ZZ'), undefined);
  const terminal = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
  let provider;
  let clicked;
  registerFileLinks({ options: {}, buffer: terminal.buffer, registerLinkProvider(value) { provider = value; } }, text => clicked = text);
  await new Promise(resolve => terminal.write('中文 /tmp/long-directory/file.ts:42:8\r\nhttps://example.com/a.ts', resolve));
  const links = await new Promise(resolve => provider.provideLinks(2, resolve));
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/tmp/long-directory/file.ts:42:8');
  assert.deepEqual(links[0].range.start, { x: 6, y: 1 });
  assert.equal(links[0].range.end.y, 2);
  links[0].activate();
  assert.equal(clicked, links[0].text);
  assert.deepEqual(await new Promise(resolve => provider.provideLinks(3, resolve)), []);
  await new Promise(resolve => terminal.write('\r\n./main.rs ../README.md Makefile', resolve));
  const relative = await new Promise(resolve => provider.provideLinks(4, resolve));
  assert.deepEqual(relative.map(link => link.text), ['./main.rs', '../README.md', 'Makefile']);
  terminal.dispose();
});

test('command options are not file links; explicit paths starting with a dash still work', async () => {
  assert.equal(fileLocation('--exclude-dir=.svn'), undefined);
  assert.equal(fileLocation('./-notes.md').path, './-notes.md');
  const terminal = new Terminal({ cols: 120, rows: 3, allowProposedApi: true });
  let provider;
  registerFileLinks({ options: {}, buffer: terminal.buffer, registerLinkProvider(value) { provider = value; } }, () => {});
  await new Promise(resolve => terminal.write('rg --exclude-dir=.svn --output=./result.txt -I./include src/main.ts ./-notes.md', resolve));
  const links = await new Promise(resolve => provider.provideLinks(1, resolve));
  assert.deepEqual(links.map(link => link.text), ['src/main.ts', './-notes.md']);
  terminal.dispose();
});
