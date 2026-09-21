// Small world interactions share a menu, independent of campaign presentation.
import { modalEl } from './modal.js';
import { t } from '../core/i18n.js';
let menu = null;
let previousFocus = null;
let onClose = null;
export const worldChoicesOpen = () => !!menu;
function shield(event) {
    if (!menu) return;
    if (event.key === 'Escape') { event.preventDefault(); closeWorldChoices(); }
    if (event.key === 'Tab' && event.type === 'keydown' && menu) {
        event.preventDefault();
        const buttons = [...menu.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
    // Keep keyboard activation and tab navigation in the dialog, but never
    // pass a held movement/E key through to the world underneath it.
    if (!['Tab', 'Enter', ' '].includes(event.key)) event.preventDefault();
    event.stopPropagation();
}
export function closeWorldChoices() {
    if (!menu) return;
    menu.remove(); menu = null;
    const finish = onClose; onClose = null; finish?.();
    window.removeEventListener('keydown', shield, true);
    window.removeEventListener('keyup', shield, true);
    previousFocus?.focus?.(); previousFocus = null;
}
export function showWorldChoices({ title, text = '', choices = [], onDismiss = null }) {
    closeWorldChoices();
    previousFocus = document.activeElement;
    onClose = onDismiss;
    menu = document.createElement('div');
    menu.className = 's3d-world-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-label', title);
    const heading = document.createElement('strong'); heading.textContent = title; menu.append(heading);
    if (text) { const paragraph = document.createElement('p'); paragraph.textContent = text; menu.append(paragraph); }
    for (const choice of [...choices, { label: t('world.leave'), action: closeWorldChoices }]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = choice.label;
        button.onclick = event => { event.stopPropagation(); choice.action(); };
        menu.append(button);
    }
    for (const type of ['pointerdown', 'pointerup', 'click', 'wheel']) menu.addEventListener(type, e => e.stopPropagation());
    (modalEl || document.body).append(menu);
    window.addEventListener('keydown', shield, true);
    window.addEventListener('keyup', shield, true);
    menu.querySelector('button')?.focus();
}
