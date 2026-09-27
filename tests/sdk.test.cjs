const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { connect } = require('../sdk/dist/index.cjs');

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error('Timed out waiting for SDK output');
}

test('Node SDK: local PTYs, binary files, detach and reconnect', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'shu-sdk-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const binary = resolve('node/dist/debug/shu');
  let machine;
  try {
    await assert.rejects(connect({ type: 'local', binary: join(home, 'absent') }), /ENOENT/);
    const abort = new AbortController();
    const opening = connect({ type: 'local', binary, signal: abort.signal });
    abort.abort();
    await assert.rejects(opening, /cancelled/);
    machine = await connect({ type: 'local', binary });
    assert.equal(machine.state.status, 'connected');
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    const path = join(home, 'binary');
    writeFileSync(path, bytes);
    assert.deepEqual(Buffer.from(await machine.fs.readFile(path)), bytes);
    await assert.rejects(machine.fs.readFile(join(home, 'missing')), /No such file/);
    await assert.rejects(machine.fs.readFile('relative'), /absolute/);
    const session = await machine.pty.create({ rows: 25, cols: 90 });
    const terminal = await machine.pty.attach(session.id);
    const output = [];
    terminal.onSnapshot((event) => { assert.equal(event.cols, 90); output.push(Buffer.from(event.data).toString()); });
    terminal.onData((event) => output.push(Buffer.from(event.data).toString()));
    await terminal.write("printf 'SDK_%s\\n' success\r");
    await until(() => output.join('').includes('SDK_success'));
    await terminal.resize({ rows: 30, cols: 100 });
    assert.equal((await machine.pty.list())[0].cols, 100);
    await terminal.write("sleep 0.3; printf 'SDK_%s\\n' offline\r");
    await terminal.detach();
    const next = await machine.pty.attach(session.id);
    await terminal.detach();
    await next.resize({ rows: 30, cols: 100 });
    machine.disconnect();
    await delay(500);
    machine = await connect({ type: 'local', binary });
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
