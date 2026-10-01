import type { Channel, Context } from '@wangcai/sdk/channel';
import { denied, previewMessage, previewUrl, type Dispose, type TabRecord } from '../shared';
import './style.css';

type TabContent = { dispose: Dispose; onSelect?(): void };
type TabOptions = { id: string; title: string; tooltip?: string; workspaceId?: string; onClose?(): void; mount(container: HTMLElement): TabContent };

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

async function start() {
  const plugins = await window.wangcai.plugins();
  const profile = await window.wangcai.config();
  for (const [token, color] of Object.entries(profile.theme)) document.documentElement.style.setProperty(`--wc-${token}`, color);
  document.documentElement.style.setProperty('--wc-font', profile.font.ui.family);
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
  document.documentElement.style.colorScheme = r * 299 + g * 587 + b * 114 > 128_000 ? 'light' : 'dark';
  if (!plugins.length) root.textContent = '未安装插件';
  const left = document.createElement('aside');
  left.className = 'desktop-sidebar sidebar-left';
  left.setAttribute('aria-label', '左侧边栏');
  left.hidden = true;
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
    ['left', left, right, 140], ['right', right, left, 260],
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
  const persist = () => { void window.wangcai.saveTabs([...records.values()]); };
  for (const record of await window.wangcai.loadTabs()) records.set(tabKey(record.plugin, record.id, record.workspaceId), record);
  const show = () => {
    right.hidden = !tabs.size;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    for (const [key, tab] of tabs) {
      const visible = tab.workspaceId === undefined || tab.workspaceId === activeWorkspaceId;
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
  disposers.push(window.wangcai.subscribe('workspace:list', (value) => {
    const workspaceIds = new Set(value as string[]);
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId === undefined || workspaceIds.has(tab.workspaceId)) continue;
      if (activeWorkspaceId === tab.workspaceId) activeWorkspaceId = undefined;
      removeTab(key);
    }
    settle();
  }));
  disposers.push(window.wangcai.subscribe('terminal:active', (value) => {
    const next = (value as { workspaceId?: string } | null)?.workspaceId;
    if (next === undefined || next === activeWorkspaceId) return;
    activeWorkspaceId = next;
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId !== undefined) continue;
      const record = records.get(key)!;
      const moved = tabKey(record.plugin, record.id, next);
      tabs.delete(key);
      tab.workspaceId = next;
      tab.key = moved;
      tabs.set(moved, tab);
      records.delete(key);
      records.set(moved, { ...record, workspaceId: next });
      if (selected.get(group()) === key) selected.set(group(next), moved);
    }
    settle();
  }));
  const picker = document.createElement('button');
  picker.className = 'view-picker';
  picker.textContent = '+';
  picker.setAttribute('aria-label', '新建侧栏标签页');
  const menu = document.createElement('div');
  menu.id = 'view-menu';
  menu.className = 'view-menu';
  menu.popover = 'auto';
  menu.setAttribute('aria-label', '视图');
  picker.popoverTargetElement = menu;
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const bounds = picker.getBoundingClientRect();
    menu.style.top = `${bounds.bottom + 4}px`;
    menu.style.left = `${Math.min(bounds.left, window.innerWidth - 132)}px`;
  });
  header.append(picker);
  const toggle = document.createElement('button');
  toggle.className = 'sidebar-toggle';
  toggle.textContent = '◧';
  toggle.setAttribute('aria-label', '切换右侧栏');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
    right.hidden = !right.hidden;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    if (!right.hidden) refresh();
    menu.hidePopover();
  };
  root.append(toggle, menu);
  for (const plugin of plugins) {
    if (!plugin.error && !plugin.ui) continue;
    const container = document.createElement('section');
    container.className = 'plugin';
    container.dataset.plugin = plugin.id;
    main.append(container);
    const subscriptions = new Set<() => void>();
    let stylesheet: HTMLLinkElement | undefined;
    let dispose: Dispose | undefined;
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
      let sidebar: HTMLElement | undefined;
      const sidebarSlot = () => {
        if (sidebar) return sidebar;
        sidebar = document.createElement('section');
        sidebar.className = 'sidebar-slot';
        sidebar.dataset.plugin = plugin.id;
        left.append(sidebar);
        left.hidden = false;
        return sidebar;
      };
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
        header.insertBefore(element, picker);
        content.append(panel);
        tabs.set(key, tab);
        select(key);
      };
      const context: Context = {
        global: {
          publish: window.wangcai.publish,
          subscribe(topic, callback) {
            const off = window.wangcai.subscribe(topic, callback as (data: unknown) => void);
            subscriptions.add(off);
            return () => { off(); subscriptions.delete(off); };
          },
          request: denied('global', 'request'),
          handle: denied('global', 'handle'),
        },
        ui: {
          publish: denied('ui', 'publish'),
          subscribe(topic, callback) {
            const off = window.wangcai.on((id, event, data) => { if (id === plugin.id && event === topic) callback(data as never); });
            subscriptions.add(off);
            return () => { off(); subscriptions.delete(off); };
          },
          request: (method, params) => window.wangcai.request(plugin.id, method, params),
          handle: denied('ui', 'handle'),
        },
        host: {
          publish: denied('host', 'publish'),
          subscribe: denied('host', 'subscribe'),
          request: (async (topic: string, params?: unknown) => {
            if (topic === 'sidebar') return sidebarSlot();
            if (topic === 'config') return profile;
            if (topic === 'tabs') return openTab(params as TabOptions);
            if (topic === 'preview') return { url: previewUrl, message: previewMessage };
            throw new Error(`Unsupported host topic: ${topic}`);
          }) as Channel['request'],
          handle: denied('host', 'handle'),
        },
      };
      const module = await import(/* @vite-ignore */ plugin.ui!);
      if (module.open) container.hidden = true;
      dispose = await module.mount(container, context);
      const pluginRecords = [...records.values()].filter((record) => record.plugin === plugin.id);
      if (module.restore && pluginRecords.length) await module.restore(context, pluginRecords);
      if (module.open) {
        const item = document.createElement('button');
        item.textContent = module.title ?? plugin.id;
        item.onclick = () => { module.open(context); menu.hidePopover(); };
        menu.append(item);
      }
      const cleanup = async () => {
        for (const off of subscriptions) off();
        await dispose?.();
        stylesheet?.remove();
        container.remove();
        sidebar?.remove();
      };
      if (closing) await cleanup(); else disposers.push(cleanup);
    } catch (error) {
      for (const off of subscriptions) off();
      await dispose?.();
      stylesheet?.remove();
      container.hidden = false;
      container.className = 'plugin-error';
      container.textContent = `${plugin.id}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  disposers.push(() => { for (const tab of tabs.values()) void tab.content.dispose(); tabs.clear(); });
}
void start().catch((error) => { root.textContent = String(error); });
