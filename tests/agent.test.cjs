const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { agentVersion: version, coreModule } = require('./init.cjs');

// The installer downloads whatever the caller hands it, so the test steers every request itself and the stub
// release answers with the assets it was given, by the name a URL ends with.
const { agentInstaller } = coreModule('main/agent.ts');
let assets = {};
let requests = [];
// Set when the stub release should answer a digest of other bytes than the asset it serves.
let mismatched;
const download = async (url) => {
  requests.push(url);
  const sum = url.endsWith('.sha256');
  const asset = sum ? url.slice(0, -'.sha256'.length) : url;
  const name = Object.keys(assets).find((suffix) => asset.endsWith(suffix));
  if (!name) return new Response('', { status: 404, statusText: 'Not Found' });
  return new Response(sum ? mismatched ?? digest(assets[name]) : assets[name], { status: 200 });
};
// The release publishes each asset with its digest beside it; the stub serves both from the same body.
const digest = (body) => createHash('sha256').update(body).digest('hex');
const publishes = (next) => { assets = next; requests = []; mismatched = undefined; };
const released = `#!/bin/sh\n[ "$1" = --version ] && echo "wangcai ${version}"\n`;
const older = '#!/bin/sh\n[ "$1" = --version ] && echo "wangcai 0.0.9"\n';
const release = (target) => `https://github.com/lengmoXXL/WangCai/releases/download/agent-v${version}/wangcai-${target}`;
// What this machine's own release is called.
const target = { 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl' }[`${process.platform}-${process.arch}`];
const directory = () => mkdtempSync(join(tmpdir(), 'wangcai-agent-'));

test('this machine gets the agent it runs from its release, once', async () => {
  const storage = directory();
  publishes({ [`/wangcai-${target}`]: released });
  try {
    assert.equal(await agentInstaller(storage, {}, download).local(), join(storage, 'bin/wangcai'));
    assert.equal(readFileSync(join(storage, 'bin/wangcai'), 'utf8'), released);
    assert.equal(statSync(join(storage, 'bin/wangcai')).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(join(storage, 'bin')), ['wangcai']);
    assert.deepEqual(requests, [`${release(target)}.sha256`, release(target)]);
    // The agent is already there, so a second run does not download it again.
    await agentInstaller(storage, {}, download).local();
    assert.equal(requests.length, 2);
    // One that is a version behind is replaced, and the new one is the agent a run drives.
    writeFileSync(join(storage, 'bin/wangcai'), older, { mode: 0o755 });
    await agentInstaller(storage, {}, download).local();
    assert.equal(readFileSync(join(storage, 'bin/wangcai'), 'utf8'), released);
    assert.equal(requests.length, 4);
    assert.deepEqual(readdirSync(join(storage, 'bin')), ['wangcai']);
  } finally { rmSync(storage, { recursive: true, force: true }); }
});

test('an agent from a development checkout is used as it stands', async () => {
  const storage = directory();
  const built = join(storage, 'built-wangcai');
  writeFileSync(built, older, { mode: 0o755 });
  publishes({});
  const previous = process.env.WANGCAI_AGENT_SOURCE;
  process.env.WANGCAI_AGENT_SOURCE = built;
  try {
    assert.equal(await agentInstaller(storage, {}, download).local(), built);
    assert.deepEqual(requests, []);
  } finally {
    if (previous === undefined) delete process.env.WANGCAI_AGENT_SOURCE;
    else process.env.WANGCAI_AGENT_SOURCE = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

// A stub ssh runs the remote command here against a stubbed uname and a private HOME, so an install is
// exercised end to end with only the download left to the test.
function machine(platform, network = {}) {
  const home = directory();
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho "${platform}"\n`, { mode: 0o755 });
  const agents = agentInstaller(join(home, 'data'), network, download);
  return {
    home,
    // What the machine already has installed, if a test gives it an older one.
    installed: (build) => { mkdirSync(join(home, '.local/bin'), { recursive: true }); writeFileSync(join(home, '.local/bin/wangcai'), build, { mode: 0o755 }); },
    install: async () => {
      const environment = { HOME: process.env.HOME, PATH: process.env.PATH };
      process.env.HOME = home;
      process.env.WANGCAI_HOME = '';
      process.env.PATH = `${bin}:/bin:/usr/bin`;
      try { await agents.ssh('stub'); }
      finally { Object.assign(process.env, environment); }
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('a remote machine gets the agent for its platform, and only when the version differs', async () => {
  publishes({ '/wangcai-aarch64-apple-darwin': released });
  const remote = machine('Darwin arm64');
  try {
    await remote.install();
    assert.equal(readFileSync(join(remote.home, '.local/bin/wangcai'), 'utf8'), released);
    assert.deepEqual(readdirSync(join(remote.home, '.local/bin')), ['wangcai']);
    assert.deepEqual(requests, [`${release('aarch64-apple-darwin')}.sha256`, release('aarch64-apple-darwin')]);
    await remote.install();
    assert.equal(requests.length, 2);
    // The machine is a version behind, so the agent it runs is the one this Core drives.
    remote.installed(older);
    await remote.install();
    assert.equal(requests.length, 4);
  } finally { remote.close(); }
});

test('a machine that refuses the probe is left alone', async () => {
  publishes({});
  const remote = machine('Darwin arm64');
  writeFileSync(join(remote.home, 'bin/ssh'), '#!/bin/sh\nexit 255\n');
  try {
    await remote.install();
    assert.deepEqual(requests, []);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('a platform without a release fails before anything is downloaded', async () => {
  publishes({});
  const remote = machine('FreeBSD amd64');
  try {
    await assert.rejects(remote.install(), /FreeBSD amd64 上暂不支持自动安装 agent/);
    assert.deepEqual(requests, []);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('a release that is not there fails with what the download answered', async () => {
  publishes({});
  const remote = machine('Darwin arm64');
  try {
    await assert.rejects(remote.install(), /下载 agent 失败：[\s\S]*404 Not Found/);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});

test('the download goes out through the mirror init.ts names', async () => {
  publishes({ '/wangcai-aarch64-apple-darwin': released });
  const remote = machine('Darwin arm64', { mirror: 'https://ghfast.top/' });
  try {
    await remote.install();
    assert.equal(readFileSync(join(remote.home, '.local/bin/wangcai'), 'utf8'), released);
    assert.deepEqual(requests, [`https://ghfast.top/${release('aarch64-apple-darwin')}.sha256`, `https://ghfast.top/${release('aarch64-apple-darwin')}`]);
  } finally { remote.close(); }
});

test('a download that disagrees with the published digest is never installed', async () => {
  publishes({ '/wangcai-aarch64-apple-darwin': released });
  const remote = machine('Darwin arm64');
  // A mirror that answers the digest with its own error page, and one that publishes a digest of other bytes.
  const serve = (sum) => { publishes({ '/wangcai-aarch64-apple-darwin': released }); mismatched = sum; };
  try {
    serve('<!doctype html><title>502 Bad Gateway</title>');
    await assert.rejects(remote.install(), /下载 agent 失败：[\s\S]*校验值不是 sha256/);
    serve(digest('some other build'));
    await assert.rejects(remote.install(), /下载 agent 失败：[\s\S]*sha256 不符/);
    assert.equal(existsSync(join(remote.home, '.local/bin/wangcai')), false);
  } finally { remote.close(); }
});