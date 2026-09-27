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
  const home = mkdtempSync(join(tmpdir(), 'shu-ssh-test-'));
  const binary = resolve('target/debug/shu');
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  const cli = (...args) => execFileSync(binary, ['server', ...args], { env, encoding: 'utf8', timeout: 15000 });
  let server;
  let connection;
  let logs = '';
  const originalPath = process.env.PATH;
  try {
    cli('start');
    const info = JSON.parse(cli('status', '--json'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(home, 'host-key')]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(home, 'client-key')]);
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const sshPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(home, 'status-command'), `#!/bin/sh\nexec env HOME=${quote(home)} ${quote(binary)} server status --json\n`, { mode: 0o700 });
    writeFileSync(join(home, 'sshd_config'), [
      `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${join(home, 'host-key')}`,
      `PidFile ${join(home, 'sshd.pid')}`, `AuthorizedKeysFile ${join(home, 'client-key.pub')}`,
      'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
      'AllowTcpForwarding yes', 'PermitRootLogin yes', `ForceCommand ${join(home, 'status-command')}`,
    ].join('\n'));
    server = spawn(sshd, ['-D', '-e', '-f', join(home, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', (data) => { logs += data; });
    await delay(300);
    if (server.exitCode !== null) { t.skip(`Local sshd unavailable: ${logs.trim()}`); return; }
    writeFileSync(join(home, 'ssh_config'), [
      'Host shu-test', '  HostName 127.0.0.1', `  Port ${sshPort}`, `  User ${userInfo().username}`,
      `  IdentityFile ${join(home, 'client-key')}`, '  IdentitiesOnly yes', '  StrictHostKeyChecking yes',
      `  UserKnownHostsFile ${join(home, 'known_hosts')}`,
    ].join('\n'));
    writeFileSync(join(home, 'known_hosts'), `[127.0.0.1]:${sshPort} ${readFileSync(join(home, 'host-key.pub'), 'utf8')}`);
    // Inject only a private SSH config. All SSH transport is the real system client/server.
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin/ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(home, 'ssh_config'))} "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${join(home, 'bin')}:${originalPath}`;
    connection = await connect({ type: 'ssh', host: 'shu-test' });
    let state;
    connection.onState((value) => { state = value; });
    const localPort = Number(new URL(connection.ws.url).port);
    assert.ok(localPort > 0);
    assert.notEqual(localPort, info.port);
    const bytes = Buffer.from([0, 255, 1, 128, 10]);
    writeFileSync(join(home, 'remote.bin'), bytes);
    assert.deepEqual(Buffer.from(await connection.fs.readFile(join(home, 'remote.bin'))), bytes);
    const session = await connection.pty.create();
    let terminal = await connection.pty.attach(session.id);
    await terminal.write("sleep 0.3; printf 'SSH_%s\\n' survived\r");
    connection.disconnect();
    await delay(500);
    connection = await connect({ type: 'ssh', host: 'shu-test' });
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
    cli('start');
    const restarted = JSON.parse(cli('status', '--json'));
    assert.notEqual(restarted.instance_id, info.instance_id);
    await until(() => state?.status === 'connected' && state.generation > generation, () => state?.error);
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
