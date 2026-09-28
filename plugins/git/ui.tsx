import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { Context } from '@wangcai/sdk/channel';
import type { ActiveTerminal, Commit, Comparison, Diff, GitFile, History, Overview, Stage } from './shared';
import './style.css';

export const title = 'Git';
let activeWorkspaceId: string | undefined;
const stages: Record<Stage, string> = { conflicted: '冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };

function DiffEditor({ diff, path, split, wrap }: { diff: Diff; path: string; split: boolean; wrap: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor>(undefined);
  useEffect(() => {
    const name = path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find(item => item.filenames?.includes(name) || item.extensions?.some(extension => name.endsWith(extension)))?.id ?? 'plaintext';
    const original = monaco.editor.createModel(diff.oldText, language);
    const modified = monaco.editor.createModel(diff.newText, language);
    const view = monaco.editor.createDiffEditor(element.current!, {
      theme: 'vs-dark', readOnly: true, domReadOnly: true,
      automaticLayout: true, scrollBeyondLastLine: false,
      renderOverviewRuler: false, hideUnchangedRegions: { enabled: true },
      useInlineViewWhenSpaceIsLimited: false, fontSize: 13, lineNumbersMinChars: 3,
      renderSideBySide: split, wordWrap: wrap ? 'on' : 'off', contextmenu: false,
    });
    view.setModel({ original, modified });
    view.getOriginalEditor().updateOptions({ glyphMargin: false });
    editor.current = view;
    return () => { editor.current = undefined; view.dispose(); original.dispose(); modified.dispose(); };
  }, [diff, path]);
  useEffect(() => { editor.current?.updateOptions({ renderSideBySide: split, wordWrap: wrap ? 'on' : 'off' }); }, [split, wrap]);
  return <div className="git-editor" ref={element} />;
}

function DiffPane({ context, terminal, root, comparison, split, wrap, refresh }: {
  context: Context; terminal: ActiveTerminal; root: string; comparison: Comparison; split: boolean; wrap: boolean; refresh: number;
}) {
  const [diff, setDiff] = useState<Diff>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setDiff(undefined); setError('');
    void context.ui.request<Diff>('diff', { terminal, root, comparison }).then(value => { if (alive) setDiff(value); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, terminal, root, comparison, refresh]);
  if (error) return <div className="git-note" role="alert">{error}</div>;
  if (!diff) return <div className="git-note">正在读取 diff…</div>;
  if (diff.notice) return <div className="git-note">{diff.notice}</div>;
  return <div className="git-diff" data-reading={split ? 'split' : 'inline'} data-wrap={wrap}>
    <div className="git-labels"><span>{diff.oldLabel}</span><span>{diff.newLabel}</span></div>
    <DiffEditor diff={diff} path={comparison.path} split={split} wrap={wrap} />
  </div>;
}

function FileRow({ file, select }: { file: GitFile; select: (beside: boolean) => void }) {
  return <div className="git-file">
    <button title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={event => select(event.altKey)}>
      <span className={`git-status git-status-${file.status}`}>{file.status}</span><span>{file.path}</span>
    </button>
    <button className="git-beside" aria-label={`并排查看 ${file.path}`} title="并排查看 (Alt + 点击)" onClick={() => select(true)}>+</button>
  </div>;
}

function CommitRow({ commit, context, terminal, root, selected, toggle, select }: {
  commit: Commit; context: Context; terminal: ActiveTerminal; root: string; selected: boolean;
  toggle: () => void; select: (comparison: Comparison, beside: boolean) => void;
}) {
  const [files, setFiles] = useState<GitFile[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!selected || files) return;
    let alive = true;
    setError('');
    void context.ui.request<GitFile[]>('files', { terminal, root, rev: commit.sha }).then(value => { if (alive) setFiles(value); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [selected, context, terminal, root, commit.sha, files]);
  return <div>
    <button className="git-commit-row" aria-expanded={selected} onClick={toggle} title={`${commit.sha}\n${commit.author} · ${new Date(commit.time * 1000).toLocaleString()}\n${commit.subject}`}>
      <span>{selected ? '▾' : '▸'}</span><span className="git-subject">{commit.subject}</span>
      <small>{commit.sha.slice(0, 8)}</small>
    </button>
    <div className="git-meta"><span>{commit.author}</span><time>{new Date(commit.time * 1000).toLocaleDateString()}</time>
      {commit.refs.map(ref => <span className="git-ref" key={ref}>{ref.replace(/refs\/(heads|remotes|tags)\//g, '')}</span>)}
    </div>
    {selected && <div className="git-commit-files">
      {error ? <div className="git-note" role="alert">{error}</div> : !files ? <div className="git-note">正在读取…</div>
        : files.length ? files.map(file => <FileRow key={file.path} file={file} select={beside => select({ ...file, source: 'commit', rev: commit.sha }, beside)} />)
        : <div className="git-note">没有文件改动</div>}
    </div>}
  </div>;
}

function Repository({ context, terminal, activation }: { context: Context; terminal: ActiveTerminal; activation: number }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [panes, setPanes] = useState<Comparison[]>([]);
  const [focused, setFocused] = useState(0);
  const [split, setSplit] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [rail, setRail] = useState(true);
  const generation = useRef(0);
  const repositoryRoot = useRef('');
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setOlder(false); setError('');
    void context.ui.request<Overview>('overview', { terminal }).then(value => {
      if (current !== generation.current) return;
      if (repositoryRoot.current !== value.root) { setPanes([]); setOpened(value.commits[0]?.sha ?? null); setFocused(0); }
      repositoryRoot.current = value.root;
      setOverview(value);
    }).catch((error: Error) => { if (current === generation.current) { setOverview(undefined); setPanes([]); setError(error.message); } })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [context, terminal, refresh, activation]);
  const select = (comparison: Comparison, beside: boolean) => {
    const existing = panes.findIndex(pane => JSON.stringify(pane) === JSON.stringify(comparison));
    if (existing >= 0) { setFocused(existing); return; }
    const index = beside ? (panes.length < 2 ? panes.length : 1 - focused) : Math.min(focused, panes.length);
    setPanes(panes => { const next = [...panes]; next[index] = comparison; return next; });
    setFocused(index);
  };
  return <section className="git-page" aria-label="Git history">
    <header className="git-toolbar">
      <button aria-label="切换 Git 列表" aria-pressed={rail} onClick={() => setRail(!rail)}>列表</button>
      <strong title={overview?.root}>{overview?.root.split('/').pop() ?? terminal.machine.name}</strong>
      <span title={overview?.upstream}>{overview?.branch}{overview?.ahead ? ` ↑${overview.ahead}` : ''}{overview?.behind ? ` ↓${overview.behind}` : ''}</span>
      <button onClick={() => setSplit(!split)} aria-pressed={split}>{split ? '双栏' : '单栏'}</button>
      <button onClick={() => setWrap(!wrap)} aria-pressed={wrap}>折行</button>
      <button aria-label="刷新 Git" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button>
    </header>
    {error ? <div className="git-note" role="alert">{error}</div> : !overview ? <div className="git-note">正在读取 Git…</div> : <div className="git-body">
      {rail && <nav className="git-rail" aria-label="Git 改动与历史">
        <div className="git-root" title={overview.root}>{overview.root}</div>
        {!overview.changes.length && <div className="git-note">工作区干净</div>}
        {(Object.entries(stages) as [Stage, string][]).map(([stage, title]) => {
          const files = overview.changes.filter(file => file.stage === stage);
          return files.length > 0 && <details key={stage} open><summary>{title} <small>{files.length}</small></summary>
            {files.map(file => <FileRow key={file.path} file={file} select={beside => select({ ...file, source: stage }, beside)} />)}
          </details>;
        })}
        {overview.truncated && <div className="git-note">仅显示前 1000 项改动</div>}
        <details open><summary>提交历史</summary>
          {overview.commits.map(commit => <CommitRow key={`${overview.root}:${commit.sha}`} commit={commit} context={context} terminal={terminal} root={overview.root}
            selected={opened === commit.sha} toggle={() => setOpened(opened === commit.sha ? null : commit.sha)} select={select} />)}
          {!overview.commits.length && <div className="git-note">暂无提交</div>}
          {overview.hasMore && <button className="git-more" disabled={older || loading} onClick={() => {
            const current = generation.current;
            setOlder(true);
            void context.ui.request<History>('history', { terminal, root: overview.root, head: overview.head, skip: overview.commits.length }).then(value => {
              if (current === generation.current) setOverview(previous => ({ ...previous!, commits: [...previous!.commits, ...value.commits], hasMore: value.hasMore }));
            }).catch((error: Error) => { if (current === generation.current) setError(error.message); })
              .finally(() => { if (current === generation.current) setOlder(false); });
          }}>{older ? '正在读取…' : '加载更多提交'}</button>}
        </details>
      </nav>}
      <div className="git-board">
        {!panes.length && <div className="git-note">选择文件查看 diff；点击 + 可并排比较</div>}
        {panes.map((comparison, index) => <section className="git-pane" key={JSON.stringify(comparison)} data-focused={focused === index} onMouseDown={() => setFocused(index)} aria-label={`Diff ${comparison.path}`}>
          <header><span title={comparison.path}>{comparison.path}</span><button aria-label={`关闭 diff ${index + 1}`} onClick={() => { setPanes(panes.filter((_, i) => i !== index)); setFocused(0); }}>×</button></header>
          <DiffPane context={context} terminal={terminal} root={overview.root} comparison={comparison} split={split} wrap={wrap} refresh={refresh + activation} />
        </section>)}
      </div>
    </div>}
  </section>;
}

function GitView({ context, activation }: { context: Context; activation: number }) {
  const [terminal, setTerminal] = useState<ActiveTerminal | null>(null);
  useEffect(() => {
    const off = context.global.subscribe<ActiveTerminal | null>('terminal:active', value => setTerminal(previous =>
      JSON.stringify(previous) === JSON.stringify(value) ? previous : value));
    void context.global.publish('terminal:query', null);
    return off;
  }, [context, activation]);
  if (!terminal) return <div className="git-note">请选择一个已连接的终端</div>;
  return <Repository key={JSON.stringify(terminal)} context={context} terminal={terminal} activation={activation} />;
}

export function open(context: Context) {
  openTab(context, activeWorkspaceId);
}

export function restore(context: Context, tabs: { id: string; workspaceId?: string }[]) {
  for (const tab of tabs) if (tab.id === 'history') openTab(context, tab.workspaceId);
}

function openTab(context: Context, workspaceId?: string) {
  void context.host.request('tabs', { id: 'history', title: 'Git', workspaceId, mount(container: HTMLElement) {
    const root = createRoot(container);
    let activation = 0;
    return { onSelect: () => root.render(<GitView context={context} activation={++activation} />), dispose: () => root.unmount() };
  } });
}

export async function mount(_container: HTMLElement, context: Context) {
  const offActive = context.global.subscribe<ActiveTerminal | null>('terminal:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('terminal:query', null);
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load Git diff worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  const previous = self.MonacoEnvironment;
  const environment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  self.MonacoEnvironment = environment;
  return () => {
    offActive();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    if (self.MonacoEnvironment === environment) self.MonacoEnvironment = previous;
  };
}
