// Pure text / number formatting helpers. Shared between modal and HUD.

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function formatNumber(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('hr-HR');
}

export function formatCurrencyEur(amount) {
    if (amount == null || !isFinite(amount)) return '—';
    return `${Math.round(amount).toLocaleString('hr-HR')} EUR`;
}
