import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fileLocation, registerFileLinks } from './links';
import type { WorkspaceApi } from './main';
import type { Config, Machine, MachineState, Session, WangcaiAPI, Workspace } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { Profile } from '@wangcai/sdk';
import type { Context } from '@wangcai/sdk/channel';

let api: WangcaiAPI;
let sidebar: HTMLElement;

function TerminalPane({ machineId, session, active, connected, generation, profile }: {
  machineId: string; session: Session; active: boolean; connected: boolean; generation: number; profile: Profile;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: profile.font.terminal.size, lineHeight: profile.font.terminal.lineHeight,
      fontFamily: profile.font.terminal.family,
      // xterm takes its scrollbar width from the overview ruler, which also paints the ruler outline.
      overviewRuler: { width: 10 },
      scrollback: 10_000, cols: session.cols, rows: session.rows,
      theme: { ...profile.theme, overviewRulerBorder: profile.theme.background, selectionBackground: profile.theme.selection },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element.current!);
    const links = registerFileLinks(term, (text) => {
      const location = fileLocation(text);
      if (location) void api.click(machineId, session.id, location).catch((error: Error) => setError(error.message));
    });
    terminal.current = term;
    fit.current = addon;
    let alive = true;
    let replaying = false;
    let ready = false;
    setError('');
    const sendSize = () => {
      if (!alive || !ready || replaying) return;
      void api.pty(machineId, 'resize', { session_id: session.id, rows: term.rows, cols: term.cols }).catch((error: Error) => { if (alive) setError(error.message); });
    };
    const unsubscribe = api.onTerminal((event) => {
      if (!alive || event.machineId !== machineId || event.session_id !== session.id) return;
      if (event.event === 'snapshot') {
        replaying = true;
        term.reset();
        term.resize(event.cols!, event.rows!);
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
      void api.pty(machineId, 'input', { session_id: session.id, data }).catch((error: Error) => { if (alive) setError(error.message); });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    if (connected) {
      void api.pty(machineId, 'attach', { session_id: session.id }).then(() => {
        if (!alive) return;
        ready = true;
        sendSize();
      }).catch((error: Error) => { if (alive) setError(error.message); });
    }
    return () => {
      alive = false;
      ready = false;
      unsubscribe(); input.dispose(); resize.dispose(); observer.disconnect();
      links.dispose(); term.dispose(); terminal.current = null;
      if (connected) void api.pty(machineId, 'detach', { session_id: session.id }).catch(() => {});
    };
  }, [machineId, session.id, connected, generation, profile]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [active, connected, generation]);

  return <div className={`terminal-pane ${active ? 'active' : ''}`}>
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error">{error}</div>}
    {session.exit_code !== null && <div className="terminal-message">进程已退出 · exit {session.exit_code}</div>}
  </div>;
}

function MachineForm({ machine, onUpdate, onClose }: { machine?: Machine; onUpdate: (config: Config) => void; onClose: () => void }) {
  const [name, setName] = useState(machine?.name ?? '');
  const [host, setHost] = useState(machine?.host ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="machine-form" role="dialog" aria-modal="true" aria-label={machine ? '编辑机器' : '添加机器'} onClick={(event) => event.stopPropagation()}>
      <header><h2>{machine ? '编辑机器' : '添加机器'}</h2><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      <form onSubmit={(event) => {
        event.preventDefault(); setSaving(true); setError('');
        void api.saveMachine({ id: machine?.id, name, host }).then((config) => { onUpdate(config); onClose(); }).catch((error: Error) => setError(error.message)).finally(() => setSaving(false));
      }}>
        <label>名称<input required placeholder="开发服务器" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>SSH Host<input required placeholder="dev-server 或 user@host" value={host} onChange={(event) => setHost(event.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={saving} type="submit">{saving ? '保存中…' : machine ? '保存修改' : '添加机器'}</button></footer>
      </form>
    </section>
  </div>;
}

type Menu = { left: number; top: number; trigger: HTMLElement; label?: string; kind: 'header' | 'machine' | 'workspace' | 'empty'; machineId?: string; workspaceId?: string };

function App({ context, profile }: { context: Context; profile: Profile }) {
  const [config, setConfig] = useState<Config>();
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ machine?: Machine }>();
  const [menu, setMenu] = useState<Menu>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const dragged = useRef<{ id: string; machineId: string }>(undefined);
  useEffect(() => {
    const off = api.onState((state) => setStates((states) => ({ ...states, [state.machineId]: state })));
    const offConfig = api.onConfig(setConfig);
    void api.config().then(setConfig).catch((error: Error) => setError(error.message));
    return () => { off(); offConfig(); };
  }, []);
  const selected = config?.selected;
  const machine = config?.machines.find((m) => m.id === selected);
  useEffect(() => {
    if (selected) void api.connect(selected).then((state) => setStates((states) => ({ ...states, [selected]: state }))).catch((error: Error) => setError(error.message));
  }, [selected, machine?.host]);
  const state = selected ? states[selected] : undefined;
  const workspaces = (config?.workspaces ?? []).filter((workspace) => workspace.machineId === selected);
  const sessionFor = (workspace: Workspace) => (states[workspace.machineId]?.sessions ?? []).find((session) => session.id === workspace.sessionId);
  const liveSession = (session: Session | undefined) => session?.exit_code === null ? session : undefined;
  const activeWorkspaceId = selected ? selectedWorkspaces[selected] : undefined;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const activeWorkspaceSession = activeWorkspace ? sessionFor(activeWorkspace) : undefined;
  const activeSession = liveSession(activeWorkspaceSession);
  const connected = state?.status === 'connected';
  const generation = state?.generation ?? 0;
  const errorMessage = error || state?.error;
  useEffect(() => {
    const publish = () => context.global.publish('terminal:active', connected && machine && activeSession && activeWorkspace ? { machine, sessionId: activeSession.id, workspaceId: activeWorkspace.id } : null);
    void publish();
    return context.global.subscribe('terminal:query', publish);
  }, [context, machine, activeSession?.id, activeWorkspace?.id, connected]);
  const workspaceIdKey = config?.workspaces.map((workspace) => workspace.id).join(' ');
  useEffect(() => {
    if (workspaceIdKey === undefined) return;
    void context.global.publish('workspace:list', workspaceIdKey === '' ? [] : workspaceIdKey.split(' '));
  }, [context, workspaceIdKey]);

  const selectWorkspace = (machineId: string, workspaceId: string) => {
    setSelectedWorkspaces((workspaces) => ({ ...workspaces, [machineId]: workspaceId }));
    if (states[machineId]?.status !== 'connected' || busy) return;
    setBusy(true);
    void api.openWorkspace(machineId, workspaceId)
      .then((result) => setConfig(result.config))
      .catch((error: Error) => setError(error.message))
      .finally(() => setBusy(false));
  };
  const createWorkspace = (machineId = selected) => {
    if (!machineId || states[machineId]?.status !== 'connected' || busy) return;
    setBusy(true); setError('');
    void api.openWorkspace(machineId).then((result) => {
      setConfig(result.config);
      setSelectedWorkspaces((workspaces) => ({ ...workspaces, [machineId]: result.workspaceId }));
    }).catch((error: Error) => setError(error.message)).finally(() => setBusy(false));
  };
  const openMenu = (event: MouseEvent<HTMLElement>, target: Omit<Menu, 'left' | 'top' | 'trigger'>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ ...target, trigger: event.currentTarget, left: event.clientX, top: event.clientY });
  };
  const closeMenu = () => {
    if (!menu) return;
    setMenu(undefined);
    menu.trigger.focus();
  };
  const menuElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menuElement.current;
    if (!menu || !node) return;
    node.style.left = `${Math.max(8, Math.min(menu.left, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.top, window.innerHeight - node.offsetHeight - 8))}px`;
  }, [menu]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === 't' && !form) { event.preventDefault(); createWorkspace(); }
      if (event.key === 'Escape') { closeMenu(); setForm(undefined); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });

  if (!config) return <div className="loading">{error || '正在打开 旺财…'}</div>;
  const selectMachine = (machineId: string) => {
    setError('');
    setConfig({ ...config, selected: machineId });
    void api.selectMachine(machineId);
  };
  const applyConfig = (config: Config) => {
    setConfig(config);
    void api.connect(config.selected);
  };
  const menuMachine = config.machines.find((item) => item.id === menu?.machineId);
  const menuWorkspace = config.workspaces.find((workspace) => workspace.id === menu?.workspaceId);
  const menuItems: ({ label: string; hint?: string; disabled?: boolean; run: () => void } | { separator: true })[] = [];
  if (menu?.kind === 'header') menuItems.push({ label: '添加机器…', run: () => setForm({}) });
  if (menu?.kind === 'machine' && menuMachine) {
    const status = states[menuMachine.id]?.status ?? 'disconnected';
    menuItems.push({ label: `在 ${menuMachine.name} 新建工作区`, hint: '⌘T', disabled: status !== 'connected' || busy, run: () => { selectMachine(menuMachine.id); createWorkspace(menuMachine.id); } });
    menuItems.push({ label: status === 'connected' ? '断开连接' : status === 'connecting' ? '取消连接' : `连接 ${menuMachine.name}`, run: () => { void (status === 'disconnected' ? api.connect(menuMachine.id) : api.disconnect(menuMachine.id)).catch((error: Error) => setError(error.message)); } });
    if (menuMachine.id !== 'local') {
      menuItems.push({ separator: true });
      menuItems.push({ label: '编辑机器…', run: () => setForm({ machine: menuMachine }) });
      menuItems.push({ label: '移除机器…', run: () => { void api.removeMachine(menuMachine.id).then(applyConfig).catch((error: Error) => setError(error.message)); } });
    }
  }
  if (menu?.kind === 'workspace' && menuWorkspace) {
    const workspaceConnected = states[menuWorkspace.machineId]?.status === 'connected';
    if (!liveSession(sessionFor(menuWorkspace))) menuItems.push({ label: '重新打开终端', disabled: !workspaceConnected || busy, run: () => selectWorkspace(menuWorkspace.machineId, menuWorkspace.id) });
    menuItems.push({ label: '关闭工作区', disabled: !workspaceConnected, run: () => { void api.closeWorkspace(menuWorkspace.id).then(setConfig).catch((error: Error) => setError(error.message)); } });
  }
  if (menu?.kind === 'empty') {
    menuItems.push({ label: '新建工作区', hint: '⌘T', disabled: !connected || busy, run: () => createWorkspace() });
    menuItems.push({ label: '添加机器…', run: () => setForm({}) });
  }

  return <div className="app">
    {createPortal(<div className="sidebar" onContextMenu={(event) => openMenu(event, { kind: 'empty' })}>
      <div className="sidebar-header" onContextMenu={(event) => openMenu(event, { kind: 'header' })}>工作区</div>
      <nav aria-label="工作区">{config.machines.map((item) => {
        const itemStatus = states[item.id]?.status ?? 'disconnected';
        const itemSelected = selected === item.id;
        const machineWorkspaces = config.workspaces.filter((workspace) => workspace.machineId === item.id);
        return <section className="machine-group" key={item.id}>
          <button title={item.host ?? '本机'} aria-current={itemSelected ? 'page' : undefined} className={`machine ${itemStatus} ${itemSelected ? 'current' : ''}`} onClick={() => selectMachine(item.id)} onContextMenu={(event) => openMenu(event, { kind: 'machine', label: item.name, machineId: item.id })}>
            <svg className="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.2 2.4h11.6v4.5H2.2zM2.2 9.1h11.6v4.5H2.2z" /><path d="M4.8 4.6h4.4M4.8 11.3h4.4" /></svg>
            <span className="machine-name">{item.name}</span>
          </button>
          <div role="tablist" aria-label={`${item.name} 工作区`} aria-orientation="vertical" className={`workspaces ${itemStatus === 'connected' ? '' : 'offline'}`}>
            {machineWorkspaces.map((workspace, index) => {
              const current = itemSelected && activeWorkspace?.id === workspace.id;
              const label = workspace.name ?? `工作区 ${index + 1}`;
              const dropHere = drop?.id === workspace.id ? `drop-${drop.after ? 'after' : 'before'}` : '';
              return <div role="tab" aria-selected={current} tabIndex={0} key={workspace.id} draggable className={`workspace ${current ? 'selected' : ''} ${liveSession(sessionFor(workspace)) ? 'running' : ''} ${dropHere}`} onDragStart={(event) => {
                dragged.current = { id: workspace.id, machineId: item.id };
                event.dataTransfer.effectAllowed = 'move';
              }} onDragEnd={() => { dragged.current = undefined; setDrop(undefined); }} onDragLeave={() => setDrop(undefined)} onDragOver={(event) => {
                const moving = dragged.current;
                if (!moving || moving.id === workspace.id || moving.machineId !== item.id) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                setDrop({ id: workspace.id, after: event.clientY > box.top + box.height / 2 });
              }} onDrop={(event) => {
                const moving = dragged.current!;
                event.preventDefault();
                const after = drop?.id === workspace.id && drop.after;
                const before = after ? machineWorkspaces[index + 1]?.id : workspace.id;
                void api.moveWorkspace(moving.id, before).then(setConfig).catch((error: Error) => setError(error.message));
              }} onClick={() => {
                selectMachine(item.id);
                selectWorkspace(item.id, workspace.id);
              }} onContextMenu={(event) => openMenu(event, { kind: 'workspace', label, workspaceId: workspace.id })} onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                event.currentTarget.click();
              }}>
                <svg className="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.6 3.2c0-.6.5-1.1 1.1-1.1h3l1.1 1.4h5.5c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1z" /></svg>
                <span className="name">{label}</span>
              </div>;
            })}
          </div>
        </section>;
      })}</nav>
    </div>, sidebar)}
    <main>
      {errorMessage && <div className="error-banner"><span>{errorMessage}</span>{error && <button onClick={() => setError('')}>×</button>}</div>}
      <div className="terminal-area">
        {workspaces.map((workspace) => {
          const session = sessionFor(workspace);
          return session ? <TerminalPane key={`${workspace.id}:${session.id}`} machineId={selected!} session={session} active={workspace.id === activeWorkspace?.id} connected={connected} generation={generation} profile={profile} /> : null;
        })}
        {activeWorkspace && !activeSession && <div className="terminal-message">
          {!activeWorkspaceSession && '终端未运行'}
          <button onClick={() => selectWorkspace(activeWorkspace.machineId, activeWorkspace.id)}>重新打开终端</button>
        </div>}
      </div>
    </main>
    {menu && <div className="menu-backdrop" onClick={closeMenu}>
      <div className="context-menu" ref={menuElement} role="menu" aria-label="操作" onClick={(event) => event.stopPropagation()}>
        {menu.label && <strong>{menu.label}</strong>}
        {menuItems.map((item, index) => 'separator' in item
          ? <hr key={index} />
          : <button key={item.label} role="menuitem" autoFocus={index === 0} disabled={item.disabled} onClick={() => { closeMenu(); item.run(); }}>{item.label}{item.hint && <span>{item.hint}</span>}</button>)}
      </div>
    </div>}
    {form && <MachineForm machine={form.machine} onUpdate={applyConfig} onClose={() => setForm(undefined)} />}
  </div>;
}

export async function mount(container: HTMLElement, context: Context) {
  container.classList.add('wangcai-workspace');
  sidebar = await context.host.request<HTMLElement>('sidebar');
  sidebar.classList.add('wangcai-workspace');
  const call = <K extends keyof WorkspaceApi>(method: K, params?: Parameters<WorkspaceApi[K]>[0]) => context.ui.request<Awaited<ReturnType<WorkspaceApi[K]>>>(method, params);
  api = {
    click: (id, sessionId, location) => call('click', { id, sessionId, location }),
    config: () => call('config'),
    saveMachine: (machine) => call('save-machine', machine),
    removeMachine: (id) => call('remove-machine', id),
    selectMachine: (id) => call('select-machine', id),
    connect: (id) => call('connect', id),
    disconnect: (id) => call('disconnect', id),
    openWorkspace: (machineId, workspaceId) => call('open-workspace', { machineId, workspaceId }),
    closeWorkspace: (id) => call('close-workspace', id),
    moveWorkspace: (id, before) => call('move-workspace', { id, before }),
    pty: (id, op, params = {}) => call('pty', { id, op, params }),
    onConfig: (callback) => context.ui.subscribe('config', callback),
    onState: (callback) => context.ui.subscribe('state', callback),
    onTerminal: (callback) => context.ui.subscribe('terminal', callback),
  };
  const profile = await context.host.request<Profile>('config');
  const root = createRoot(container);
  root.render(<App context={context} profile={profile} />);
  return () => root.unmount();
}
