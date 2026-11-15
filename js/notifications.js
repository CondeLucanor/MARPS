/**
 * MAЯPS — toast notifications and modal dialogs.
 */
import { CONFIG } from './config.js';

let toastRoot = null;
let modalRoot = null;
const openModals = [];

export function initNotifications() {
  toastRoot = document.getElementById('notifications');
  modalRoot = document.getElementById('modal-root');
  document.addEventListener('keydown', handleKeyDown);
}

/** True while a modal dialog is open (used to block keyboard movement). */
export function isModalOpen() {
  return openModals.length > 0;
}

/**
 * Shows a short message in the corner of the screen.
 * type: 'info' | 'success' | 'warning' | 'error'
 */
export function notify(message, { type = 'info', duration = CONFIG.notifications.toastDurationMs } = {}) {
  if (!toastRoot) {
    console.log(`[MAЯPS ${type}] ${message}`);
    return;
  }
  while (toastRoot.children.length >= CONFIG.notifications.maxToasts) {
    toastRoot.firstChild.remove();
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  const remove = () => toast.remove();
  toast.addEventListener('click', remove);
  toastRoot.appendChild(toast);
  if (duration > 0) setTimeout(remove, duration);
}

/**
 * Opens a modal dialog and returns a Promise that resolves with the `value` of the button pressed,
 * or with null if the dialog is dismissed (Escape key or click outside) when `dismissible` is true.
 *
 * options: { title, message, content (DOM node), buttons: [{ label, value, variant }], dismissible, wide }
 * variant: 'primary' | 'danger' | undefined
 */
export function openModal({
  title = '',
  message = '',
  content = null,
  buttons = [{ label: 'OK', value: true, variant: 'primary' }],
  dismissible = true,
  wide = false
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = wide ? 'modal modal-wide' : 'modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    if (title) {
      const titleEl = document.createElement('h2');
      titleEl.className = 'modal-title';
      titleEl.textContent = title;
      dialog.appendChild(titleEl);
    }

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (message) {
      const p = document.createElement('p');
      p.textContent = message;
      body.appendChild(p);
    }
    if (content instanceof Node) body.appendChild(content);
    dialog.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    dialog.appendChild(actions);

    const entry = {
      backdrop,
      dialog,
      resolve,
      dismissible,
      previousFocus: document.activeElement
    };

    let primaryButton = null;
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.variant ? ` btn-${b.variant}` : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => closeModal(entry, b.value));
      actions.appendChild(btn);
      if (!primaryButton && b.variant === 'primary') primaryButton = btn;
    });

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop && dismissible) closeModal(entry, null);
    });

    backdrop.appendChild(dialog);
    (modalRoot || document.body).appendChild(backdrop);
    openModals.push(entry);

    const focusTarget = primaryButton || actions.querySelector('button');
    if (focusTarget) focusTarget.focus();
  });
}

/** Asks the user to confirm an action. Resolves to true (confirmed) or false (cancelled). */
export function confirmDialog({
  title = 'Confirm',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false
} = {}) {
  return openModal({
    title,
    message,
    buttons: [
      { label: cancelText, value: false },
      { label: confirmText, value: true, variant: danger ? 'danger' : 'primary' }
    ]
  }).then((value) => value === true);
}

/** Closes every open dialog (they resolve with `value`). */
export function closeAllModals(value = null) {
  [...openModals].forEach((entry) => closeModal(entry, value));
}

function closeModal(entry, value) {
  const index = openModals.indexOf(entry);
  if (index === -1) return;
  openModals.splice(index, 1);
  entry.backdrop.remove();
  if (entry.previousFocus && typeof entry.previousFocus.focus === 'function') {
    entry.previousFocus.focus();
  }
  entry.resolve(value);
}

function handleKeyDown(event) {
  if (openModals.length === 0) return;
  const top = openModals[openModals.length - 1];

  if (event.key === 'Escape' && top.dismissible) {
    event.preventDefault();
    closeModal(top, null);
    return;
  }

  if (event.key === 'Tab') {
    const focusable = top.dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}