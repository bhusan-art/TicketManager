import { useEffect, type RefObject } from 'react';

/**
 * On phones each table row is shown as a card (styles.css), with every cell labelled by its
 * column heading. This copies each heading into `data-label` on the cells below it, for every
 * `.table` inside `root`, and keeps doing so as pages and rows change.
 */
export function useTableLabels(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const label = () => {
      for (const table of el.querySelectorAll<HTMLTableElement>('table.table')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) =>
          (th.getAttribute('aria-label') ?? th.textContent ?? '').trim(),
        );
        if (heads.length === 0) continue;
        for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
          let col = 0;
          for (const cell of row.children) {
            const span = (cell as HTMLTableCellElement).colSpan || 1;
            const text = span === 1 ? (heads[col] ?? '') : '';
            if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
            col += span;
          }
        }
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}
