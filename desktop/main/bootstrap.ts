import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { Theme } from '@lengmoxxl/sdk';
import { link, uiFont, type InstallStage } from '@lengmoxxl/sdk/bridge';

// The topic the page in this window follows. It is the shell's own window, so the SDK does not name it.
const topic = 'bootstrap';

/**
 * The window a run that finds no Core says what it is doing in: what the install is on, how far its three steps
 * are, and the command behind it. The window carries a page of its own only until Core's page can take over.
 */
export function bootstrap(theme: Theme) {
  const window = new BrowserWindow({
    width: 360, height: 104, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    center: true, backgroundColor: theme.background, show: false,
    webPreferences: { preload: join(__dirname, '../preload/preload.js') },
  });
  let state: { stage: InstallStage; message?: string } = { stage: 'cloning' };
  const push = () => { if (!window.isDestroyed()) window.webContents.send(link.channel, topic, state); };
  // The first reports come before the page can be drawn, so what is remembered here goes out when it can be.
  window.webContents.on('did-finish-load', push);
  window.once('ready-to-show', () => window.show());
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(theme))}`);
  return {
    report(stage: InstallStage, message?: string) {
      state = { stage, message };
      push();
    },
    hide() { if (!window.isDestroyed()) window.hide(); },
    destroy() { if (!window.isDestroyed()) window.destroy(); },
  };
}

/** The page is written here rather than built: the shell carries no renderer of its own, and this one is thrown
 * away once Core draws the window. */
const page = (theme: Theme) => `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 14px 16px 16px; background: ${theme.background}; color: ${theme.foreground}; font-family: ${uiFont}; font-size: 12px; -webkit-user-select: none; -webkit-app-region: drag; }
  p { margin: 0; }
  .doing { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .doing b { font-weight: 600; }
  .doing span { color: ${theme.muted}; font-size: 11px; }
  .bar { height: 3px; border-radius: 2px; background: ${theme.border}; overflow: hidden; }
  .bar i { display: block; width: 12%; height: 100%; background: ${theme.accent}; transition: width 320ms ease; }
  .detail { margin-top: 8px; color: ${theme.muted}; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
<p class="doing"><b id="doing">正在准备</b><span id="count"></span></p>
<div class="bar"><i id="fill"></i></div>
<p class="detail" id="detail"></p>
<script>
  const labels = { cloning: '正在克隆核心组件', updating: '正在同步核心组件', installing: '正在安装依赖', building: '正在构建核心组件', ready: '核心组件已就绪', failed: '核心组件安装失败' };
  const steps = { cloning: 0, updating: 0, installing: 1, building: 2, ready: 3, failed: 0 };
  const doing = document.getElementById('doing');
  const count = document.getElementById('count');
  const fill = document.getElementById('fill');
  const detail = document.getElementById('detail');
  window.wangcai.subscribe('${topic}', function (state) {
    const index = steps[state.stage] ?? 0;
    doing.textContent = labels[state.stage] ?? '正在准备';
    count.textContent = index < 3 ? (index + 1) + '/3' : '';
    fill.style.width = Math.max(12, (index + 0.35) / 3 * 100) + '%';
    detail.textContent = state.message ?? '';
  });
</script>
`;