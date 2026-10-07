// Stop the terminal nodes the tests started. Their HOME is a temporary directory, which is what
// separates them from the node that serves the app the user is running.
const { execFileSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');

// macOS reports the same temporary directory with and without the /private prefix.
const roots = [tmpdir(), realpathSync(tmpdir())];
const pids = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .filter((line) => line.includes('server start'))
  .map((line) => Number(line.trim().split(/\s+/)[0]));

let reaped = 0;
for (const pid of pids) {
  // A node that just finished on its own can leave the listing before its HOME is read, or die before the signal lands.
  try {
    const home = /(?:^|\s)HOME=(\S+)/.exec(execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' }))?.[1];
    if (!roots.some((root) => home?.startsWith(`${root}/wangcai-`))) continue;
    process.kill(pid, 'SIGTERM');
    reaped += 1;
  } catch {}
}
if (reaped) console.log(`reaped ${reaped} test terminal node(s)`);
