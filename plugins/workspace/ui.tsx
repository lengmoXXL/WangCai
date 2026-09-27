import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fileLocation, registerFileLinks } from './links';
import type { Config, MachineState, Session, WangcaiAPI, Workspace } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { UIContext } from '@wangcai/sdk/plugin';

let api: WangcaiAPI;

function TerminalPane({ machineId, session, active, connected, generation }: {
  machineId: string; session: Session; active: boolean; connected: boolean; generation: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, lineHeight: 1.25,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
      scrollback: 10_000, cols: session.cols, rows: session.rows,
      theme: { background: '#11151b', foreground: '#d9e0e9', cursor: '#9bc7bc', selectionBackground: '#35534e', black: '#26303a', blue: '#86a9de', green: '#9bc7bc', red: '#e68c8c', yellow: '#e4c590' },
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
  }, [machineId, session.id, connected, generation]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [active, connected, generation]);

  return <div className={`terminal-pane ${active ? 'active' : ''}`}>
    <div className="terminal-surface" ref={element} />
    {error && <div className="terminal-message error">{error}</div>}
    {session.exit_code !== null && <div className="terminal-message">进程已退出 · exit {session.exit_code}</div>}
  </div>;
}

function Settings({ config, onUpdate, onClose }: { config: Config; onUpdate: (config: Config) => void; onClose: () => void }) {
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const reset = () => { setEditing(undefined); setName(''); setHost(''); setError(''); };
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="settings" role="dialog" aria-modal="true" aria-label="机器设置" onClick={(event) => event.stopPropagation()}>
      <header><h2>机器设置</h2><button className="icon-button" onClick={onClose} aria-label="关闭设置">×</button></header>
      <div className="machine-settings-list">
        {config.machines.filter((machine) => machine.host).map((machine) => <div className="machine-setting" key={machine.id}>
          <span><strong>{machine.name}</strong>{machine.host !== machine.name && <small>{machine.host}</small>}</span>
          <div className="actions">
            <button onClick={() => { setEditing(machine.id); setName(machine.name); setHost(machine.host!); setError(''); }}>编辑</button>
            <button onClick={() => { void api.removeMachine(machine.id).then((config) => { onUpdate(config); if (editing === machine.id) reset(); }).catch((error: Error) => setError(error.message)); }}>移除</button>
          </div>
        </div>)}
      </div>
      <form onSubmit={(event) => {
        event.preventDefault(); setSaving(true); setError('');
        void api.saveMachine({ id: editing, name, host }).then((config) => { onUpdate(config); reset(); }).catch((error: Error) => setError(error.message)).finally(() => setSaving(false));
      }}>
        <label>名称<input required placeholder="开发服务器" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>SSH Host<input required placeholder="dev-server 或 user@host" value={host} onChange={(event) => setHost(event.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <footer>{editing && <button type="button" onClick={reset}>取消编辑</button>}<button className="primary" disabled={saving} type="submit">{saving ? '保存中…' : editing ? '保存修改' : '添加机器'}</button></footer>
      </form>
    </section>
  </div>;
}

function App({ context }: { context: UIContext }) {
  const [config, setConfig] = useState<Config>();
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<{ machineId: string; left: number; top: number; trigger: HTMLElement }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const off = api.onState((state) => setStates((states) => ({ ...states, [state.machineId]: state })));
    void api.config().then(setConfig).catch((error: Error) => setError(error.message));
    return off;
  }, []);
  const selected = config?.selected;
  const machine = config?.machines.find((m) => m.id === selected);
  useEffect(() => {
    if (selected) void api.connect(selected).then((state) => setStates((states) => ({ ...states, [selected]: state }))).catch((error: Error) => setError(error.message));
  }, [selected, machine?.host]);
  const state = selected ? states[selected] : undefined;
  const workspaces = (config?.workspaces ?? []).filter((workspace) => workspace.machineId === selected);
  const sessionFor = (workspace: Workspace) => (states[workspace.machineId]?.sessions ?? []).find((session) => session.id === workspace.sessionId);
  const liveSession = (workspace: Workspace) => {
    const session = sessionFor(workspace);
    return session?.exit_code === null ? session : undefined;
  };
  const activeWorkspaceId = selected ? selectedWorkspaces[selected] : undefined;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const activeSession = activeWorkspace ? liveSession(activeWorkspace) : undefined;
  const connected = state?.status === 'connected';
  const menuStatus = menu ? states[menu.machineId]?.status : undefined;
  const menuConnected = menuStatus === 'connected' || menuStatus === 'connecting';
  const generation = state?.generation ?? 0;
  const errorMessage = error || state?.error;
  useEffect(() => {
    const publish = () => context.publish('terminal:active', connected && machine && activeSession ? { machine, sessionId: activeSession.id } : null);
    void publish();
    return context.subscribe('terminal:query', publish);
  }, [context, machine, activeSession?.id, connected]);

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
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === 't' && !settings) { event.preventDefault(); createWorkspace(); }
      if (event.key === 'Escape') { setSettings(false); setMenu(undefined); menu?.trigger.focus(); }
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
  return <div className="app">
    {createPortal(<div className="sidebar">
      <nav aria-label="机器">{config.machines.map((item) => {
        const itemStatus = states[item.id]?.status ?? 'disconnected';
        const itemSelected = selected === item.id;
        const itemConnected = itemStatus === 'connected';
        return <section className="machine-group" aria-label={item.name} key={item.id}>
          <div className="machine-row" tabIndex={-1} onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ machineId: item.id, left: Math.max(0, Math.min(event.clientX, window.innerWidth - 132)), top: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)), trigger: event.currentTarget });
          }}>
            <button title={item.host ?? '本机'} aria-current={itemSelected ? 'page' : undefined} className={`machine ${itemSelected ? 'selected' : ''}`} onClick={() => selectMachine(item.id)}><span className={`status-dot ${itemStatus}`} /><span className="machine-name">{item.name}</span></button>
            <button className="new-tab" title={`在 ${item.name} 新建工作区`} aria-label="新建工作区" disabled={!itemConnected || busy} onClick={() => {
              selectMachine(item.id);
              createWorkspace(item.id);
            }}>+</button>
          </div>
          <div role="tablist" aria-label={`${item.name} 工作区`} aria-orientation="vertical">
            {config.workspaces.filter((workspace) => workspace.machineId === item.id).map((workspace, index) => {
              const current = itemSelected && activeWorkspace?.id === workspace.id;
              const number = index + 1;
              return <div role="tab" aria-selected={current} tabIndex={0} key={workspace.id} className={`tab ${current ? 'selected' : ''}`} onClick={() => {
                selectMachine(item.id);
                selectWorkspace(item.id, workspace.id);
              }} onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                event.currentTarget.click();
              }}>
                <span className="tab-label"><span className={`status-dot ${liveSession(workspace) ? 'connected' : 'disconnected'}`} />工作区 {number}</span><button aria-label={`结束工作区 ${number}`} disabled={!itemConnected} onClick={(event) => {
                  event.stopPropagation();
                  void api.closeWorkspace(workspace.id).then(setConfig).catch((error: Error) => setError(error.message));
                }}>×</button>
              </div>;
            })}
          </div>
        </section>;
      })}</nav>
      <div className="sidebar-actions">
        <button className="settings-button" onClick={() => setSettings(true)}>机器设置</button>
      </div>
    </div>, context.sidebar)}
    <main>
      {errorMessage && <div className="error-banner"><span>{errorMessage}</span>{error && <button onClick={() => setError('')}>×</button>}</div>}
      <div className="terminal-area">
        {workspaces.map((workspace) => {
          const session = sessionFor(workspace);
          return session ? <TerminalPane key={`${workspace.id}:${session.id}`} machineId={selected!} session={session} active={workspace.id === activeWorkspace?.id} connected={connected} generation={generation} /> : null;
        })}
        {activeWorkspace && !sessionFor(activeWorkspace) && <div className="terminal-message">终端未运行，点击左侧工作区重建</div>}
      </div>
    </main>
    {menu && <div className="menu-backdrop" onClick={() => { setMenu(undefined); menu.trigger.focus(); }}>
      <div className="machine-menu" role="menu" aria-label="机器操作" style={{ left: menu.left, top: menu.top }} onClick={(event) => event.stopPropagation()}>
        <button role="menuitem" autoFocus onClick={() => {
          void (menuConnected ? api.disconnect(menu.machineId) : api.connect(menu.machineId)).catch((error: Error) => setError(error.message));
          setMenu(undefined); menu.trigger.focus();
        }}>{menuStatus === 'connected' ? '断开' : menuStatus === 'connecting' ? '取消连接' : '连接'}</button>
      </div>
    </div>}
    {settings && <Settings config={config} onUpdate={(config) => { setConfig(config); void api.connect(config.selected); }} onClose={() => setSettings(false)} />}
  </div>;
}

export function mount(container: HTMLElement, context: UIContext) {
  container.classList.add('wangcai-workspace');
  context.sidebar.classList.add('wangcai-workspace');
  api = {
    click: (id, sessionId, location) => context.request('click', { id, sessionId, location }),
    config: () => context.request('config'),
    saveMachine: (machine) => context.request('save-machine', machine),
    removeMachine: (id) => context.request('remove-machine', id),
    selectMachine: (id) => context.request('select-machine', id),
    connect: (id) => context.request('connect', id),
    disconnect: (id) => context.request('disconnect', id),
    openWorkspace: (machineId, workspaceId) => context.request('open-workspace', { machineId, workspaceId }),
    closeWorkspace: (id) => context.request('close-workspace', id),
    pty: (id, op, params = {}) => context.request('pty', { id, op, params }),
    onState: (callback) => context.on('state', callback),
    onTerminal: (callback) => context.on('terminal', callback),
  };
  const root = createRoot(container);
  root.render(<App context={context} />);
  return () => root.unmount();
}
