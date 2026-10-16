const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { openMachine, agentCommand } = require('../sdk/dist/index.cjs');

async function until(check, message = 'SDK output') {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error(`Timed out waiting for ${message}`);
}

test('the command the SDK runs on a machine carries the home a development profile uses', () => {
  process.env.WANGCAI_HOME = "/tmp/a b'c";
  assert.equal(agentCommand('wangcai server start --json'), "export WANGCAI_HOME='/tmp/a b'\\''c'; export PATH=\"$HOME/.local/bin:$PATH\"; wangcai server start --json");
});

test('Node SDK: local PTYs, binary files, file watches, detach and reconnect', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-sdk-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.WANGCAI_HOME = '';
  const binary = resolve('wangcaicli/dist/debug/wangcai');
  let machine;
  try {
    await assert.rejects(openMachine({ type: 'local', binary: join(home, 'absent') }), /ENOENT/);
    const abort = new AbortController();
    const opening = openMachine({ type: 'local', binary, signal: abort.signal });
    abort.abort();
    await assert.rejects(opening, /cancelled/);
    machine = await openMachine({ type: 'local', binary });
    assert.equal(machine.state.status, 'connected');
    assert.deepEqual(await machine.pty.list(), []);
    machine.disconnect();
    assert.equal(machine.state.status, 'disconnected');
    machine = await openMachine({ type: 'local', binary });
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    const path = join(home, 'binary');
    writeFileSync(path, bytes);
    assert.deepEqual(Buffer.from(await machine.fs.readFile(path)), bytes);
    assert.deepEqual(await machine.fs.stat(path), { isDirectory: false });
    assert.deepEqual(await machine.fs.stat(home), { isDirectory: true });
    assert.equal(await machine.fs.stat(join(path, "child")), null);
    assert.equal(await machine.fs.stat(join(home, 'missing')), null);
    await assert.rejects(machine.fs.stat('relative'), /absolute/);
    await assert.rejects(machine.fs.readFile(join(home, 'missing')), /No such file/);
    await assert.rejects(machine.fs.readFile('relative'), /absolute/);
    mkdirSync(join(home, 'folder'));
    writeFileSync(join(home, '.hidden'), 'hidden');
    symlinkSync(join(home, 'folder'), join(home, 'linked-folder'));
    assert.deepEqual(await machine.fs.stat(join(home, 'linked-folder')), { isDirectory: true });
    const entries = await machine.fs.readDirectory(home);
    assert.ok(entries.some(entry => entry.name === 'folder' && entry.isDirectory));
    assert.ok(entries.some(entry => entry.name === 'linked-folder' && entry.isDirectory));
    assert.ok(entries.some(entry => entry.name === '.hidden' && !entry.isDirectory));
    assert.ok(entries.some(entry => entry.name === 'binary' && !entry.isDirectory));
    await assert.rejects(machine.fs.readDirectory('relative'), /absolute/);
    await assert.rejects(machine.fs.readDirectory(path), /Not a directory/);
    const watched = join(home, 'watched');
    mkdirSync(watched);
    const batches = [];
    const mentioned = (file) => batches.some((batch) => [...batch.created, ...batch.modified, ...batch.removed].includes(file));
    const close = await machine.fs.watch(watched, { recursive: true }, (changes) => batches.push(changes));
    await assert.rejects(machine.fs.watch('relative', {}, () => {}), /absolute/);
    await assert.rejects(machine.fs.watch(join(home, 'missing'), {}, () => {}), /does not exist/);
    writeFileSync(join(watched, 'one.txt'), 'one');
    await until(() => mentioned(join(watched, 'one.txt')), 'the file written under the watched path');
    // A node that restarts under the connection is followed by the watch it was holding.
    const generation = machine.state.generation;
    execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' });
    await until(() => machine.state.generation > generation, 'a reconnect to the restarted node');
    writeFileSync(join(watched, 'two.txt'), 'two');
    await until(() => mentioned(join(watched, 'two.txt')), 'the file written after the restart');
    close();
    batches.length = 0;
    writeFileSync(join(watched, 'three.txt'), 'three');
    await delay(600);
    assert.deepEqual(batches, []);
    const session = await machine.pty.create({ rows: 25, cols: 90 });
    const terminal = await machine.pty.attach(session.id);
    const output = [];
    terminal.onSnapshot((event) => { assert.equal(event.cols, 90); output.push(Buffer.from(event.data).toString()); });
    terminal.onData((event) => output.push(Buffer.from(event.data).toString()));
    await terminal.write("printf 'SDK_%s\\n' success\r");
    await until(() => output.join('').includes('SDK_success'));
    assert.equal(await machine.pty.cwd(session.id), realpathSync(home));
    await terminal.write("cd /tmp; printf 'CWD_%s\\n' changed\r");
    await until(() => output.join('').includes('CWD_changed'));
    assert.equal(await machine.pty.cwd(session.id), realpathSync('/tmp'));
    await terminal.resize({ rows: 30, cols: 100 });
    assert.equal((await machine.pty.list())[0].cols, 100);
    await terminal.write("sleep 0.3; printf 'SDK_%s\\n' offline\r");
    await terminal.detach();
    const next = await machine.pty.attach(session.id);
    await terminal.detach();
    await next.resize({ rows: 30, cols: 100 });
    machine.disconnect();
    await delay(500);
    machine = await openMachine({ type: 'local', binary });
    const restored = await machine.pty.attach(session.id);
    let snapshot = '';
    restored.onSnapshot((event) => { snapshot = Buffer.from(event.data).toString(); });
    await until(() => snapshot.includes('SDK_offline'));
    await machine.pty.close(session.id);
    assert.deepEqual(await machine.pty.list(), []);
    await assert.rejects(restored.write('oops'), /detached/);
  } finally {
    machine?.disconnect();
    try { execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' }); } catch {}
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
