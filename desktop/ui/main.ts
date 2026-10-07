import type { WorkspaceMenuItem, WorkspaceRow } from '@lengmoxxl/sdk';
import type { Dispose, TabContent, TabOptions, TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { previewMessage, previewUrl, uiFont, type InstallStage, type InstallStatus } from '../shared';
import './style.css';

type MenuAnchor = { left: number; top: number };

const root = document.getElementById('root')!;
const disposers: Dispose[] = [];
let closing = false;
window.addEventListener('beforeunload', () => {
  closing = true;
  for (const dispose of disposers.reverse()) void dispose();
});
// Scroll events do not bubble, so only a capture-phase listener can see the sidebar panels scroll.
const SCROLLBAR_IDLE = 700;
const idleTimers = new WeakMap<Element, number>();
document.addEventListener('scroll', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest('.sidebar-right')) return;
  target.dataset.scrolling = '';
  clearTimeout(idleTimers.get(target));
  idleTimers.set(target, window.setTimeout(() => delete target.dataset.scrolling, SCROLLBAR_IDLE));
}, true);

const stageNames: Record<InstallStage, string> = { cloning: '克隆中', installing: '安装依赖', building: '构建中', ready: '就绪', failed: '失败' };

/** The plugin page: what each plugin init.ts lists is doing, and why one failed. */
function installsPage() {
  const element = document.createElement('section');
  element.className = 'installs';
  element.hidden = true;
  element.setAttribute('aria-label', '插件');
  const heading = document.createElement('h1');
  heading.textContent = '插件';
  const list = document.createElement('ul');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.onclick = () => { element.hidden = true; };
  element.append(heading, list, close);
  // A plugin with something left to do opens the page; it stays until it is closed, so a failure is read.
  const update = (statuses: InstallStatus[]) => {
    list.replaceChildren(...statuses.map(({ id, stage, message }) => {
      const row = document.createElement('li');
      row.dataset.stage = stage;
      const name = document.createElement('span');
      name.className = 'install-id';
      name.textContent = id;
      const state = document.createElement('span');
      state.className = 'install-stage';
      state.textContent = stageNames[stage];
      row.append(name, state);
      if (message) {
        const detail = document.createElement('p');
        detail.className = 'install-message';
        detail.textContent = message;
        row.append(detail);
      }
      return row;
    }));
    if (statuses.some(({ stage }) => stage !== 'ready')) element.hidden = false;
  };
  return { element, update };
}

async function start() {
  // The shell's own theme comes from the app, not from a plugin, so it is set before anything is drawn:
  // the plugin page is styled from its first moment even when a plugin still has to be cloned and built.
  const profile = await window.wangcai.config();
  for (const [token, color] of Object.entries(profile.theme)) document.documentElement.style.setProperty(`--wc-${token}`, color);
  document.documentElement.style.setProperty('--wc-font', uiFont);
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
  document.documentElement.style.colorScheme = r * 299 + g * 587 + b * 114 > 128_000 ? 'light' : 'dark';
  window.wangcai.subscribe('fullscreen', (value) => document.documentElement.toggleAttribute('data-fullscreen', value === true));
  const installs = installsPage();
  window.wangcai.subscribe('plugin-page', () => { installs.element.hidden = false; });
  window.wangcai.subscribe('install-statuses', (statuses) => installs.update(statuses as InstallStatus[]));
  installs.update(await window.wangcai.installs());
  root.append(installs.element);
  // This resolves once every repository has been installed and every plugin has loaded.
  const plugins = await window.wangcai.plugins();
  if (!plugins.length) root.textContent = '未安装插件';
  const left = document.createElement('aside');
  left.className = 'desktop-sidebar sidebar-left';
  const main = document.createElement('main');
  main.className = 'desktop-main';
  const right = document.createElement('aside');
  right.className = 'desktop-sidebar sidebar-right';
  right.setAttribute('aria-label', '右侧边栏');
  right.hidden = true;
  const header = document.createElement('header');
  header.className = 'sidebar-tabs';
  header.setAttribute('role', 'tablist');
  header.setAttribute('aria-label', '侧栏标签页');
  const content = document.createElement('div');
  content.className = 'sidebar-content';
  right.append(header, content);
  root.append(left, main, right);
  const stored = JSON.parse(localStorage.getItem('sidebar-ratios') ?? '{}') as { left?: number; right?: number };
  const ratios = {
    left: stored.left ?? 180 / root.clientWidth,
    right: stored.right ?? Math.min(600, root.clientWidth * .4) / root.clientWidth,
  };
  for (const [side, pane, opposite, minimum] of [
    ['left', left, right, 120], ['right', right, left, 260],
  ] as const) {
    const divider = document.createElement('div');
    divider.className = `sidebar-divider divider-${side}`;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', side === 'left' ? '调整左侧栏宽度' : '调整右侧栏宽度');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.tabIndex = 0;
    if (side === 'left') left.after(divider); else right.before(divider);
    let painted: number;
    const paint = (requested = root.clientWidth * ratios[side]) => {
      const maximum = Math.max(minimum, root.clientWidth - (opposite.hidden ? 0 : opposite.getBoundingClientRect().width) - 248);
      painted = Math.round(Math.max(minimum, Math.min(maximum, requested)));
      pane.style.width = `${painted}px`;
      divider.hidden = pane.hidden;
      divider.setAttribute('aria-valuemin', String(minimum));
      divider.setAttribute('aria-valuemax', String(Math.round(maximum)));
      divider.setAttribute('aria-valuenow', String(painted));
      return painted;
    };
    const resize = (requested: number) => {
      ratios[side] = paint(requested) / root.clientWidth;
      localStorage.setItem('sidebar-ratios', JSON.stringify(ratios));
    };
    const observer = new ResizeObserver(() => paint());
    observer.observe(root);
    observer.observe(pane);
    observer.observe(opposite);
    disposers.push(() => observer.disconnect());
    let origin: number;
    let width: number;
    divider.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      origin = event.clientX;
      width = painted;
      divider.setPointerCapture(event.pointerId);
    };
    divider.onpointermove = (event) => {
      if (divider.hasPointerCapture(event.pointerId)) resize(width + (event.clientX - origin) * (side === 'left' ? 1 : -1));
    };
    divider.onpointerup = (event) => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); };
    divider.onkeydown = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resize(painted + (event.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1));
    };
    paint();
  }
  type Tab = { key: string; element: HTMLElement; button: HTMLButtonElement; panel: HTMLElement; content: TabContent; workspaceId?: string; onClose?(): void };
  const group = (workspaceId?: string) => workspaceId ?? '';
  let activeWorkspaceId: string | undefined;
  let current = '';
  const selected = new Map<string, string>();
  const tabKey = (plugin: string, id: string, workspaceId?: string) => JSON.stringify([plugin, group(workspaceId), id]);
  const tabs = new Map<string, Tab>();
  const records = new Map<string, TabRecord>();
  let dragging: string | undefined;
  const reorder = <T>(map: Map<string, T>, key: string, before: string | undefined) => {
    if (key === before) return;
    const value = map.get(key)!;
    map.delete(key);
    if (before === undefined) { map.set(key, value); return; }
    const entries = [...map];
    map.clear();
    for (const [item, entry] of entries) {
      if (item === before) map.set(key, value);
      map.set(item, entry);
    }
  };
  const visibleTab = (tab: Tab) => tab.workspaceId === undefined || tab.workspaceId === activeWorkspaceId;
  const persist = () => { void window.wangcai.saveTabs([...records.values()]); };
  for (const record of await window.wangcai.loadTabs()) records.set(tabKey(record.plugin, record.id, record.workspaceId), record);
  const show = () => {
    right.hidden = !tabs.size;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    for (const [key, tab] of tabs) {
      const visible = visibleTab(tab);
      const isCurrent = key === current;
      tab.element.hidden = !visible;
      tab.button.setAttribute('aria-selected', String(isCurrent));
      tab.panel.hidden = !visible || !isCurrent;
    }
  };
  const refresh = () => tabs.get(current)?.content.onSelect?.();
  const select = (key: string) => {
    const tab = tabs.get(key);
    current = tab ? key : '';
    if (tab) selected.set(group(tab.workspaceId), key);
    show();
    refresh();
    tab?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const removeTab = (key: string) => {
    const tab = tabs.get(key)!;
    tab.onClose?.();
    void tab.content.dispose();
    tab.element.remove();
    tab.panel.remove();
    tabs.delete(key);
    records.delete(key);
  };
  const settle = () => {
    persist();
    const wanted = selected.get(group(activeWorkspaceId)) ?? selected.get(group());
    current = wanted && tabs.has(wanted) ? wanted : '';
    show();
    refresh();
  };
  // The workspace view draws the rows every provider holds, and the menu offers what they can create.
  const providers = plugins.filter((plugin) => plugin.workspaces && !plugin.error).map((plugin) => plugin.id);
  const grouped = new Map(providers.map((id) => [id, [] as WorkspaceRow[]]));
  const listed = () => providers.flatMap((provider) => grouped.get(provider)!);
  const providerOf = (id: string) => providers.find((provider) => grouped.get(provider)!.some((row) => row.id === id));
  let draggingRow: string | undefined;
  const workspaceHeader = document.createElement('header');
  workspaceHeader.className = 'workspace-header';
  const workspaceTitle = document.createElement('span');
  workspaceTitle.textContent = '工作区';
  workspaceHeader.append(workspaceTitle);
  const workspaceList = document.createElement('nav');
  workspaceList.className = 'workspaces';
  workspaceList.setAttribute('role', 'tablist');
  workspaceList.setAttribute('aria-label', '工作区');
  workspaceList.setAttribute('aria-orientation', 'vertical');
  left.append(workspaceHeader, workspaceList);
  // The menu carries what to open, and how to close the workspace it was opened on.
  const rowMenu = document.createElement('div');
  rowMenu.id = 'workspace-row-menu';
  rowMenu.className = 'view-menu';
  rowMenu.setAttribute('role', 'menu');
  rowMenu.setAttribute('aria-label', '工作区');
  const rowBackdrop = document.createElement('div');
  rowBackdrop.className = 'menu-scrim';
  rowBackdrop.hidden = true;
  rowBackdrop.append(rowMenu);
  root.append(rowBackdrop);
  let menuRow: string | undefined;
  const hideRowMenu = () => { rowBackdrop.hidden = true; menuRow = undefined; };
  // A click on an entry belongs to the entry, which decides for itself when the menu goes away.
  rowBackdrop.onclick = (event) => { if (!rowMenu.contains(event.target as Node)) hideRowMenu(); };
  const escapeRowMenu = (event: KeyboardEvent) => { if (event.key === 'Escape') hideRowMenu(); };
  document.addEventListener('keydown', escapeRowMenu);
  disposers.push(() => document.removeEventListener('keydown', escapeRowMenu));
  // A menu is as large as its entries, so where it fits is only known once they are in the DOM.
  const clampMenu = (menu: HTMLElement, at: MenuAnchor) => {
    menu.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(at.top, window.innerHeight - menu.offsetHeight - 4))}px`;
  };
  const showRowMenu = (at: MenuAnchor, row: string | undefined) => {
    menuRow = row;
    // The anchor is set before the menu is on screen.
    rowMenu.replaceChildren();
    rowMenu.style.left = `${at.left}px`;
    rowMenu.style.top = `${at.top}px`;
    rowBackdrop.hidden = false;
    void fillRowMenu(at);
  };

  const fillRowMenu = async (at: MenuAnchor) => {
    const entries: { provider: string; item: WorkspaceMenuItem }[] = [];
    for (const provider of providers) {
      try {
        for (const item of await window.wangcai.request<WorkspaceMenuItem[]>(provider, 'workspace-menu')) entries.push({ provider, item });
      } catch (error) {
        if (!closing) console.error(error);
      }
    }
    const closeId = menuRow;
    const items: HTMLElement[] = [];
    if (closeId !== undefined) {
      const button = document.createElement('button');
      button.setAttribute('role', 'menuitem');
      button.textContent = '关闭工作区';
      button.onclick = () => {
        const provider = providerOf(closeId);
        hideRowMenu();
        if (provider) void window.wangcai.request(provider, 'workspace-close', { id: closeId }).then(refreshRows).catch(console.error);
      };
      items.push(button);
    }
    for (const { provider, item } of entries) {
      const button = document.createElement('button');
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      const hint = document.createElement('span');
      hint.textContent = item.hint ?? '';
      button.append(hint);
      button.disabled = Boolean(item.error);
      if (item.error) button.title = item.error;
      button.onclick = async () => {
        button.disabled = true;
        hint.textContent = '连接中…';
        try {
          const created = await window.wangcai.request<{ id: string }>(provider, 'workspace-create', { key: item.key });
          hideRowMenu();
          await refreshRows();
          selectWorkspace(created.id);
        } catch (error) {
          // A failed attempt keeps the entry listed, greyed out, with the reason in the hint and on hover.
          hint.textContent = error instanceof Error ? error.message : String(error);
          button.title = hint.textContent;
        }
      };
      items.push(button);
    }
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'menu-empty';
      empty.textContent = '没有可用的工作区';
      items.push(empty);
    }
    rowMenu.replaceChildren(...items);
    clampMenu(rowMenu, at);
  };
  // A right-click on the heading or on empty list space opens the menu with no row to close.
  const openRowMenu = (event: MouseEvent) => {
    event.preventDefault();
    const row = (event.target as Element).closest<HTMLElement>('.workspace');
    showRowMenu({ left: event.clientX, top: event.clientY }, row?.dataset.workspace);
  };
  workspaceHeader.oncontextmenu = openRowMenu;
  workspaceList.oncontextmenu = openRowMenu;

  const selectWorkspace = (id: string) => {
    const provider = providerOf(id);
    if (!provider) return;
    activeWorkspaceId = id;
    // Tabs opened before any workspace existed belong to the one now in front.
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId !== undefined) continue;
      const record = records.get(key)!;
      const moved = tabKey(record.plugin, record.id, id);
      tabs.delete(key);
      tab.workspaceId = id;
      tab.key = moved;
      tabs.set(moved, tab);
      records.delete(key);
      records.set(moved, { ...record, workspaceId: id });
      if (selected.get(group()) === key) selected.set(group(id), moved);
    }
    showRows();
    settle();
    void window.wangcai.request(provider, 'workspace-select', { id }).catch(console.error);
  };

  const refreshRows = async () => {
    // The window is going away: a plugin that already disposed itself is not a failed refresh.
    if (closing) return;
    for (const provider of providers) {
      try {
        grouped.set(provider, await window.wangcai.request<WorkspaceRow[]>(provider, 'workspaces'));
      } catch (error) {
        // A provider that cannot answer keeps the rows it had: a lost reply must not close its workspaces.
        if (!closing) console.error(error);
      }
    }
    if (closing) return;
    const served = new Set(listed().map((row) => row.id));
    // A workspace that is gone takes its tabs with it.
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId === undefined || served.has(tab.workspaceId)) continue;
      if (activeWorkspaceId === tab.workspaceId) activeWorkspaceId = undefined;
      removeTab(key);
    }
    if (activeWorkspaceId === undefined || !served.has(activeWorkspaceId)) {
      const first = listed()[0];
      if (first) {
        selectWorkspace(first.id);
        return;
      }
    }
    showRows();
    settle();
  };

  // A drag cancelled with Escape never reaches dragleave or drop, so the target keeps its marker.
  const clearDrop = (container: HTMLElement) => {
    for (const node of container.querySelectorAll<HTMLElement>('[data-drop]')) delete node.dataset.drop;
  };

  const showRows = () => {
    workspaceList.replaceChildren(...listed().map((row) => {
      const element = document.createElement('div');
      element.className = `workspace${row.id === activeWorkspaceId ? ' selected' : ''}${row.running ? ' running' : ''}`;
      element.setAttribute('role', 'tab');
      element.setAttribute('aria-selected', String(row.id === activeWorkspaceId));
      element.setAttribute('aria-label', `${row.label} · ${row.machine}`);
      element.dataset.workspace = row.id;
      element.tabIndex = 0;
      element.draggable = true;
      element.innerHTML = '<svg class="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.6 3.2c0-.6.5-1.1 1.1-1.1h3l1.1 1.4h5.5c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1z"/></svg>';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.label;
      element.append(name);
      element.onclick = () => selectWorkspace(row.id);
      element.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectWorkspace(row.id);
      };
      element.ondragstart = (event) => {
        draggingRow = row.id;
        event.dataTransfer!.effectAllowed = 'move';
      };
      element.ondragend = () => {
        draggingRow = undefined;
        clearDrop(workspaceList);
      };
      element.ondragover = (event) => {
        const source = draggingRow;
        if (source === undefined || source === row.id || providerOf(source) !== providerOf(row.id)) return;
        event.preventDefault();
        const box = element.getBoundingClientRect();
        element.dataset.drop = event.clientY > box.top + box.height / 2 ? 'after' : 'before';
      };
      element.ondragleave = () => { delete element.dataset.drop; };
      element.ondrop = (event) => {
        event.preventDefault();
        const moved = draggingRow!;
        const after = element.dataset.drop === 'after';
        draggingRow = undefined;
        clearDrop(workspaceList);
        const rows = listed();
        const before = after ? rows[rows.findIndex((item) => item.id === row.id) + 1]?.id : row.id;
        const provider = providerOf(moved);
        if (provider) void window.wangcai.request(provider, 'workspace-move', { id: moved, before }).catch(console.error);
      };
      return element;
    }));
  };

  const viewPicker = document.createElement('button');
  viewPicker.className = 'view-picker';
  viewPicker.textContent = '+';
  viewPicker.setAttribute('aria-label', '新建侧栏标签页');
  const viewMenu = document.createElement('div');
  viewMenu.id = 'view-menu';
  viewMenu.className = 'view-menu';
  viewMenu.popover = 'auto';
  viewPicker.popoverTargetElement = viewMenu;
  const pickerAnchor = (): MenuAnchor => {
    const bounds = viewPicker.getBoundingClientRect();
    return { left: bounds.left, top: bounds.bottom + 4 };
  };
  viewMenu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const at = pickerAnchor();
    viewMenu.style.left = `${at.left}px`;
    viewMenu.style.top = `${at.top}px`;
  });
  viewMenu.addEventListener('toggle', (event) => {
    if (event.newState !== 'open') return;
    clampMenu(viewMenu, pickerAnchor());
  });
  header.append(viewPicker);
  const toggle = document.createElement('button');
  toggle.className = 'sidebar-toggle';
  toggle.textContent = '◧';
  toggle.setAttribute('aria-label', '切换右侧栏');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
    right.hidden = !right.hidden;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    if (!right.hidden) refresh();
    viewMenu.hidePopover();
  };
  root.append(toggle, viewMenu);
  disposers.push(window.wangcai.subscribe('workspaces', () => void refreshRows()));
  void refreshRows();
  const opens = new Map<string, (record: TabRecord) => Promise<void>>();
  for (const plugin of plugins) {
    if (!plugin.error && !plugin.ui) continue;
    const container = document.createElement('section');
    container.className = 'plugin';
    container.dataset.plugin = plugin.id;
    main.append(container);
    const subscriptions = new Set<() => void>();
    let stylesheet: HTMLLinkElement | undefined;
    let dispose: Dispose | undefined;
    const fail = async (error: unknown) => {
      for (const off of subscriptions) off();
      await dispose?.();
      stylesheet?.remove();
      container.hidden = false;
      container.className = 'plugin-error';
      container.textContent = `${plugin.id}: ${error instanceof Error ? error.message : String(error)}`;
    };
    try {
      if (plugin.error) throw new Error(plugin.error);
      if (plugin.css) {
        stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = plugin.css;
        const loaded = new Promise<void>((resolve, reject) => {
          stylesheet!.onload = () => resolve();
          stylesheet!.onerror = () => reject(new Error('Cannot load plugin stylesheet'));
        });
        document.head.append(stylesheet);
        await loaded;
      }
      const openTab = (options: TabOptions) => {
        const workspaceId = options.workspaceId ?? activeWorkspaceId;
        const key = tabKey(plugin.id, options.id, workspaceId);
        const record: TabRecord = { plugin: plugin.id, id: options.id, workspaceId };
        records.set(key, record);
        persist();
        const existing = tabs.get(key);
        if (existing) {
          void existing.content.dispose();
          existing.panel.replaceChildren();
          existing.content = options.mount(existing.panel);
          select(key);
          return;
        }
        const element = document.createElement('div');
        element.className = 'sidebar-tab';
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.textContent = options.title;
        button.title = options.tooltip ?? options.title;
        const close = document.createElement('button');
        close.className = 'close-tab';
        close.textContent = '×';
        close.setAttribute('aria-label', `关闭 ${options.title}`);
        const panel = document.createElement('section');
        panel.className = 'sidebar-panel';
        panel.dataset.plugin = plugin.id;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-label', options.title);
        const tab: Tab = { key, element, button, panel, workspaceId, onClose: options.onClose, content: options.mount(panel) };
        button.onclick = () => select(tab.key);
        close.onclick = () => {
          const siblings = [...tabs].filter(([, item]) => group(item.workspaceId) === group(tab.workspaceId)).map(([itemKey]) => itemKey);
          const index = siblings.indexOf(tab.key);
          removeTab(tab.key);
          persist();
          if (current === tab.key) select(siblings[index - 1] ?? siblings[index + 1] ?? '');
        };
        element.append(button, close);
        element.draggable = true;
        element.ondragstart = (event) => {
          dragging = tab.key;
          event.dataTransfer!.effectAllowed = 'move';
        };
        element.ondragend = () => {
          dragging = undefined;
          clearDrop(header);
        };
        element.ondragover = (event) => {
          if (dragging === undefined || dragging === tab.key) return;
          event.preventDefault();
          const box = element.getBoundingClientRect();
          element.dataset.drop = event.clientX < box.left + box.width / 2 ? 'before' : 'after';
        };
        element.ondragleave = () => { delete element.dataset.drop; };
        element.ondrop = (event) => {
          event.preventDefault();
          const source = dragging!;
          const after = element.dataset.drop === 'after';
          const visible = [...tabs].filter(([, item]) => visibleTab(item));
          const before = after ? visible[visible.findIndex(([item]) => item === tab.key) + 1]?.[0] : tab.key;
          reorder(tabs, source, before);
          reorder(records, source, before);
          header.insertBefore(tabs.get(source)!.element, before === undefined ? viewPicker : tabs.get(before)!.element);
          persist();
        };
        header.insertBefore(element, viewPicker);
        content.append(panel);
        tabs.set(key, tab);
        select(key);
      };
      const context: UiContext = {
        global: {
          publish: window.wangcai.publish,
          subscribe(topic, callback) {
            const off = window.wangcai.subscribe(topic, callback as (data: unknown) => void);
            subscriptions.add(off);
            return () => { off(); subscriptions.delete(off); };
          },
        },
        ui: {
          request: (method, params) => window.wangcai.request(plugin.id, method, params),
          subscribe(topic, callback) {
            const off = window.wangcai.subscribe(`${plugin.id}:${topic}`, callback as (data: unknown) => void);
            subscriptions.add(off);
            return () => { off(); subscriptions.delete(off); };
          },
        },
        host: {
          config: { ...profile, ...plugin.config },
          preview: { url: previewUrl, message: previewMessage },
          tabs: openTab,
        },
      };
      const module = await import(/* @vite-ignore */ plugin.ui!);
      if (module.open) container.hidden = true;
      dispose = await module.mount(container, context);
      if (module.open) {
        const item = document.createElement('button');
        item.textContent = module.title ?? plugin.id;
        item.onclick = () => { void module.open(context); viewMenu.hidePopover(); };
        viewMenu.append(item);
        opens.set(plugin.id, async (record) => {
          try { await module.open(context, record); } catch (error) { await fail(error); }
        });
      }
      const cleanup = async () => {
        for (const off of subscriptions) off();
        await dispose?.();
        stylesheet?.remove();
        container.remove();
      };
      if (closing) await cleanup(); else disposers.push(cleanup);
    } catch (error) {
      await fail(error);
    }
  }
  for (const record of records.values()) await opens.get(record.plugin)?.(record);
  disposers.push(() => { for (const tab of tabs.values()) void tab.content.dispose(); tabs.clear(); });
}
void start().catch((error) => { root.textContent = String(error); });
