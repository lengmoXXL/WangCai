import type { Dispose, RendererContext } from '../../shared';
import './style.css';

const root = document.getElementById('root')!;
const disposers: Dispose[] = [];
let closing = false;
window.addEventListener('beforeunload', () => {
  closing = true;
  for (const dispose of disposers.reverse()) void dispose();
});

async function start() {
  const plugins = await window.shu.plugins();
  if (!plugins.length) root.textContent = '未安装插件';
  for (const plugin of plugins) {
    if (!plugin.error && !plugin.renderer) continue;
    const container = document.createElement('section');
    container.className = 'plugin';
    container.dataset.plugin = plugin.id;
    root.append(container);
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
      const context: RendererContext = {
        request: (method, params) => window.shu.request(plugin.id, method, params),
        on(event, callback) {
          const off = window.shu.on((id, name, data) => { if (id === plugin.id && name === event) callback(data as never); });
          subscriptions.add(off);
          return () => { off(); subscriptions.delete(off); };
        },
      };
      const module = await import(/* @vite-ignore */ plugin.renderer!);
      dispose = await module.mount(container, context);
      const cleanup = async () => {
        for (const off of subscriptions) off();
        await dispose?.();
        stylesheet?.remove();
        container.remove();
      };
      if (closing) await cleanup(); else disposers.push(cleanup);
    } catch (error) {
      for (const off of subscriptions) off();
      await dispose?.();
      stylesheet?.remove();
      container.className = 'plugin-error';
      container.textContent = `${plugin.id}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
void start().catch((error) => { root.textContent = String(error); });
