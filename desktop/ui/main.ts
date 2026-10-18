import type { Dispose, TabContent, TabOptions, TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { previewMessage, previewUrl, uiFont } from '../shared';
import { installsPage } from './installs';
import { clampMenu, dragSource, onDragLeave, sidebarDividers, workspaceSidebar, type MenuAnchor } from './workspace-sidebar';
import './style.css';

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
  // The shell's own theme comes from the app, not from a plugin, so it is set before anything is drawn:
  // the plugin page is styled from its first moment even when a plugin still has to be cloned and built.
  const profile = await window.wangcai.config();
  for (const [token, color] of Object.entries(profile.theme)) document.documentElement.style.setProperty(`--wc-${token}`, color);
  document.documentElement.style.setProperty('--wc-font', uiFont);
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
  document.documentElement.style.colorScheme = r * 299 + g * 587 + b * 114 > 128_000 ? 'light' : 'dark';
  // The window is asked once per load, and followed for every change after that.
  const applyChrome = (fullscreen: unknown) => {
    if (fullscreen === true) document.documentElement.style.setProperty('--wc-chrome', '0px');
    else document.documentElement.style.removeProperty('--wc-chrome');
  };
  window.wangcai.subscribe('fullscreen', applyChrome);
  applyChrome(await window.wangcai.fullscreen());
  root.append(installsPage());
  const main = document.createElement('main');
  main.className = 'desktop-main';
  const plugins = await window.wangcai.plugins();
  // Nothing to load fills the pane rather than the window: the page above it is what reported the plugins
  // that are out.
  if (!plugins.length) main.textContent = '未安装插件';
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
  type Tab = { key: string; element: HTMLElement; button: HTMLButtonElement; panel: HTMLElement; content: TabContent; workspaceId?: string; onClose?(): void };
  let current = '';
  const selected = new Map<string, string>();
  const tabs = new Map<string, Tab>();
  const records = new Map<string, TabRecord>();
  let dragging: string | undefined;
  for (const record of await window.wangcai.loadTabs()) records.set(JSON.stringify([record.plugin, record.workspaceId ?? '', record.id]), record);

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
    if (!right.hidden) tabs.get(current)?.content.onSelect?.();
    viewMenu.hidePopover();
  };
  root.append(toggle, viewMenu);

  const show = (activeId: string | undefined) => {
    right.hidden = !tabs.size;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    for (const [key, tab] of tabs) {
      const visible = tab.workspaceId === undefined || tab.workspaceId === activeId;
      const isCurrent = key === current;
      tab.element.hidden = !visible;
      tab.button.setAttribute('aria-selected', String(isCurrent));
      tab.panel.hidden = !visible || !isCurrent;
    }
  };
  const select = (key: string, activeId: string | undefined) => {
    const tab = tabs.get(key);
    current = tab ? key : '';
    if (tab) selected.set(tab.workspaceId ?? '', key);
    show(activeId);
    tab?.content.onSelect?.();
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
  const settle = (activeId: string | undefined) => {
    void window.wangcai.saveTabs([...records.values()]);
    const wanted = selected.get(activeId ?? '') ?? selected.get('');
    current = wanted && tabs.has(wanted) ? wanted : '';
    show(activeId);
    tabs.get(current)?.content.onSelect?.();
  };
  const rebindTabs = (id: string) => {
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId !== undefined) continue;
      const record = records.get(key)!;
      const moved = JSON.stringify([record.plugin, id, record.id]);
      tabs.delete(key);
      tab.workspaceId = id;
      tab.key = moved;
      tabs.set(moved, tab);
      records.delete(key);
      records.set(moved, { ...record, workspaceId: id });
      if (selected.get('') === key) selected.set(id, moved);
    }
  };
  // A tab whose workspace a provider stopped serving goes with it.
  const closeGoneTabs = (ids: string[]) => {
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId === undefined || ids.includes(tab.workspaceId)) continue;
      removeTab(key);
    }
  };
  const providers = plugins.filter((plugin) => plugin.workspaces && !plugin.error).map((plugin) => plugin.id);
  const workspaceColumn = await workspaceSidebar({
    root,
    providers,
    tabs: { rebind: rebindTabs, close: closeGoneTabs, settle },
    closing: () => closing,
    disposers,
  });
  root.append(workspaceColumn.element, main, right);
  sidebarDividers(root, workspaceColumn.element, right, disposers);

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
        const workspaceId = options.workspaceId ?? workspaceColumn.activeId();
        const key = JSON.stringify([plugin.id, workspaceId ?? '', options.id]);
        records.set(key, { plugin: plugin.id, id: options.id, workspaceId });
        void window.wangcai.saveTabs([...records.values()]);
        const existing = tabs.get(key);
        if (existing) {
          void existing.content.dispose();
          existing.panel.replaceChildren();
          existing.content = options.mount(existing.panel);
          select(key, workspaceColumn.activeId());
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
        button.onclick = () => select(tab.key, workspaceColumn.activeId());
        close.onclick = () => {
          const siblings = [...tabs].filter(([, item]) => (item.workspaceId ?? '') === (tab.workspaceId ?? '')).map(([itemKey]) => itemKey);
          const index = siblings.indexOf(tab.key);
          removeTab(tab.key);
          void window.wangcai.saveTabs([...records.values()]);
          if (current === tab.key) select(siblings[index - 1] ?? siblings[index + 1] ?? '', workspaceColumn.activeId());
        };
        element.append(button, close);
        element.draggable = true;
        dragSource(element, () => { dragging = tab.key; }, () => { dragging = undefined; }, header);
        element.ondragover = (event) => {
          if (dragging === undefined || dragging === tab.key) return;
          event.preventDefault();
          const box = element.getBoundingClientRect();
          element.dataset.drop = event.clientX < box.left + box.width / 2 ? 'before' : 'after';
        };
        onDragLeave(element);
        element.ondrop = (event) => {
          event.preventDefault();
          const source = dragging!;
          const after = element.dataset.drop === 'after';
          const visible = [...tabs].filter(([, item]) => item.workspaceId === undefined || item.workspaceId === workspaceColumn.activeId());
          const before = after ? visible[visible.findIndex(([item]) => item === tab.key) + 1]?.[0] : tab.key;
          const reorder = <T>(map: Map<string, T>) => {
            if (source === before) return;
            const value = map.get(source)!;
            map.delete(source);
            if (before === undefined) { map.set(source, value); return; }
            const entries = [...map];
            map.clear();
            for (const [item, entry] of entries) {
              if (item === before) map.set(source, value);
              map.set(item, entry);
            }
          };
          reorder(tabs);
          reorder(records);
          header.insertBefore(tabs.get(source)!.element, before === undefined ? viewPicker : tabs.get(before)!.element);
          void window.wangcai.saveTabs([...records.values()]);
        };
        header.insertBefore(element, viewPicker);
        content.append(panel);
        tabs.set(key, tab);
        select(key, workspaceColumn.activeId());
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
          open: window.wangcai.open,
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
