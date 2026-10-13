/* ==========================================================================
   ReceiptShield — validate.js
   Stage 4: mathematical validation.

   Every equation the receipt asserts is recomputed from the numbers the
   document itself prints, then compared with the printed answer. Nothing is
   taken on trust: if a document says qty × unit = line total, or that
   items − discount + tax = grand total, that claim gets checked.

   Exposes window.RS.validate
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  const PASS = 'pass', WARN = 'warn', FAIL = 'fail', SKIP = 'skip';

  /** Tolerance for a single printed line: rounding noise plus OCR jitter. */
  const lineTol = (amount) => Math.max(0.02, Math.abs(amount || 0) * 0.005);
  /** Tolerance for a sum of many lines. */
  const sumTol = (expected) => Math.max(0.5, Math.abs(expected || 0) * 0.002);

  function status(delta, tol) {
    const d = Math.abs(delta);
    if (d <= tol) return PASS;
    if (d <= tol * 3) return WARN;
    return FAIL;
  }

  function check(o) {
    return {
      stage: 'math',
      status: o.status,
      id: o.id,
      label: o.label,
      equation: o.equation,
      printed: o.printed,
      computed: o.computed,
      delta: o.delta,
      tol: o.tol,
      severity: o.severity || 'medium',
      detail: o.detail || '',
    };
  }

  /**
   * @param {object} r structured receipt from RS.parse
   * @returns {{checks:Array, summary:object, reconciles:boolean}}
   */
  function validate(r) {
    const checks = [];
    const sym = r.currency.symbol;
    const m = (v) => U.fmtMoney(v, sym);
    const T = r.totals;
    const items = r.items.filter((i) => Number.isFinite(i.amount));

    /* ── 1. is there anything to check? ─────────────────────── */
    if (!items.length) {
      checks.push(check({
        id: 'items-present', label: 'Line items detected', status: FAIL, severity: 'medium',
        equation: 'at least one line item', printed: 0, computed: items.length,
        delta: NaN, tol: 0,
        detail: 'No line item with a price could be read, so the arithmetic behind this receipt cannot be verified.',
      }));
    } else {
      checks.push(check({
        id: 'items-present', label: 'Line items detected', status: PASS, severity: 'info',
        equation: 'count of priced line items', printed: items.length, computed: items.length,
        delta: 0, tol: 0, detail: items.length + ' priced line item(s) parsed.',
      }));
    }

    if (!Number.isFinite(T.total)) {
      checks.push(check({
        id: 'total-present', label: 'Grand total present', status: FAIL, severity: 'high',
        equation: 'a printed grand total', printed: NaN, computed: T.total,
        delta: NaN, tol: 0,
        detail: 'No grand total could be found. Without it there is nothing to reconcile against, which is itself unusual for a real receipt.',
      }));
    } else {
      checks.push(check({
        id: 'total-present', label: 'Grand total present', status: PASS, severity: 'info',
        equation: 'printed grand total', printed: T.total, computed: T.total,
        delta: 0, tol: 0, detail: 'Grand total read as ' + m(T.total) + '.',
      }));
    }

    /* ── 2. each line: qty × unit = line total ─────────────── */
    const lineFails = [];
    items.forEach((it, i) => {
      if (!it.qtyStated || !Number.isFinite(it.unit) || it.unitDerived) return;
      const expected = U.round2(it.qty * it.unit);
      const delta = U.round2(it.amount - expected);
      const tol = lineTol(expected);
      const st = status(delta, tol);
      if (st === PASS) return;
      const row = check({
        id: 'line-' + i, label: 'Line ' + (i + 1) + ': ' + it.name, status: st, severity: st === FAIL ? 'high' : 'medium',
        equation: it.qty + ' × ' + m(it.unit) + ' = ' + m(expected),
        printed: it.amount, computed: expected, delta, tol,
        detail: 'Printed line total ' + m(it.amount) + ' does not match ' + it.qty + ' × ' + m(it.unit) + ' (' + m(expected) + ').',
      });
      lineFails.push(row);
      checks.push(row);
    });
    checks.push(check({
      id: 'line-qty-unit', label: 'Quantity × unit price on every line',
      status: lineFails.some((c) => c.status === FAIL) ? FAIL : (lineFails.length ? WARN : PASS),
      severity: 'medium',
      equation: 'qty × unit = line total, all lines',
      printed: lineFails.length, computed: 0, delta: lineFails.length, tol: 0,
      detail: lineFails.length
        ? lineFails.length + ' line(s) fail their own multiplication.'
        : 'Every stated quantity times its unit price equals the printed line total.',
    }));

    /* ── 3. items ⇒ subtotal ───────────────────────────────── */
    const itemsSum = r.itemsSum;
    if (Number.isFinite(T.subtotal)) {
      const expected = itemsSum;
      const delta = U.round2(T.subtotal - expected);
      const tol = sumTol(expected);
      const st = status(delta, tol);
      checks.push(check({
        id: 'items-sum-subtotal', label: 'Line items add up to the subtotal',
        status: st, severity: st === FAIL ? 'critical' : 'medium',
        equation: 'Σ line totals = subtotal → ' + m(itemsSum),
        printed: T.subtotal, computed: itemsSum, delta, tol,
        detail: st === PASS
          ? 'The item lines sum exactly to the printed subtotal ' + m(T.subtotal) + '.'
          : 'The item lines sum to ' + m(itemsSum) + ' but the receipt prints a subtotal of ' + m(T.subtotal) +
            ' — a difference of ' + U.fmtMoney(Math.abs(delta), sym) + '.',
      }));
    } else {
      checks.push(check({
        id: 'items-sum-subtotal', label: 'Line items add up to the subtotal',
        status: SKIP, severity: 'info', equation: 'Σ line totals = subtotal',
        printed: NaN, computed: itemsSum, delta: NaN, tol: 0,
        detail: 'No subtotal line printed; the sum of the items (' + m(itemsSum) + ') is carried forward instead.',
      }));
    }

    /* ── 4. subtotal − discount = taxable value ────────────── */
    const discount = Number.isFinite(T.discount) ? T.discount : 0;
    const netBeforeTax = Number.isFinite(T.taxable)
      ? T.taxable
      : U.round2((Number.isFinite(T.subtotal) ? T.subtotal : itemsSum) - discount);

    if (Number.isFinite(T.taxable) && Number.isFinite(T.subtotal)) {
      const expected = U.round2(T.subtotal - discount);
      const delta = U.round2(T.taxable - expected);
      const tol = sumTol(expected);
      const st = status(delta, tol);
      checks.push(check({
        id: 'subtotal-less-discount', label: 'Subtotal − discount = taxable value', status: st,
        severity: st === FAIL ? 'high' : 'medium',
        equation: m(T.subtotal) + ' − ' + m(discount) + ' = ' + m(expected),
        printed: T.taxable, computed: expected, delta, tol,
        detail: st === PASS
          ? 'The taxable value ' + m(T.taxable) + ' matches subtotal minus discount.'
          : 'Taxable value should be ' + m(expected) + ' but the receipt prints ' + m(T.taxable) + '.',
      }));
    }

    /* ── 5. net + tax + round-off = grand total ────────────── */
    if (Number.isFinite(T.total)) {
      const tax = Number.isFinite(T.tax) ? T.tax : 0;
      const roundOff = Number.isFinite(T.roundOff) ? T.roundOff : 0;
      const expected = U.round2(netBeforeTax + tax + roundOff);
      const delta = U.round2(T.total - expected);
      const tol = sumTol(expected);
      const st = status(delta, tol);
      checks.push(check({
        id: 'net-tax-total', label: 'Net + tax + rounding = grand total',
        status: st, severity: st === FAIL ? 'critical' : 'medium',
        equation: m(netBeforeTax) + ' + ' + m(tax) + (roundOff ? ' + ' + m(roundOff) : '') + ' = ' + m(expected),
        printed: T.total, computed: expected, delta, tol,
        detail: st === PASS
          ? 'The grand total reconciles: ' + m(expected) + ' as printed.'
          : 'Recomputing from the receipt’s own figures gives ' + m(expected) + ', but the printed grand total is ' +
            m(T.total) + ' — off by ' + U.fmtMoney(Math.abs(delta), sym) + '.',
      }));

      // materiality: is the gap a big fraction of the bill?
      if (st !== PASS && expected > 0) {
        const pct = (Math.abs(delta) / expected) * 100;
        if (pct >= 5) {
          checks[checks.length - 1].detail +=
            ' The gap is ' + pct.toFixed(1) + '% of the bill, far beyond rounding noise.';
        }
      }
    }

    /* ── 6. does each tax line follow its own rate? ────────── */
    if (r.taxes.length) {
      r.taxes.forEach((t, i) => {
        if (!Number.isFinite(t.rate)) return;
        const base = netBeforeTax;
        if (!Number.isFinite(base) || base <= 0) return;
        const expected = U.round2((base * t.rate) / 100);
        const delta = U.round2(t.amount - expected);
        const tol = Math.max(0.05, Math.abs(expected) * 0.02);
        const rateOk = t.rate > 0 && t.rate <= 30;
        const st = !rateOk ? FAIL : status(delta, tol);
        checks.push(check({
          id: 'tax-rate-' + i, label: 'Tax line ' + (i + 1) + ': ' + t.label.replace(/\s+/g, ' '),
          status: st, severity: !rateOk ? 'high' : (st === FAIL ? 'medium' : 'info'),
          equation: m(base) + ' × ' + t.rate + '% = ' + m(expected),
          printed: t.amount, computed: expected, delta, tol,
          detail: !rateOk
            ? 'A tax rate of ' + t.rate + '% is outside any plausible band for a retail receipt.'
            : (st === PASS
              ? 'The ' + t.rate + '% rate applied to ' + m(base) + ' gives ' + m(t.amount) + ' as printed.'
              : 'A ' + t.rate + '% rate on ' + m(base) + ' should give ' + m(expected) + ', not ' + m(t.amount) + '.'),
        }));
      });
    }

    /* ── 7. rounding line behaves like a rounding line ─────── */
    if (Number.isFinite(T.roundOff)) {
      const okMagnitude = Math.abs(T.roundOff) <= 0.5;
      checks.push(check({
        id: 'roundoff', label: 'Rounding adjustment is within ±0.50',
        status: okMagnitude ? PASS : FAIL, severity: okMagnitude ? 'info' : 'medium',
        equation: '|round off| ≤ 0.50', printed: T.roundOff, computed: okMagnitude ? 0 : T.roundOff,
        delta: okMagnitude ? 0 : T.roundOff, tol: 0.5,
        detail: okMagnitude
          ? 'The rounding line is ' + m(T.roundOff) + ', a normal amount.'
          : 'A rounding adjustment of ' + m(T.roundOff) + ' is too large to be rounding — it is being used to hide a difference.',
      }));
    }

    /* ── 8. payment lines ──────────────────────────────────── */
    if (Number.isFinite(T.tendered) && Number.isFinite(T.total)) {
      const short = U.round2(T.total - T.tendered);
      const st = short > lineTol(T.total) ? FAIL : PASS;
      checks.push(check({
        id: 'tendered', label: 'Amount paid covers the total',
        status: st, severity: st === FAIL ? 'high' : 'info',
        equation: m(T.tendered) + ' ≥ ' + m(T.total),
        printed: T.tendered, computed: T.total, delta: short, tol: lineTol(T.total),
        detail: st === PASS
          ? 'The payment line covers the total.'
          : 'The amount shown as paid (' + m(T.tendered) + ') is ' + m(short) + ' short of the printed total.',
      }));
    }
    if (Number.isFinite(T.change) && Number.isFinite(T.tendered) && Number.isFinite(T.total)) {
      const expected = U.round2(T.tendered - T.total);
      const delta = U.round2(T.change - expected);
      const st = status(delta, lineTol(expected));
      checks.push(check({
        id: 'change', label: 'Change = paid − total', status: st,
        severity: st === FAIL ? 'medium' : 'info',
        equation: m(T.tendered) + ' − ' + m(T.total) + ' = ' + m(expected),
        printed: T.change, computed: expected, delta, tol: lineTol(expected),
        detail: st === PASS ? 'Change matches.' : 'Change should be ' + m(expected) + ' but the receipt prints ' + m(T.change) + '.',
      }));
    }

    /* ── 9. sign sanity ────────────────────────────────────── */
    const negativeItems = items.filter((i) => i.amount < 0);
    if (negativeItems.length) {
      checks.push(check({
        id: 'signs', label: 'Line amounts are positive', status: FAIL, severity: 'medium',
        equation: 'all line totals > 0', printed: negativeItems.length, computed: 0,
        delta: negativeItems.length, tol: 0,
        detail: negativeItems.length + ' line item(s) carry a non-positive amount without being labelled as a discount or return.',
      }));
    }

    const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
    checks.forEach((c) => { summary[c.status] = (summary[c.status] || 0) + 1; });

    return {
      checks,
      summary,
      reconciles: summary.fail === 0,
      netBeforeTax,
      itemsSum,
      computedTotal: Number.isFinite(T.total)
        ? U.round2(netBeforeTax + (Number.isFinite(T.tax) ? T.tax : 0) + (Number.isFinite(T.roundOff) ? T.roundOff : 0))
        : null,
    };
  }

  RS.validate = { validate, PASS, WARN, FAIL, SKIP };
})(window);
