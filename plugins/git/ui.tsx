import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { Profile, Theme } from '@wangcai/sdk';
import type { Context } from '@wangcai/sdk/channel';
import type { ActiveTerminal, Commit, Comparison, Diff, GitFile, History, Overview, Stage } from './shared';
import './style.css';

export const title = 'Git';
let activeWorkspaceId: string | undefined;
const stages: Record<Stage, string> = { conflicted: '冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };
const readingOrder = ['auto', 'split', 'inline'] as const;
type Reading = typeof readingOrder[number];
const readings: Record<Reading, string> = { auto: '自动', split: '双栏', inline: '单栏' };

function editorTheme(theme: Theme): monaco.editor.IStandaloneThemeData {
  const hex = (color: string) => color.slice(1);
  const alpha = (color: string, value: number) => `${color}${Math.round(value * 255).toString(16).padStart(2, '0')}`;
  return {
    base: getComputedStyle(document.documentElement).colorScheme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex(theme.muted) },
      { token: 'string', foreground: hex(theme.green) },
      { token: 'number', foreground: hex(theme.yellow) },
      { token: 'keyword', foreground: hex(theme.magenta) },
      { token: 'type', foreground: hex(theme.cyan) },
      { token: 'function', foreground: hex(theme.blue) },
      { token: 'constant', foreground: hex(theme.brightMagenta) },
      { token: 'delimiter', foreground: hex(theme.muted) },
      { token: 'regexp', foreground: hex(theme.red) },
    ],
    colors: {
      'editor.background': theme.background,
      'editor.foreground': theme.foreground,
      'editorLineNumber.foreground': theme.muted,
      'editorCursor.foreground': theme.cursor,
      'editor.selectionBackground': theme.selection,
      'editorWidget.background': theme.overlay,
      'editorWidget.border': theme.border,
      'editorGutter.background': theme.background,
      'editorBracketHighlight.foreground1': theme.foreground,
      'editorBracketHighlight.foreground2': theme.foreground,
      'editorBracketHighlight.foreground3': theme.foreground,
      'diffEditor.insertedTextBackground': alpha(theme.green, 0.2),
      'diffEditor.removedTextBackground': alpha(theme.red, 0.2),
      'diffEditor.insertedLineBackground': alpha(theme.green, 0.08),
      'diffEditor.removedLineBackground': alpha(theme.red, 0.08),
      'scrollbarSlider.background': alpha(theme.muted, 0.25),
      'scrollbarSlider.hoverBackground': alpha(theme.muted, 0.4),
      'scrollbarSlider.activeBackground': alpha(theme.muted, 0.5),
    },
  };
}

function DiffEditor({ diff, path, reading, wrap }: { diff: Diff; path: string; reading: Reading; wrap: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor>(undefined);
  const options = {
    renderSideBySide: reading !== 'inline',
    useInlineViewWhenSpaceIsLimited: reading === 'auto',
    wordWrap: wrap ? 'on' : 'off',
  } as const;
  useEffect(() => {
    const name = path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find(item => item.filenames?.includes(name) || item.extensions?.some(extension => name.endsWith(extension)))?.id ?? 'plaintext';
    const original = monaco.editor.createModel(diff.oldText, language);
    const modified = monaco.editor.createModel(diff.newText, language);
    const view = monaco.editor.createDiffEditor(element.current!, {
      theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, scrollBeyondLastLine: false,
      renderOverviewRuler: false, hideUnchangedRegions: { enabled: true },
      ...options, fontSize: 13, lineNumbersMinChars: 3, contextmenu: false,
    });
    view.setModel({ original, modified });
    view.getOriginalEditor().updateOptions({ glyphMargin: false });
    editor.current = view;
    return () => { editor.current = undefined; view.dispose(); original.dispose(); modified.dispose(); };
  }, [diff, path]);
  useEffect(() => { editor.current?.updateOptions(options); }, [reading, wrap]);
  return <div className="git-editor" ref={element} />;
}

function DiffPane({ context, terminal, root, comparison, reading, wrap, refresh }: {
  context: Context; terminal: ActiveTerminal; root: string; comparison: Comparison; reading: Reading; wrap: boolean; refresh: number;
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
  return <DiffEditor diff={diff} path={comparison.path} reading={reading} wrap={wrap} />;
}

function FileRow({ file, select }: { file: GitFile; select: () => void }) {
  const cut = file.path.lastIndexOf('/');
  return <button className="git-file" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={select}>
    <span className={`git-status git-status-${file.status}`}>{file.status}</span>
    <span className="git-path">{cut < 0 ? file.path : <>
      <span className="git-dir">{file.path.slice(0, cut + 1)}</span><span>{file.path.slice(cut + 1)}</span>
    </>}</span>
  </button>;
}

function CommitRow({ commit, context, terminal, root, selected, toggle, select }: {
  commit: Commit; context: Context; terminal: ActiveTerminal; root: string; selected: boolean;
  toggle: () => void; select: (comparison: Comparison) => void;
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
  const [tip, setTip] = useState<{ top: number; left: number }>();
  const tipElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = tipElement.current;
    if (!tip || !node) return;
    node.style.left = `${Math.max(8, Math.min(tip.left, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(tip.top, window.innerHeight - node.offsetHeight - 8))}px`;
  }, [tip]);
  return <>
    <button className="git-commit-row" aria-expanded={selected} onClick={toggle} onMouseEnter={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTip({ top: rect.top, left: rect.right + 8 });
    }} onMouseLeave={() => setTip(undefined)}>
      <span>{selected ? '▾' : '▸'}</span>
      <span className="git-subject">{commit.subject}</span>
      <span className="git-who">{commit.author}</span>
    </button>
    {tip && <div className="git-tip" ref={tipElement}>
      <div><b>{commit.subject}</b></div>
      <div className="mono">{commit.sha}</div>
      <div>{commit.author} · {new Date(commit.time * 1000).toLocaleString()}</div>
      <div>{commit.refs.map(ref => ref.replace(/refs\/(heads|remotes|tags)\//g, '')).join(' · ') || '没有引用'}</div>
    </div>}
    {selected && <div className="git-commit-files">
      {error ? <div className="git-note" role="alert">{error}</div> : !files ? <div className="git-note">正在读取…</div>
        : files.length ? files.map(file => <FileRow key={file.path} file={file} select={() => select({ ...file, source: 'commit', rev: commit.sha })} />)
        : <div className="git-note">没有文件改动</div>}
    </div>}
  </>;
}

function Repository({ context, terminal, activation }: { context: Context; terminal: ActiveTerminal; activation: number }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison>();
  const [reading, setReading] = useState<Reading>('auto');
  const [wrap, setWrap] = useState(true);
  const [rail, setRail] = useState(true);
  const [railWidth, setRailWidth] = useState(260);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; width: number }>(undefined);
  const railMinimum = 180;
  const railMaximum = Math.round((body.current?.clientWidth ?? 0) * 0.7);
  const clampWidth = (requested: number) => Math.round(Math.max(railMinimum, Math.min(railMaximum, requested)));
  const generation = useRef(0);
  const repositoryRoot = useRef('');
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setOlder(false); setError('');
    void context.ui.request<Overview>('overview', { terminal }).then(value => {
      if (current !== generation.current) return;
      if (repositoryRoot.current !== value.root) { setComparison(undefined); setOpened(value.commits[0]?.sha ?? null); }
      repositoryRoot.current = value.root;
      setOverview(value);
    }).catch((error: Error) => { if (current === generation.current) { setOverview(undefined); setComparison(undefined); setError(error.message); } })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [context, terminal, refresh, activation]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.git-menu')) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape); };
  }, [menu]);
  return <section className="git-page" aria-label="Git history" data-reading={reading}>
    <header className="git-toolbar">
      <span className="git-branch" title={overview?.upstream}>{overview?.branch}
        {overview?.ahead ? <b> ↑{overview.ahead}</b> : null}{overview?.behind ? <i> ↓{overview.behind}</i> : null}</span>
      <span className="git-spacer" />
      <button className="git-icon" aria-label="切换 Git 列表" aria-pressed={rail} onClick={() => setRail(!rail)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM6 3.5v9"/></svg>
      </button>
      <button className="git-icon" aria-label={`阅读方式 ${readings[reading]}`} title={`阅读方式：${readings[reading]}（点击切换）`}
        onClick={() => setReading(readingOrder[(readingOrder.indexOf(reading) + 1) % readingOrder.length])}>
        <svg className="git-icon-auto" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11z"/><path d="M8 3.5v9" strokeDasharray="2 2"/></svg>
        <svg className="git-icon-split" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM8 3.5v9"/></svg>
        <svg className="git-icon-inline" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11zM4.5 6.5h7M4.5 9.5h4"/></svg>
      </button>
      <button className="git-icon" aria-label="长行折行" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h8a2 2 0 1 1 0 4H8M2.5 12h3"/><path d="M9.4 10.6 8 12l1.4 1.4"/></svg>
      </button>
      <button className="git-icon" aria-label="刷新 Git" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 6.2A5 5 0 1 0 13 9"/><path d="M13.2 3v3.4h-3.4"/></svg>
      </button>
    </header>
    {error ? <div className="git-note" role="alert">{error}</div> : !overview ? <div className="git-note">正在读取 Git…</div>
      : <div className="git-body" ref={body} data-rail={rail ? 'shown' : 'hidden'} style={{ '--rail-width': `${railWidth}px` } as CSSProperties}>
        <div className="git-rail-wrap">
          <nav className="git-rail" aria-label="Git 改动与历史">
            <div className="git-section">改动 {overview.changes.length ? <small>{overview.changes.length}</small> : null}</div>
            {!overview.changes.length && <div className="git-note">工作区干净</div>}
            {(Object.entries(stages) as [Stage, string][]).map(([stage, title]) => {
              const files = overview.changes.filter(file => file.stage === stage);
              return files.length > 0 && <details key={stage} open><summary>{title} <small>{files.length}</small></summary>
                {files.map(file => <FileRow key={file.path} file={file} select={() => setComparison({ ...file, source: stage })} />)}
              </details>;
            })}
            {overview.truncated && <div className="git-note">仅显示前 1000 项改动</div>}
            <div className="git-gap" />
            <details open><summary>提交历史</summary>
              {overview.commits.map(commit => <CommitRow key={`${overview.root}:${commit.sha}`} commit={commit} context={context} terminal={terminal} root={overview.root}
                selected={opened === commit.sha} toggle={() => setOpened(opened === commit.sha ? null : commit.sha)} select={setComparison} />)}
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
          </nav>
          <div className="git-divider" role="separator" aria-orientation="vertical" aria-label="调整 Git 列表宽度" tabIndex={0}
            aria-valuenow={railWidth} aria-valuemin={railMinimum} aria-valuemax={railMaximum}
            onPointerDown={(event) => { event.preventDefault(); drag.current = { origin: event.clientX, width: railWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) setRailWidth(clampWidth(drag.current.width + event.clientX - drag.current.origin)); }}
            onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onKeyDown={(event) => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setRailWidth(clampWidth(railWidth + (event.key === 'ArrowRight' ? 20 : -20))); }} />
        </div>
        <div className="git-board">
          {comparison ? <section className="git-pane" aria-label={`Diff ${comparison.path}`}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
            <DiffPane context={context} terminal={terminal} root={overview.root} comparison={comparison} reading={reading} wrap={wrap} refresh={refresh + activation} />
          </section> : <div className="git-note">选择文件查看 diff</div>}
        </div>
      </div>}
    {menu && <div className="git-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" onClick={() => { setComparison(undefined); setMenu(undefined); }}>关闭</button>
    </div>}
  </section>;
}

function GitView({ context, activation, workspaceId }: { context: Context; activation: number; workspaceId?: string }) {
  const [terminal, setTerminal] = useState<ActiveTerminal | null>(null);
  useEffect(() => {
    const off = context.global.subscribe<ActiveTerminal | null>('terminal:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      setTerminal(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
    });
    void context.global.publish('terminal:query', null);
    return off;
  }, [context, activation, workspaceId]);
  if (!terminal) return <div className="git-note">请选择一个已连接的终端</div>;
  return <Repository key={JSON.stringify(terminal)} context={context} terminal={terminal} activation={activation} />;
}

export function open(context: Context) {
  void openTab(context, activeWorkspaceId);
}

export async function restore(context: Context, record: { workspaceId?: string }) {
  await openTab(context, record.workspaceId);
}

function openTab(context: Context, workspaceId?: string) {
  return context.host.request('tabs', { id: 'history', title: 'Git', workspaceId, mount(container: HTMLElement) {
    const root = createRoot(container);
    let activation = 0;
    return { onSelect: () => root.render(<GitView context={context} activation={++activation} workspaceId={workspaceId} />), dispose: () => root.unmount() };
  } });
}

export async function mount(_container: HTMLElement, context: Context) {
  const profile = await context.host.request<Profile>('config');
  monaco.editor.defineTheme('wangcai', editorTheme(profile.theme));
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
