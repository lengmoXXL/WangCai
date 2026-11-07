// The keys handed to the engine, written the way Neovim writes them: a sequence of presses, each either a character or a
// `<...>` name.

/** One press: the modifiers held and the key they were held for, named as `event.key` names it. */
interface Stroke { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

interface KeyBinding { keys: string; run(): void; insert?: boolean }

// What a `<...>` name stands for: the key Nvim writes as CR, Esc or Space is what `event.key` calls
// Enter, Escape or a space.
const NAMES: Record<string, string> = {
  cr: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  space: ' ', bs: 'Backspace', backspace: 'Backspace', del: 'Delete', delete: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
};
for (let at = 1; at <= 12; at += 1) NAMES[`f${at}`] = `F${at}`;

/** What the tries are keyed by: the same press written two ways has to give the same string. */
const strokeKey = (stroke: Stroke) => `${Number(stroke.ctrl)}${Number(stroke.alt)}${Number(stroke.shift)}${Number(stroke.meta)}:${stroke.key}`;

/**
 * One press, written either as `<C-Space>` or as `C-Space`, and read as nothing when it names no key. Shift is carried
 * by the character's case for a letter, as Neovim's is, and stays a modifier only for a named key, whose name cannot
 * show it.
 */
export function readStroke(text: string): Stroke | undefined {
  const written = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
  const stroke: Stroke = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  let rest = written;
  while (rest.length > 2 && rest[1] === '-') {
    const modifier = rest[0].toLowerCase();
    if (modifier === 'c') stroke.ctrl = true;
    else if (modifier === 'a' || modifier === 'm') stroke.alt = true;
    else if (modifier === 'd') stroke.meta = true;
    else if (modifier === 's') stroke.shift = true;
    else break;
    rest = rest.slice(2);
  }
  if (rest.length === 1) return { ...stroke, shift: false, key: stroke.shift && rest.toLowerCase() !== rest.toUpperCase() ? rest.toUpperCase() : rest };
  const named = NAMES[rest.toLowerCase()];
  return named ? { ...stroke, key: named } : undefined;
}

/**
 * A written sequence as the presses it stands for: whitespace only separates, a space itself is `<Space>`, a bare
 * character is one press, and `<leader>` is the leader given. A sequence that cannot be read yields nothing.
 */
function parseKeys(text: string, leader?: Stroke): Stroke[] | undefined {
  const presses: Stroke[] = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at += 1; continue; }
    let token: string;
    if (text[at] === '<') {
      const end = text.indexOf('>', at);
      if (end < 0) return undefined;
      token = text.slice(at + 1, end);
      at = end + 1;
    } else {
      token = text[at];
      at += 1;
    }
    if (token.toLowerCase() === 'leader') {
      if (!leader) return undefined;
      presses.push(leader);
      continue;
    }
    const stroke = readStroke(token);
    if (!stroke) return undefined;
    presses.push(stroke);
  }
  return presses.length ? presses : undefined;
}

// The character a key sits on, by its base-layout name: macOS reports Option+f as `ƒ`, so a binding has to be able to
// name the key it is actually on.
const baseChar = (code: string) => code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : undefined;

/** The presses one keydown could stand for, or nothing for a key that cannot be named. */
function strokesOf(event: KeyboardEvent): Stroke[] {
  const { ctrlKey: ctrl, altKey: alt, metaKey: meta } = event;
  // `event.key` is the shifted character itself, so only the other modifiers are read here.
  if (event.key.length === 1) {
    const stroke: Stroke = { ctrl, alt, shift: false, meta, key: event.key };
    const base = alt ? baseChar(event.code) : undefined;
    return base && base !== event.key ? [stroke, { ...stroke, key: base }] : [stroke];
  }
  if (event.key === 'Dead' || event.key === 'Unidentified' || event.key === 'Process') return [];
  return [{ ctrl, alt, shift: event.shiftKey, meta, key: event.key }];
}

/** Whether the press was made in something the selector names — including inside a shadow tree, since a press there is
 * retargeted to its host and only the path it took says where it came from. */
export const pressIn = (event: Event, selector: string) =>
  event.composedPath().some((node) => node instanceof Element && node.matches(selector));

/** Whether the press was made in a field. */
export const isEditable = (event: Event) => pressIn(event, 'input, textarea, [contenteditable=""], [contenteditable="true"]');

/** A node of the sequences bound: what a prefix leads to, how a hint names that press, and the binding that ends there,
 * if one does. */
export interface TrieNode<T> { children: Map<string, TrieNode<T>>; label: string; binding?: T }

function labelOf(stroke: Stroke): string {
  const modifiers = `${stroke.ctrl ? 'C-' : ''}${stroke.alt ? 'A-' : ''}${stroke.shift ? 'S-' : ''}${stroke.meta ? 'D-' : ''}`;
  const key = stroke.key.length === 1 ? stroke.key : stroke.key.toUpperCase();
  return `${modifiers}${stroke.key === ' ' ? 'SPC' : key}`;
}

/**
 * The tree a set of bindings is matched in: every written sequence read into the presses it stands for, with a later
 * binding overriding one it repeats — its label included, since a hint shows what would run. A binding that cannot be
 * read is reported and left out.
 */
function buildTrie<T extends { keys: string }>(bindings: T[], leader?: Stroke): TrieNode<T> {
  const root: TrieNode<T> = { children: new Map(), label: '' };
  for (const binding of bindings) {
    const presses = parseKeys(binding.keys, leader);
    if (!presses) { console.error(`Keymap ${binding.keys}: cannot be read`); continue; }
    let node = root;
    for (const stroke of presses) {
      const key = strokeKey(stroke);
      const label = labelOf(stroke);
      let child = node.children.get(key);
      if (child) child.label = label;
      else node.children.set(key, child = { children: new Map(), label });
      node = child;
    }
    node.binding = binding;
  }
  return root;
}

function nodeAt<T>(trie: TrieNode<T>, path: Stroke[]) {
  let node: TrieNode<T> | undefined = trie;
  for (const stroke of path) {
    node = node.children.get(strokeKey(stroke));
    if (!node) return undefined;
  }
  return node;
}

export type Tries<B extends KeyBinding> = { outside: TrieNode<B>; field: TrieNode<B> };

/**
 * The two tries a set of bindings is matched in: every binding outside a field, and only those that say `insert` inside
 * one — or all of them there when the page is an editor, which is what `fields: 'all'` says.
 */
export function triesOf<B extends KeyBinding>(bindings: B[], options: { leader?: Stroke; fields?: 'all' } = {}): Tries<B> {
  const outside = buildTrie(bindings, options.leader);
  return { outside, field: options.fields === 'all' ? outside : buildTrie(bindings.filter((binding) => binding.insert), options.leader) };
}

/** The options both entry points take. */
interface KeyOptions {
  /** Presses the engine leaves to whatever is behind it, such as the ones another pane of the same panel reads for itself. */
  ignore?(event: KeyboardEvent): boolean;
  /** How long a prefix waits for the press that would continue it; left out, the engine's own default applies. */
  timeout?: number;
}

/** What `bindKeys` takes beyond `KeyOptions`: how its tries are built. */
interface PageOptions extends KeyOptions {
  /** `all`, or left out for the tries `triesOf` builds. */
  fields?: 'all';
}

/** What `bindTries` takes beyond `KeyOptions`: what it tells the caller, and the presses it takes first. */
interface BindOptions<B extends KeyBinding> extends KeyOptions {
  /** The prefix as it now stands: the node it reached and how its presses are written, told again each time a press makes
   * it longer — then nothing, once the wait is over, however it ended. */
  prefix?(node: TrieNode<B> | undefined, labels: string[]): void;
  /** A press taken before matching, where a caller leaves a field or takes a press the field would otherwise get, such as
   * the Escape that should end a waiting prefix; it is told whether a prefix is waiting, and true takes the press and ends
   * the matching there. */
  before?(event: KeyboardEvent, waiting: boolean): boolean;
}

const PREFIX_WAIT = 800;
const prefixes = new WeakMap<Element, { path: Stroke[]; timer: number }>();

/**
 * Binds keys whose tries the caller picks per press, for a keymap whose keys depend on where the press was made. A press
 * that continues nothing ends the wait and is matched again from the start, as Vim does; one that matches nothing at all
 * is left to whatever is behind it.
 */
export function bindTries<B extends KeyBinding>(element: HTMLElement, triesFor: (event: KeyboardEvent) => Tries<B>, options: BindOptions<B>): () => void {
  const stopTimer = () => clearTimeout(prefixes.get(element)?.timer);
  const endPrefix = () => {
    stopTimer();
    if (prefixes.delete(element)) options.prefix?.(undefined, []);
  };
  const runAfterWait = (binding?: KeyBinding) => {
    endPrefix();
    binding?.run();
  };
  const takeEvent = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.repeat) return;
    const started = prefixes.get(element);
    if (options.before?.(event, started !== undefined)) {
      takeEvent(event);
      endPrefix();
      return;
    }
    if (options.ignore?.(event)) return;
    const { outside, field } = triesFor(event);
    const trie = isEditable(event) ? field : outside;
    const takePress = (next: TrieNode<B>, path: Stroke[]) => {
      takeEvent(event);
      if (next.binding && !next.children.size) {
        runAfterWait(next.binding);
        return;
      }
      // A prefix that also ends here waits for its next press, as Vim does with `g` and `gg`.
      stopTimer();
      const timer = window.setTimeout(() => runAfterWait(next.binding), options.timeout ?? PREFIX_WAIT);
      prefixes.set(element, { path, timer });
      options.prefix?.(next, path.map(labelOf));
    };
    const strokes = strokesOf(event);
    const tryStrokes = (base: Stroke[]) => {
      for (const stroke of strokes) {
        const path = [...base, stroke];
        const next = nodeAt(trie, path);
        if (next) { takePress(next, path); return true; }
      }
      return false;
    };
    if (started) {
      if (tryStrokes(started.path)) return;
      endPrefix();
    }
    tryStrokes([]);
  };
  // A click means the reader has gone somewhere else with the pointer.
  const onPointerDown = () => endPrefix();
  element.addEventListener('keydown', onKeyDown, true);
  element.addEventListener('pointerdown', onPointerDown, true);
  // Unbinding leaves a prefix that is already waiting alone: a page that re-binds its keys on every render would otherwise
  // drop it each time it renders, and the wait it dropped would never run its binding.
  return () => {
    element.removeEventListener('keydown', onKeyDown, true);
    element.removeEventListener('pointerdown', onPointerDown, true);
  };
}

/**
 * Binds a page's own keys, given as the bindings it declares: they answer while the focus is inside `element`, and their
 * tries are the two `triesOf` makes of them.
 */
export function bindKeys<B extends KeyBinding>(element: HTMLElement, bindings: B[], options: PageOptions = {}): () => void {
  const { fields, ...shared } = options;
  let own: Tries<B> | undefined;
  return bindTries(element, () => (own ??= triesOf(bindings, { fields })), shared);
}
