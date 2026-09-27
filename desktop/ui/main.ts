import type { Dispose, TabContent, UIContext } from '@wangcai/sdk/plugin';
import './style.css';

const root = document.getElementById('root')!;
const disposers: Dispose[] = [];
let closing = false;
window.addEventListener('beforeunload', () => {
  closing = true;
  for (const dispose of disposers.reverse()) void dispose();
});

async function start() {
  const plugins = await window.wangcai.plugins();
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
  const tabs = new Map<string, { button: HTMLButtonElement; panel: HTMLElement; content: TabContent }>();
  let selected = '';
  const select = (id: string) => {
    selected = id;
    right.hidden = !tabs.size;
    toggle.setAttribute('aria-expanded', String(!right.hidden));
    for (const [key, tab] of tabs) {
      tab.panel.hidden = key !== id;
      tab.button.setAttribute('aria-selected', String(key === id));
    }
    tabs.get(id)?.content.onSelect?.();
    tabs.get(id)?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
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
    if (!right.hidden) tabs.get(selected)?.content.onSelect?.();
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
      const context: UIContext = {
        get sidebar() {
          if (sidebar) return sidebar;
          sidebar = document.createElement('section');
          sidebar.className = 'sidebar-slot';
          sidebar.dataset.plugin = plugin.id;
          left.append(sidebar);
          left.hidden = false;
          return sidebar;
        },
        tabs: { open(options) {
          const key = JSON.stringify([plugin.id, options.id]);
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
          button.onclick = () => select(key);
          const close = document.createElement('button');
          close.className = 'close-tab';
          close.textContent = '×';
          close.setAttribute('aria-label', `关闭 ${options.title}`);
          close.onclick = () => {
            const keys = [...tabs.keys()];
            const index = keys.indexOf(key);
            void tabs.get(key)!.content.dispose();
            tabs.delete(key);
            panel.remove(); element.remove();
            if (selected === key) select(keys[index - 1] ?? keys[index + 1] ?? '');
          };
          element.append(button, close);
          header.insertBefore(element, picker);
          const panel = document.createElement('section');
          panel.className = 'sidebar-panel';
          panel.dataset.plugin = plugin.id;
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-label', options.title);
          content.append(panel);
          tabs.set(key, { button, panel, content: options.mount(panel) });
          select(key);
        } },
        publish: window.wangcai.publish,
        subscribe(event, callback) {
          const off = window.wangcai.subscribe(event, callback);
          subscriptions.add(off);
          return () => { off(); subscriptions.delete(off); };
        },
        request: (method, params) => window.wangcai.request(plugin.id, method, params),
        on(event, callback) {
          const off = window.wangcai.on((id, name, data) => { if (id === plugin.id && name === event) callback(data as never); });
          subscriptions.add(off);
          return () => { off(); subscriptions.delete(off); };
        },
      };
      const module = await import(/* @vite-ignore */ plugin.ui!);
      if (module.open) container.hidden = true;
      dispose = await module.mount(container, context);
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
