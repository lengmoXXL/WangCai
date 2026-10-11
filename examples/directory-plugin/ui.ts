import type { DirectoryEntry } from '@lengmoxxl/sdk';
import type { TabRecord, UiContext } from '@lengmoxxl/sdk/channel';

export const title = 'Directory';

export function mount() {}

export function open(context: UiContext, record?: TabRecord) {
  const path = record?.id ?? context.host.config.directory;
  context.host.tabs({
    id: path,
    title,
    tooltip: path,
    workspaceId: record?.workspaceId,
    mount(panel) {
      const button = document.createElement('button');
      button.textContent = 'Read directory';
      const status = document.createElement('p');
      const output = document.createElement('pre');
      panel.append(button, status, output);

      const off = context.ui.subscribe<{ path: string; count: number }>(
        'listed',
        (value) => { status.textContent = `${value.path}: ${value.count} entries`; },
      );
      button.onclick = async () => {
        button.disabled = true;
        try {
          const entries = await context.ui.request<DirectoryEntry[]>(
            'list', { path },
          );
          output.textContent = entries.map(
            (entry) => entry.name + (entry.isDirectory ? '/' : ''),
          ).join('\n');
        } catch (error) {
          output.textContent = error instanceof Error
            ? error.message : String(error);
        } finally {
          button.disabled = false;
        }
      };

      return {
        dispose: off,
        onSelect() { button.focus(); },
      };
    },
  });
}
