const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const binary = resolve('wangcaicli/dist/debug/wangcai');
async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out waiting for ${message}`);
}

class Client {
  pending = new Map();
  events = [];
  terminals = new Map();
  writes = Promise.resolve();
  serial = 0;
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data, binary) => {
      if (binary) {
        const length = data.readUInt32BE(0);
        const event = JSON.parse(data.subarray(4, 4 + length));
        event.data = data.subarray(4 + length);
        this.events.push(event);
        this.writes = this.writes.then(() => new Promise((resolve) => {
          let term = this.terminals.get(event.session_id);
          if (!term) { term = new Terminal({ cols: event.cols, rows: event.rows, allowProposedApi: true, scrollback: 10000 }); this.terminals.set(event.session_id, term); }
          if (event.event === 'snapshot') { term.reset(); term.resize(event.cols, event.rows); }
          term.write(event.data, resolve);
        }));
      } else {
        const event = JSON.parse(data);
        if (event.id) {
          const pending = this.pending.get(event.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(event.id);
          event.error ? pending.reject(new Error(event.error)) : pending.resolve(event.result);
        } else this.events.push(event);
      }
    });
    this.ws.on('error', () => {});
  }
  async connect() { await once(this.ws, 'open'); return this; }
  rpc(op, params = {}) {
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op} timed out`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, op, ...params }));
    });
  }
  raw(id) { return this.events.filter((e) => e.session_id === id && e.data).map((e) => e.data.toString()).join(''); }
  async text(id) {
    await this.writes;
    const buffer = this.terminals.get(id)?.buffer.active;
    return buffer ? Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true)).join('\n') : '';
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, 'close'); this.ws.close(); await closed;
    await this.writes;
    for (const term of this.terminals.values()) term.dispose();
  }
}

test('persistent terminal node lifecycle', { timeout: 150000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-node-test-'));
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  const cli = (...args) => execFileSync(binary, ['server', ...args], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  try {
    assert.throws(() => cli('status', '--json'), /not running/);
    assert.equal(existsSync(join(home, '.local/share/wangcai/server.json')), false);
    mkdirSync(join(home, '.local/share/wangcai'), { recursive: true });
    writeFileSync(join(home, '.local/share/wangcai/server.json'), JSON.stringify({ pid: 1, port: 1, instance_id: 'stale', protocol: 1 }));
    const started = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(binary, ['server', 'start', '--json'], { env, timeout: 30000 })));
    const info = JSON.parse(started[0].stdout);
    for (const result of started) assert.deepEqual(JSON.parse(result.stdout), info);
    assert.deepEqual(JSON.parse(cli('start', '--json')), info);
    assert.ok(info.port > 0);
    assert.equal(info.protocol, 1);
    assert.match(cli('start'), /already running/);
    assert.equal(JSON.parse(cli('status', '--json')).instance_id, info.instance_id);
    const client = await new Client(info.port).connect(); clients.push(client);
    let first;
    await t.test('multiple PTYs preserve cwd, environment, Unicode and isolation', async () => {
      first = await client.rpc('create', { rows: 24, cols: 80 });
      const second = await client.rpc('create', { rows: 24, cols: 80 });
      await client.rpc('attach', { session_id: first.id });
      await client.rpc('attach', { session_id: second.id });
      await client.rpc('input', { session_id: first.id, data: "export WANGCAI_TEST=kept; cd /tmp; printf '你好_%s_%s\\n' \"$WANGCAI_TEST\" \"$PWD\"\r" });
      await until(async () => (await client.text(first.id)).includes('你好_kept_/tmp'), 'Unicode output');
      assert.ok(!(await client.text(second.id)).includes('你好_kept_/tmp'));
      await client.rpc('input', { session_id: second.id, data: "printf '\\033[?1049h\\033[2J\\033[H\\033[32mALT_SCREEN\\033[?2004h'; sleep 10\r" });
      await until(async () => (await client.text(second.id)).includes('ALT_SCREEN'), 'alternate screen');
      await client.rpc('detach', { session_id: second.id });
      const observer = await new Client(info.port).connect(); clients.push(observer);
      await observer.rpc('attach', { session_id: second.id });
      await until(async () => (await observer.text(second.id)).includes('ALT_SCREEN'), 'alternate snapshot');
      await observer.writes;
      assert.equal(observer.terminals.get(second.id).buffer.active.type, 'alternate');
      assert.equal(observer.terminals.get(second.id).modes.bracketedPasteMode, true);
      await observer.rpc('input', { session_id: second.id, data: '\x03' });
      await observer.rpc('input', { session_id: second.id, data: "printf '\\033[?1049l'\r" });
      await until(() => observer.terminals.get(second.id)?.buffer.active.type === 'normal', 'normal screen restored');
      await observer.rpc('close', { session_id: second.id });
      assert.equal((await client.rpc('list')).length, 1);
    });
    await t.test('ownership and dimensions are enforced', async () => {
      const other = await new Client(info.port).connect(); clients.push(other);
      await assert.rejects(other.rpc('attach', { session_id: first.id }), /another client/);
      await assert.rejects(other.rpc('input', { session_id: first.id, data: 'oops' }), /Attach/);
      await client.rpc('resize', { session_id: first.id, rows: 31, cols: 101 });
      await client.rpc('input', { session_id: first.id, data: 'stty size\r' });
      await until(() => client.raw(first.id).includes('31 101'), 'PTY resize');
      await assert.rejects(client.rpc('resize', { session_id: first.id, rows: 0, cols: 99999 }), /size/);
    });
    await t.test('process and output survive disconnect without replaying input', async () => {
      await client.rpc('input', { session_id: first.id, data: "sleep 0.4; printf 'OFFLINE_%s\\n' \"$WANGCAI_TEST\"\r" });
      await client.close();
      await delay(800);
      const reconnect = await new Client(info.port).connect(); clients.push(reconnect);
      await reconnect.rpc('attach', { session_id: first.id });
      await until(async () => (await reconnect.text(first.id)).includes('OFFLINE_kept'), 'offline output in snapshot');
      assert.equal((await reconnect.rpc('list'))[0].pid, first.pid);
      await reconnect.rpc('input', { session_id: first.id, data: "for i in {1..70}; do printf 'history_%s\\n' \"$i\"; done\r" });
      await until(() => reconnect.raw(first.id).includes('history_70'), 'history output');
      await reconnect.rpc('detach', { session_id: first.id });
      const history = await new Client(info.port).connect(); clients.push(history);
      await history.rpc('attach', { session_id: first.id });
      await until(async () => (await history.text(first.id)).includes('history_1\n'), 'scrollback restored');
      const packets = history.events.filter((e) => e.session_id === first.id && e.seq !== undefined);
      assert.equal(packets[0].event, 'snapshot');
      for (let i = 1; i < packets.length; i++) assert.ok(packets[i].seq > packets[i - 1].seq);
      await history.rpc('input', { session_id: first.id, data: 'exit 7\r' });
      await until(async () => (await history.rpc('list'))[0]?.exit_code === 7, 'exit status');
      await history.rpc('close', { session_id: first.id });
      assert.deepEqual(await history.rpc('list'), []);
    });
    await t.test('closing a terminal kills shell and background descendants', async () => {
      const owner = await new Client(info.port).connect(); clients.push(owner);
      const session = await owner.rpc('create');
      await owner.rpc('attach', { session_id: session.id });
      const pidFile = join(home, 'background.pid');
      await owner.rpc('input', { session_id: session.id, data: `sleep 60 & echo $! > '${pidFile}'\r` });
      let pid;
      await until(() => { try { pid = Number(readFileSync(pidFile, 'utf8')); return pid > 0; } catch { return false; } }, 'background pid');
      await owner.rpc('close', { session_id: session.id });
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'background cleanup');
      await until(() => { try { process.kill(session.pid, 0); return false; } catch { return true; } }, 'shell cleanup');
    });
    await t.test('instance identity, stop and restart', async () => {
      await assert.rejects(clients.at(-1).rpc('stop', { instance_id: 'wrong' }), /instance/);
      cli('stop');
      assert.throws(() => cli('status', '--json'));
      cli('start');
      const restarted = JSON.parse(cli('status', '--json'));
      assert.notEqual(restarted.instance_id, info.instance_id);
      const fresh = await new Client(restarted.port).connect(); clients.push(fresh);
      assert.deepEqual(await fresh.rpc('list'), []);
    });
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    try { cli('stop'); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
