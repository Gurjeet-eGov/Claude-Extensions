// Dropdowns as DESIGN.md › Dropdowns describes (the Test Run console's dropdown(); Run › Test Type
// is the model), for Bug Reporter's pages. Each native <select> stays in the page, hidden, as the
// value everyone reads and sets: the page's code keeps using select.value, select.innerHTML and its
// 'change' event. The field and its list are drawn next to it and follow it (options, value, disabled).
//
// In the extension every list shows 5 rows at a time and scrolls; each option is one line (cut
// with …, whole in its title). A list with more than 8 options has a search box at the top.

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ROWS = 5; // rows shown before the list scrolls (a select's data-rows can change it)
const ROW = 31; // one option row: 6px 8px padding, 13px text, plus the 2px gap
const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const indexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Only one list is open at a time; a click anywhere else closes it.
let current = null; // { wrap, close }
document.addEventListener('click', (e) => {
  if (current && !current.wrap.contains(e.target)) current.close(false);
});

/**
 * Draw `sel` as a DESIGN.md dropdown.
 * On the <select>: data-search="always" (a search box however short the list), data-search-placeholder,
 * data-rows (rows shown, default 5). On an <option>: data-hint (muted text after its label) and
 * data-side (muted text at the row's right end, e.g. a test case's status). An option with value ""
 * is the placeholder: the field shows its text greyed out (with the hidden attribute it isn't listed,
 * so the field reads like "Find test case"). <optgroup> labels show as headings.
 */
export function enhanceSelect(sel) {
  if (!sel || sel.dataset.dd) return;
  sel.dataset.dd = '1';
  // A small dropdown in a line of text (Time, Model, Effort…) is as wide as its longest option.
  const inline = sel.classList.contains('inline') || !!sel.closest('.claude-opts, label.row');
  const wrap = document.createElement('div');
  wrap.className = 'multi' + (inline ? ' inline' : '') + (sel.classList.contains('grow') ? ' grow' : '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'multi-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  wrap.appendChild(btn);
  sel.before(wrap); // before the select: inside a <label>, the label's text opens this button
  sel.hidden = true;
  sel.tabIndex = -1;

  let pop = null;
  let q = '';

  /** The options in order, each with the heading of its <optgroup> (if any). */
  const opts = () => [...sel.options].filter((o) => !o.hidden).map((o) => ({
    value: o.value,
    label: o.textContent.trim(),
    hint: o.dataset.hint || '',
    side: o.dataset.side || '',
    group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '',
    disabled: o.disabled,
  }));

  function field() {
    const o = sel.options[sel.selectedIndex];
    const text = o ? o.textContent.trim() : '';
    const ph = !o || o.value === '';
    // inline: every option sits invisibly in the same spot, so the field takes the widest one's width
    const sizer = inline ? `<span class="dd-sizer" aria-hidden="true">${opts().map((x) => `<span>${esc(x.label)}</span>`).join('')}</span>` : '';
    btn.innerHTML = `<span class="grow dd-box"><span class="dd-val${ph ? ' dd-ph' : ''}">${esc(text || 'Select')}</span>${sizer}</span>${CHEVRON}`;
    btn.title = text;
    btn.disabled = sel.disabled;
  }

  function list() {
    const all = opts();
    const search = sel.dataset.search === 'always' || all.length > 8;
    const t = q.trim().toLowerCase();
    const hits = all.filter((x) => !t || `${x.label} ${x.hint} ${x.side}`.toLowerCase().includes(t));
    const max = (Number(sel.dataset.rows) || ROWS) * ROW - 2;
    let group = '';
    const rows = hits.map((x) => {
      const head = x.group && x.group !== group ? `<div class="dd-group" role="presentation">${esc(x.group)}</div>` : '';
      group = x.group;
      const on = x.value === sel.value;
      return head + `<button type="button" class="dd-item${on ? ' on' : ''}" role="option" aria-selected="${on}" data-value="${esc(x.value)}"${x.disabled ? ' disabled' : ''} title="${esc([x.label, x.hint, x.side].filter(Boolean).join(' · '))}">` +
        `<span class="dd-text"><span class="dd-label">${esc(x.label)}</span>${x.hint ? ` <span class="dd-hint">${esc(x.hint)}</span>` : ''}</span>` +
        `${x.side ? `<span class="dd-side">${esc(x.side)}</span>` : ''}</button>`;
    });
    pop.innerHTML =
      (search ? `<input type="search" class="dd-search" placeholder="${esc(sel.dataset.searchPlaceholder || 'Search')}" aria-label="Search the list" autocomplete="off" spellcheck="false">` : '') +
      `<div class="dd-list" role="listbox" style="max-height:${max}px">${rows.join('') || '<div class="small faint dd-none">Nothing matches</div>'}</div>`;
    const s = pop.querySelector('.dd-search');
    if (s) {
      s.value = q;
      s.addEventListener('input', () => {
        q = s.value;
        list();
        const n = pop.querySelector('.dd-search');
        n.focus();
        n.setSelectionRange(n.value.length, n.value.length);
      });
      s.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = pop.querySelector('.dd-item:not([disabled])');
          if (first) pick(first.dataset.value);
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          pop.querySelector('.dd-item:not([disabled])')?.focus();
        }
      });
    }
    pop.querySelector('.dd-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (sel.disabled || pop) return;
    if (current) current.close(false);
    current = { wrap, close };
    q = '';
    pop = document.createElement('div');
    pop.className = 'multi-pop';
    wrap.appendChild(pop);
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    list();
    (pop.querySelector('.dd-search') || pop.querySelector('.dd-item.on') || pop.querySelector('.dd-item'))?.focus();
    pop.addEventListener('click', (e) => {
      const it = e.target.closest('.dd-item');
      if (it && !it.disabled) pick(it.dataset.value);
    });
    pop.addEventListener('keydown', (e) => {
      if (!pop) return; // Enter in the search box picked an option and closed the list
      const items = [...pop.querySelectorAll('.dd-item:not([disabled])')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[Math.min(i + 1, items.length - 1)].focus();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        (i === 0 ? pop.querySelector('.dd-search') || items[0] : items[i - 1]).focus();
      }
    });
  }

  function close(focusBtn) {
    if (!pop) return;
    pop.remove();
    pop = null;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (current && current.wrap === wrap) current = null;
    if (focusBtn) btn.focus();
  }

  function pick(v) {
    const changed = sel.value !== v;
    valueProp.set.call(sel, v);
    close(true);
    field();
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  btn.addEventListener('click', () => (pop ? close(true) : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !pop) {
      e.preventDefault();
      open();
    }
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  wrap.addEventListener('focusout', (e) => {
    if (pop && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false);
  });

  // Follow the select: options filled or changed, disabled, and a value or focus set by code.
  new MutationObserver(() => {
    field();
    if (pop) list();
  }).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'data-hint', 'data-side'] });
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return valueProp.get.call(this); },
    set(v) { valueProp.set.call(this, v); field(); },
  });
  Object.defineProperty(sel, 'selectedIndex', {
    configurable: true,
    get() { return indexProp.get.call(this); },
    set(v) { indexProp.set.call(this, v); field(); },
  });
  sel.focus = () => btn.focus();
  field();
}

/** Every <select> in the page, and any drawn later. A select with data-native keeps the browser's own. */
export function enhanceAll(root = document) {
  const run = () => root.querySelectorAll('select:not([data-native]):not([data-dd])').forEach(enhanceSelect);
  run();
  new MutationObserver(run).observe(root.body || root, { childList: true, subtree: true });
}
