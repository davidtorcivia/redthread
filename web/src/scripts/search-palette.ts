// The search dialog: entry names (adjacency.json), matches by meaning (/api/search, when the
// site runs behind the Worker) and full text (Pagefind's JS API), as one keyboard-driven list.
import { loadAdjacency } from './adjacency';
import { entityHref, TYPE_LABELS } from './entity-types';
import { mergeTop, nameRank, quietMarks, TOP_MAX, type Row } from './search-rank';

interface NameEntry { id: string; title: string; type: string; href: string; keys: string[] }
interface Preview { title: string; type: string; summary: string | null }
interface PagefindResult { data(): Promise<{ url: string; meta: { title?: string }; excerpt: string; sub_results?: { title: string; url: string; excerpt: string }[] }> }
interface Pagefind {
  options(o: object): Promise<void>;
  debouncedSearch(q: string, o?: object, ms?: number): Promise<{ results: PagefindResult[] } | null>;
}

const RECENT_KEY = 'rt-recent';
const RECENT_MAX = 6;
const TEXT_PAGE = 5;

function readRecent(): Row[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.href === 'string' && typeof r.title === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember the entry page being viewed, newest first. */
function rememberPage(): void {
  const el = document.querySelector<HTMLElement>('[data-recent-title]');
  if (!el) return;
  const row: Row = { href: location.pathname, title: el.dataset.recentTitle!, type: el.dataset.recentType };
  try {
    const list = [row, ...readRecent().filter((r) => r.href !== row.href)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private mode or storage disabled */ }
}

export function initSearch(opts: { semantic: boolean; onOpen(): void; fallbackFocus(): HTMLElement }) {
  const modal = document.getElementById('pf-modal')!;
  const input = document.getElementById('sp-input') as HTMLInputElement;
  const list = document.getElementById('sp-results')!;
  const spinner = document.getElementById('sp-spinner')!;
  const status = document.getElementById('sp-status')!;
  const trigger = document.getElementById('search-open') as HTMLButtonElement;
  let opener: HTMLElement | null = null;
  let active = -1;
  let seq = 0;
  let textShown = TEXT_PAGE;

  rememberPage();

  const v = (window as any).__V;
  let namesP: Promise<NameEntry[]> | null = null;
  const loadNames = () => namesP ??= loadAdjacency()
    .then((d) => d.ids.map((id, i) => ({
      id, title: d.titles[i], type: d.types[i], href: entityHref(d.types[i], id),
      keys: [d.titles[i], ...((d as any).aliases?.[String(i)] || [])].map((k: string) => k.toLowerCase()),
    })))
    .catch(() => []);
  let previewsP: Promise<Record<string, Preview>> | null = null;
  const loadPreviews = () => previewsP ??= fetch('/previews.json?v=' + v).then((r) => r.json()).catch(() => ({}));
  let pagefindP: Promise<Pagefind | null> | null = null;
  const loadPagefind = () => pagefindP ??= (async () => {
    try {
      // A runtime URL keeps the bundler (and Vite's dev server) away from this /public file.
      const url = new URL('/search-index/pagefind.js', location.href).href;
      const pf: Pagefind = await import(/* @vite-ignore */ url);
      await pf.options({ excerptLength: 22 });
      return pf;
    } catch {
      return null;
    }
  })();

  // ---- rendering ----
  function rowEl(r: Row, i: number): HTMLAnchorElement {
    const a = document.createElement('a');
    a.className = 'sp-row' + (r.type ? ' type-' + r.type : '');
    a.href = r.href;
    a.id = 'sp-opt-' + i;
    a.setAttribute('role', 'option');
    a.tabIndex = -1;
    const top = document.createElement('span');
    top.className = 'sp-row-top';
    if (r.type) {
      const t = document.createElement('span');
      t.className = 'sp-type';
      t.textContent = TYPE_LABELS[r.type] || r.type;
      top.append(t);
    }
    const title = document.createElement('span');
    title.className = 'sp-title';
    title.textContent = r.title;
    top.append(title);
    if (r.section) {
      const s = document.createElement('span');
      s.className = 'sp-section';
      s.textContent = r.section;
      top.append(s);
    }
    a.append(top);
    if (r.detail || r.excerptHtml) {
      const d = document.createElement('span');
      d.className = 'sp-detail';
      // Pagefind excerpts are escaped text plus <mark>; everything else goes in as text.
      if (r.excerptHtml) d.innerHTML = quietMarks(r.excerptHtml);
      else d.textContent = r.detail!;
      a.append(d);
    }
    return a;
  }

  function render(sections: { label: string; rows: Row[]; more?: () => void; moreLabel?: string }[], empty?: string) {
    list.replaceChildren();
    let i = 0;
    for (const s of sections) {
      if (!s.rows.length) continue;
      const g = document.createElement('div');
      g.className = 'sp-group';
      g.setAttribute('role', 'group');
      const h = document.createElement('div');
      h.className = 'sp-label';
      h.id = 'sp-label-' + i;
      h.textContent = s.label;
      g.setAttribute('aria-labelledby', h.id);
      g.append(h, ...s.rows.map((r) => rowEl(r, i++)));
      if (s.more) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sp-more';
        b.textContent = s.moreLabel!;
        b.addEventListener('click', s.more);
        g.append(b);
      }
      list.append(g);
    }
    if (!i && empty) {
      const p = document.createElement('p');
      p.className = 'sp-empty';
      p.textContent = empty;
      list.append(p);
    }
    setActive(i ? 0 : -1);
  }

  const options = () => [...list.querySelectorAll<HTMLAnchorElement>('.sp-row')];
  function setActive(i: number, scroll = false) {
    const rows = options();
    rows.forEach((r, k) => r.setAttribute('aria-selected', String(k === i)));
    active = i;
    if (i >= 0 && rows[i]) {
      input.setAttribute('aria-activedescendant', rows[i].id);
      if (scroll) rows[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // ---- searching ----
  async function showHome() {
    const [names, adj] = [await loadNames(), await loadAdjacency().catch(() => null)];
    const hubs = adj ? Object.entries((adj as any).hubs || {})
      .sort((a: any, b: any) => a[1].rank - b[1].rank).slice(0, 6)
      .map(([i]) => names[Number(i)]).filter(Boolean) : [];
    render([
      { label: 'Recently viewed', rows: readRecent() },
      { label: 'Most connected', rows: hubs.map((n) => ({ href: n.href, type: n.type, title: n.title })) },
    ]);
  }

  let meaningAbort: AbortController | null = null;
  async function meaningRows(q: string): Promise<Row[]> {
    if (!opts.semantic || q.split(/\s+/).length < 2) return [];
    meaningAbort?.abort();
    meaningAbort = new AbortController();
    try {
      const r = await fetch('/api/search?limit=8&q=' + encodeURIComponent(q), { signal: meaningAbort.signal });
      if (!r.ok) return [];
      return ((await r.json()).results || []).map((x: any): Row => {
        // Deep-link to the best section unless that is the opening one.
        const sec = x.sections?.[0]?.heading ? x.sections[0] : null;
        const url = new URL(sec ? sec.url : x.url);
        return { href: url.pathname + url.hash, type: x.type, title: x.title, section: sec?.heading, detail: sec ? sec.snippet : x.summary };
      });
    } catch {
      return [];
    }
  }

  /** Entry type from a page path like /people/allen-dulles/ via previews.json. */
  const typeOf = (previews: Record<string, Preview>, path: string) => previews[path.split('/').filter(Boolean)[1] ?? '']?.type;

  async function textRows(q: string, previews: Record<string, Preview>): Promise<{ rows: Row[]; total: number }> {
    const pf = await loadPagefind();
    const res = pf && await pf.debouncedSearch(q, {}, 120);
    if (!res) return { rows: [], total: 0 };
    const data = await Promise.all(res.results.slice(0, textShown).map((r) => r.data()));
    return {
      total: res.results.length,
      rows: data.map((d) => {
        const sub = d.sub_results?.find((s) => s.url !== d.url && s.title !== d.meta.title);
        return { href: sub ? sub.url : d.url, type: typeOf(previews, d.url), title: d.meta.title || d.url, section: sub?.title, excerptHtml: sub ? sub.excerpt : d.excerpt };
      }),
    };
  }

  async function run() {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { spinner.hidden = true; status.textContent = ''; return showHome(); }
    const ql = q.toLowerCase();
    const [names, previews] = await Promise.all([loadNames(), loadPreviews()]);
    if (mine !== seq) return;
    const named: [number, Row][] = (ql.length < 2 ? [] : names.map((n) => [nameRank(n.keys, ql), n] as const))
      .filter(([r]) => r < 9)
      .sort((a, b) => a[0] - b[0] || a[1].title.length - b[1].title.length)
      .slice(0, TOP_MAX)
      .map(([r, n]) => [r, { href: n.href, type: n.type, title: n.title, detail: previews[n.id]?.summary ?? undefined }]);
    // Names render at once; meaning and full text fill in as they arrive.
    let meaning: Row[] = [];
    let text = { rows: [] as Row[], total: 0 };
    const paint = (final: boolean) => {
      if (mine !== seq) return;
      const top = mergeTop(named, meaning);
      const topHrefs = new Set(top.map((r) => r.href.split('#')[0]));
      const rest = text.rows.filter((r) => !topHrefs.has(r.href.split('#')[0]));
      render([
        { label: 'Top results', rows: top },
        {
          label: 'Mentioned in', rows: rest,
          ...(text.total > textShown ? { more: () => { textShown += TEXT_PAGE; void run(); }, moreLabel: `Show more (${text.total - textShown} left)` } : {}),
        },
      ], final ? `No matches for “${q}”. Try fewer words, or a name.` : undefined);
      status.textContent = final ? `${top.length + rest.length} results` : '';
    };
    paint(false);
    spinner.hidden = false;
    await Promise.all([
      meaningRows(q).then((r) => { meaning = r; paint(false); }),
      textRows(q, previews).then((r) => { text = r; paint(false); }),
    ]);
    if (mine === seq) { spinner.hidden = true; paint(true); }
  }

  // ---- dialog ----
  function setBackgroundInert(on: boolean) {
    for (const sel of ['header.site', 'main', 'footer.site']) document.querySelector(sel)?.toggleAttribute('inert', on);
  }
  function open(query?: string, from?: HTMLElement) {
    opts.onOpen();
    opener = from ?? null;
    modal.classList.add('open');
    setBackgroundInert(true);
    // Focus synchronously inside the user gesture so iOS raises the keyboard.
    void modal.offsetHeight;
    input.focus();
    if (query != null) input.value = query;
    input.select();
    textShown = TEXT_PAGE;
    void run();
    void loadPagefind();
  }
  function close() {
    modal.classList.remove('open');
    setBackgroundInert(false);
    meaningAbort?.abort();
    const back = opener && document.contains(opener) ? opener : trigger;
    opener = null;
    (back.getClientRects().length ? back : opts.fallbackFocus()).focus();
  }

  input.addEventListener('input', () => { textShown = TEXT_PAGE; void run(); });
  input.addEventListener('keydown', (e) => {
    const rows = options();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(active + 1, rows.length - 1) : Math.max(active - 1, 0);
      setActive(next, true);
    } else if (e.key === 'Enter' && active >= 0 && rows[active]) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) window.open(rows[active].href, '_blank', 'noopener');
      else { rows[active].click(); }
    }
  });
  list.addEventListener('mousemove', (e) => {
    const row = (e.target as Element).closest('.sp-row');
    if (row) setActive(options().indexOf(row as HTMLAnchorElement));
  });
  // A section link on the current page only changes the hash, so close the dialog ourselves.
  list.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a');
    if (a && !(e as MouseEvent).metaKey && !(e as MouseEvent).ctrlKey && !(e as MouseEvent).shiftKey) close();
  });
  document.getElementById('pf-close')!.addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  // Trap Tab inside the dialog.
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...modal.querySelectorAll<HTMLElement>('input, button:not([disabled])')].filter((el) => el.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (modal.classList.contains('open')) close(); else open();
    } else if (e.key === 'Escape' && modal.classList.contains('open')) {
      close();
    }
  });
  // An unresolved wikilink has no page; clicking it searches for the name instead.
  document.addEventListener('click', (e) => {
    const a = (e.target as Element).closest?.<HTMLAnchorElement>('a.wikilink.unresolved');
    if (!a) return;
    e.preventDefault();
    open(a.dataset.target || a.textContent!.trim(), a);
  });
  document.addEventListener('auxclick', (e) => {
    if ((e.target as Element).closest?.('a.wikilink.unresolved')) e.preventDefault();
  });
  trigger.addEventListener('click', () => open());
  trigger.disabled = false;
}
