
/* ==========================================================================
   ReceiptShield — validate.js
   Stage 4: mathematical validation with OCR-aware review handling.

   OCR uncertainty is not proof of fraud.
   Arithmetic discrepancies remain visible for manual verification.

   Exposes window.RS.validate
   ========================================================================== */

(function (global) {
  'use strict';

  const RS = global.RS;

  if (!RS || !RS.util) {
    throw new Error(
      'ReceiptShield: RS.util must load before validate.js'
    );
  }

  const U = RS.util;

  const PASS = 'pass';
  const WARN = 'warn';
  const FAIL = 'fail';
  const SKIP = 'skip';

  const lineTol = amount =>
    Math.max(0.02, Math.abs(amount || 0) * 0.005);

  const sumTol = amount =>
    Math.max(0.5, Math.abs(amount || 0) * 0.002);

  function status(delta, tolerance) {
    const difference = Math.abs(delta);

    if (difference <= tolerance) return PASS;
    if (difference <= tolerance * 3) return WARN;

    return FAIL;
  }

  function check(options) {
    return {
      stage: 'math',
      status: options.status,
      id: options.id,
      label: options.label,
      equation: options.equation,
      printed: options.printed,
      computed: options.computed,
      delta: options.delta,
      tol: options.tol,
      severity: options.severity || 'medium',
      detail: options.detail || ''
    };
  }

  function validate(receipt) {
    receipt = receipt || {};

    const checks = [];
    const totals = receipt.totals || {};

    const items = (receipt.items || []).filter(item =>
      Number.isFinite(item.amount)
    );

    const currency = receipt.currency || {};
    const symbol = currency.symbol || '₹';

    const money = value =>
      Number.isFinite(value)
        ? U.fmtMoney(value, symbol)
        : 'Unavailable';

    const round2 = value => U.round2(value);

    const hasTotal = Number.isFinite(totals.total);
    const hasSubtotal = Number.isFinite(totals.subtotal);

    const itemsSum = Number.isFinite(receipt.itemsSum)
      ? receipt.itemsSum
      : round2(
          items.reduce((sum, item) => sum + item.amount, 0)
        );

    /*
     * OCR confidence is useful for deciding when to request review.
     * It is not proof that the recognized financial values are correct.
     */
    const itemConfidenceValues = items
      .map(item => item.geo && item.geo.conf)
      .filter(value => Number.isFinite(value));

    const lowItemConfidence = itemConfidenceValues.some(value =>
      value <= 1 ? value < 0.6 : value < 60
    );

    const lowLineConfidence =
      (receipt.suspiciousText || []).length > 0;

    const ocrUncertain =
      lowItemConfidence ||
      lowLineConfidence ||
      receipt.needsReview === true ||
      receipt.reviewRequired === true;

    const reviewReasons = [];

    if (!items.length) {
      reviewReasons.push(
        'No priced line items could be read reliably.'
      );
    }

    if (!hasTotal) {
      reviewReasons.push(
        'Grand total could not be read reliably.'
      );
    }

    if (lowItemConfidence || lowLineConfidence || ocrUncertain) {
      reviewReasons.push(
        'OCR confidence or extracted text requires manual verification.'
      );
    }

    /*
     * 1. Line items present
     */
    checks.push(check({
      id: 'items-present',
      label: 'Line items detected',
      status: items.length ? PASS : WARN,
      severity: 'info',
      equation: 'At least one priced line item',
      printed: items.length,
      computed: items.length,
      delta: 0,
      tol: 0,
      detail: items.length
        ? `${items.length} priced item(s) detected.`
        : 'No priced items could be verified. This may be an OCR failure.'
    }));

    /*
     * 2. Grand total present
     */
    checks.push(check({
      id: 'total-present',
      label: 'Grand total present',
      status: hasTotal ? PASS : WARN,
      severity: 'info',
      equation: 'Printed grand total',
      printed: hasTotal ? totals.total : NaN,
      computed: hasTotal ? totals.total : NaN,
      delta: 0,
      tol: 0,
      detail: hasTotal
        ? `Grand total read as ${money(totals.total)}.`
        : 'Grand total is unavailable; manual review is required.'
    }));

    /*
     * 3. Quantity × unit price = line total
     */
    const lineFailures = [];

    items.forEach((item, index) => {
      if (
        !item.qtyStated ||
        !Number.isFinite(item.unit) ||
        item.unitDerived
      ) {
        return;
      }

      const expected = round2(item.qty * item.unit);
      const delta = round2(item.amount - expected);
      const tolerance = lineTol(expected);
      const result = status(delta, tolerance);

      if (result === PASS) return;

      const row = check({
        id: `line-${index}`,
        label: `Line ${index + 1}: ${item.name}`,
        status: result,
        severity: result === FAIL ? 'high' : 'medium',
        equation:
          `${item.qty} × ${money(item.unit)} = ${money(expected)}`,
        printed: item.amount,
        computed: expected,
        delta,
        tol: tolerance,
        detail:
          `Printed amount ${money(item.amount)}; ` +
          `calculated amount ${money(expected)}.`
      });

      lineFailures.push(row);
      checks.push(row);
    });

    checks.push(check({
      id: 'line-qty-unit',
      label: 'Quantity × unit price on every stated line',
      status: lineFailures.some(row => row.status === FAIL)
        ? FAIL
        : lineFailures.length
          ? WARN
          : PASS,
      severity: 'medium',
      equation: 'Quantity × unit price = line total',
      printed: lineFailures.length,
      computed: 0,
      delta: lineFailures.length,
      tol: 0,
      detail: lineFailures.length
        ? `${lineFailures.length} line(s) need arithmetic verification.`
        : 'No stated quantity/unit-price discrepancies detected.'
    }));

    /*
     * 4. Item sum = subtotal
     */
    if (hasSubtotal) {
      const delta = round2(totals.subtotal - itemsSum);
      const tolerance = sumTol(itemsSum);
      const result = status(delta, tolerance);

      checks.push(check({
        id: 'items-sum-subtotal',
        label: 'Line items add up to subtotal',
        status: result,
        severity: result === FAIL ? 'high' : 'medium',
        equation: `Items sum = ${money(itemsSum)}`,
        printed: totals.subtotal,
        computed: itemsSum,
        delta,
        tol: tolerance,
        detail:
          `Parsed items sum to ${money(itemsSum)}; ` +
          `printed subtotal is ${money(totals.subtotal)}.`
      }));
    } else {
      checks.push(check({
        id: 'items-sum-subtotal',
        label: 'Line items add up to subtotal',
        status: SKIP,
        severity: 'info',
        equation: 'Sum of line items = subtotal',
        printed: NaN,
        computed: itemsSum,
        delta: NaN,
        tol: 0,
        detail: 'Subtotal not detected; this check was skipped.'
      }));
    }

    /*
     * 5. Subtotal − discount = taxable value
     *
     * A discount is a deduction. Its sign in the source text
     * must not cause it to be added to the subtotal.
     */
    const discount = Number.isFinite(totals.discount)
      ? Math.abs(totals.discount)
      : 0;

    const baseBeforeTax = hasSubtotal
      ? totals.subtotal
      : itemsSum;

    const expectedTaxable = round2(
      baseBeforeTax - discount
    );

    if (
      Number.isFinite(totals.taxable) &&
      (hasSubtotal || Number.isFinite(totals.discount))
    ) {
      const delta = round2(
        totals.taxable - expectedTaxable
      );

      const tolerance = sumTol(expectedTaxable);
      const result = status(delta, tolerance);

      checks.push(check({
        id: 'subtotal-less-discount',
        label: 'Subtotal − discount = taxable value',
        status: result,
        severity: result === FAIL ? 'high' : 'medium',
        equation:
          `${money(baseBeforeTax)} − ${money(discount)} ` +
          `= ${money(expectedTaxable)}`,
        printed: totals.taxable,
        computed: expectedTaxable,
        delta,
        tol: tolerance,
        detail:
          `Expected taxable amount ${money(expectedTaxable)}; ` +
          `receipt shows ${money(totals.taxable)}. ` +
          'Verify the printed discount and taxable amount.'
      }));
    } else {
      checks.push(check({
        id: 'subtotal-less-discount',
        label: 'Subtotal − discount = taxable value',
        status: SKIP,
        severity: 'info',
        equation: 'Subtotal − discount = taxable value',
        printed: NaN,
        computed: expectedTaxable,
        delta: NaN,
        tol: 0,
        detail: 'Required financial fields were not all available.'
      }));
    }

    /*
     * 6. Net + tax + rounding = grand total
     */
    const netBeforeTax = Number.isFinite(totals.taxable)
      ? totals.taxable
      : expectedTaxable;

    const tax = Number.isFinite(totals.tax)
      ? totals.tax
      : 0;

    const rounding = Number.isFinite(totals.roundOff)
      ? totals.roundOff
      : 0;

    const computedTotal = round2(
      netBeforeTax + tax + rounding
    );

    if (hasTotal) {
      const delta = round2(totals.total - computedTotal);
      const tolerance = sumTol(computedTotal);
      const result = status(delta, tolerance);

      checks.push(check({
        id: 'net-tax-total',
        label: 'Net + tax + rounding = grand total',
        status: result,
        severity: result === FAIL ? 'high' : 'medium',
        equation:
          `${money(netBeforeTax)} + ${money(tax)} + ` +
          `${money(rounding)} = ${money(computedTotal)}`,
        printed: totals.total,
        computed: computedTotal,
        delta,
        tol: tolerance,
        detail:
          `Calculated total ${money(computedTotal)}; ` +
          `printed total ${money(totals.total)}. ` +
          'A discrepancy may result from OCR errors or incorrect receipt figures.'
      }));
    } else {
      checks.push(check({
        id: 'net-tax-total',
        label: 'Net + tax + rounding = grand total',
        status: SKIP,
        severity: 'info',
        equation: 'Net + tax + rounding = grand total',
        printed: NaN,
        computed: computedTotal,
        delta: NaN,
        tol: 0,
        detail: 'Cannot reconcile totals without a readable grand total.'
      }));
    }

    /*
     * 7. Tax rate checks
     *
     * Compare a tax amount with its rate only when the parser
     * provides both a rate and an amount for that tax row.
     */
    (receipt.taxes || []).forEach((taxRow, index) => {
      if (
        !Number.isFinite(taxRow.rate) ||
        !Number.isFinite(taxRow.amount)
      ) {
        return;
      }

      if (
        !Number.isFinite(netBeforeTax) ||
        netBeforeTax <= 0
      ) {
        return;
      }

      const expected = round2(
        netBeforeTax * taxRow.rate / 100
      );

      const delta = round2(
        taxRow.amount - expected
      );

      const tolerance = Math.max(
        0.05,
        Math.abs(expected) * 0.02
      );

      const result = status(delta, tolerance);

      checks.push(check({
        id: `tax-rate-${index}`,
        label: `Tax line ${index + 1}: ${taxRow.label}`,
        status: result,
        severity: result === FAIL ? 'medium' : 'info',
        equation:
          `${money(netBeforeTax)} × ${taxRow.rate}% = ${money(expected)}`,
        printed: taxRow.amount,
        computed: expected,
        delta,
        tol: tolerance,
        detail:
          `Verify the printed rate ${taxRow.rate}% and the tax base.`
      }));
    });

    /*
     * 8. Rounding adjustment
     */
    if (Number.isFinite(totals.roundOff)) {
      const valid = Math.abs(totals.roundOff) <= 0.5;

      checks.push(check({
        id: 'roundoff',
        label: 'Rounding adjustment within ±0.50',
        status: valid ? PASS : WARN,
        severity: 'info',
        equation: '|round off| ≤ 0.50',
        printed: totals.roundOff,
        computed: 0,
        delta: totals.roundOff,
        tol: 0.5,
        detail: valid
          ? 'Rounding adjustment is within the expected range.'
          : 'Large rounding adjustment needs manual verification.'
      }));
    }

    /*
     * 9. Payment checks
     */
    if (
      Number.isFinite(totals.tendered) &&
      hasTotal
    ) {
      const shortfall = round2(
        totals.total - totals.tendered
      );

      const underpaid =
        shortfall > lineTol(totals.total);

      checks.push(check({
        id: 'tendered',
        label: 'Amount paid covers the total',
        status: underpaid ? WARN : PASS,
        severity: 'info',
        equation:
          `${money(totals.tendered)} ≥ ${money(totals.total)}`,
        printed: totals.tendered,
        computed: totals.total,
        delta: shortfall,
        tol: lineTol(totals.total),
        detail: underpaid
          ? 'Payment amount appears lower than the printed total; verify it.'
          : 'Payment amount covers the printed total.'
      }));
    }

    if (
      Number.isFinite(totals.change) &&
      Number.isFinite(totals.tendered) &&
      hasTotal
    ) {
      const expected = round2(
        totals.tendered - totals.total
      );

      const delta = round2(
        totals.change - expected
      );

      const tolerance = lineTol(expected);

      checks.push(check({
        id: 'change',
        label: 'Change = paid − total',
        status: status(delta, tolerance),
        severity: 'info',
        equation:
          `${money(totals.tendered)} − ${money(totals.total)} ` +
          `= ${money(expected)}`,
        printed: totals.change,
        computed: expected,
        delta,
        tol: tolerance,
        detail:
          'Verify the amount of change printed on the receipt.'
      }));
    }

    /*
     * 10. OCR uncertainty policy
     *
     * Preserve the original discrepancy values, but downgrade
     * failed checks to warnings when extraction is uncertain.
     *
     * A warning still requires review. This is not a finding that
     * the receipt is genuine, and it must not conceal discrepancies.
     */
    if (ocrUncertain) {
      checks.forEach(row => {
        if (row.status === FAIL) {
          row.status = WARN;
          row.severity = 'medium';

          row.detail =
            (row.detail ? row.detail + ' ' : '') +
            'OCR extraction is uncertain. Verify the original ' +
            'printed figures before drawing a fraud conclusion.';
        }
      });
    }

    /*
     * 11. Recalculate summary after applying OCR policy.
     */
    const summary = {
      pass: 0,
      warn: 0,
      fail: 0,
      skip: 0
    };

    checks.forEach(row => {
      summary[row.status] =
        (summary[row.status] || 0) + 1;
    });

    const reviewRequired =
      ocrUncertain ||
      reviewReasons.length > 0 ||
      summary.fail > 0 ||
      summary.warn > 0;

    let result;

    if (ocrUncertain || reviewReasons.length > 0) {
      result = 'needs_review';
    } else if (summary.fail > 0 || summary.warn > 0) {
      result = 'verification_failed';
    } else {
      result = 'reconciled';
    }

    return {
      checks,
      summary,

      /*
       * This indicates arithmetic reconciliation only.
       * It is not a determination of receipt authenticity.
       */
      reconciles:
        summary.fail === 0 &&
        summary.warn === 0 &&
        !ocrUncertain,

      reviewRequired,
      reviewReasons,
      result,
      netBeforeTax,
      itemsSum,
      computedTotal: hasTotal ? computedTotal : null,
      ocrUncertain
    };
  }

  RS.validate = {
    validate,
    PASS,
    WARN,
    FAIL,
    SKIP
  };

})(window);
