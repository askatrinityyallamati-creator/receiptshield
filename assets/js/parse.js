/* ==========================================================================
   ReceiptShield — parse.js
   Stage 3: item / price / tax detection.

   Turns raw text (plus OCR geometry when available) into a structured receipt:
   line items with quantity, unit price and line total; discount, tax and
   rounding rows; and the totals the document claims to assert.

   Every value keeps a back-reference to the line and, when present, the exact
   OCR word box it came from, because stage 5 reasons about alignment,
   type size and confidence of those very boxes.

   Exposes window.RS.parse
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  /* ── number scanning ─────────────────────────────────────── */
  const CURRENCY_TOKEN = /(?:₹|Rs\.?|INR|\$|€|£|¥)/i;

  /** Blank out dates and times so their digits are never read as amounts. */
  function maskDatesTimes(text) {
    return text
      .replace(/\b\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g, (m) => ' '.repeat(m.length))
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, (m) => ' '.repeat(m.length))
      .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, (m) => ' '.repeat(m.length));
  }

  const AMOUNT_RE = new RegExp([
    '(?:₹|Rs\\.?|INR|\\$|€|£|¥)\\s*-?\\(?\\d[\\d,]*(?:\\.\\d{1,2})?\\)?', // symbol-led
    '-?\\(?\\d{1,3}(?:[,\\u00a0 ]\\d{2,3})+(?:\\.\\d{1,2})?\\)?',        // grouped
    '-?\\(?\\d+\\.\\d{1,2}\\)?',                                          // decimal
    '-?\\(?\\d{2,7}\\)?',                                                // bare integer
  ].join('|'), 'gi');

  function isBoundaryBefore(ch) {
    return !ch || !/[0-9A-Za-z.,\/]/.test(ch);
  }
  function isBoundaryAfter(ch) {
    return !ch || !/[0-9A-Za-z.,\/:%]/.test(ch);
  }

  /**
   * Find money-looking tokens with their positions.
   * Boundary tests plus date/time masking are what keep invoice ids,
   * GSTINs, phone numbers and tax rates out of the amount list.
   */
  function scanAmounts(rawText, opts) {
    const relaxed = !!(opts && opts.relaxed);
    // maskDatesTimes preserves length, so the second pass can safely rebuild a
    // decimal separator that OCR misread as a colon ("35:5" for "35.5").
    const text = maskDatesTimes(rawText).replace(/(\d)[:;](\d{1,2})(?=\s|$)/g, '$1.$2');
    const out = [];
    AMOUNT_RE.lastIndex = 0;
    let m;
    while ((m = AMOUNT_RE.exec(text)) !== null) {
      if (m.index === AMOUNT_RE.lastIndex) AMOUNT_RE.lastIndex++;
      const token = m[0];
      const before = text[m.index - 1];
      const after = text[m.index + token.length];
      if (!isBoundaryBefore(before) || !isBoundaryAfter(after)) continue;
      if (!/\d/.test(token)) continue;

      const digits = token.replace(/[^0-9]/g, '');
      const hasSymbol = CURRENCY_TOKEN.test(token);
      const hasDecimal = /\.\d{1,2}\)?$/.test(token.trim());
      const hasGrouping = /[\d][,\u00a0 ]\d{2,3}/.test(token);
      // Without a currency symbol, a decimal point or digit grouping, a short
      // integer is a quantity or a percentage and a long one is an identifier:
      // a postal code, phone number, invoice id or tax registration number.
      // On a row we already know is a money row (subtotal, tax, total), a bare
      // integer is accepted because "Subtotal 710" is a perfectly normal print.
      if (!hasSymbol && !hasDecimal && !hasGrouping) {
        if (digits.length >= 6) continue;
        if (digits.length <= 3 && !relaxed) continue;
      }

      const value = U.parseAmount(token);
      if (!Number.isFinite(value)) continue;
      out.push({
        raw: token.trim(),
        value,
        index: m.index,
        end: m.index + token.length,
        hasSymbol,
        hasDecimal,
      });
    }
    return out;
  }

  /** Repair the classic OCR digit confusions inside an obviously numeric token. */
  function fixNumericToken(token) {
    const digits = (token.match(/\d/g) || []).length;
    const letters = (token.match(/[A-Za-z]/g) || []).length;
    if (!digits || letters === 0 || letters > digits) return token;
    return token
      .replace(/[OoQ]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[Zz]/g, '2');
  }

  /* ── line classifiers ────────────────────────────────────── */
  const rateOf = (text) => {
    const m = text.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%/);
    return m ? Number(m[1]) : null;
  };

  const RULES = [
    { key: 'roundOff', kind: 'roundoff', re: /^round(?:ing)?[\s\-_.]*off\b/i },
    { key: 'taxable', kind: 'taxable', re: /^(?:taxable\s+(?:value|amount|total)|net\s+(?:amount|total)|amount\s+before\s+tax|pre[\s\-]?tax\s+total)\b/i },
    { key: 'subtotal', kind: 'subtotal', re: /^(?:sub[\s\-_.]*total|total\s+before\s+(?:tax|discount)|gross\s+total)\b/i },
    { key: 'discount', kind: 'discount', re: /^(?:disc(?:ount)?\b|less\b|savings?\b|promo(?:tion)?\b|coupon\b|offer\b|rebate\b|voucher\b)/i },
    { key: 'tax', kind: 'tax', re: /^\s*(?:cgst|sgst|igst|utgst|gst|vat|hst|pst|qst|cess|service\s+tax|sales\s+tax|tax|swachh\s+?bharat\s+cess)\b/i },
    { key: 'total', kind: 'total', re: /^(?:grand\s+total|total\s+(?:due|payable|amount)|amount\s+(?:due|payable)|balance\s+due|net\s+payable|invoice\s+total|bill\s+amount|total)\b/i },
    { key: 'tendered', kind: 'tendered', re: /^(?:cash|card|credit\s+card|debit\s+card|upi|netbanking|wallet|paid|tendered|payment|amount\s+paid|received|round\s?up)\b/i },
    { key: 'change', kind: 'change', re: /^(?:change|balance|due\s+back|return|refund)\b/i },
  ];

  const META_PATTERNS = [
    { key: 'invoiceNo', re: /^(?:invoice|inv|bill|receipt|order|ref|txn|transaction|token)\s*(?:no\.?|number|#|id)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/i },
    { key: 'date', re: /\b(?:date|dt)\b\s*[:\-]?\s*(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i },
    { key: 'time', re: /\b(?:time)\b\s*[:\-]?\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)/i },
    { key: 'gstin', re: /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3})\b/i },
    // Phone numbers only: no spaces allowed inside, and at least eight digits,
    // otherwise "00    700" from a column of amounts reads as a phone number.
    { key: 'phone', re: /\b(\+?\d{2}[\d\-()]{6,}\d)\b/ },
    { key: 'payment', re: /\b(upi|visa|mastercard|amex|rupay|card|netbanking|wallet|paytm|phonepe|gpay)\b/i },
  ];

  function classify(lineText) {
    const t = lineText.trim();
    if (!t) return { kind: 'blank' };
    if (/^[\-=_*·•~\s]{3,}$/.test(t)) return { kind: 'rule' };
    // A payment-method row is metadata even though it starts with "paid":
    // it names a channel, and any digits on it are a masked card number.
    if (/\b(?:paid\s+by|paid\s+via|payment\s+(?:method|mode)|tender\s+type|card\s*(?:no\.?|#)|upi|visa|mastercard|amex|rupay)\b/i.test(t)
        && !/\d[\d,]*\.\d{2}/.test(t)) {
      return { kind: 'meta', key: 'payment', value: t.replace(/\s{2,}/g, ' ').trim() };
    }
    for (const r of RULES) if (r.re.test(t)) return { kind: r.kind, key: r.key };
    for (const p of META_PATTERNS) {
      const m = t.match(p.re);
      if (m) return { kind: 'meta', key: p.key, value: m[1] };
    }
    return { kind: 'text' };
  }

  /* ── item parsing ────────────────────────────────────────── */
  const MONEY_ROWS = ['subtotal', 'taxable', 'discount', 'tax', 'total', 'tendered', 'change', 'roundoff'];

  const QTY_PREFIX = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:x|×|\*|@|nos?\.?|pcs?\.?|qty\.?)\s+/i;
  const QTY_BARE = /^\s*(\d{1,3})\s+(?=[A-Za-z])/;

  function parseItemLine(text, amounts, geo) {
    const tokens = amounts.slice().sort((a, b) => a.index - b.index);
    if (!tokens.length) return null;

    const last = tokens[tokens.length - 1];
    const second = tokens.length > 1 ? tokens[tokens.length - 2] : null;

    // the printed line total must be the final token on the line
    const tail = text.slice(last.end).replace(/[\s.\-–—_|:]*$/, '');
    if (tail.length > 0 && !/^[A-Za-z%]{1,4}$/.test(tail)) return null;

    let name = text.slice(0, second ? second.index : last.index);
    let qty = null;
    let unit = null;
    let amount = last.value;

    const qm = name.match(QTY_PREFIX);
    if (qm) {
      qty = U.parseAmount(qm[1]);
      name = name.slice(qm[0].length);
    } else {
      const qb = name.match(QTY_BARE);
      if (qb) {
        qty = U.parseAmount(qb[1]);
        name = name.slice(qb[0].length);
      }
    }

    // A second trailing number is the unit-price column. Take it as printed even
    // when it disagrees with the line total — that disagreement is the finding.
    let unitStated = false;
    if (second && Number.isFinite(second.value) && second.value > 0) {
      const cand = second.value;
      unit = cand;
      unitStated = true;
      if (qty === null) {
        const ratio = amount / cand;
        const ri = Math.round(ratio);
        if (ri >= 1 && ri <= 99 && Math.abs(ratio - ri) <= 0.02) qty = ri;
      }
    }

    name = name
      .replace(/[\s.\-–—_|:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!name || !/[A-Za-z]/.test(name)) return null;
    if (name.length > 60) return null;

    const derived = !unitStated;
    if (derived) {
      const q = qty === null ? 1 : qty;
      unit = q > 0 ? U.round2(amount / q) : amount;
    }

    return {
      name,
      qty: qty === null ? 1 : qty,
      qtyStated: qty !== null,
      unit,
      unitStated,
      unitDerived: derived,
      amount,
      raw: text.trim(),
      geo: geo || null,
    };
  }

  /* ── geometry helpers ────────────────────────────────────── */
  /** Box/confidence of the nth word from the end of an OCR line. */
  function wordFromEnd(line, n) {
    if (!line || !line.words || !line.words.length) return null;
    const idx = line.words.length - 1 - (n || 0);
    if (idx < 0) return null;
    const w = line.words[idx];
    return {
      text: w.text,
      conf: w.conf,
      x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1,
      height: w.y1 - w.y0,
      baseline: w.y1,
    };
  }

  /* ── main ────────────────────────────────────────────────── */
  /**
   * @param {{lines?:Array, text:string, source?:string}} input
   * @returns structured receipt
   */
  function parse(input) {
    const rawText = (input && input.text) || '';
    let lines = (input && input.lines) || [];
    if (!lines.length) {
      lines = rawText.split(/\r?\n/).map((text, i) => ({
        key: 'txt-' + i, text, words: [], x0: 0, x1: 0, y0: 0, y1: 0,
        height: 0, baseline: 0, conf: null, minConf: null, width: 0, gaps: [],
      }));
    }

    const currency = U.detectCurrency(rawText + ' ' + lines.map((l) => l.text).join(' '));

    const items = [];
    const taxes = [];
    const adjustments = [];
    const meta = {};
    const misc = [];
    const suspiciousText = [];

    lines.forEach((line, lineIndex) => {
      const text = (line.text || '').replace(/\s+$/, '');
      if (!text.trim()) return;

      const cls = classify(text);
      if (cls.kind === 'rule' || cls.kind === 'blank') return;

      const isMoneyRow = MONEY_ROWS.indexOf(cls.kind) !== -1;
      const amountTokens = scanAmounts(text, { relaxed: isMoneyRow });
      // Prefer the numerically repaired reading when OCR clearly mangled a figure.
      amountTokens.forEach((t) => {
        const fixed = fixNumericToken(t.raw);
        if (fixed !== t.raw) {
          const v = U.parseAmount(fixed);
          if (Number.isFinite(v)) { t.raw = fixed; t.value = v; t.repaired = true; }
        }
      });

      const geo = {
        lineIndex,
        lineY: line.y0,
        lineHeight: line.height,
        conf: line.conf,
        minConf: line.minConf,
        lastWord: wordFromEnd(line, 0),
        unitWord: wordFromEnd(line, 1),
      };

      if (cls.kind === 'meta') {
        if (cls.value && !meta[cls.key]) meta[cls.key] = cls.value;
        if (amountTokens.length) {
          misc.push({ lineIndex, text: text.trim(), amounts: amountTokens.map((a) => a.value) });
        }
        return;
      }

      if (isMoneyRow) {
        if (!amountTokens.length) {
          suspiciousText.push({ lineIndex, text: text.trim(), reason: 'label without an amount' });
          return;
        }
        const amountToken = amountTokens[amountTokens.length - 1];
        const amount = amountToken.value;
        const rate = rateOf(text);
        // The label is the row's words with its figure removed, so the report
        // reads "CGST 2.5%" rather than a column of spaces.
        const label = (text.slice(0, amountToken.index) + text.slice(amountToken.end))
          .replace(/\s{2,}/g, ' ').replace(/[\s.:|\-–—_]+$/, '').trim() || cls.kind;
        const entry = {
          kind: cls.kind,
          key: cls.key,
          label,
          amount,
          rate,
          lineIndex,
          geo: { ...geo, amountWord: wordFromEnd(line, 0) },
          raw: text.trim(),
        };
        if (cls.kind === 'tax') taxes.push(entry);
        else if (cls.kind === 'total') meta.__total = entry;
        else if (cls.kind === 'subtotal') meta.__subtotal = entry;
        else if (cls.kind === 'taxable') meta.__taxable = entry;
        else if (cls.kind === 'discount') adjustments.push(entry);
        else if (cls.kind === 'roundoff') meta.__roundOff = entry;
        else if (cls.kind === 'tendered') meta.__tendered = entry;
        else if (cls.kind === 'change') meta.__change = entry;
        return;
      }

      // plain text line — candidate item
      const item = parseItemLine(text, amountTokens, geo);
      if (item) {
        item.lineIndex = lineIndex;
        // Straighten the geometry out for stage 5: the amount is the last word
        // on the line, the unit price is the one before it.
        item.geo = { ...geo, amountWord: geo.lastWord };
        items.push(item);
      } else if (amountTokens.length === 0) {
        if (!meta.merchant && /[A-Za-z]{2,}/.test(text) && text.trim().length <= 48 && lineIndex < 6) {
          meta.merchant = text.trim().replace(/^[^A-Za-z0-9]+/, '');
        } else if (!/^[\d\s\W]*$/.test(text)) {
          misc.push({ lineIndex, text: text.trim() });
        }
      } else {
        misc.push({ lineIndex, text: text.trim(), amounts: amountTokens.map((a) => a.value) });
      }
    });

    const totals = {
      subtotal: meta.__subtotal ? meta.__subtotal.amount : null,
      taxable: meta.__taxable ? meta.__taxable.amount : null,
      discount: adjustments.filter((a) => a.kind === 'discount').reduce((s, a) => s + a.amount, 0) || null,
      tax: taxes.length ? taxes.reduce((s, t) => s + t.amount, 0) : null,
      roundOff: meta.__roundOff ? meta.__roundOff.amount : null,
      total: meta.__total ? meta.__total.amount : null,
      tendered: meta.__tendered ? meta.__tendered.amount : null,
      change: meta.__change ? meta.__change.amount : null,
    };

    const fields = {
      subtotal: meta.__subtotal || null,
      taxable: meta.__taxable || null,
      total: meta.__total || null,
      roundOff: meta.__roundOff || null,
      tendered: meta.__tendered || null,
      change: meta.__change || null,
    };

    const itemsSum = U.round2(items.reduce((s, i) => s + i.amount, 0));

    return {
      currency,
      meta,
      items,
      taxes,
      adjustments,
      totals,
      fields,
      itemsSum,
      misc,
      suspiciousText,
      counts: { lines: lines.length, items: items.length, taxes: taxes.length, adjustments: adjustments.length },
      source: (input && input.source) || 'image',
    };
  }

  RS.parse = { parse, scanAmounts, classify, maskDatesTimes, fixNumericToken };
})(window);
