const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { connect } = require('../sdk/dist/index.cjs');

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error('Timed out waiting for subprocess cleanup');
}

function running(pid) {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); }
  catch { return false; }
}

test('SDK subprocess: binary output, argv, cwd, environment, limits and cancellation', { timeout: 150000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-subprocess-')));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.WANGCAI_HOME = '';
  const binary = resolve('wangcaicli/dist/debug/wangcai');
  let machine;
  try {
    machine = await connect({ type: 'local', binary });
    const cwd = join(home, "directory with 'quote");
    mkdirSync(cwd);
    const literal = "$(touch unwanted); 'quoted'\nargument";
    const info = await machine.subprocess.exec(process.execPath, ['-e', 'console.log(JSON.stringify({ cwd: process.cwd(), arg: process.argv[1], env: process.env.SDK_TEST }))', literal], { cwd, env: { SDK_TEST: 'custom' } });
    assert.equal(info.code, 0);
    assert.deepEqual(JSON.parse(Buffer.from(info.stdout).toString()), { cwd, arg: literal, env: 'custom' });
    assert.equal(existsSync(join(cwd, 'unwanted')), false);
    const bytes = await machine.subprocess.exec(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0, 255, 128])); process.stderr.write(Buffer.from([254, 0])); process.exitCode = 7'], { cwd });
    assert.equal(bytes.code, 7);
    assert.deepEqual(Buffer.from(bytes.stdout), Buffer.from([0, 255, 128]));
    assert.deepEqual(Buffer.from(bytes.stderr), Buffer.from([254, 0]));
    await assert.rejects(machine.subprocess.exec(join(home, 'absent'), [], { cwd }), /Cannot start/);
    await assert.rejects(machine.subprocess.exec(process.execPath, [], { cwd: 'relative' }), /absolute/);
    for (const stream of ['stdout', 'stderr']) {
      await assert.rejects(machine.subprocess.exec(process.execPath, ['-e', `process.${stream}.write(Buffer.alloc(8 * 1024 * 1024 + 1)); setInterval(() => {}, 1000)`], { cwd }), /exceeds 8 MiB/);
    }
    const pidFile = join(home, 'timeout-pids');
    const timedOut = assert.rejects(machine.subprocess.exec('/bin/sh', ['-c', 'sleep 60 & echo "$$ $!" > "$1"; wait', 'sh', pidFile], { cwd }), /Process timed out/);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
    const pids = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
    assert.deepEqual(await machine.pty.list(), []);
    const concurrent = await machine.subprocess.exec('/bin/echo', ['still responsive'], { cwd });
    assert.equal(Buffer.from(concurrent.stdout).toString(), 'still responsive\n');
    await timedOut;
    await until(() => pids.every(pid => !running(pid)));
    const cancelledFile = join(home, 'cancelled-pids');
    const cancelled = assert.rejects(machine.subprocess.exec('/bin/sh', ['-c', 'sleep 60 & echo "$$ $!" > "$1"; wait', 'sh', cancelledFile], { cwd }), /Connection lost/);
    await until(() => existsSync(cancelledFile) && readFileSync(cancelledFile, 'utf8').trim());
    const cancelledPids = readFileSync(cancelledFile, 'utf8').trim().split(' ').map(Number);
    machine.disconnect();
    await cancelled;
    await until(() => cancelledPids.every(pid => !running(pid)));
  } finally {
    machine?.disconnect();
    try { execFileSync(binary, ['server', 'stop'], { stdio: 'ignore' }); } catch {}
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
