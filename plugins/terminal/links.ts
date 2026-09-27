import type { ILink, Terminal } from '@xterm/xterm';
import type { FileClick } from '@shu/sdk/plugin';

export function fileLocation(text: string): Pick<FileClick, 'path' | 'line' | 'column'> | undefined {
  if (text.startsWith('file://')) {
    try { text = decodeURIComponent(new URL(text).pathname); } catch { return; }
  }
  if (!text || text.startsWith('-') || text.includes('://')) return;
  const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(text)!;
  if (/^[a-z][a-z\d+.-]*:/i.test(match[1])) return;
  return { path: match[1], line: match[2] ? Number(match[2]) : undefined, column: match[3] ? Number(match[3]) : undefined };
}

export function registerFileLinks(term: Terminal, activate: (text: string) => void) {
  term.options.linkHandler = { allowNonHttpProtocols: true, activate: (_, text) => activate(text) };
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      let text = '';
      const positions: { x: number; y: number }[] = [];
      let row = y - 1;
      while (row > 0 && buffer.getLine(row)?.isWrapped) row--;
      do {
        const line = buffer.getLine(row);
        if (!line) break;
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col)!;
          if (cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let i = 0; i < chars.length; i++) positions.push({ x: col + 1, y: row + 1 });
          text += chars;
        }
        row++;
      } while (buffer.getLine(row)?.isWrapped);
      const links: ILink[] = [];
      for (const match of text.matchAll(/(?:^|[\s("'`=])([^\s<>"'`]+)/g)) {
        const value = match[1].replace(/[),;\]}]+$/, '');
        const location = fileLocation(value);
        if (!location || !(/[/.]/.test(location.path) || /^(?:[A-Z][A-Z\d_-]+|Makefile|Dockerfile|Justfile|Gemfile)$/.test(location.path))) continue;
        const start = match.index + match[0].length - match[1].length;
        const end = start + value.length - 1;
        if (positions[start].y > y || positions[end].y < y) continue;
        links.push({ text: value, range: { start: positions[start], end: positions[end] }, activate: () => activate(value) });
      }
      callback(links);
    },
  });
}
