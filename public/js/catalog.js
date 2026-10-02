/**
 * Catalog / feed / queue rendering.
 *
 * The catalog itself comes from GET /api/catalog (server side data, so it can
 * be edited without touching the frontend). Bookmarks and history live in
 * localStorage.
 */
import { $, esc, formatDuration, store } from './dom.js';
import { api } from './api.js';
import { bus } from './ui.js';

const SAVED_KEY = 'cyberstream.saved';
const HISTORY_KEY = 'cyberstream.history';
const HISTORY_MAX = 40;

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const BOOKMARK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
const PLAY_SMALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

export class CatalogView {
  constructor() {
    this.items = [];
    this.filter = '';
    this.activeId = null;
    this.saved = new Set(store.get(SAVED_KEY, []) ?? []);
    this.history = store.get(HISTORY_KEY, []) ?? [];
    this.queue = [];

    this.rail = $('#feed-rail');
    this.search = $('#catalog-search');
    this.panels = {
      queue: { list: $('#queue-list'), empty: $('#queue-empty') },
      history: { list: $('#history-list'), empty: $('#history-empty') },
      saved: { list: $('#saved-list'), empty: $('#saved-empty') },
    };

    this._wire();
  }

  _wire() {
    this.search?.addEventListener('input', () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.renderFeed();
    });

    $('#history-clear')?.addEventListener('click', () => {
      this.history = [];
      store.set(HISTORY_KEY, this.history);
      this.renderPanels();
      bus.emit('toast', { message: 'History cleared.', tone: 'info' });
    });
  }

  async load() {
    // Via api.catalog, not a bare fetch('/api/catalog'): the API dialog can
    // repoint the client at a remote server, and a hardcoded relative path would
    // silently keep loading the local catalog while everything else went remote.
    const data = await api.catalog();
    this.items = data.items ?? [];
    this.demo = data.demo ?? null;
    this.renderFeed();
    this.renderPanels();
    return data;
  }

  find(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  /* ------------------------------------------------------------- feed -- */
  renderFeed() {
    if (!this.rail) return;
    const items = this.filter
      ? this.items.filter((i) =>
          `${i.title} ${i.subtitle ?? ''} ${(i.tags ?? []).join(' ')}`
            .toLowerCase()
            .includes(this.filter),
        )
      : this.items;

    if (!items.length) {
      this.rail.innerHTML = `<li class="empty" style="grid-column:1/-1">
        <p class="empty__title">No matches</p>
        <p class="empty__hint">Try a different search</p>
      </li>`;
      return;
    }

    this.rail.innerHTML = items
      .map(
        (item) => `
      <li>
        <article class="card${item.id === this.activeId ? ' is-active' : ''}" data-id="${esc(item.id)}">
          <div class="card__thumb">
            <img src="${esc(item.thumb)}" alt="" loading="lazy" decoding="async"
                 onerror="this.style.visibility='hidden'">
            <span class="card__dur">${esc(item.duration ?? '')}</span>
            <span class="card__play"><span>${PLAY_ICON}</span></span>
          </div>
          <button class="card__bookmark${this.saved.has(item.id) ? ' is-on' : ''}" type="button"
                  data-bookmark="${esc(item.id)}"
                  aria-label="${this.saved.has(item.id) ? 'Remove from saved' : 'Save for later'}">
            ${BOOKMARK_ICON}
          </button>
          <div class="card__body">
            <h3 class="card__title">${esc(item.title)}</h3>
            <p class="card__sub">${esc(item.subtitle ?? '')}</p>
          </div>
        </article>
      </li>`,
      )
      .join('');

    for (const card of this.rail.querySelectorAll('.card')) {
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-bookmark]')) return;
        const item = this.find(card.dataset.id);
        if (item) bus.emit('play:item', item);
      });
    }
    for (const btn of this.rail.querySelectorAll('[data-bookmark]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.toggleSaved(btn.dataset.bookmark);
      });
    }
  }

  setActive(id) {
    this.activeId = id;
    for (const card of this.rail?.querySelectorAll('.card') ?? []) {
      card.classList.toggle('is-active', card.dataset.id === id);
    }
    this.renderPanels();
  }

  /* ------------------------------------------------------------ panels -- */
  renderPanels() {
    this._renderList('queue', this.queue);
    this._renderList('history', this.history.slice(0, 12));
    this._renderList(
      'saved',
      [...this.saved].map((id) => this.find(id)).filter(Boolean),
    );
  }

  _renderList(name, entries) {
    const panel = this.panels[name];
    if (!panel) return;

    panel.list.innerHTML = entries
      .map((entry) => {
        const item = typeof entry === 'string' ? this.find(entry) : entry;
        if (!item) return '';
        const isCurrent = item.id === this.activeId;
        return `
        <li class="qitem${isCurrent ? ' is-current' : ''}" data-id="${esc(item.id)}">
          <button class="qitem__thumb" type="button" data-play="${esc(item.id)}" aria-label="Play ${esc(item.title)}">
            <img src="${esc(item.thumb)}" alt="" loading="lazy">
          </button>
          <div class="qitem__body">
            <div class="qitem__title">${esc(item.title)}</div>
            <div class="qitem__meta">${esc(item.duration ?? '')}</div>
          </div>
          <div class="qitem__actions">
            <button class="iconmini${this.saved.has(item.id) ? ' is-on' : ''}" type="button"
                    data-bookmark="${esc(item.id)}" aria-label="Save">${BOOKMARK_ICON}</button>
            <button class="iconmini" type="button" data-remove="${esc(item.id)}" aria-label="Remove">${TRASH_ICON}</button>
          </div>
        </li>`;
      })
      .join('');

    panel.empty.hidden = entries.length > 0;

    panel.list.querySelectorAll('[data-play]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const item = this.find(btn.dataset.play);
        if (item) bus.emit('play:item', item);
      }),
    );
    panel.list.querySelectorAll('[data-bookmark]').forEach((btn) =>
      btn.addEventListener('click', () => this.toggleSaved(btn.dataset.bookmark)),
    );
    panel.list.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.removeFrom(name, btn.dataset.remove);
      }),
    );
  }

  removeFrom(name, id) {
    if (name === 'saved') this.toggleSaved(id);
    if (name === 'history') {
      this.history = this.history.filter((i) => i.id !== id);
      store.set(HISTORY_KEY, this.history);
    }
    if (name === 'queue') this.queue = this.queue.filter((i) => i.id !== id);
    this.renderPanels();
  }

  /* ------------------------------------------------------------ storage -- */
  toggleSaved(id) {
    if (this.saved.has(id)) this.saved.delete(id);
    else this.saved.add(id);
    store.set(SAVED_KEY, [...this.saved]);
    this.renderFeed();
    this.renderPanels();
  }

  addToQueue(item) {
    this.queue = [item, ...this.queue.filter((i) => i.id !== item.id)].slice(0, 20);
    this.renderPanels();
  }

  pushHistory(item) {
    this.history = [item, ...this.history.filter((i) => i.id !== item.id)].slice(0, HISTORY_MAX);
    store.set(HISTORY_KEY, this.history);
    this.renderPanels();
  }

  clearQueue() {
    this.queue = [];
    this.renderPanels();
  }
}

export { PLAY_SMALL, formatDuration };
