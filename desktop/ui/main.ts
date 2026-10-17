import type { WorkspaceMenuItem, WorkspaceRow } from '@lengmoxxl/sdk';
import type { Dispose, TabContent, TabOptions, TabRecord, UiContext } from '@lengmoxxl/sdk/channel';
import { previewMessage, previewUrl, uiFont, type WorkspaceGroup } from '../shared';
import { installsPage } from './installs';
import { sidebarDividers } from './sidebar';
import './style.css';

type MenuAnchor = { left: number; top: number };
type RenameTarget = { kind: 'workspace' | 'group'; id: string };

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
  window.wangcai.subscribe('fullscreen', (value) => document.documentElement.toggleAttribute('data-fullscreen', value === true));
  root.append(installsPage());
  const left = document.createElement('aside');
  left.className = 'desktop-sidebar sidebar-left';
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
  root.append(left, main, right);
  sidebarDividers(root, left, right, disposers);
  type Tab = { key: string; element: HTMLElement; button: HTMLButtonElement; panel: HTMLElement; content: TabContent; workspaceId?: string; onClose?(): void };
  let activeWorkspaceId: string | undefined;
  let current = '';
  const selected = new Map<string, string>();
  const tabs = new Map<string, Tab>();
  const records = new Map<string, TabRecord>();
  let dragging: string | undefined;
  for (const record of await window.wangcai.loadTabs()) records.set(JSON.stringify([record.plugin, record.workspaceId ?? '', record.id]), record);
  const groups = await window.wangcai.loadGroups();
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
  const settle = () => {
    void window.wangcai.saveTabs([...records.values()]);
    const wanted = selected.get(activeWorkspaceId ?? '') ?? selected.get('');
    current = wanted && tabs.has(wanted) ? wanted : '';
    show();
    tabs.get(current)?.content.onSelect?.();
  };
  const providers = plugins.filter((plugin) => plugin.workspaces && !plugin.error).map((plugin) => plugin.id);
  const rowsByProvider = new Map(providers.map((id) => [id, [] as WorkspaceRow[]]));
  const providerOf = (id: string) => providers.find((provider) => rowsByProvider.get(provider)!.some((row) => row.id === id));
  // A group only decides which workspaces sit together.
  const groupOf = (id: string) => groups.find((group) => group.workspaces.includes(id));
  const groupById = (id: string) => groups.find((group) => group.id === id);
  const servedRows = () => providers.flatMap((provider) => rowsByProvider.get(provider)!);
  const topRows = (rows: WorkspaceRow[]) => rows.filter((row) => !groupOf(row.id));
  // A missing count reads as Infinity, so the slot comparison stays a number comparison.
  const rowsAbove = (group: WorkspaceGroup) => group.after ?? Infinity;
  let draggingRow: string | undefined;
  let draggingGroup: string | undefined;
  // A drag is handled once, so the id it carries is taken before any branch below can return early.
  const takenRow = () => { const id = draggingRow!; draggingRow = undefined; return id; };
  const takenGroup = () => { const id = draggingGroup!; draggingGroup = undefined; return id; };
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
  const hideRowMenu = () => { rowBackdrop.hidden = true; };
  // A click on an entry belongs to the entry, which decides for itself when the menu goes away.
  rowBackdrop.onclick = (event) => { if (!rowMenu.contains(event.target as Node)) hideRowMenu(); };
  const escapeOverlays = (event: KeyboardEvent) => { if (event.key === 'Escape') { hideRename(); hideRowMenu(); } };
  document.addEventListener('keydown', escapeOverlays);
  disposers.push(() => document.removeEventListener('keydown', escapeOverlays));
  // A menu is as large as its entries, so where it fits is only known once they are in the DOM.
  const clampMenu = (menu: HTMLElement, at: MenuAnchor) => {
    menu.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(at.top, window.innerHeight - menu.offsetHeight - 4))}px`;
  };

  const openRowMenu = async (event: MouseEvent) => {
    event.preventDefault();
    const at = { left: event.clientX, top: event.clientY };
    const target = event.target as Element;
    const menuRow = target.closest<HTMLElement>('.workspace')?.dataset.workspace;
    // A row inside a group answers as a row, so the group is only asked when no row was hit.
    const menuGroup = menuRow === undefined ? target.closest<HTMLElement>('.workspace-group')?.dataset.group : undefined;
    rowMenu.replaceChildren();
    rowMenu.style.left = `${at.left}px`;
    rowMenu.style.top = `${at.top}px`;
    rowBackdrop.hidden = false;
    const items: HTMLElement[] = [];
    const entry = (label: string, action: () => void) => {
      const button = document.createElement('button');
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.onclick = action;
      return button;
    };
    // A row's menu acts on that row, a group's menu on that group, and what can be opened belongs to the space
    // around them.
    if (menuRow === undefined && menuGroup === undefined) {
      for (const provider of providers) {
        let menuItems: WorkspaceMenuItem[];
        try {
          menuItems = await window.wangcai.request<WorkspaceMenuItem[]>(provider, 'workspace-menu');
        } catch (error) {
          if (!closing) console.error(error);
          continue;
        }
        for (const item of menuItems) {
          const hint = document.createElement('span');
          hint.textContent = item.hint ?? '';
          const button = entry(`新建 ${item.label}`, async () => {
            button.disabled = true;
            hint.textContent = '连接中…';
            try {
              const created = await window.wangcai.request<{ id: string }>(provider, 'workspace-create', { key: item.key });
              hideRowMenu();
              await refreshRows();
              selectWorkspace(created.id);
            } catch (error) {
              hint.textContent = error instanceof Error ? error.message : String(error);
              button.title = hint.textContent;
              button.disabled = false;
            }
          });
          button.append(hint);
          if (item.error) button.title = item.error;
          items.push(button);
        }
      }
      // A group gathers workspaces, so with no workspace at all there is nothing to make one for.
      if (servedRows().length > 0) items.push(entry('新建分组', () => { hideRowMenu(); createGroup(); }));
    } else if (menuGroup !== undefined) {
      items.push(
        entry('重命名分组', () => { hideRowMenu(); openRename({ kind: 'group', id: menuGroup }); }),
        entry('删除分组', () => { hideRowMenu(); removeGroup(menuGroup); }),
      );
    } else if (menuRow !== undefined) {
      const rowGroup = groupOf(menuRow);
      items.push(entry('重命名', () => { hideRowMenu(); openRename({ kind: 'workspace', id: menuRow }); }));
      if (rowGroup) items.push(entry('移出分组', () => { hideRowMenu(); fileRow(menuRow); }));
      for (const other of groups) {
        if (other.id !== rowGroup?.id) items.push(entry(`移入 ${other.name}`, () => { hideRowMenu(); fileRow(menuRow, other.id); }));
      }
      items.push(entry('关闭工作区', () => {
        const provider = providerOf(menuRow);
        hideRowMenu();
        if (provider) void window.wangcai.request(provider, 'workspace-close', { id: menuRow }).then(refreshRows).catch(console.error);
      }));
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
  workspaceHeader.oncontextmenu = openRowMenu;
  workspaceList.oncontextmenu = openRowMenu;

  // A workspace row is a draggable tab and a group bar folds where it stands, so renaming either asks in a
  // dialog rather than in place.
  const renameScrim = document.createElement('div');
  renameScrim.className = 'menu-scrim rename-scrim';
  renameScrim.hidden = true;
  const renameDialog = document.createElement('form');
  renameDialog.className = 'rename-dialog';
  renameDialog.setAttribute('role', 'dialog');
  const renameInput = document.createElement('input');
  renameInput.className = 'rename-input';
  const renameNote = document.createElement('p');
  renameNote.className = 'rename-note';
  renameNote.setAttribute('role', 'alert');
  const renameCancel = document.createElement('button');
  renameCancel.type = 'button';
  renameCancel.textContent = '取消';
  const renameSubmit = document.createElement('button');
  renameSubmit.type = 'submit';
  renameSubmit.textContent = '重命名';
  const renameActions = document.createElement('div');
  renameActions.className = 'rename-actions';
  renameActions.append(renameCancel, renameSubmit);
  renameDialog.append(renameInput, renameNote, renameActions);
  renameScrim.append(renameDialog);
  root.append(renameScrim);
  let renameTarget: RenameTarget | undefined;
  const hideRename = () => { renameScrim.hidden = true; renameTarget = undefined; };
  const openRename = (target: RenameTarget) => {
    renameTarget = target;
    const forGroup = target.kind === 'group';
    renameDialog.setAttribute('aria-label', forGroup ? '重命名分组' : '重命名工作区');
    renameInput.setAttribute('aria-label', forGroup ? '分组名称' : '工作区名字');
    renameInput.placeholder = forGroup ? '' : '留空则恢复默认名字';
    renameInput.value = forGroup
      ? groupById(target.id)!.name
      : servedRows().find((row) => row.id === target.id)?.label ?? '';
    renameNote.textContent = '';
    renameScrim.hidden = false;
    renameInput.focus();
    renameInput.select();
  };
  renameScrim.onclick = (event) => { if (!renameDialog.contains(event.target as Node)) hideRename(); };
  renameCancel.onclick = hideRename;
  renameDialog.onsubmit = async (event) => {
    event.preventDefault();
    const target = renameTarget;
    if (!target) return;
    renameSubmit.disabled = true;
    try {
      if (target.kind === 'group') {
        const name = renameInput.value.trim();
        if (!name) {
          renameNote.textContent = '分组名称不能为空';
          return;
        }
        renameGroup(target.id, name);
      } else {
        const provider = providerOf(target.id);
        if (!provider) return;
        await window.wangcai.request(provider, 'workspace-rename', { id: target.id, name: renameInput.value });
        await refreshRows();
      }
      hideRename();
    } catch (error) {
      renameNote.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      renameSubmit.disabled = false;
    }
  };

  const selectWorkspace = (id: string) => {
    const provider = providerOf(id);
    if (!provider) return;
    activeWorkspaceId = id;
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
    showRows();
    settle();
    void window.wangcai.request(provider, 'workspace-select', { id }).catch(console.error);
  };

  const refreshRows = async () => {
    // The window is going away: a plugin that already disposed itself is not a failed refresh.
    if (closing) return;
    for (const provider of providers) {
      try {
        rowsByProvider.set(provider, await window.wangcai.request<WorkspaceRow[]>(provider, 'workspaces'));
      } catch (error) {
        // A provider that cannot answer keeps the rows it had: a lost reply must not close its workspaces.
        if (!closing) console.error(error);
      }
    }
    if (closing) return;
    const rows = servedRows();
    const served = new Set(rows.map((row) => row.id));
    for (const [key, tab] of [...tabs]) {
      if (tab.workspaceId === undefined || served.has(tab.workspaceId)) continue;
      if (activeWorkspaceId === tab.workspaceId) activeWorkspaceId = undefined;
      removeTab(key);
    }
    if (activeWorkspaceId === undefined || !served.has(activeWorkspaceId)) {
      const first = rows[0];
      if (first) {
        selectWorkspace(first.id);
        return;
      }
    }
    showRows();
    settle();
  };

  const saveGroupsAndDraw = () => {
    void window.wangcai.saveGroups(groups);
    showRows();
  };
  // A row joins the group it was filed into, if any, and leaves the one it was in. The write at the end also carries
  // any slot the caller changed just before.
  const fileRow = (id: string, groupId?: string) => {
    for (const group of groups) {
      const at = group.workspaces.indexOf(id);
      if (group.id === groupId) {
        if (at < 0) group.workspaces.push(id);
        // A row filed into a folded group would otherwise leave no trace of where it went.
        group.collapsed = false;
      } else if (at >= 0) group.workspaces.splice(at, 1);
    }
    saveGroupsAndDraw();
  };
  const removeGroup = (id: string) => {
    groups.splice(groups.findIndex((group) => group.id === id), 1);
    saveGroupsAndDraw();
  };
  const renameGroup = (id: string, name: string) => {
    groupById(id)!.name = name;
    saveGroupsAndDraw();
  };
  const createGroup = () => {
    let number = groups.length + 1;
    while (groups.some((group) => group.id === `g${number}`)) number += 1;
    const group: WorkspaceGroup = { id: `g${number}`, name: '新分组', collapsed: false, workspaces: [] };
    groups.push(group);
    saveGroupsAndDraw();
    openRename({ kind: 'group', id: group.id });
  };

  // A div with a role is not a button, so it answers a click and the keys a button would.
  const onActivate = (element: HTMLElement, action: () => void) => {
    element.onclick = action;
    element.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };
  };
  // A child of the target is still the target, so the marker stays while the pointer crosses one.
  const onDragLeave = (element: HTMLElement) => {
    element.ondragleave = (event) => { if (!element.contains(event.relatedTarget as Node)) delete element.dataset.drop; };
  };

  // A drag cancelled with Escape never reaches dragleave or drop, so the target keeps its marker.
  const clearDrop = (container: HTMLElement) => {
    for (const node of container.querySelectorAll<HTMLElement>('[data-drop]')) delete node.dataset.drop;
  };
  // An element that starts a drag hands over what is being dragged, and clears the markers off its container when the
  // drag ends.
  const dragSource = (element: HTMLElement, start: () => void, end: () => void, container: HTMLElement = workspaceList) => {
    element.ondragstart = (event) => {
      start();
      event.dataTransfer!.effectAllowed = 'move';
    };
    element.ondragend = () => {
      end();
      clearDrop(container);
    };
  };

  // A line a drag drops on: it marks itself while a drag hangs over it, and hands the drop to the action it carries.
  const dropLine = (className: string, accepts: () => boolean, drop: () => void) => {
    const element = document.createElement('div');
    element.className = className;
    element.setAttribute('role', 'presentation');
    element.ondragover = (event) => {
      if (!accepts()) return;
      event.preventDefault();
      element.dataset.drop = 'line';
    };
    onDragLeave(element);
    element.ondrop = (event) => {
      event.preventDefault();
      clearDrop(workspaceList);
      drop();
    };
    return element;
  };
  // A dropped row takes the place its line showed: it joins the group the place belongs to, if any, and its provider
  // is asked for that place as far as the provider's own order allows.
  const takePlace = (moved: string, before: string | undefined, group?: WorkspaceGroup) => {
    fileRow(moved, group?.id);
    const provider = providerOf(moved)!;
    if (before !== undefined && providerOf(before) !== provider) return;
    void window.wangcai.request(provider, 'workspace-move', before === undefined ? { id: moved } : { id: moved, before }).then(refreshRows).catch(console.error);
  };
  // The line under a group's bar, in front of each of its rows, and after the last.
  const groupLine = (group: WorkspaceGroup, before: string | undefined) =>
    dropLine('workspace-line inside', () => draggingRow !== undefined, () => takePlace(takenRow(), before, group));
  // The line between two entries of the list, and the one that closes it.
  const listLine = (options: { slot: number; above?: WorkspaceGroup; below?: WorkspaceGroup; last?: boolean }) => {
    const { slot, above, below, last = false } = options;
    // A row stands at the end of the list only when no provider after its own still has a top-level row.
    const endsTheList = (id: string) => {
      const provider = providerOf(id)!;
      return providers.slice(providers.indexOf(provider) + 1).every((other) => rowsByProvider.get(other)!.every((row) => groupOf(row.id) !== undefined));
    };
    // Only a row that can reach the end is dropped on the line that closes the list; a group can always take it.
    const accepts = () => {
      if (draggingGroup !== undefined) return true;
      if (draggingRow === undefined) return false;
      return !last || endsTheList(draggingRow);
    };
    const element = dropLine('workspace-line', accepts, () => {
      if (draggingGroup !== undefined) {
        const group = groupById(takenGroup())!;
        // A group dropped on a line takes the place in front of the entry the line belongs to; the line in front of
        // the group itself leaves that order alone.
        if (below !== undefined && below !== group) {
          groups.splice(groups.indexOf(group), 1);
          groups.splice(groups.indexOf(below), 0, group);
        }
        group.after = slot;
        saveGroupsAndDraw();
        return;
      }
      const moved = takenRow();
      const top = topRows(servedRows());
      const others = top.filter((row) => row.id !== moved);
      // The line counts the rows above it, the dragged one included when it is drawn up there: counting again without
      // it is both the place the row takes and what keeps a row dropped on the line under itself where it is.
      const index = top.slice(0, slot).filter((row) => row.id !== moved).length;
      // Both directions read a group by the rows its record names, not by the clamped slot it happens to be drawn at:
      // the group above comes up to the place the row takes so the row stays under it, and the group below steps down
      // one slot to open the place between them. These slots are written down by the takePlace call below.
      if (above !== undefined && rowsAbove(above) > index) above.after = index;
      if (below !== undefined && rowsAbove(below) <= index) below.after = index + 1;
      takePlace(moved, others[index]?.id);
    });
    return element;
  };

  const workspaceRow = (row: WorkspaceRow) => {
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
    onActivate(element, () => selectWorkspace(row.id));
    dragSource(element, () => { draggingRow = row.id; }, () => { draggingRow = undefined; });
    return element;
  };

  const groupBlock = (group: WorkspaceGroup, members: WorkspaceRow[], followedBy: string | undefined) => {
    const block = document.createElement('div');
    block.className = 'workspace-group';
    block.setAttribute('role', 'presentation');
    block.dataset.group = group.id;
    const bar = document.createElement('div');
    bar.className = 'workspace-group-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('aria-label', `分组 ${group.name}`);
    bar.setAttribute('aria-expanded', String(!group.collapsed));
    bar.tabIndex = 0;
    bar.draggable = true;
    bar.innerHTML = '<svg class="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z"/></svg>';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = group.name;
    bar.append(name);
    const list = document.createElement('div');
    list.className = 'workspace-group-rows';
    list.hidden = group.collapsed;
    list.append(...members.flatMap((row) => [groupLine(group, row.id), workspaceRow(row)]), groupLine(group, followedBy));
    block.append(bar, list);
    // Folding is the bar's own business: it is written down here and the list it folds is redrawn in place, where the
    // focus is.
    const fold = () => {
      group.collapsed = !group.collapsed;
      void window.wangcai.saveGroups(groups);
      list.hidden = group.collapsed;
      bar.setAttribute('aria-expanded', String(!group.collapsed));
    };
    onActivate(bar, fold);
    dragSource(bar, () => { draggingGroup = group.id; }, () => { draggingGroup = undefined; });
    return block;
  };

  const showRows = () => {
    // A group draws the rows it holds in the order the provider served them, not the order they joined in.
    const rows = servedRows();
    const top = topRows(rows);
    const children: HTMLElement[] = [];
    // The line in front of every entry and the one that closes the list, each told the group it stands under.
    let above: WorkspaceGroup | undefined;
    for (let slot = 0; slot <= top.length; slot += 1) {
      for (const group of groups) {
        // The list can be shorter than the record says, so the slot is clamped to the rows there are.
        if (Math.min(rowsAbove(group), top.length) !== slot) continue;
        const members = rows.filter((row) => groupOf(row.id)?.id === group.id);
        const lastMember = members[members.length - 1];
        // The row that follows the group's last member: a row filed at the end of the group stands in front of it.
        const followedBy = lastMember === undefined ? undefined : rows[rows.indexOf(lastMember) + 1]?.id;
        children.push(listLine({ slot, above, below: group }), groupBlock(group, members, followedBy));
        above = group;
      }
      if (slot < top.length) {
        children.push(listLine({ slot, above }), workspaceRow(top[slot]));
        above = undefined;
      }
    }
    children.push(listLine({ slot: top.length, above, last: true }));
    workspaceList.replaceChildren(...children);
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
    if (!right.hidden) tabs.get(current)?.content.onSelect?.();
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
        const key = JSON.stringify([plugin.id, workspaceId ?? '', options.id]);
        records.set(key, { plugin: plugin.id, id: options.id, workspaceId });
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
        panel.dataset.plugin = plugin.id;
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
          const visible = [...tabs].filter(([, item]) => item.workspaceId === undefined || item.workspaceId === activeWorkspaceId);
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
