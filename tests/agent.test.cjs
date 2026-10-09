const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');

const sdkAgent = new Module('sdk-agent');
sdkAgent._compile(buildSync({ entryPoints: ['sdk/agent.ts'], bundle: true, platform: 'node', write: false }).outputFiles[0].text, 'sdk-agent.cjs');
const { ensureAgent } = sdkAgent.exports;

const agent = '#!/bin/sh\n[ "$1" = --version ] && echo "wangcai 0.1.0"\n';

// A stub ssh runs the remote command here against a stubbed uname and a private HOME, so the install is
// exercised end to end against a local release server.
async function remote(platform, assets) {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-agent-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho "${platform}"\n`, { mode: 0o755 });
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    if (!assets[request.url]) { response.writeHead(404).end(); return; }
    response.end(assets[request.url]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const prefix = `http://127.0.0.1:${server.address().port}`;
  return {
    requested,
    home,
    prefix,
    install: async (version, prefixes = [prefix]) => {
      const environment = { HOME: process.env.HOME, PATH: process.env.PATH };
      process.env.HOME = home;
      process.env.WANGCAI_HOME = '';
      process.env.PATH = `${bin}:/bin:/usr/bin`;
      try { await ensureAgent('stub', { version, prefixes }); }
      finally { Object.assign(process.env, environment); }
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a remote machine gets the agent for its platform, and only when the version differs', async () => {
  const machine = await remote('Darwin arm64', { '/agent-v0.1.0/wangcai-aarch64-apple-darwin': agent });
  try {
    await machine.install('0.1.0');
    assert.equal(readFileSync(join(machine.home, '.local/bin/wangcai'), 'utf8'), agent);
    assert.deepEqual(readdirSync(join(machine.home, '.local/bin')), ['wangcai']);
    assert.deepEqual(machine.requested, ['/agent-v0.1.0/wangcai-aarch64-apple-darwin']);
    await machine.install('0.1.0');
    assert.deepEqual(machine.requested, ['/agent-v0.1.0/wangcai-aarch64-apple-darwin']);
    await assert.rejects(machine.install('9.9.9'), /下载 agent 失败：[\s\S]*404 Not Found/);
    assert.deepEqual(machine.requested, ['/agent-v0.1.0/wangcai-aarch64-apple-darwin', '/agent-v9.9.9/wangcai-aarch64-apple-darwin']);
    // A failed download left the working agent in place, so this version is still a no-op.
    await machine.install('0.1.0');
    assert.deepEqual(machine.requested, ['/agent-v0.1.0/wangcai-aarch64-apple-darwin', '/agent-v9.9.9/wangcai-aarch64-apple-darwin']);
  } finally { await machine.close(); }
});

test('a machine that refuses the probe is left alone', async () => {
  const machine = await remote('Darwin arm64', {});
  writeFileSync(join(machine.home, 'bin/ssh'), '#!/bin/sh\nexit 255\n');
  try {
    await machine.install('0.1.0');
    assert.deepEqual(machine.requested, []);
    assert.equal(existsSync(join(machine.home, '.local/bin/wangcai')), false);
  } finally { await machine.close(); }
});

test('a platform without a release fails before anything is downloaded', async () => {
  const machine = await remote('FreeBSD amd64', {});
  try {
    await assert.rejects(machine.install('0.1.0'), /FreeBSD amd64 上暂不支持自动安装 agent/);
    assert.deepEqual(machine.requested, []);
    assert.equal(existsSync(join(machine.home, '.local/bin/wangcai')), false);
  } finally { await machine.close(); }
});

test('a prefix that does not answer hands the download to the next one', async () => {
  const machine = await remote('Darwin arm64', { '/agent-v0.1.0/wangcai-aarch64-apple-darwin': agent });
  try {
    // Nothing listens on the first prefix.
    await machine.install('0.1.0', ['http://127.0.0.1:1', machine.prefix]);
    assert.equal(readFileSync(join(machine.home, '.local/bin/wangcai'), 'utf8'), agent);
    assert.deepEqual(machine.requested, ['/agent-v0.1.0/wangcai-aarch64-apple-darwin']);
  } finally { await machine.close(); }
});
