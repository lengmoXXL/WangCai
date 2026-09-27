const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir, userInfo } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createServer } = require('node:net');
const { connect } = require('../sdk/dist/index.cjs');

async function until(check, diagnostic) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(50); }
  throw new Error(`Timed out: ${diagnostic()}`);
}

test('real OpenSSH forwarding discovers random node ports and reconnects', { timeout: 45000 }, async (t) => {
  const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find(existsSync);
  if (!sshd) { t.skip('OpenSSH server is not installed'); return; }
  const home = mkdtempSync(join(tmpdir(), 'wangcai-ssh-test-'));
  const binary = resolve('wangcaicli/dist/debug/wangcai');
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  const cli = (...args) => execFileSync(binary, ['server', ...args], { env, encoding: 'utf8', timeout: 15000 });
  let server;
  let connection;
  let logs = '';
  const originalPath = process.env.PATH;
  try {
    assert.throws(() => cli('status', '--json'), /not running/);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(home, 'host-key')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(home, 'client-key')]);
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const sshPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(home, 'start-command'), `#!/bin/sh\n[ "$SSH_ORIGINAL_COMMAND" = ${quote('export PATH="$HOME/.local/bin:$PATH"; wangcai server start --json')} ] || exit 64\nexec env HOME=${quote(home)} ${quote(binary)} server start --json\n`, { mode: 0o700 });
    writeFileSync(join(home, 'sshd_config'), [
      `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${join(home, 'host-key')}`,
      `PidFile ${join(home, 'sshd.pid')}`, `AuthorizedKeysFile ${join(home, 'client-key.pub')}`,
      'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
      'AllowTcpForwarding yes', 'PermitRootLogin yes', `ForceCommand ${join(home, 'start-command')}`,
    ].join('\n'));
    server = spawn(sshd, ['-D', '-e', '-f', join(home, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', (data) => { logs += data; });
    await delay(300);
    if (server.exitCode !== null) { t.skip(`Local sshd unavailable: ${logs.trim()}`); return; }
    writeFileSync(join(home, 'ssh_config'), [
      'Host wangcai-test', '  HostName 127.0.0.1', `  Port ${sshPort}`, `  User ${userInfo().username}`,
      `  IdentityFile ${join(home, 'client-key')}`, '  IdentitiesOnly yes', '  StrictHostKeyChecking yes',
      `  UserKnownHostsFile ${join(home, 'known_hosts')}`,
    ].join('\n'));
    writeFileSync(join(home, 'known_hosts'), `[127.0.0.1]:${sshPort} ${readFileSync(join(home, 'host-key.pub'), 'utf8')}`);
    // Inject only a private SSH config. All SSH transport is the real system client/server.
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin/ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(home, 'ssh_config'))} "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${join(home, 'bin')}:${originalPath}`;
    connection = await connect({ type: 'ssh', host: 'wangcai-test' });
    const info = JSON.parse(cli('status', '--json'));
    let state;
    connection.onState((value) => { state = value; });
    const localPort = Number(new URL(connection.ws.url).port);
    assert.ok(localPort > 0);
    assert.notEqual(localPort, info.port);
    const bytes = Buffer.from([0, 255, 1, 128, 10]);
    writeFileSync(join(home, 'remote.bin'), bytes);
    assert.deepEqual(Buffer.from(await connection.fs.readFile(join(home, 'remote.bin'))), bytes);
    assert.deepEqual(await connection.fs.stat(join(home, 'remote.bin')), { isDirectory: false });
    assert.deepEqual(await connection.fs.stat(home), { isDirectory: true });
    assert.equal(await connection.fs.stat(join(home, 'missing')), null);
    const { buildSync } = require('esbuild');
    const { Module } = require('node:module');
    const filePlugin = new Module(resolve('tests/files-main.cjs'));
    filePlugin.paths = module.paths;
    filePlugin._compile(buildSync({ entryPoints: ['plugins/files/main.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, resolve('tests/files-main.cjs'));
    const handlers = {};
    const disposeFiles = filePlugin.exports.activate({ handle: (name, handler) => { handlers[name] = handler; return () => {}; } });
    const remoteText = join(home, 'remote.md');
    writeFileSync(remoteText, '# Remote Markdown\n');
    try {
      const directory = await handlers.list({ machine: { host: 'wangcai-test' }, path: home });
      assert.equal(directory.path, home);
      assert.ok(directory.entries.some(entry => entry.name === 'remote.md' && !entry.isDirectory));
      assert.equal(await handlers.read({ machine: { id: 'remote', name: 'Remote', host: 'wangcai-test' }, path: remoteText }), '# Remote Markdown\n');
      await assert.rejects(handlers.read({ machine: { host: 'wangcai-test' }, path: join(home, 'remote.bin') }), /二进制/);
    } finally { disposeFiles(); }
    const session = await connection.pty.create();
    let terminal = await connection.pty.attach(session.id);
    const repository = join(home, "repo with 'quote");
    mkdirSync(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'SSH Test'); git('config', 'user.email', 'ssh@test.local');
    writeFileSync(join(repository, 'remote.txt'), 'before SSH\n'); git('add', '.'); git('commit', '-qm', 'remote commit');
    writeFileSync(join(repository, 'remote.txt'), 'after SSH\n');
    const gitPlugin = new Module(resolve('tests/git-main.cjs'));
    gitPlugin.paths = module.paths;
    gitPlugin._compile(buildSync({ entryPoints: ['plugins/git/main.ts'], bundle: true, platform: 'node', packages: 'external', write: false }).outputFiles[0].text, resolve('tests/git-main.cjs'));
    const gitHandlers = {};
    const disposeGit = gitPlugin.exports.activate({ handle: (name, handler) => { gitHandlers[name] = handler; return () => {}; } });
    const target = { machine: { id: 'remote', name: 'Remote', host: 'wangcai-test' }, sessionId: session.id };
    const cwdOutput = [];
    const off = terminal.onData(event => cwdOutput.push(Buffer.from(event.data).toString()));
    await terminal.write(`cd ${quote(repository)}; printf 'GIT_%s\\n' ready\r`);
    await until(() => cwdOutput.join('').includes('GIT_ready'), () => 'remote Git cwd');
    off();
    try {
      const overview = await gitHandlers.overview({ terminal: target });
      assert.equal(overview.commits[0].subject, 'remote commit');
      assert.equal(overview.changes[0].path, 'remote.txt');
      const files = await gitHandlers.files({ terminal: target, root: overview.root, rev: overview.head });
      assert.equal(files[0].status, 'A');
      const diff = await gitHandlers.diff({ terminal: target, root: overview.root, comparison: { path: 'remote.txt', status: 'M', source: 'unstaged' } });
      assert.equal(diff.oldText, 'before SSH\n'); assert.equal(diff.newText, 'after SSH\n');
    } finally { disposeGit(); }
    await terminal.write("sleep 0.3; printf 'SSH_%s\\n' survived\r");
    connection.disconnect();
    await delay(500);
    connection = await connect({ type: 'ssh', host: 'wangcai-test' });
    connection.onState((value) => { state = value; });
    assert.equal(state.sessions[0].id, session.id);
    terminal = await connection.pty.attach(session.id);
    const snapshots = [];
    terminal.onSnapshot((event) => snapshots.push(Buffer.from(event.data).toString()));
    await until(() => snapshots.some((text) => text.includes('SSH_survived')), () => 'remote snapshot');
    const errors = [];
    terminal.onError((error) => errors.push(error.message));
    connection.tunnel.kill();
    const beforeReconnect = state.generation;
    await until(() => state.status === 'connected' && state.generation > beforeReconnect, () => state.error);
    await terminal.write("printf 'REATTACH_%s\\n' ok\r");
    const output = [];
    terminal.onData((event) => output.push(Buffer.from(event.data).toString()));
    await until(() => output.join('').includes('REATTACH_ok'), () => 'automatic reattach');
    const generation = state.generation;
    cli('stop');
    await until(() => state?.status === 'connected' && state.generation > generation, () => state?.error);
    const restarted = JSON.parse(cli('status', '--json'));
    assert.notEqual(restarted.instance_id, info.instance_id);
    assert.deepEqual(state.sessions, []);
    assert.match(errors[0], /restarted/);
    await assert.rejects(terminal.write('oops'), /restarted/);
  } finally {
    connection?.disconnect();
    process.env.PATH = originalPath;
    server?.kill();
    try { cli('stop'); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
