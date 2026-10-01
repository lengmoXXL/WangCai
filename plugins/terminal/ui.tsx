import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Profile, TerminalEvent } from '@wangcai/sdk';
import type { Context } from '@wangcai/sdk/channel';
import type { ActiveTerminal, Machine, TerminalRef } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';

export const title = '终端';

let profile: Profile;
let activeTerminal: ActiveTerminal | null = null;

function TerminalPane({ context, machine, sessionId, activation }: { context: Context; machine: Machine; sessionId: string; activation: number }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: profile.font.terminal.size, lineHeight: profile.font.terminal.lineHeight,
      fontFamily: profile.font.terminal.family,
      // xterm takes its scrollbar width from the overview ruler, which also paints the ruler outline.
      overviewRuler: { width: 10 },
      scrollback: 10_000,
      theme: { ...profile.theme, overviewRulerBorder: profile.theme.background, selectionBackground: profile.theme.selection },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element.current!);
    terminal.current = term;
    let alive = true;
    let replaying = false;
    let ready = false;
    const sendSize = () => {
      if (!alive || !ready || replaying) return;
      void context.ui.request('pty', { op: 'resize', sessionId, params: { rows: term.rows, cols: term.cols } }).catch((error: Error) => { if (alive) setError(error.message); });
    };
    const unsubscribe = context.ui.subscribe<TerminalEvent>('terminal', (event) => {
      if (!alive || event.session_id !== sessionId) return;
      if (event.event === 'snapshot') {
        replaying = true;
        term.reset();
        term.resize(event.cols, event.rows);
        term.write(event.data, () => {
          if (!alive) return;
          replaying = false;
          if (!element.current?.offsetWidth) return;
          addon.fit();
          sendSize();
        });
      } else {
        term.write(event.data);
      }
    });
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      void context.ui.request('pty', { op: 'input', sessionId, params: { data } }).catch((error: Error) => { if (alive) setError(error.message); });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current?.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    void context.ui.request('attach', { machine, sessionId }).then(() => {
      if (!alive) return;
      ready = true;
      sendSize();
    }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => {
      alive = false;
      unsubscribe(); input.dispose(); resize.dispose(); observer.disconnect(); term.dispose();
      terminal.current = null;
      void context.ui.request('pty', { op: 'detach', sessionId }).catch(() => {});
    };
  }, [context, machine, sessionId]);

  useEffect(() => {
    requestAnimationFrame(() => terminal.current?.focus());
  }, [activation]);

  return <div className="terminal-pane">
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error" role="alert">{error}</div>}
  </div>;
}

function openTab(context: Context, tab: TerminalRef & { workspaceId?: string }) {
  void context.host.request('tabs', {
    id: tab.sessionId, title: tab.label, tooltip: `${tab.machine.name}: ${tab.label}`, workspaceId: tab.workspaceId,
    onClose: () => { void context.ui.request('close', tab.sessionId).catch(() => {}); },
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      const root = createRoot(container);
      let activation = 0;
      return {
        onSelect: () => { root.render(<TerminalPane context={context} machine={tab.machine} sessionId={tab.sessionId} activation={++activation} />); },
        dispose: () => root.unmount(),
      };
    },
  });
}

function showMessage(context: Context, id: string, message: string, workspaceId?: string) {
  void context.host.request('tabs', {
    id, title: '终端', tooltip: message, workspaceId,
    mount(container: HTMLElement) {
      container.classList.add('wangcai-terminal');
      const text = document.createElement('div');
      text.className = 'terminal-message';
      text.textContent = message;
      container.append(text);
      return { dispose: () => text.remove() };
    },
  });
}

export function open(context: Context) {
  const terminal = activeTerminal;
  if (!terminal) {
    showMessage(context, 'message', '请先打开一个工作区终端');
    return;
  }
  void context.ui.request<TerminalRef>('open', terminal).then((tab) => {
    openTab(context, { ...tab, workspaceId: terminal.workspaceId });
  }).catch((error: Error) => showMessage(context, 'message', error.message, terminal.workspaceId));
}

export function restore(context: Context, records: { id: string; workspaceId?: string }[]) {
  for (const record of records) {
    if (record.id === 'message') {
      showMessage(context, 'message', '请先打开一个工作区终端', record.workspaceId);
      continue;
    }
    void context.ui.request<TerminalRef>('describe', record.id).then((tab) => {
      openTab(context, { ...tab, workspaceId: record.workspaceId });
    }).catch((error: Error) => showMessage(context, record.id, error.message, record.workspaceId));
  }
}

export async function mount(_container: HTMLElement, context: Context) {
  profile = await context.host.request<Profile>('config');
  const off = context.global.subscribe<ActiveTerminal | null>('terminal:active', (value) => { activeTerminal = value; });
  void context.global.publish('terminal:query', null);
  return off;
}
