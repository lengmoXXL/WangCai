import type { TabContent, TabOptions, TabRecord } from '@lengmoxxl/sdk/channel';
import { clampMenu, dragSource, onDragLeave, type MenuAnchor } from './layout';

export async function sidebarTabs(root: HTMLElement) {
  // Scroll events do not bubble, so only a capture-phase listener can see the sidebar panels scroll.
  const SCROLLBAR_IDLE = 700;
  const idleTimers = new WeakMap<Element, number>();
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('.sidebar-right')) return;
    target.dataset.scrolling = '';
    clearTimeout(idleTimers.get(target));
    idleTimers.set(target, window.setTimeout(() => delete target.dataset.scrolling, SCROLLBAR_IDLE));
  };
  document.addEventListener('scroll', onScroll, true);

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
  let active: string | undefined;
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

  const show = () => {
    right.hidden = !tabs.size;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    for (const [key, tab] of tabs) {
      const visible = tab.workspaceId === undefined || tab.workspaceId === active;
      const isCurrent = key === current;
      tab.element.hidden = !visible;
      tab.button.setAttribute('aria-selected', String(isCurrent));
      tab.panel.hidden = !visible || !isCurrent;
    }
  };
  const select = (key: string) => {
    const tab = tabs.get(key);
    current = tab ? key : '';
    if (tab) selected.set(tab.workspaceId ?? '', key);
    show();
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
    active = activeId;
    void window.wangcai.saveTabs([...records.values()]);
    const wanted = selected.get(activeId ?? '') ?? selected.get('');
    current = wanted && tabs.has(wanted) ? wanted : '';
    show();
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

  const open = (plugin: string, options: TabOptions) => {
    const workspaceId = options.workspaceId ?? active;
    const key = JSON.stringify([plugin, workspaceId ?? '', options.id]);
    records.set(key, { plugin, id: options.id, workspaceId });
    void window.wangcai.saveTabs([...records.values()]);
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
    panel.dataset.plugin = plugin;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', options.title);
    const tab: Tab = { key, element, button, panel, workspaceId, onClose: options.onClose, content: options.mount(panel) };
    button.onclick = () => select(tab.key);
    close.onclick = () => {
      const siblings = [...tabs].filter(([, item]) => (item.workspaceId ?? '') === (tab.workspaceId ?? '')).map(([itemKey]) => itemKey);
      const index = siblings.indexOf(tab.key);
      removeTab(tab.key);
      void window.wangcai.saveTabs([...records.values()]);
      if (current === tab.key) select(siblings[index - 1] ?? siblings[index + 1] ?? '');
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
      const visible = [...tabs].filter(([, item]) => item.workspaceId === undefined || item.workspaceId === active);
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
    select(key);
  };

  return {
    element: right,
    rebind: rebindTabs,
    close: closeGoneTabs,
    settle,
    open,
    addView(title: string, open: () => void) {
      const item = document.createElement('button');
      item.textContent = title;
      item.onclick = () => { open(); viewMenu.hidePopover(); };
      viewMenu.append(item);
    },
    async restore(open: (record: TabRecord) => Promise<void> | undefined) {
      for (const record of records.values()) await open(record);
    },
    dispose() {
      document.removeEventListener('scroll', onScroll, true);
      for (const tab of tabs.values()) void tab.content.dispose();
      tabs.clear();
    },
  };
}
