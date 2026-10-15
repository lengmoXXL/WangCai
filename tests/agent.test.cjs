const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');

// The installer downloads through electron's net.fetch and asks the SDK how a machine is addressed; the
// bundle is compiled against those packages and these stand in for them, so a test steers the download.
const { agentCommand } = require('@lengmoxxl/sdk');
let download = async () => new Response('', { status: 404, statusText: 'Not Found' });
const stubs = { electron: { net: { fetch: (url, init) => download(url, init) } }, '@lengmoxxl/sdk': { agentCommand } };
const installer = new Module('agent-installer');
const load = Module._load;
Module._load = function (request, ...rest) {
  return stubs[request] ?? load.call(this, request, ...rest);
};
installer._compile(buildSync({ entryPoints: ['desktop/main/agent.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, 'agent-installer.cjs');
Module._load = load;
const { agentInstaller } = installer.exports;
// The agent the app ships: the installer reads its version and installs that release.
const shipped = '#!/bin/sh\n[ "$1" = --version ] && echo "wangcai 0.1.0"\n';
// The release publishes each asset with its digest beside it; the stub serves both from the same body.
const digest = (body) => createHash('sha256').update(body).digest('hex');

// A stub ssh runs the remote command here against a stubbed uname and a private HOME, so an install is
// exercised end to end with only the download left to the test.
async function machine(platform, assets = {}, network = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-agent-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho "${platform}"\n`, { mode: 0o755 });
  const resources = join(home, 'resources');
  mkdirSync(resources);
  writeFileSync(join(resources, 'wangcai'), shipped, { mode: 0o755 });
  const requests = [];
  download = async (url) => {
    requests.push(url);
    const sum = url.endsWith('.sha256');
    const asset = sum ? url.slice(0, -'.sha256'.length) : url;
    const name = Object.keys(assets).find((suffix) => asset.endsWith(suffix));
    if (!name) return new Response('', { status: 404, statusText: 'Not Found' });
    return new Response(sum ? digest(assets[name]) : assets[name], { status: 200 });
  };
  const install = agentInstaller(resources, network);
  return {
    requests,
    home,
    resources,
    // What the machine already has installed, if a test gives it an older one.
    installed: (version) => { mkdirSync(join(home, '.local/bin'), { recursive: true }); writeFileSync(join(home, '.local/bin/wangcai'), `#!/bin/sh\n[ "$1" = --version ] && echo "wangcai ${version}"\n`, { mode: 0o755 }); },
    install: async () => {
      const environment = { HOME: process.env.HOME, PATH: process.env.PATH };
      process.env.HOME = home;
      process.env.WANGCAI_HOME = '';
      process.env.PATH = `${bin}:/bin:/usr/bin`;
      try { await install('stub'); }
      finally { Object.assign(process.env, environment); }
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('a remote machine gets the agent for its platform, and only when the version differs', async () => {
  const target = 'agent-v0.1.0/wangcai-aarch64-apple-darwin';
  const asset = `https://github.com/lengmoXXL/WangCai/releases/download/${target}`;
  const remote = await machine('Darwin arm64', { [target]: shipped });
  try {
    await remote.install();
    assert.equal(readFileSync(join(remote.home, '.local/bin/wangcai'), 'utf8'), shipped);
    assert.deepEqual(readdirSync(join(remote.home, '.local/bin')), ['wangcai']);
    assert.deepEqual(remote.requests, [`${asset}.sha256`, asset]);
    await remote.install();
    assert.equal(remote.requests.length, 2);
    // The machine is a version behind, so the agent it runs is the one this app ships.
    remote.installed('0.0.9');
    await remote.install();
    assert.equal(remote.requests.length, 4);
  } finally { remote.close(); }
});

test('a machine that refuses the probe is left alone', async () => {
  const remote = await machine('Darwin arm64');
  writeFileSync(join(remote.home, 'bin/ssh'), '#!/bin/sh\nexit 255\n');
  try {
    await remote.install();
    assert.deepEqual(remote.requests, []);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('a platform without a release fails before anything is downloaded', async () => {
  const remote = await machine('FreeBSD amd64');
  try {
    await assert.rejects(remote.install(), /FreeBSD amd64 上暂不支持自动安装 agent/);
    assert.deepEqual(remote.requests, []);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('a release that is not there fails with what the download answered', async () => {
  const remote = await machine('Darwin arm64');
  try {
    await assert.rejects(remote.install(), /下载 agent 失败：[\s\S]*404 Not Found/);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('the download goes out through the mirror init.ts names', async () => {
  const target = 'agent-v0.1.0/wangcai-aarch64-apple-darwin';
  const asset = `https://ghfast.top/https://github.com/lengmoXXL/WangCai/releases/download/${target}`;
  const remote = await machine('Darwin arm64', { [target]: shipped }, { mirror: 'https://ghfast.top/' });
  try {
    await remote.install();
    assert.equal(readFileSync(join(remote.home, '.local/bin/wangcai'), 'utf8'), shipped);
    assert.deepEqual(remote.requests, [`${asset}.sha256`, asset]);
  } finally { remote.close(); }
});

test('a download that disagrees with the published digest is never installed', async () => {
  const target = 'agent-v0.1.0/wangcai-aarch64-apple-darwin';
  const remote = await machine('Darwin arm64', { [target]: shipped });
  const serve = (sum) => {
    download = async (url) => {
      return url.endsWith('.sha256') ? new Response(sum, { status: 200 }) : new Response(shipped, { status: 200 });
    };
  };
  try {
    // A mirror that answers the digest with its own error page, and one that publishes a digest of other bytes.
    serve('<!doctype html><title>502 Bad Gateway</title>');
    await assert.rejects(remote.install(), /校验值不是 sha256/);
    serve(digest('some other build'));
    await assert.rejects(remote.install(), /sha256 不符/);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});
