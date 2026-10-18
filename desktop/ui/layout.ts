import type { Dispose } from '@lengmoxxl/sdk/channel';

/** Where a menu hangs, in client coordinates. */
export type MenuAnchor = { left: number; top: number };

/** The two dividers that size the sidebars, dragged or stepped with the arrow keys. */
export function sidebarDividers(root: HTMLElement, left: HTMLElement, right: HTMLElement, disposers: Dispose[]) {
  const stored = JSON.parse(localStorage.getItem('sidebar-ratios') ?? '{}') as { left?: number; right?: number };
  const ratios = {
    left: stored.left ?? 180 / root.clientWidth,
    right: stored.right ?? Math.min(600, root.clientWidth * .4) / root.clientWidth,
  };
  for (const [side, pane, opposite, minimum] of [
    ['left', left, right, 120], ['right', right, left, 260],
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
}

// A menu is as large as its entries, so where it fits is only known once they are in the DOM.
export const clampMenu = (menu: HTMLElement, at: MenuAnchor) => {
  menu.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(at.top, window.innerHeight - menu.offsetHeight - 4))}px`;
};

// A child of the target is still the target, so the marker stays while the pointer crosses one.
export const onDragLeave = (element: HTMLElement) => {
  element.ondragleave = (event) => { if (!element.contains(event.relatedTarget as Node)) delete element.dataset.drop; };
};

// A drag cancelled with Escape never reaches dragleave or drop, so the target keeps its marker.
export const clearDrop = (container: HTMLElement) => {
  for (const node of container.querySelectorAll<HTMLElement>('[data-drop]')) delete node.dataset.drop;
};

// An element that starts a drag hands over what is being dragged, and clears the markers off its container when the
// drag ends.
export const dragSource = (element: HTMLElement, start: () => void, end: () => void, container: HTMLElement) => {
  element.ondragstart = (event) => {
    start();
    event.dataTransfer!.effectAllowed = 'move';
  };
  element.ondragend = () => {
    end();
    clearDrop(container);
  };
};
