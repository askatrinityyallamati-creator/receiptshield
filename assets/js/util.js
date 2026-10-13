/* ==========================================================================
   ReceiptShield — util.js
   Shared helpers: DOM, currency/number parsing, statistics, geometry.
   Exposes window.RS.util
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = (global.RS = global.RS || {});

  /* ── DOM ─────────────────────────────────────────────────── */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ── currency ────────────────────────────────────────────── */
  const CURRENCY = /(?:₹|rs\.?|inr|usd|sgd|aed|eur|gbp|chf|myr|thb|\$|€|£|¥)/gi;

  /** Detect the dominant currency glyph in a block of text. */
  function detectCurrency(text) {
    if (/₹/.test(text)) return { symbol: '₹', code: 'INR' };
    if (/\b(rs\.?|inr)\b/i.test(text)) return { symbol: '₹', code: 'INR' };
    if (/€/.test(text) || /\beur\b/i.test(text)) return { symbol: '€', code: 'EUR' };
    if (/£/.test(text) || /\bgbp\b/i.test(text)) return { symbol: '£', code: 'GBP' };
    if (/\$/.test(text) || /\busd\b/i.test(text)) return { symbol: '$', code: 'USD' };
    if (/¥/.test(text)) return { symbol: '¥', code: 'JPY' };
    return { symbol: '', code: '' };
  }

  /**
   * Parse a money-ish string into a number.
   * Handles "₹1,500.00", "1.500,00" (European), "(120.00)" (negative),
   * "1,234", "1500.5", "12 500.00" and trailing CR/DR markers.
   * Returns NaN when there is no usable number.
   */
  function parseAmount(raw) {
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;

    let s = String(raw).trim();
    if (!s) return NaN;

    s = s.replace(CURRENCY, ' ');
    let negative = false;
    if (/^\(.*\)$/.test(s.trim())) { negative = true; s = s.replace(/[()]/g, ' '); }
    if (/\b(?:cr|dr)\b\s*$/i.test(s)) negative = /cr\s*$/i.test(s.trim()); // credit = refund
    if (/^\s*-/.test(s)) { negative = true; }

    s = s.replace(/[^0-9.,]/g, '').replace(/^[.,]+/, '');
    if (!s) return NaN;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    const decSep = lastDot > lastComma ? '.' : (lastComma > lastDot ? ',' : '');

    if (!decSep) {
      // pure digits, possibly long — treat as integer
      const n = Number(s.replace(/[.,]/g, ''));
      return Number.isFinite(n) ? (negative ? -n : n) : NaN;
    }

    const intPart = s.slice(0, s.lastIndexOf(decSep)).replace(/[.,]/g, '');
    const fracPart = s.slice(s.lastIndexOf(decSep) + 1);

    // A single separator followed by exactly 3 digits is far more likely a
    // thousands separator ("1,500") than a decimal ("1.500").
    if (fracPart.length === 3 && intPart.length > 0 && (lastDot < 0 || lastComma < 0)) {
      const merged = Number(intPart + fracPart);
      return Number.isFinite(merged) ? (negative ? -merged : merged) : NaN;
    }
    // "1,50" or "1,5" -> decimal comma. Trailing "0" groups are separators.
    const frac = fracPart.replace(/[.,].*$/, '');
    if (frac.length > 3) {
      const merged = Number(intPart + fracPart.replace(/[^0-9]/g, ''));
      return Number.isFinite(merged) ? (negative ? -merged : merged) : NaN;
    }

    const n = Number((intPart || '0') + '.' + (frac || '0'));
    if (!Number.isFinite(n)) return NaN;
    return negative ? -n : n;
  }

  /** Extract every trailing/embedded money token from a string. */
  function moneyTokens(text) {
    const re = /(?:₹|rs\.?|inr|\$|€|£|¥)?\s*\(?-?\d[\d.,]*\)?(?:\s*(?:cr|dr))?/gi;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = parseAmount(m[0]);
      if (Number.isFinite(value) && /\d/.test(m[0])) {
        out.push({ raw: m[0].trim(), value, index: m.index });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  /** The last money-looking token on a line, or null. */
  function trailingAmount(text) {
    const tokens = moneyTokens(text);
    if (!tokens.length) return null;
    const last = tokens[tokens.length - 1];
    // must actually sit at the end of the line (allow trailing junk like units)
    const tail = text.slice(last.index + last.raw.length).replace(/[.\s:|\-–—_]+$/, '');
    if (tail.length > 0 && !/^[a-z]{1,4}$/i.test(tail)) return null;
    return { ...last, before: text.slice(0, last.index).trim() };
  }

  function fmtMoney(value, symbol) {
    if (!Number.isFinite(value)) return '—';
    const sym = symbol === undefined ? '' : symbol;
    const fixed = Math.abs(value) >= 1000
      ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : value.toFixed(2);
    return (value < 0 ? '-' : '') + sym + fixed.replace('-', '');
  }

  function fmtDelta(value) {
    if (!Number.isFinite(value)) return '—';
    const s = value.toFixed(2);
    return (value > 0 ? '+' : '') + s;
  }

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  /* ── statistics ──────────────────────────────────────────── */
  function median(values) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function mean(values) {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  }
  /** Median absolute deviation — robust spread measure. */
  function mad(values) {
    const med = median(values);
    if (!Number.isFinite(med)) return NaN;
    return median(values.filter(Number.isFinite).map((v) => Math.abs(v - med)));
  }
  /** Robust z-score using median/MAD (0.6745 scales MAD to sigma). */
  function robustZ(value, med, spread) {
    if (!Number.isFinite(value) || !Number.isFinite(med) || !Number.isFinite(spread)) return 0;
    if (spread <= 1e-9) return value === med ? 0 : 999;
    return (0.6745 * (value - med)) / spread;
  }
  function percentile(values, p) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
    return a[idx];
  }

  /* ── geometry ────────────────────────────────────────────── */
  const box = (w) => ({ x: w.x0, y: w.y0, w: w.x1 - w.x0, h: w.y1 - w.y0 });
  const boxArea = (b) => Math.max(0, b.w) * Math.max(0, b.h);
  function overlapRatio(a, b) {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = x * y;
    const denom = Math.min(boxArea(a), boxArea(b));
    return denom > 0 ? inter / denom : 0;
  }

  /* ── misc ────────────────────────────────────────────────── */
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  RS.util = {
    $, $$, el, esc, clamp, sleep, round2,
    detectCurrency, parseAmount, moneyTokens, trailingAmount, fmtMoney, fmtDelta,
    median, mean, mad, robustZ, percentile,
    box, boxArea, overlapRatio,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RS.util;
})(typeof window !== 'undefined' ? window : globalThis);
