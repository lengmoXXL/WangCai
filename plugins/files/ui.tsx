import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/jsonMode.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { FileClick, UIContext } from '@shu/sdk/plugin';
import './style.css';

export const placement = 'right';
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

interface FileTab { key: string; file: FileClick; text?: string; error?: string }

function App({ context, container }: { context: UIContext; container: HTMLElement }) {
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    let alive = true;
    const off = context.subscribe<FileClick>('onclick', (file) => {
      if (file.type !== 'file') return;
      const tab: FileTab = { key: JSON.stringify([file.machine.host ?? file.machine.id, file.path]), file };
      setTabs((tabs) => tabs.some((item) => item.key === tab.key)
        ? tabs.map((item) => item.key === tab.key ? tab : item) : [...tabs, tab]);
      setSelected(tab.key);
      void context.request<string>('read', file).then((text) => {
        if (alive) setTabs((tabs) => tabs.map((item) => item === tab ? { ...tab, text } : item));
      }).catch((error: Error) => {
        if (alive) setTabs((tabs) => tabs.map((item) => item === tab ? { ...tab, error: error.message } : item));
      });
    });
    return () => { alive = false; off(); };
  }, [context]);
  useEffect(() => { container.hidden = tabs.length === 0; }, [container, tabs.length]);
  const tab = tabs.find((item) => item.key === selected);
  if (!tab) return null;
  return <section className="file-preview" aria-label="文件预览">
    <header role="tablist" aria-label="文件标签页">{tabs.map((item, index) => {
      const name = item.file.path.split('/').pop();
      return <div className={`file-tab${item.key === selected ? ' selected' : ''}`} key={item.key}>
        <button role="tab" aria-selected={item.key === selected} title={`${item.file.machine.name}: ${item.file.path}`}
          onClick={() => setSelected(item.key)}>{name}</button>
        <button className="close-file" aria-label={`关闭 ${name}`} onClick={() => {
          setTabs((tabs) => tabs.filter((tab) => tab.key !== item.key));
          if (item.key === selected) setSelected(tabs[index - 1]?.key ?? tabs[index + 1]?.key ?? '');
        }}>×</button>
      </div>;
    })}</header>
    <div className="file-content" role="tabpanel" aria-label={tab.file.path.split('/').pop()}>
      {tab.error ? <div className="file-message" role="alert">{tab.error}</div>
        : tab.text === undefined ? <div className="file-message">正在读取…</div>
        : <Preview file={tab.file} text={tab.text} />}
    </div>
  </section>;
}

export async function mount(container: HTMLElement, context: UIContext) {
  container.hidden = true;
  const response = await fetch(new URL('./ui.worker.js', import.meta.url));
  if (!response.ok) throw new Error('Cannot load file preview worker');
  const workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  const workers = new Set<Worker>();
  self.MonacoEnvironment = { getWorker() {
    const worker = new Worker(workerURL, { type: 'module' });
    workers.add(worker);
    return worker;
  } };
  const root = createRoot(container);
  root.render(<App context={context} container={container} />);
  return () => {
    root.unmount();
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerURL);
    delete self.MonacoEnvironment;
  };
}
