/** Toasts + a tiny event bus for cross-module messaging. */

const busTarget = new EventTarget();

export const bus = {
  on(type, handler) {
    const wrapped = (ev) => handler(ev.detail);
    busTarget.addEventListener(type, wrapped);
    return () => busTarget.removeEventListener(type, wrapped);
  },
  emit(type, detail) {
    busTarget.dispatchEvent(new CustomEvent(type, { detail }));
  },
};

const ICONS = {
  info: '<path d="M12 8h.01M11 12h1v4h1"/><circle cx="12" cy="12" r="9"/>',
  ok: '<path d="m4 12 5 5L20 6"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
};

const TITLES = {
  info: 'Notice',
  ok: 'Done',
  warn: 'Heads up',
  error: 'Problem',
};

let container = null;

/**
 * @param {string} message
 * @param {{tone?:'info'|'ok'|'warn'|'error', title?:string, timeout?:number}} [opts]
 */
export function toast(message, opts = {}) {
  container ??= document.getElementById('toaster');
  if (!container) return;

  const tone = opts.tone ?? 'info';
  const timeout = opts.timeout ?? (tone === 'error' ? 8000 : 4000);

  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'toast__icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ICONS[tone] ?? ICONS.info;

  const body = document.createElement('div');
  body.className = 'toast__body';
  const title = document.createElement('div');
  title.className = 'toast__title';
  title.textContent = opts.title ?? TITLES[tone];
  const text = document.createElement('div');
  text.className = 'toast__text';
  text.textContent = message;
  body.append(title, text);

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  close.addEventListener('click', () => dismiss());

  el.append(icon, body, close);
  container.append(el);

  let timer = null;
  const dismiss = () => {
    if (!el.isConnected) return;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  };

  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  return dismiss;
}
