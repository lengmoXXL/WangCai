import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/jsonMode.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { DirectoryEntry } from '@shu/sdk';
import type { ActiveTerminal, FileClick, UIContext } from '@shu/sdk/plugin';
import './style.css';

export const title = '文件';
jsonDefaults.setModeConfiguration({ tokens: true });

function Preview({ file, text }: { file: FileClick; text: string }) {
  const element = useRef<HTMLDivElement>(null);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  useEffect(() => {
    if (markdown) return;
    const name = file.path.split('/').pop()!;
    const language = monaco.languages.getLanguages().find((item) => item.filenames?.includes(name) || item.extensions?.some((extension) => name.endsWith(extension)))?.id ?? 'plaintext';
    const editor = monaco.editor.create(element.current!, {
      value: text, language, theme: 'vs-dark', readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      fontSize: 13, lineNumbersMinChars: 3, renderLineHighlight: 'none',
      ariaLabel: '代码预览', contextmenu: false,
    });
    const position = { lineNumber: file.line ?? 1, column: file.column ?? 1 };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    return () => { editor.getModel()?.dispose(); editor.dispose(); };
  }, [file, text, markdown]);
  if (markdown) return <article className="markdown-preview"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></article>;
  return <div className="code-preview" ref={element} />;
}

function Directory({ context, location }: { context: UIContext; location: { machine: FileClick['machine']; sessionId?: string; path?: string } | null }) {
  const [path, setPath] = useState(location?.path);
  const [directory, setDirectory] = useState<{ path: string; entries: DirectoryEntry[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!location) return;
    let alive = true;
    setDirectory(undefined); setError('');
    void context.request<{ path: string; entries: DirectoryEntry[] }>('list', { ...location, path }).then((result) => {
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
        else void context.publish('onclick', { type: 'file', machine: location.machine, path });
      }}><svg className="file-icon" data-kind={entry.isDirectory ? 'folder' : 'file'} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
        {entry.isDirectory ? <path d="M2 5h6l2 2h8v10H2z" /> : <path d="M5 2h6l4 4v12H5z M11 2v5h4 M8 11h4 M8 14h4" />}
      </svg><span>{entry.name}{entry.isDirectory ? '/' : ''}</span></button>)}
      {!directory.entries.length && <div className="file-message">空目录</div>}
    </nav>
  </div>;
}

function DirectoryView({ context }: { context: UIContext }) {
  const [terminal, setTerminal] = useState<ActiveTerminal | null>(null);
  useEffect(() => {
    const off = context.subscribe<ActiveTerminal | null>('terminal:active', setTerminal);
    void context.publish('terminal:query', null);
    return off;
  }, [context]);
  return <Directory key={`${terminal?.machine.id}:${terminal?.sessionId}`} context={context} location={terminal} />;
}

function FileView({ context, file }: { context: UIContext; file: FileClick }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void context.request<string>('read', file).then((text) => { if (alive) setText(text); })
      .catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [context, file]);
  return <section className="file-preview" aria-label="文件预览">
    {error ? <div className="file-message" role="alert">{error}</div>
      : text === undefined ? <div className="file-message">正在读取…</div>
      : <Preview file={file} text={text} />}
  </section>;
}

export function open(context: UIContext) {
  context.tabs.open({ id: 'directory', title: '文件', mount(container) {
    const root = createRoot(container);
    let revision = 0;
    return {
      onSelect: () => root.render(<DirectoryView key={++revision} context={context} />),
      dispose: () => root.unmount(),
    };
  } });
}

export async function mount(_container: HTMLElement, context: UIContext) {
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load file preview worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  self.MonacoEnvironment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  const off = context.subscribe<FileClick>('onclick', (file) => {
    if (file.type !== 'file' && file.type !== 'directory') return;
    context.tabs.open({
      id: JSON.stringify([file.machine.host ?? file.machine.id, file.path]),
      title: file.path.split('/').filter(Boolean).pop() ?? '/', tooltip: `${file.machine.name}: ${file.path}`,
      mount(container) {
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
    off();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    delete self.MonacoEnvironment;
  };
}
