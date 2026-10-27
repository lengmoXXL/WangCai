const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { agentVersion: version, coreModule } = require('./init.cjs');

const { agentInstaller } = coreModule('main/agent.ts');

const digest = (content) => createHash('sha256').update(content).digest('hex');
const released = `#!/bin/sh\n[ "$1" = --version ] && echo "wangcai ${version}"\n`;
const older = '#!/bin/sh\n[ "$1" = --version ] && echo "wangcai 0.0.9"\n';
const release = (name) => `https://github.com/lengmoXXL/WangCai/releases/download/agent-v${version}/wangcai-${name}`;
// What this machine's own release is called.
const target = { 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl' }[`${process.platform}-${process.arch}`];
const directory = () => mkdtempSync(join(tmpdir(), 'wangcai-agent-'));

// A stub ssh runs the remote command here against a stubbed uname and a private HOME, so an install is exercised end
// to end with only the release left to the case. The description is the platform it answers as, and the network Core
// would download through.
const machine = ({ platform, network = {} }) => {
  const home = directory();
  const bin = join(home, 'bin');
  const published = join(home, 'release.json');
  const asked = join(home, 'asked');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho "${platform}"\n`, { mode: 0o755 });
  // The installer downloads with curl, so this machine answers for the release with a curl of its own, first on PATH.
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(__dirname, 'curl-stub.cjs'))} "$@"\n`, { mode: 0o755 });
  // What a process the installer spawns sees: this machine's stubs first, and no agent of a development checkout. A
  // case may name a variable of its own, which is set after that one is cleared.
  const withEnvironment = async (body, extra = {}) => {
    const environment = { HOME: home, WANGCAI_HOME: '', PATH: `${bin}:/bin:/usr/bin`, STUB_RELEASE: published, STUB_ASKED: asked, WANGCAI_AGENT_SOURCE: undefined, ...extra };
    const saved = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
    const apply = (values) => {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    apply(environment);
    try { return await body(); } finally { apply(saved); }
  };
  return {
    home,
    // What the release answers, by URL suffix: each asset and the digest published beside it, which a case may
    // answer with other bytes than the asset it serves.
    publish: (files, wrongDigest) => {
      const index = {};
      for (const [suffix, content] of Object.entries(files)) {
        index[suffix] = content;
        index[`${suffix}.sha256`] = wrongDigest ?? digest(content);
      }
      writeFileSync(published, JSON.stringify(index));
      writeFileSync(asked, '');
    },
    // Every URL the installer asked for, in the order it asked.
    asked: () => readFileSync(asked, 'utf8').split('\n').filter(Boolean),
    // What the machine already has installed, if a case gives it an older one.
    installed: (build) => { mkdirSync(join(home, '.local/bin'), { recursive: true }); writeFileSync(join(home, '.local/bin/wangcai'), build, { mode: 0o755 }); },
    withEnvironment,
    install: () => withEnvironment(() => agentInstaller(join(home, 'data'), network).ssh('stub')),
    close: () => rmSync(home, { recursive: true, force: true }),
  };
};

// Runs a case on a stub machine with a storage of its own to install into; the machine and the storage are taken down
// after the case, passed or not. What the release answers is for the case to publish.
const withMachine = async (spec, body) => {
  const storage = directory();
  const stub = machine(spec);
  try { return await body({ ...stub, storage }); } finally {
    stub.close();
    rmSync(storage, { recursive: true, force: true });
  }
};

test('this machine gets the agent it runs from its release, once', () => withMachine({ platform: 'Darwin arm64' }, async ({ storage, withEnvironment, asked, publish }) => {
  publish({ [`/wangcai-${target}`]: released });
  assert.equal(await withEnvironment(() => agentInstaller(storage, {}).local()), join(storage, 'bin/wangcai'));
  assert.equal(readFileSync(join(storage, 'bin/wangcai'), 'utf8'), released);
  assert.equal(statSync(join(storage, 'bin/wangcai')).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(storage, 'bin')), ['wangcai']);
  assert.deepEqual(asked(), [`${release(target)}.sha256`, release(target)]);
  // The agent is already there, so a second run does not download it again.
  await withEnvironment(() => agentInstaller(storage, {}).local());
  assert.equal(asked().length, 2);
  // One that is a version behind is replaced, and the new one is the agent a run drives.
  writeFileSync(join(storage, 'bin/wangcai'), older, { mode: 0o755 });
  await withEnvironment(() => agentInstaller(storage, {}).local());
  assert.equal(readFileSync(join(storage, 'bin/wangcai'), 'utf8'), released);
  assert.equal(asked().length, 4);
  assert.deepEqual(readdirSync(join(storage, 'bin')), ['wangcai']);
}));

test('an agent from a development checkout is used as it stands', () => withMachine({ platform: 'Darwin arm64' }, async ({ storage, withEnvironment, asked, publish }) => {
  publish({});
  const built = join(storage, 'built-wangcai');
  writeFileSync(built, older, { mode: 0o755 });
  assert.equal(await withEnvironment(() => agentInstaller(storage, {}).local(), { WANGCAI_AGENT_SOURCE: built }), built);
  assert.deepEqual(asked(), []);
}));

test('a remote machine gets the agent for its platform, and only when the version differs', () => withMachine({ platform: 'Darwin arm64' }, async ({ home, install, asked, installed, publish }) => {
  publish({ '/wangcai-aarch64-apple-darwin': released });
  await install();
  assert.equal(readFileSync(join(home, '.local/bin/wangcai'), 'utf8'), released);
  assert.deepEqual(readdirSync(join(home, '.local/bin')), ['wangcai']);
  assert.deepEqual(asked(), [`${release('aarch64-apple-darwin')}.sha256`, release('aarch64-apple-darwin')]);
  await install();
  assert.equal(asked().length, 2);
  // The machine is a version behind, so the agent it runs is the one this Core drives.
  installed(older);
  await install();
  assert.equal(asked().length, 4);
}));

test('a machine that refuses the probe is left alone', () => withMachine({ platform: 'Darwin arm64' }, async ({ home, install, asked, publish }) => {
  publish({});
  writeFileSync(join(home, 'bin/ssh'), '#!/bin/sh\nexit 255\n');
  await install();
  assert.deepEqual(asked(), []);
  assert.ok(!existsSync(join(home, '.local/bin/wangcai')));
}));

test('a platform without a release fails before anything is downloaded', () => withMachine({ platform: 'FreeBSD amd64' }, async ({ home, install, asked, publish }) => {
  publish({});
  await assert.rejects(install(), /FreeBSD amd64 上暂不支持自动安装 agent/);
  assert.deepEqual(asked(), []);
  assert.ok(!existsSync(join(home, '.local/bin/wangcai')));
}));

test('a release that is not there fails with what the download answered', () => withMachine({ platform: 'Darwin arm64' }, async ({ home, install, publish }) => {
  publish({});
  await assert.rejects(install(), /下载 agent 失败：[\s\S]*404 Not Found/);
  assert.ok(!existsSync(join(home, '.local/bin/wangcai')));
}));

test('the download goes out through the mirror init.ts names', () => withMachine({ platform: 'Darwin arm64', network: { mirror: 'https://ghfast.top/' } }, async ({ home, install, asked, publish }) => {
  publish({ '/wangcai-aarch64-apple-darwin': released });
  await install();
  assert.equal(readFileSync(join(home, '.local/bin/wangcai'), 'utf8'), released);
  assert.deepEqual(asked(), [`https://ghfast.top/${release('aarch64-apple-darwin')}.sha256`, `https://ghfast.top/${release('aarch64-apple-darwin')}`]);
}));

test('a download that disagrees with the published digest is never installed', () => withMachine({ platform: 'Darwin arm64' }, async ({ home, install, publish }) => {
  // A mirror that answers the digest with its own error page, and one that publishes a digest of other bytes.
  publish({ '/wangcai-aarch64-apple-darwin': released }, '<!doctype html><title>502 Bad Gateway</title>');
  await assert.rejects(install(), /下载 agent 失败：[\s\S]*校验值不是 sha256/);
  publish({ '/wangcai-aarch64-apple-darwin': released }, digest('some other build'));
  await assert.rejects(install(), /下载 agent 失败：[\s\S]*sha256 不符/);
  assert.ok(!existsSync(join(home, '.local/bin/wangcai')));
}));
