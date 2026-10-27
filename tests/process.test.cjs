const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { openMachine } = require('../sdk/dist/index.cjs');
const binary = resolve('wangcaicli/dist/debug/wangcai');

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error('Timed out waiting for process output');
}

function running(pid) {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); }
  catch { return false; }
}

// Answers with READY once it has read something, then echoes every write to both pipes. The first
// answer has to follow a write, so nothing the node drops before a client attaches can be missed.
const ECHO = "let first = true; process.stdin.on('data', (chunk) => { if (first) { first = false; process.stdout.write('READY'); } process.stdout.write(chunk); process.stderr.write(chunk); });";

test('SDK process: streaming pipes, binary writes, exit codes, cleanup and reconnect', { timeout: 120000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-process-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.WANGCAI_HOME = '';
  let machine;
  try {
    machine = await openMachine({ type: 'local', binary });
    const info = await machine.subprocess.spawn(process.execPath, ['-e', ECHO], { cwd: home });
    assert.equal(info.exit_code, null);
    assert.ok(info.pid > 0);
    // A process is not a terminal: it stays out of the session list the app draws workspaces from.
    assert.deepEqual(await machine.pty.list(), []);
    await assert.rejects(machine.subprocess.attach(join(home, 'absent')), /Process no longer exists/);
    await assert.rejects(machine.subprocess.spawn(process.execPath, [], { cwd: 'relative' }), /absolute/);
    await assert.rejects(machine.subprocess.spawn(process.execPath, [], { cwd: join(home, 'absent') }), /Not a directory/);
    await assert.rejects(machine.subprocess.spawn(join(home, 'absent'), [], { cwd: home }), /Cannot start/);

    const inEnv = await machine.subprocess.spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.stdout.write(process.env.SDK_TEST ?? 'missing'))"], { cwd: home, env: { SDK_TEST: 'custom' } });
    const envHandle = await machine.subprocess.attach(inEnv.id);
    const printed = [];
    envHandle.onData((event) => printed.push(Buffer.from(event.data)));
    await envHandle.write(Buffer.from('go'));
    await until(() => Buffer.concat(printed).toString() === 'custom');
    await machine.subprocess.close(inEnv.id);

    const handle = await machine.subprocess.attach(info.id);
    const stdout = [];
    const stderr = [];
    handle.onData((event) => (event.stream === 'stdout' ? stdout : stderr).push(Buffer.from(event.data)));
    await handle.write(Buffer.from('ping'));
    // Both pipes are separate, so the marks are taken once each of them has the answer it was given.
    await until(() => Buffer.concat(stdout).toString() === 'READYping' && Buffer.concat(stderr).toString() === 'ping');
    const stdoutMark = Buffer.concat(stdout).length;
    const stderrMark = Buffer.concat(stderr).length;
    const pattern = Buffer.alloc(256 * 1024, 0);
    for (let index = 0; index < pattern.length; index++) pattern[index] = index % 251;
    await handle.write(pattern);
    await until(() => Buffer.concat(stdout).length === stdoutMark + pattern.length && Buffer.concat(stderr).length === stderrMark + pattern.length);
    assert.deepEqual(Buffer.concat(stdout).subarray(stdoutMark), pattern);
    assert.deepEqual(Buffer.concat(stderr).subarray(stderrMark), pattern);
    const opaque = Buffer.from([0, 255, 128, 13, 10, 3, 4]);
    await handle.write(opaque);
    await until(() => Buffer.concat(stdout).length === stdoutMark + pattern.length + opaque.length && Buffer.concat(stderr).length === stderrMark + pattern.length + opaque.length);
    assert.deepEqual(Buffer.concat(stdout).subarray(stdoutMark + pattern.length), opaque);
    assert.deepEqual(Buffer.concat(stderr).subarray(stderrMark + pattern.length), opaque);

    await machine.subprocess.close(info.id);

    const ending = await machine.subprocess.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 50)'], { cwd: home });
    const exited = await machine.subprocess.attach(ending.id);
    const code = await new Promise((resolve) => exited.onExit(resolve));
    assert.equal(code, 7);
    await assert.rejects(exited.write(Buffer.from('late')), /Process has exited/);
    await machine.subprocess.close(ending.id);

    // The pipes outlive the process, since a helper it leaves behind can still write to them: that output is delivered
    // although the exit event has already gone past.
    const shell = await machine.subprocess.spawn('/bin/sh', ['-c', 'read x; (sleep 0.3; printf tail) & exit 0'], { cwd: home });
    const attached = await machine.subprocess.attach(shell.id);
    const tail = [];
    attached.onData((event) => { if (event.stream === 'stdout') tail.push(Buffer.from(event.data)); });
    await attached.write(Buffer.from('go\n'));
    await until(() => Buffer.concat(tail).toString() === 'tail');
    await machine.subprocess.close(shell.id);

    // Closing a process kills the helpers it started, which its own process group holds.
    const pidFile = join(home, 'pids');
    const group = await machine.subprocess.spawn('/bin/sh', ['-c', 'sleep 60 & echo "$$ $!" > "$1"; wait', 'sh', pidFile], { cwd: home });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
    const pids = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
    await machine.subprocess.close(group.id);
    await until(() => pids.every((pid) => !running(pid)));
    await assert.rejects(machine.subprocess.attach(group.id), /Process no longer exists/);

    // The node owns the process, so a window that reconnects finds it still running.
    const kept = await machine.subprocess.spawn(process.execPath, ['-e', ECHO], { cwd: home });
    const before = await machine.subprocess.attach(kept.id);
    const seen = [];
    before.onData((event) => { if (event.stream === 'stdout') seen.push(Buffer.from(event.data)); });
    await before.write(Buffer.from('one'));
    await until(() => Buffer.concat(seen).toString() === 'READYone');
    machine.disconnect();
    machine = await openMachine({ type: 'local', binary });
    const restored = await machine.subprocess.attach(kept.id);
    const again = [];
    restored.onData((event) => { if (event.stream === 'stdout') again.push(Buffer.from(event.data)); });
    await restored.write(Buffer.from('two'));
    await until(() => Buffer.concat(again).toString() === 'two');
    await assert.rejects(before.write(Buffer.from('detached')), /detached/);
    await machine.subprocess.close(kept.id);
    await assert.rejects(machine.subprocess.attach(kept.id), /Process no longer exists/);

    // Stopping the node ends its children before the node itself goes.
    const child = await machine.subprocess.spawn('/bin/sh', ['-c', 'sleep 60'], { cwd: home });
    assert.ok(running(child.pid));
    machine.disconnect();
    execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' });
    await until(() => !running(child.pid));
  } finally {
    machine?.disconnect();
    try { execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' }); } catch {}
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// A process that writes everything it has before it reads anything: a node that writes stdin under the
// lock its output forwarder needs deadlocks here, losing the client's write to its timeout.
test('SDK process: a slow reader does not stall the output it is producing', { timeout: 120000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-slow-reader-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.WANGCAI_HOME = '';
  const size = 512 * 1024;
  let machine;
  try {
    machine = await openMachine({ type: 'local', binary });
    const script = `process.stdout.write(Buffer.alloc(${size}, 7), () => {
      let read = 0;
      process.stdin.on('data', (chunk) => {
        read += chunk.length;
        if (read >= ${size}) process.stdout.write('GOT ' + read);
      });
    });`;
    const info = await machine.subprocess.spawn(process.execPath, ['-e', script], { cwd: home });
    const handle = await machine.subprocess.attach(info.id);
    const stdout = [];
    handle.onData((event) => { if (event.stream === 'stdout') stdout.push(Buffer.from(event.data)); });
    await handle.write(Buffer.alloc(size, 5));
    await until(() => Buffer.concat(stdout).includes(`GOT ${size}`));
    await machine.subprocess.close(info.id);
  } finally {
    machine?.disconnect();
    try { execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' }); } catch {}
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
