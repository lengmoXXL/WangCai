import { posix } from 'node:path';
import type { Commit, Diff, GitFile, GitRequest, History, Overview } from './shared';

export type RunGit = (cwd: string, args: string[]) => Promise<{ stdout: Buffer; stderr: string; code: number }>;
const logFormat = '%H%x00%an%x00%at%x00%D%x00%s';

export async function readGit(method: string, cwd: string, query: GitRequest, run: RunGit, readFile: (path: string) => Promise<Uint8Array>) {
  const git = async (args: string[]) => {
    const result = await run(cwd, args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
    return result.stdout;
  };
  const revision = (value: string) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Invalid commit ID');
    return value;
  };
  const history = async (head: string, skip = 0): Promise<History> => {
    if (!head) return { commits: [], hasMore: false };
    if (!Number.isSafeInteger(skip) || skip < 0) throw new Error('Invalid history offset');
    const fields = (await git(['log', '-z', `--format=${logFormat}`, '--decorate=full', '-n', '51', `--skip=${skip}`, revision(head), '--'])).toString().split('\0');
    const commits: Commit[] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      commits.push({ sha: fields[i], author: fields[i + 1], time: Number(fields[i + 2]), refs: fields[i + 3].split(', ').filter(Boolean), subject: fields[i + 4] });
    }
    return { commits: commits.slice(0, 50), hasMore: commits.length > 50 };
  };
  if (method === 'overview') {
    cwd = (await git(['rev-parse', '--show-toplevel'])).toString().replace(/\r?\n$/, '');
    const fields = (await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])).toString().split('\0');
    const result: Overview = { root: cwd, branch: '', upstream: '', ahead: 0, behind: 0, head: '', changes: [], commits: [], hasMore: false, truncated: false };
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.startsWith('# branch.oid ')) result.head = field.slice(13) === '(initial)' ? '' : field.slice(13);
      else if (field.startsWith('# branch.head ')) result.branch = field.slice(14);
      else if (field.startsWith('# branch.upstream ')) result.upstream = field.slice(18);
      else if (field.startsWith('# branch.ab ')) {
        const [ahead, behind] = field.slice(12).split(' ');
        result.ahead = Number(ahead); result.behind = -Number(behind);
      } else if (field[0] === '?') result.changes.push({ path: field.slice(2), status: '?', stage: 'untracked' });
      else if (field[0] === 'u') result.changes.push({ path: field.split(' ').slice(10).join(' '), status: 'U', stage: 'conflicted' });
      else if (field[0] === '1' || field[0] === '2') {
        const parts = field.split(' ');
        const path = parts.slice(field[0] === '1' ? 8 : 9).join(' ');
        const oldPath = field[0] === '2' ? fields[++i] : undefined;
        if (parts[1][0] !== '.') result.changes.push({ path, oldPath, status: parts[1][0], stage: 'staged' });
        if (parts[1][1] !== '.') result.changes.push({ path, status: parts[1][1], stage: 'unstaged' });
      }
    }
    result.truncated = result.changes.length > 1000;
    result.changes = result.changes.slice(0, 1000);
    Object.assign(result, await history(result.head));
    return result;
  }
  if (method === 'history') return history(query.head!, query.skip);
  if (method === 'files') {
    const sha = revision(query.rev!);
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha, '--'])).toString().trim().split(' ');
    const fields = (await git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', ...(parents[1] ? [parents[1], sha] : [sha]), '--'])).toString().split('\0');
    const files: GitFile[] = [];
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i++][0];
      const first = fields[i++];
      if (status === 'R' || status === 'C') files.push({ status, oldPath: first, path: fields[i++] });
      else files.push({ status, path: first });
    }
    return files;
  }
  if (method !== 'diff') throw new Error('Unknown Git operation');
  const comparison = query.comparison!;
  for (const path of [comparison.path, comparison.oldPath ?? comparison.path]) {
    if (!path || path.includes('\0') || posix.isAbsolute(path) || path.split('/').includes('..')) throw new Error('Invalid repository path');
  }
  const blob = async (tree: string | undefined, path: string, stage = '0'): Promise<Buffer> => {
    if (tree === '') return Buffer.alloc(0);
    const records = (await git(tree === undefined ? ['ls-files', '--stage', '-z', '--', path] : ['ls-tree', '-z', tree, '--', path])).toString().split('\0');
    const record = records.find(record => {
      const tab = record.indexOf('\t');
      return record.slice(tab + 1) === path && (tree !== undefined || record.slice(0, tab).split(' ')[2] === stage);
    });
    if (!record) return Buffer.alloc(0);
    const [mode, typeOrHash, hashOrStage] = record.slice(0, record.indexOf('\t')).split(' ');
    if (mode === '160000') return Buffer.from(`Subproject commit ${tree === undefined ? typeOrHash : hashOrStage}\n`);
    const hash = tree === undefined ? typeOrHash : hashOrStage;
    const size = Number((await git(['cat-file', '-s', hash])).toString());
    if (size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MiB diff limit');
    return git(['cat-file', 'blob', hash]);
  };
  const oldPath = comparison.oldPath ?? comparison.path;
  let oldBytes: Uint8Array;
  let newBytes: Uint8Array;
  if (comparison.source === 'commit') {
    const sha = revision(comparison.rev!);
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha, '--'])).toString().trim().split(' ');
    oldBytes = await blob(parents[1] ?? '', oldPath);
    newBytes = await blob(sha, comparison.path);
  } else if (comparison.source === 'staged') {
    const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr || 'Cannot resolve HEAD');
    oldBytes = await blob(head.code === 0 ? head.stdout.toString().trim() : '', oldPath);
    newBytes = await blob(undefined, comparison.path);
  } else {
    oldBytes = comparison.source === 'untracked' ? Buffer.alloc(0) : await blob(undefined, comparison.path, comparison.source === 'conflicted' ? '2' : '0');
    newBytes = comparison.status === 'D' ? Buffer.alloc(0) : await readFile(posix.join(cwd, comparison.path));
  }
  const result: Diff = { oldText: '', newText: '' };
  if (oldBytes.length > 2 * 1024 * 1024 || newBytes.length > 2 * 1024 * 1024) return { ...result, notice: 'File exceeds the 2 MiB diff limit' };
  if (oldBytes.includes(0) || newBytes.includes(0)) return { ...result, notice: 'Binary files cannot be compared as text' };
  try {
    const decoder = new TextDecoder(undefined, { fatal: true });
    result.oldText = decoder.decode(oldBytes); result.newText = decoder.decode(newBytes);
  } catch { result.notice = 'Non-UTF-8 files cannot be compared as text'; }
  return result;
}
