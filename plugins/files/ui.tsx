import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/jsonMode.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { DirectoryEntry, Theme, WorkspaceActive } from '@wangcai/sdk';
import type { TabRecord, UiContext } from '@wangcai/sdk/channel';
import { imageMime, type FileClick, type Font, type Settings } from './shared';
import './style.css';

export const title = '文件';
let activeWorkspaceId: string | undefined;
let preview: { url: string; message: string };
let font: Font;
jsonDefaults.setModeConfiguration({ tokens: true });

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
      { token: 'delimiter', foreground: hex(theme.brightBlack) },
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
      'scrollbarSlider.background': alpha(theme.muted, 0.25),
      'scrollbarSlider.hoverBackground': alpha(theme.muted, 0.4),
      'scrollbarSlider.activeBackground': alpha(theme.muted, 0.5),
    },
  };
}

type Mode = 'text' | 'markdown' | 'html';
const modeLabels: Record<Mode, string> = { text: '文本', markdown: 'Markdown 预览', html: 'HTML 预览' };

function ModeMenu({ modes, mode, select }: { modes: Mode[]; mode: Mode; select: (mode: Mode) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="preview-modes">
    <button className="preview-mode" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{modeLabels[mode]}
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
    </button>
    {open && <>
      <div className="menu-backdrop" onClick={() => setOpen(false)} />
      <div className="preview-menu" role="menu" aria-label="预览方式">
        {modes.map((item) => <button key={item} role="menuitem" autoFocus={item === mode} onClick={() => { setOpen(false); select(item); }}>{modeLabels[item]}</button>)}
      </div>
    </>}
  </div>;
}

function Preview({ file, text, mode }: { file: FileClick; text: string; mode: Mode }) {
  const element = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // The preview document asks for its content as soon as it loads, so the listener has to be in place first.
  useLayoutEffect(() => {
    if (mode !== 'html') return;
    const deliver = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (target && event.data === preview.message && event.source === target) target.postMessage(text, '*');
    };
    addEventListener('message', deliver);
    return () => removeEventListener('message', deliver);
  }, [mode, text]);
  useEffect(() => {
    if (mode !== 'text') return;
    const size = font.size;
    const name = file.path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find((item) => item.filenames?.includes(name) || item.extensions?.some((extension) => name.endsWith(extension)))?.id ?? 'plaintext';
    const editor = monaco.editor.create(element.current!, {
      value: text, language, theme: 'wangcai', readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: size, lineHeight: font.lineHeight ? Math.round(size * font.lineHeight) : 0, fontFamily: font.family, lineNumbersMinChars: 3, renderLineHighlight: 'none',
      ariaLabel: '代码预览', contextmenu: false,
    });
    const position = { lineNumber: file.line ?? 1, column: file.column ?? 1 };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    return () => { editor.getModel()?.dispose(); editor.dispose(); };
  }, [file, text, mode]);
  if (mode === 'markdown') return <article className="markdown-preview"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></article>;
  if (mode === 'html') return <iframe className="html-frame" ref={frame} title="HTML 预览" sandbox="allow-scripts" src={preview.url} />;
  return <div className="code-preview" ref={element} />;
}

function Directory({ context, location }: { context: UiContext; location: { machine: FileClick['machine']; sessionId?: string; path?: string } | null }) {
  const [path, setPath] = useState(location?.path);
  const [directory, setDirectory] = useState<{ path: string; entries: DirectoryEntry[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!location) return;
    let alive = true;
    setDirectory(undefined); setError('');
    void context.ui.request<{ path: string; entries: DirectoryEntry[] }>('list', { ...location, path }).then((result) => {
      if (alive) setDirectory(result);
    }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, location, path]);
  if (!location) return <div className="file-message">请选择一个已连接的终端</div>;
  if (error) return <div className="file-message" role="alert">{error}</div>;
  if (!directory) return <div className="file-message">正在读取…</div>;
  return <div className="file-directory">
    <div className="directory-path" title={directory.path}>{directory.path}</div>
    <nav aria-label="当前目录文件">
      {directory.path !== '/' && <button onClick={() => setPath(directory.path.slice(0, directory.path.lastIndexOf('/')) || '/')} aria-label="上级目录">../</button>}
      {directory.entries.map((entry) => <button key={entry.name} onClick={() => {
        const path = `${directory.path === '/' ? '' : directory.path}/${entry.name}`;
        if (entry.isDirectory) setPath(path);
        else void context.global.publish('onclick', { type: 'file', machine: location.machine, path });
      }}><svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
        {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
      </svg><span>{entry.name}{entry.isDirectory ? '/' : ''}</span></button>)}
      {!directory.entries.length && <div className="file-message">空目录</div>}
    </nav>
  </div>;
}

function DirectoryView({ context, workspaceId }: { context: UiContext; workspaceId?: string }) {
  const [terminal, setTerminal] = useState<WorkspaceActive | null>(null);
  useEffect(() => {
    const off = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => {
      if (workspaceId !== undefined && value !== null && value.workspaceId !== workspaceId) return;
      setTerminal(value);
    });
    void context.global.publish('workspace:query', null);
    return off;
  }, [context, workspaceId]);
  return <Directory key={`${terminal?.machine.id}:${terminal?.sessionId}`} context={context} location={terminal} />;
}

function FileView({ context, file }: { context: UiContext; file: FileClick }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void context.ui.request<string>('read', file).then((text) => { if (alive) setText(text); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, file]);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const html = /\.html?$/i.test(file.path);
  const image = imageMime(file.path);
  const modes: Mode[] = image ? [] : ['text', ...(markdown ? ['markdown' as const] : []), ...(html ? ['html' as const] : [])];
  const [mode, setMode] = useState<Mode>(html ? 'html' : markdown ? 'markdown' : 'text');
  return <section className="file-preview" aria-label="文件预览">
    <header className="preview-header">
      <span className="preview-path" title={file.path}>{file.path}</span>
      {modes.length > 1 && <ModeMenu modes={modes} mode={mode} select={setMode} />}
    </header>
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : image ? <div className="image-preview"><img src={text} alt={file.path} /></div>
      : <Preview file={file} text={text} mode={mode} />}
  </section>;
}

export function open(context: UiContext, record?: TabRecord) {
  if (!record || record.id === 'directory') openTab(context, record?.workspaceId ?? activeWorkspaceId);
}

function openTab(context: UiContext, workspaceId?: string) {
  context.host.tabs({ id: 'directory', title: '文件', workspaceId, mount(container: HTMLElement) {
    container.style.fontFamily = font.family;
    const root = createRoot(container);
    let revision = 0;
    return {
      onSelect: () => root.render(<DirectoryView key={++revision} context={context} workspaceId={workspaceId} />),
      dispose: () => root.unmount(),
    };
  } });
}

export async function mount(_container: HTMLElement, context: UiContext) {
  const profile: Settings = context.host.config;
  font = profile.font;
  preview = context.host.preview;
  monaco.editor.defineTheme('wangcai', editorTheme(profile.theme));
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load file preview worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  self.MonacoEnvironment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  const offActive = context.global.subscribe<WorkspaceActive | null>('workspace:active', (value) => { activeWorkspaceId = value?.workspaceId; });
  void context.global.publish('workspace:query', null);
  const off = context.global.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'file' && file.type !== 'directory') return;
    context.host.tabs({
      id: JSON.stringify([file.machine.host ?? file.machine.id, file.path]),
      title: file.path.split('/').filter(Boolean).pop() ?? '/', tooltip: `${file.machine.name}: ${file.path}`, workspaceId: activeWorkspaceId,
      mount(container: HTMLElement) {
        container.style.fontFamily = font.family;
        const root = createRoot(container);
        let revision = 0;
        return {
          onSelect: () => root.render(file.type === 'directory'
            ? <Directory key={++revision} context={context} location={file} />
            : <FileView context={context} file={file} />),
          dispose: () => root.unmount(),
        };
      },
    });
  });
  return () => {
    offActive();
    off();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    delete self.MonacoEnvironment;
  };
}
