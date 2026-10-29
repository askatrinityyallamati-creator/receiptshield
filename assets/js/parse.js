
/* ==========================================================================
   ReceiptShield — parse.js
   OCR-aware receipt parser with conservative financial extraction.

   Exposes window.RS.parse
   ========================================================================== */

(function (global) {
  'use strict';

  const RS = global.RS;

  if (!RS || !RS.util) {
    throw new Error('ReceiptShield: RS.util must load before parse.js');
  }

  const U = RS.util;

  function maskDatesTimes(text) {
    return String(text || '')
      .replace(
        /\b\d{1,4}[/. -]\d{1,2}[/. -]\d{2,4}\b/g,
        match => ' '.repeat(match.length)
      )
      .replace(
        /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
        match => ' '.repeat(match.length)
      );
  }

  /*
   * Parse money without inventing digits.
   * OCR text is not automatically corrected from Z to 2,
   * O to 0, or similar substitutions in financial amounts.
   */
  const AMOUNT_RE =
    /(?:₹|INR\b|Rs\.?)\s*[-−]?\s*\d[\d,]*(?:\.\d{1,2})?|\(?-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\)?|\(?-?\d+\.\d{1,2}\)?|\(?-?\d{2,7}\)?/gi;

  const CURRENCY_TOKEN = /(?:₹|\bINR\b|\bRs\.?)/i;

  function scanAmounts(rawText, options) {
    const relaxed = !!(options && options.relaxed);
    const text = maskDatesTimes(rawText);
    const results = [];

    AMOUNT_RE.lastIndex = 0;

    let match;

    while ((match = AMOUNT_RE.exec(text)) !== null) {
      const token = match[0].trim();
      const before = text[match.index - 1];
      const after = text[match.index + match[0].length];

      if (before && /[A-Za-z0-9.,/]/.test(before)) continue;
      if (after && /[A-Za-z0-9.,/%:]/.test(after)) continue;

      const digits = token.replace(/\D/g, '');
      const hasSymbol = CURRENCY_TOKEN.test(token);
      const hasDecimal = /\.\d{1,2}\)?$/.test(token);
      const hasGrouping = /\d,\d{2,3}/.test(token);

      if (!hasSymbol && !hasDecimal && !hasGrouping) {
        if (digits.length >= 6) continue;
        if (digits.length <= 3 && !relaxed) continue;
      }

      const value = U.parseAmount(token);

      if (!Number.isFinite(value)) continue;

      results.push({
        raw: token,
        value,
        index: match.index,
        end: match.index + match[0].length,
        hasSymbol,
        hasDecimal
      });
    }

    return results;
  }

  /*
   * Deliberately do not auto-correct ambiguous financial tokens.
   * A wrong correction can multiply a receipt's apparent value.
   */
  function fixNumericToken(token) {
    return String(token || '');
  }

  function rateOf(text) {
    const match = String(text || '').match(
      /\b(\d{1,2}(?:\.\d{1,2})?)\s*%/
    );

    if (!match) return null;

    const value = Number(match[1]);

    return Number.isFinite(value) && value > 0 && value <= 30
      ? value
      : null;
  }

  function normalizeLabel(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[|!]/g, 'l')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function classify(lineText) {
    const text = String(lineText || '').trim();

    if (!text) return { kind: 'blank' };

    if (/^[\-=_.*·•~\s]{3,}$/.test(text)) {
      return { kind: 'rule' };
    }

    const normalized = normalizeLabel(text);
    const compact = normalized.replace(/[^a-z]/g, '');

    /*
     * Explanatory notes are not product or tax rows.
     * Their embedded figures must not be counted twice.
     */
    if (/inclusive\s+of\s+gst/i.test(text)) {
      return { kind: 'meta', key: 'taxNote', value: text };
    }

    if (
      /\b(?:grand\s*total|total\s*(?:due|payable|amount)|amount\s*(?:due|payable)|net\s*payable|bill\s*amount|invoice\s*total)\b/i.test(text)
    ) {
      return { kind: 'total', key: 'total' };
    }

    if (
      /\b(?:sub\s*total|subtotal|subtoal|subtozl|subtoal)\b/i.test(text) ||
      /^sub(?:to|t)?a?l$/.test(compact)
    ) {
      return { kind: 'subtotal', key: 'subtotal' };
    }

    if (
      /\b(?:taxable\s*(?:value|amount|total)|net\s*(?:amount|total)|amount\s*before\s*tax)\b/i.test(text) ||
      /\bl[u]?x?able\s*amoun?t\b/i.test(text)
    ) {
      return { kind: 'taxable', key: 'taxable' };
    }

    if (
      /\b(?:discount|disc\b|savings?|coupon|rebate|voucher|offer)\b/i.test(text)
    ) {
      return { kind: 'discount', key: 'discount' };
    }

    if (/\bround(?:ing)?\s*off\b/i.test(text)) {
      return { kind: 'roundoff', key: 'roundOff' };
    }

    if (
      /\b(?:cgst|sgst|igst|utgst|gst|vat|cess|service\s*tax|sales\s*tax)\b/i.test(text)
    ) {
      return { kind: 'tax', key: 'tax' };
    }

    if (/\b(?:amount\s*paid|tendered|cash\s*received)\b/i.test(text)) {
      return { kind: 'tendered', key: 'tendered' };
    }

    if (/\b(?:change\s*due|change\s*returned|balance\s*returned)\b/i.test(text)) {
      return { kind: 'change', key: 'change' };
    }

    const metaPatterns = [
      {
        key: 'invoiceNo',
        re: /\b(?:invoice|inv|bill|receipt|order|ref|txn|transaction|token)\s*(?:no\.?|number|#|id)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{2,})/i
      },
      {
        key: 'date',
        re: /\b(?:date|dt)\s*[:\-]?\s*(\d{1,4}[/. -]\d{1,2}[/. -]\d{2,4})/i
      },
      {
        key: 'time',
        re: /\btime\s*[:\-]?\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)/i
      },
      {
        key: 'gstin',
        re: /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3})\b/i
      }
    ];

    for (const pattern of metaPatterns) {
      const match = text.match(pattern.re);

      if (match) {
        return {
          kind: 'meta',
          key: pattern.key,
          value: match[1]
        };
      }
    }

    return { kind: 'text' };
  }

  const MONEY_ROWS = [
    'subtotal',
    'taxable',
    'discount',
    'tax',
    'total',
    'tendered',
    'change',
    'roundoff'
  ];

  const QTY_PREFIX =
    /^\s*\d{1,3}\s*(?:x|×|@)\s*/i;

  const QTY_BARE =
    /^\s*\d{1,3}\s+(?=[A-Za-z])/;

  /*
   * Avoid classifying addresses, contact details, GSTINs,
   * payment details, and footer text as product descriptions.
   */
  function looksLikeNonItem(text) {
    return (
      /\b(?:hyderabad|customer|payment|sales|gstin|tax invoice|thank you|please visit|terms|subtotal|discount|taxable|grand total|inclusive of gst|invoice|date|phone|mobile|address|pincode)\b/i.test(text) ||
      /\b\d{10,}\b/.test(text) ||
      /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}\b/i.test(text)
    );
  }

  function wordFromEnd(line, offset) {
    if (!line || !Array.isArray(line.words) || !line.words.length) {
      return null;
    }

    const index = line.words.length - 1 - (offset || 0);

    if (index < 0) return null;

    const word = line.words[index];

    return {
      text: word.text,
      conf: word.conf,
      x0: word.x0,
      x1: word.x1,
      y0: word.y0,
      y1: word.y1,
      height: word.y1 - word.y0,
      baseline: word.y1
    };
  }

  function parseItemLine(text, amounts, geo) {
    if (!amounts.length) return null;

    if (classify(text).kind !== 'text') return null;
    if (looksLikeNonItem(text)) return null;

    const tokens = amounts.slice().sort((a, b) => a.index - b.index);
    const last = tokens[tokens.length - 1];
    const second = tokens.length > 1 ? tokens[tokens.length - 2] : null;

    /*
     * Reject a row if OCR has merged unrelated columns after
     * the final amount. Do not infer an amount from unrelated text.
     */
    const tail = text.slice(last.end).trim();

    if (tail && !/^[A-Za-z%.)\s]*$/.test(tail)) {
      return null;
    }

    let name = text.slice(0, second ? second.index : last.index);
    let quantity = null;

    const quantityMatch = name.match(QTY_PREFIX);

    if (quantityMatch) {
      quantity = 1;
      name = name.slice(quantityMatch[0].length);
    } else {
      const bareMatch = name.match(QTY_BARE);

      if (bareMatch) {
        quantity = Number(bareMatch[0].trim());
        name = name.slice(bareMatch[0].length);
      }
    }

    let unit = null;
    let unitStated = false;

    if (second && second.value > 0) {
      unit = second.value;
      unitStated = true;
    }

    name = name
      .replace(/^\s*\d+[.)]?\s*/, '')
      .replace(/[\s.()\-–—_|:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (
      !name ||
      !/[A-Za-z]{2,}/.test(name) ||
      name.length > 60
    ) {
      return null;
    }

    const amount = last.value;

    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    if (quantity === null) quantity = 1;

    const unitDerived = !unitStated;

    if (unitDerived) {
      unit = U.round2(amount / quantity);
    }

    return {
      name,
      qty: quantity,
      qtyStated: quantity !== 1 || !!quantityMatch,
      unit,
      unitStated,
      unitDerived,
      amount,
      raw: text.trim(),
      geo: geo || null
    };
  }

  function parse(input) {
    const rawText = (input && input.text) || '';
    let lines = (input && input.lines) || [];

    if (!lines.length) {
      lines = rawText.split(/\r?\n/).map((text, index) => ({
        key: 'txt-' + index,
        text,
        words: [],
        x0: 0,
        x1: 0,
        y0: index,
        y1: index,
        height: 0,
        baseline: index,
        conf: null,
        minConf: null,
        width: 0,
        gaps: []
      }));
    }

    const currency = U.detectCurrency(
      rawText + ' ' + lines.map(line => line.text || '').join(' ')
    );

    const items = [];
    const taxes = [];
    const adjustments = [];
    const meta = {};
    const misc = [];
    const suspiciousText = [];

    lines.forEach((line, lineIndex) => {
      const text = String(line.text || '').trim();

      if (!text) return;

      const classification = classify(text);

      if (
        classification.kind === 'rule' ||
        classification.kind === 'blank'
      ) {
        return;
      }

      const isMoneyRow = MONEY_ROWS.includes(classification.kind);
      const amounts = scanAmounts(text, { relaxed: isMoneyRow });

      const geo = {
        lineIndex,
        lineY: line.y0,
        lineHeight: line.height,
        conf: line.conf,
        minConf: line.minConf,
        lastWord: wordFromEnd(line, 0),
        unitWord: wordFromEnd(line, 1)
      };

      if (classification.kind === 'meta') {
        if (classification.value && !meta[classification.key]) {
          meta[classification.key] = classification.value;
        }

        if (classification.key === 'taxNote') {
          misc.push({
            lineIndex,
            text,
            note: true
          });
        }

        return;
      }

      if (isMoneyRow) {
        if (!amounts.length) {
          suspiciousText.push({
            lineIndex,
            text,
            reason: 'Financial label found, but no reliable amount was extracted.'
          });

          return;
        }

        /*
         * For summary rows, use the final amount on the line.
         * This prevents a tax percentage from being mistaken
         * for the tax amount.
         */
        const amountToken = amounts[amounts.length - 1];

        const entry = {
          kind: classification.kind,
          key: classification.key,
          label: text.slice(0, amountToken.index).trim(),
          amount: amountToken.value,
          rate: rateOf(text),
          lineIndex,
          geo: {
            ...geo,
            amountWord: wordFromEnd(line, 0)
          },
          raw: text
        };

        if (classification.kind === 'tax') {
          taxes.push(entry);
        } else if (classification.kind === 'subtotal') {
          meta.__subtotal = entry;
        } else if (classification.kind === 'taxable') {
          meta.__taxable = entry;
        } else if (classification.kind === 'total') {
          meta.__total = entry;
        } else if (classification.kind === 'discount') {
          adjustments.push(entry);
        } else if (classification.kind === 'roundoff') {
          meta.__roundOff = entry;
        } else if (classification.kind === 'tendered') {
          meta.__tendered = entry;
        } else if (classification.kind === 'change') {
          meta.__change = entry;
        }

        return;
      }

      const item = parseItemLine(text, amounts, geo);

      if (item) {
        item.lineIndex = lineIndex;
        items.push(item);
      } else if (amounts.length) {
        misc.push({
          lineIndex,
          text,
          amounts: amounts.map(amount => amount.value)
        });
      } else if (
        !meta.merchant &&
        /[A-Za-z]{2,}/.test(text) &&
        text.length <= 48 &&
        lineIndex < 6 &&
        !looksLikeNonItem(text)
      ) {
        meta.merchant = text.replace(/^[^A-Za-z0-9]+/, '');
      } else {
        misc.push({ lineIndex, text });
      }
    });

    const discountRows = adjustments.filter(
      entry => entry.kind === 'discount'
    );

    const totals = {
      subtotal: meta.__subtotal ? meta.__subtotal.amount : null,
      taxable: meta.__taxable ? meta.__taxable.amount : null,

      discount: discountRows.length
        ? discountRows.reduce(
            (sum, entry) => sum + Math.abs(entry.amount),
            0
          )
        : null,

      tax: taxes.length
        ? U.round2(
            taxes.reduce((sum, entry) => sum + entry.amount, 0)
          )
        : null,

      roundOff: meta.__roundOff ? meta.__roundOff.amount : null,
      total: meta.__total ? meta.__total.amount : null,
      tendered: meta.__tendered ? meta.__tendered.amount : null,
      change: meta.__change ? meta.__change.amount : null
    };

    const fields = {
      subtotal: meta.__subtotal || null,
      taxable: meta.__taxable || null,
      total: meta.__total || null,
      roundOff: meta.__roundOff || null,
      tendered: meta.__tendered || null,
      change: meta.__change || null
    };

    const itemsSum = U.round2(
      items.reduce((sum, item) => sum + item.amount, 0)
    );

    /*
     * Do not equate parsing success with authenticity.
     * Downstream code should treat these as review signals.
     */
    const reviewReasons = [];

    if (input && input.needsReview) {
      reviewReasons.push(
        'OCR confidence is low; verify financial figures manually.'
      );
    }

    if (suspiciousText.length) {
      reviewReasons.push(
        'One or more financial or numeric lines could not be classified confidently.'
      );
    }

    if (!items.length) {
      reviewReasons.push('No reliable product line items were extracted.');
    }

    if (totals.total === null) {
      reviewReasons.push('Grand total was not extracted.');
    }

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
      reviewRequired: reviewReasons.length > 0,
      reviewReasons,
      counts: {
        lines: lines.length,
        items: items.length,
        taxes: taxes.length,
        adjustments: adjustments.length
      },
      source: (input && input.source) || 'image'
    };
  }

  RS.parse = {
    parse,
    scanAmounts,
    classify,
    maskDatesTimes,
    fixNumericToken
  };

})(window);
