const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execFile } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, realpathSync, cpSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const compiled = new Module('git-reader');
compiled._compile(buildSync({ entryPoints: ['plugins/git/git.ts'], bundle: true, platform: 'node', write: false }).outputFiles[0].text, 'git-reader.cjs');
const { readGit } = compiled.exports;
const run = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', ['--no-pager', '--literal-pathspecs', '-C', cwd, ...args], { encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') { reject(error); return; }
    resolve({ stdout, stderr: stderr.toString(), code: error ? error.code : 0 });
  });
});

test('Git plugin builds outside the source tree without config warnings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wangcai-git-config-'));
  try {
    const plugin = join(directory, 'plugins/git');
    cpSync('plugins/git', plugin, { recursive: true, filter: path => path !== join('plugins/git', 'node_modules') });
    for (const [platform, entries] of [['node', ['main.ts']], ['browser', ['ui.tsx', 'ui.worker.ts']]]) {
      const result = buildSync({
        entryPoints: entries.map(entry => join(plugin, entry)), outdir: join(directory, 'out'),
        bundle: true, packages: 'external', platform, format: platform === 'browser' ? 'esm' : undefined, write: false,
      });
      assert.deepEqual(result.warnings, []);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Git reader: history, stages, renames, binary, pagination and read-only queries', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wangcai-git-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const read = (method, query = {}, cwd = root) => readGit(method, cwd, query, run, readFile);
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Git Test'); git('config', 'user.email', 'git@test.local');
    assert.equal((await read('overview')).commits.length, 0);
    writeFileSync(join(root, 'a.ts'), 'const value = 1;\n');
    git('add', '.');
    assert.equal((await read('diff', { comparison: { path: 'a.ts', status: 'A', source: 'staged' } })).oldText, '');
    git('commit', '-qm', 'initial');
    const initial = git('rev-parse', 'HEAD');
    const initialFiles = await read('files', { rev: initial });
    assert.deepEqual(initialFiles, [{ path: 'a.ts', status: 'A' }]);
    assert.equal((await read('diff', { comparison: { ...initialFiles[0], source: 'commit', rev: initial } })).newText, 'const value = 1;\n');
    mkdirSync(join(root, 'nested'));
    const renamed = "nested/new 'name\n.ts";
    renameSync(join(root, 'a.ts'), join(root, renamed)); git('add', '-A'); git('commit', '-qm', 'rename');
    const renameCommit = git('rev-parse', 'HEAD');
    const renamedFiles = await read('files', { rev: renameCommit });
    assert.deepEqual(renamedFiles, [{ status: 'R', oldPath: 'a.ts', path: renamed }]);
    const renamedDiff = await read('diff', { comparison: { ...renamedFiles[0], source: 'commit', rev: renameCommit } });
    assert.equal(renamedDiff.oldText, renamedDiff.newText);
    writeFileSync(join(root, renamed), 'const value = 2;\n'); git('add', '--', renamed);
    writeFileSync(join(root, renamed), 'const value = 3;\n');
    writeFileSync(join(root, 'untracked.bin'), Buffer.from([0, 255, 1]));
    writeFileSync(join(root, ':(glob)*'), 'literal path');
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const statusBefore = git('status', '--porcelain=v2');
    const before = readFileSync(join(root, '.git/index'));
    const overview = await read('overview', {}, join(root, 'nested'));
    assert.equal(overview.root, root); assert.equal(overview.branch, 'main');
    assert.deepEqual(overview.changes.filter(file => file.path === renamed).map(file => file.stage), ['staged', 'unstaged']);
    const staged = await read('diff', { comparison: { path: renamed, status: 'M', source: 'staged' } });
    assert.equal(staged.oldText, 'const value = 1;\n'); assert.equal(staged.newText, 'const value = 2;\n');
    const worktree = await read('diff', { comparison: { path: renamed, status: 'M', source: 'unstaged' } });
    assert.equal(worktree.oldText, 'const value = 2;\n'); assert.equal(worktree.newText, 'const value = 3;\n');
    assert.match((await read('diff', { comparison: { path: 'untracked.bin', status: '?', source: 'untracked' } })).notice, /Binary/);
    assert.match((await read('diff', { comparison: { path: 'large.txt', status: '?', source: 'untracked' } })).notice, /2 MiB/);
    assert.equal((await read('diff', { comparison: { path: ':(glob)*', status: '?', source: 'untracked' } })).newText, 'literal path');
    await assert.rejects(read('files', { rev: '--all' }), /Invalid commit/);
    await assert.rejects(read('diff', { comparison: { path: '../outside', source: 'untracked' } }), /Invalid repository path/);
    assert.deepEqual(readFileSync(join(root, '.git/index')), before);
    assert.equal(git('status', '--porcelain=v2'), statusBefore);
    for (let i = 0; i < 51; i++) git('commit', '--allow-empty', '-qm', `page ${i}`);
    const first = await read('overview');
    assert.equal(first.commits.length, 50); assert.equal(first.hasMore, true);
    const second = await read('history', { head: first.head, skip: 50 });
    assert.equal(second.commits.length, 3); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.sha)).size, 53);
    git('checkout', '-q', '--detach');
    assert.equal((await read('overview')).branch, '(detached)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Git reader: merge first-parent, conflict, deletion and non-repository errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangcai-git-merge-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const read = (method, query = {}) => readGit(method, root, query, run, readFile);
  try {
    await assert.rejects(read('overview'), /not a git repository/);
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Git Test'); git('config', 'user.email', 'git@test.local');
    writeFileSync(join(root, 'file'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature'); writeFileSync(join(root, 'file'), 'theirs\n'); git('commit', '-qam', 'feature');
    git('checkout', '-q', 'main'); writeFileSync(join(root, 'file'), 'ours\n'); git('commit', '-qam', 'main');
    try { git('merge', 'feature'); } catch {}
    assert.equal((await read('overview')).changes[0].stage, 'conflicted');
    const conflict = await read('diff', { comparison: { path: 'file', source: 'conflicted', status: 'U' } });
    assert.equal(conflict.oldText, 'ours\n'); assert.match(conflict.newText, /<<<<<<< HEAD/);
    writeFileSync(join(root, 'file'), 'resolved\n'); git('add', '.'); git('commit', '-qm', 'merge');
    const rev = git('rev-parse', 'HEAD');
    assert.deepEqual(await read('files', { rev }), [{ path: 'file', status: 'M' }]);
    const merge = await read('diff', { comparison: { path: 'file', status: 'M', source: 'commit', rev } });
    assert.equal(merge.oldText, 'ours\n'); assert.equal(merge.newText, 'resolved\n');
    rmSync(join(root, 'file'));
    const deletion = await read('diff', { comparison: { path: 'file', status: 'D', source: 'unstaged' } });
    assert.equal(deletion.newText, ''); assert.equal(deletion.oldText, 'resolved\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
