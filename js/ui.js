/**
 * MAЯPS — UI helpers: toast notifications and modal dialogs.
 * Modals receive HTML in `bodyHtml`: callers must escape any user text with escapeHtml().
 */
import { CONFIG } from './config.js';
import { escapeHtml } from './utils.js';

/** Shows a temporary notification. type: 'info' | 'success' | 'warning' | 'error'. */
export function showToast(message, type = 'info') {
  const root = document.getElementById('notifications');
  if (!root) return;

  const toast = document.createElement('div');
  toast.className = type === 'info' ? 'toast' : `toast toast-${type}`;
  toast.textContent = message;

  const remove = () => toast.remove();
  toast.addEventListener('click', remove);
  root.appendChild(toast);

  while (root.children.length > CONFIG.notifications.maxToasts) {
    root.firstElementChild.remove();
  }
  setTimeout(remove, CONFIG.notifications.toastDurationMs);
}

/**
 * Shows a modal dialog and returns a Promise that resolves with the `value` of the clicked action,
 * or null if the user presses Escape.
 * actions: [{ label, value, variant: 'primary' | 'danger' | undefined }]
 */
export function showModal({ title, bodyHtml = '', actions, wide = false, focusIndex = null }) {
  const buttons = actions && actions.length
    ? actions
    : [{ label: 'OK', value: true, variant: 'primary' }];

  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve(null);
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = wide ? 'modal modal-wide' : 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.className = 'modal-title';
    heading.textContent = title || '';

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = bodyHtml;

    const actionBar = document.createElement('div');
    actionBar.className = 'modal-actions';

    function close(value) {
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      resolve(value);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') close(null);
    }

    const buttonElements = buttons.map((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (action.variant ? ` btn-${action.variant}` : '');
      btn.textContent = action.label;
      btn.addEventListener('click', () => close(action.value));
      actionBar.appendChild(btn);
      return btn;
    });

    modal.append(heading, body, actionBar);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
    document.addEventListener('keydown', onKeyDown);

    const index = focusIndex !== null ? focusIndex : buttonElements.length - 1;
    buttonElements[index].focus();
  });
}

/** Yes/no confirmation. Resolves true only if the user confirms. */
export async function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false
}) {
  const result = await showModal({
    title,
    bodyHtml: `<p>${escapeHtml(message)}</p>`,
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' }
    ],
    // For dangerous actions the safe button (Cancel) has the initial focus.
    focusIndex: danger ? 0 : 1
  });
  return result === true;
}