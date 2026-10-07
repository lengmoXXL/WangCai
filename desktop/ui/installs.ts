import type { InstallStage, InstallStatus } from '../shared';

const stageNames: Record<InstallStage, string> = { cloning: '克隆中', installing: '安装依赖', building: '构建中', ready: '就绪', failed: '失败' };

/** The plugin page: a card over the app, one row per plugin init.ts lists, and what to do about it. */
export function installsPage() {
  const install = (ids: string[]) => { void window.wangcai.install(ids).catch(console.error); };
  const element = document.createElement('section');
  element.className = 'installs';
  element.hidden = true;
  element.setAttribute('aria-label', '插件');
  const heading = document.createElement('h1');
  heading.textContent = '插件';
  const list = document.createElement('ul');
  const header = document.createElement('header');
  const actions = document.createElement('div');
  let statuses: InstallStatus[] = [];
  const entries = (stage: InstallStage) => statuses.filter((status) => status.stage === stage).map(({ id }) => id);
  const idle = (stage: InstallStage) => stage === 'ready' || stage === 'failed';
  const busy = () => statuses.some(({ stage }) => !idle(stage));
  const button = (label: string, action: () => void) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.onclick = action;
    return item;
  };
  const updateAll = button('全部更新', () => install(entries('ready')));
  const retryAll = button('全部重试', () => install(entries('failed')));
  const close = button('关闭', () => { element.hidden = true; });
  actions.append(updateAll, retryAll, close);
  header.append(heading, actions);
  element.append(header, list);
  const row = ({ id, stage, message }: InstallStatus) => {
    const item = document.createElement('li');
    item.dataset.stage = stage;
    const name = document.createElement('span');
    name.className = 'install-id';
    name.textContent = id;
    const state = document.createElement('span');
    state.className = 'install-stage';
    state.textContent = stageNames[stage];
    item.append(name, state);
    // A plugin that is ready can be moved to the version init.ts pins or to the latest one, and one that
    // failed can be tried again.
    if (idle(stage)) item.append(button(stage === 'ready' ? '更新' : '重试', () => install([id])));
    if (message) {
      const detail = document.createElement('p');
      detail.className = 'install-message';
      detail.textContent = message;
      item.append(detail);
    }
    return item;
  };
  // A plugin with something left to do opens the page; it stays until it is closed, so a failure is read.
  const update = (next: InstallStatus[]) => {
    statuses = next;
    updateAll.disabled = busy() || !entries('ready').length;
    retryAll.disabled = busy() || !entries('failed').length;
    list.replaceChildren(...statuses.map(row));
    if (statuses.some(({ stage }) => stage !== 'ready')) element.hidden = false;
  };
  window.wangcai.subscribe('plugin-page', () => { element.hidden = false; });
  window.wangcai.subscribe('install-statuses', (statuses) => update(statuses as InstallStatus[]));
  void window.wangcai.installs().then(update);
  return element;
}
