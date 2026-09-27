import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Config, MachineState, Session } from './shared';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { UIContext } from '@shu/sdk/plugin';
import type { ShuAPI } from './shared';

let api: ShuAPI;

function TerminalPane({ machineId, session, active, connected, generation }: {
  machineId: string; session: Session; active: boolean; connected: boolean; generation: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
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
    terminal.current = term;
    fit.current = addon;
    let alive = true;
    let replaying = false;
    let ready = false;
    setError('');
    const sendSize = () => {
      if (alive && ready && !replaying) {
        void api.request(machineId, 'resize', { session_id: session.id, rows: term.rows, cols: term.cols }).catch((error: Error) => { if (alive) setError(error.message); });
      }
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
          if (element.current?.offsetWidth) { addon.fit(); sendSize(); }
        });
      } else if (event.event === 'output') {
        term.write(event.data);
      }
    });
    const input = term.onData((data) => {
      if (!ready || replaying) return;
      void api.request(machineId, 'input', { session_id: session.id, data }).catch((error: Error) => { if (alive) setError(error.message); });
    });
    const resize = term.onResize(sendSize);
    const observer = new ResizeObserver(() => {
      if (!replaying && element.current?.offsetWidth && element.current?.offsetHeight) addon.fit();
    });
    observer.observe(element.current!);
    if (connected) {
      void api.request(machineId, 'attach', { session_id: session.id }).then(() => {
        if (alive) { ready = true; sendSize(); }
      }).catch((error: Error) => { if (alive) setError(error.message); });
    }
    return () => {
      alive = false;
      ready = false;
      unsubscribe(); input.dispose(); resize.dispose(); observer.disconnect();
      term.dispose(); terminal.current = null;
      if (connected) void api.request(machineId, 'detach', { session_id: session.id }).catch(() => {});
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

function App() {
  const [config, setConfig] = useState<Config>();
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<{ machineId: string; left: number; top: number; trigger: HTMLElement }>();
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
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
  const sessions = state?.sessions ?? [];
  const active = selected && sessions.some((s) => s.id === selectedTabs[selected]) ? selectedTabs[selected] : sessions[0]?.id;
  const connected = state?.status === 'connected';

  const create = (machineId = selected) => {
    if (!machineId || states[machineId]?.status !== 'connected' || creating) return;
    setCreating(true); setError('');
    void api.request(machineId, 'create', { rows: 24, cols: 80 }).then((result) => {
      const session = result as Session;
      setSelectedTabs((tabs) => ({ ...tabs, [machineId]: session.id }));
    }).catch((error: Error) => setError(error.message)).finally(() => setCreating(false));
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === 't' && !settings) { event.preventDefault(); create(); }
      if (event.key === 'Escape') { setSettings(false); setMenu(undefined); menu?.trigger.focus(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });

  if (!config) return <div className="loading">{error || '正在打开 shū…'}</div>;
  return <div className="app">
    <aside className="sidebar">
      <nav aria-label="机器">{config.machines.map((item) => {
        const itemState = states[item.id];
        const itemConnected = itemState?.status === 'connected';
        return <section className="machine-group" aria-label={item.name} key={item.id}>
          <div className="machine-row" tabIndex={-1} onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ machineId: item.id, left: Math.max(0, Math.min(event.clientX, window.innerWidth - 132)), top: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)), trigger: event.currentTarget });
          }}>
            <button title={item.host ?? '本机'} aria-current={selected === item.id ? 'page' : undefined} className={`machine ${selected === item.id ? 'selected' : ''}`} onClick={() => {
              setConfig({ ...config, selected: item.id }); setError('');
              void api.selectMachine(item.id);
            }}><span className={`status-dot ${itemState?.status ?? 'disconnected'}`} /><span className="machine-name">{item.name}</span></button>
            <button className="new-tab" title={`在 ${item.name} 新建终端`} aria-label="新建终端" disabled={!itemConnected || creating} onClick={() => {
              setConfig({ ...config, selected: item.id });
              void api.selectMachine(item.id);
              create(item.id);
            }}>+</button>
          </div>
          <div className="tablist" role="tablist" aria-label={`${item.name} 终端`} aria-orientation="vertical">
            {(itemState?.sessions ?? []).map((session, index) => <div role="tab" aria-selected={selected === item.id && active === session.id} tabIndex={0} key={session.id} className={`tab ${selected === item.id && active === session.id ? 'selected' : ''}`} onClick={() => {
              setConfig({ ...config, selected: item.id }); setError('');
              setSelectedTabs((tabs) => ({ ...tabs, [item.id]: session.id }));
              void api.selectMachine(item.id);
            }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.currentTarget.click(); } }}>
              <span title={session.title}>终端 {index + 1}</span><button aria-label={`结束终端 ${index + 1}`} title="结束终端并关闭 tab" disabled={!itemConnected} onClick={(event) => {
                event.stopPropagation();
                void api.request(item.id, 'close', { session_id: session.id }).catch((error: Error) => setError(error.message));
              }}>×</button>
            </div>)}
          </div>
        </section>;
      })}</nav>
      <div className="sidebar-actions">
        <button className="settings-button" onClick={() => setSettings(true)}>机器设置</button>
      </div>
    </aside>
    <main>
      {(state?.error || error) && <div className="error-banner"><span>{error || state?.error}</span>{error && <button onClick={() => setError('')}>×</button>}</div>}
      <div className="terminal-area">
        {sessions.map((session) => <TerminalPane key={`${selected}:${session.id}`} machineId={selected!} session={session} active={session.id === active} connected={connected} generation={state?.generation ?? 0} />)}
      </div>
    </main>
    {menu && <div className="menu-backdrop" onClick={() => { setMenu(undefined); menu.trigger.focus(); }}>
      <div className="machine-menu" role="menu" aria-label="机器操作" style={{ left: menu.left, top: menu.top }} onClick={(event) => event.stopPropagation()}>
        <button role="menuitem" autoFocus onClick={() => {
          const status = states[menu.machineId]?.status;
          const action = status === 'connected' || status === 'connecting' ? api.disconnect(menu.machineId) : api.connect(menu.machineId);
          void action.catch((error: Error) => setError(error.message));
          setMenu(undefined); menu.trigger.focus();
        }}>{states[menu.machineId]?.status === 'connected' ? '断开' : states[menu.machineId]?.status === 'connecting' ? '取消连接' : '连接'}</button>
      </div>
    </div>}
    {settings && <Settings config={config} onUpdate={(config) => { setConfig(config); void api.connect(config.selected); }} onClose={() => setSettings(false)} />}
  </div>;
}

export function mount(container: HTMLElement, context: UIContext) {
  container.classList.add('shu-terminal');
  api = {
    config: () => context.request('config'),
    saveMachine: (machine) => context.request('save-machine', machine),
    removeMachine: (id) => context.request('remove-machine', id),
    selectMachine: (id) => context.request('select-machine', id),
    connect: (id) => context.request('connect', id),
    disconnect: (id) => context.request('disconnect', id),
    request: (id, op, params = {}) => context.request('terminal', { id, op, params }),
    onState: (callback) => context.on('state', callback),
    onTerminal: (callback) => context.on('terminal', callback),
  };
  const root = createRoot(container);
  root.render(<App />);
  return () => root.unmount();
}
