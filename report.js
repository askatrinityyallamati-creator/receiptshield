/* ==========================================================================
   ReceiptShield — report.js
   Stages 6 and 7: suspicious information detection, then the fraud risk report.

   Stage 6 looks for anomalies that are neither pure arithmetic nor pure pixels:
   repeated lines, figures whose discrepancy is an exactly round amount, a
   missing tax line, absent transaction identifiers, a grand total below one of
   its own line items.

   Stage 7 weights everything into a 0–100 score, writes a plain-language
   verdict, and assembles one report object the UI and the JSON export share.

   Exposes window.RS.report
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  const WEIGHT = { critical: 34, high: 22, medium: 12, low: 5, info: 0 };
  const ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Passed' };
  const STAGE_LABEL = {
    upload: 'Receipt Upload',
    ocr: 'OCR Extraction',
    parse: 'Item / Price / Tax Detection',
    math: 'Mathematical Validation',
    visual: 'Visual Tampering Analysis',
    suspicious: 'Suspicious Information Detection',
    report: 'Fraud Risk Report',
  };

  const BANDS = [
    { max: 19, band: 'Low risk', tone: 'ok' },
    { max: 44, band: 'Elevated risk', tone: 'info' },
    { max: 69, band: 'Suspicious', tone: 'warn' },
    { max: 100, band: 'High risk', tone: 'danger' },
  ];

  /* ── helpers ─────────────────────────────────────────────── */
  const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const downgrade = (sev) => ({ critical: 'medium', high: 'medium', medium: 'low', low: 'low', info: 'info' }[sev] || 'low');

  /**
   * When a discrepancy is an exactly round money amount it is not rounding
   * noise — it is the shape of a hand-typed edit.
   */
  function roundUnit(delta) {
    const a = Math.abs(delta);
    if (!Number.isFinite(a) || a < 40) return null;
    for (const unit of [10000, 5000, 1000, 500, 100, 50]) {
      if (Math.abs(a % unit) < 0.02 || Math.abs((a % unit) - unit) < 0.02) return unit;
    }
    return null;
  }

  /* ── stage 6: suspicious information ─────────────────────── */
  function detectSuspicious(receipt, math) {
    const checks = [];
    const findings = [];
    const items = receipt.items || [];
    const sym = receipt.currency.symbol;
    const m = (v) => U.fmtMoney(v, sym);

    /* repeated descriptions */
    const groups = new Map();
    items.forEach((i) => {
      const k = normName(i.name);
      if (k.length < 4) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const dupExact = [], dupPrice = [];
    groups.forEach((g) => {
      if (g.length < 2) return;
      const amounts = new Set(g.map((i) => i.amount.toFixed(2)));
      if (amounts.size === 1) dupExact.push(g);
      else dupPrice.push(g);
    });

    if (dupExact.length) {
      checks.push({
        stage: 'suspicious', status: 'warn', id: 'dup-lines', label: 'Repeated identical line items',
        detail: dupExact.map((g) => '“' + g[0].name + '” appears ' + g.length + ' times at ' + m(g[0].amount)).join('; ') +
          '. Genuine duplicates do happen, but a repeated line is also the simplest way to inflate a bill.',
      });
      findings.push({
        stage: 'suspicious', severity: 'medium', id: 'dup-lines',
        title: 'The same line item is repeated',
        detail: 'Identical descriptions at identical prices appear more than once. Chargebacks and expense fraud frequently rely on exactly this.',
        evidence: dupExact.map((g) => g.map((i) => i.raw).join('\n')).join('\n---\n'),
      });
    }
    if (dupPrice.length) {
      checks.push({
        stage: 'suspicious', status: 'fail', id: 'dup-name-two-prices', label: 'Same item, two different prices',
        detail: dupPrice.map((g) => '“' + g[0].name + '” is priced at ' + g.map((i) => m(i.amount)).join(' and ')).join('; ') + '.',
      });
      findings.push({
        stage: 'suspicious', severity: 'medium', id: 'dup-name-two-prices',
        title: 'One item carries two different prices',
        detail: 'The same description is billed at two different line totals, which usually means one of the two was edited.',
        evidence: dupPrice.map((g) => g.map((i) => i.raw).join('\n')).join('\n---\n'),
      });
    }

    /* no tax anywhere */
    if (items.length >= 3 && !receipt.taxes.length) {
      checks.push({
        stage: 'suspicious', status: 'warn', id: 'no-tax', label: 'No tax line on the receipt',
        detail: 'A multi-item retail receipt with no tax or VAT line at all is unusual in most jurisdictions, though some merchants are exempt.',
      });
      findings.push({
        stage: 'suspicious', severity: 'low', id: 'no-tax',
        title: 'No tax line anywhere on the document',
        detail: 'There is nothing to cross-check the net amount against. This is weak on its own — some merchants print a tax-inclusive total — but it removes one of the checks a genuine receipt usually supports.',
        evidence: items.length + ' line items, 0 tax rows recognised',
      });
    }

    /* tax rows with no rate */
    const taxesWithoutRate = receipt.taxes.filter((t) => !Number.isFinite(t.rate));
    if (receipt.taxes.length && taxesWithoutRate.length === receipt.taxes.length) {
      checks.push({
        stage: 'suspicious', status: 'warn', id: 'tax-no-rate', label: 'Tax rows carry no percentage',
        detail: 'A tax amount is printed but no rate accompanies it, so the rate cannot be verified against the net amount.',
      });
    }

    /* identifiers */
    const hasInvoice = !!receipt.meta.invoiceNo;
    const hasDate = !!receipt.meta.date;
    if (!hasInvoice && !hasDate) {
      checks.push({
        stage: 'suspicious', status: 'warn', id: 'no-ids', label: 'No transaction identifiers',
        detail: 'Neither an invoice/bill number nor a date could be read. An expense that cannot be tied to a numbered document is hard to verify.',
      });
      findings.push({
        stage: 'suspicious', severity: 'low', id: 'no-ids',
        title: 'No invoice number or date on the receipt',
        detail: 'There is no identifier to reconcile this bill against a merchant record or a bank line.',
        evidence: 'merchant: ' + (receipt.meta.merchant || 'unknown'),
      });
    }

    /* discrepancies that are suspiciously round, or equal a line item */
    const deltas = (math.checks || []).filter((c) => (c.status === 'fail' || c.status === 'warn') && Number.isFinite(c.delta) && c.delta !== 0);
    const roundHits = [];
    const lineHits = [];
    deltas.forEach((c) => {
      const unit = roundUnit(c.delta);
      if (unit) roundHits.push({ check: c, unit });
      const item = items.find((i) => Math.abs(Math.abs(c.delta) - i.amount) <= 0.03);
      if (item) lineHits.push({ check: c, item });
    });

    if (roundHits.length) {
      const biggest = roundHits.slice().sort((a, b) => b.unit - a.unit)[0];
      roundHits.forEach((h) => {
        checks.push({
          stage: 'suspicious', status: 'fail', id: 'round-gap-' + h.check.id, label: 'Discrepancy is an exactly round amount',
          detail: 'The gap between the printed and recomputed value is exactly ' + m(Math.abs(h.check.delta)) +
            ' — a round multiple of ' + m(h.unit) + '. Rounding and tax never produce a number like that; a person editing a figure does.',
        });
      });
      findings.push({
        stage: 'suspicious', severity: biggest.unit >= 500 ? 'high' : 'medium', id: 'round-gap',
        title: 'The arithmetic gap is an exactly round amount',
        detail: 'Edited figures usually differ from the truth by a round number a human typed, not by the fractional amounts that rounding and tax produce.',
        evidence: roundHits.map((h) => '“' + h.check.label + '”: printed ' + m(h.check.printed) + ' vs computed ' + m(h.check.computed) +
          ' → gap of exactly ' + m(Math.abs(h.check.delta))).join('\n'),
        region: null,
      });
    }

    if (lineHits.length) {
      const best = lineHits[0];
      checks.push({
        stage: 'suspicious', status: 'fail', id: 'gap-equals-line', label: 'Discrepancy equals a single line item',
        detail: 'The gap between the printed and recomputed value is exactly the value of the “' + best.item.name + '” line (' + m(best.item.amount) + ').',
      });
      findings.push({
        stage: 'suspicious', severity: 'high', id: 'gap-equals-line',
        title: 'The discrepancy equals exactly one line item',
        detail: 'The difference between what the receipt prints and what its own figures support is the value of one billed line — the classic signature of a line being added, doubled or retyped.',
        evidence: lineHits.map((h) => '“' + h.check.label + '” gap ' + m(Math.abs(h.check.delta)) +
          ' = “' + h.item.name + '” at ' + m(h.item.amount)).join('\n'),
      });
    }

    /* total below a line item */
    if (items.length >= 2 && Number.isFinite(receipt.totals.total)) {
      const maxItem = items.reduce((a, b) => (b.amount > a.amount ? b : a), items[0]);
      if (receipt.totals.total < maxItem.amount - 0.05) {
        checks.push({
          stage: 'suspicious', status: 'fail', id: 'total-below-item', label: 'Grand total is below a line item',
          detail: 'The printed total ' + m(receipt.totals.total) + ' is less than the single line “' + maxItem.name + '” at ' + m(maxItem.amount) +
            '. A total can never be smaller than one of the items it is made of.',
        });
        findings.push({
          stage: 'suspicious', severity: 'high', id: 'total-below-item',
          title: 'Grand total is smaller than one of its own line items',
          detail: 'No sequence of discounts or taxes can push a total below one of the items it contains, so at least one of the two figures has been rewritten.',
          evidence: 'total ' + m(receipt.totals.total) + ' < “' + maxItem.name + '” ' + m(maxItem.amount),
        });
      }
    }

    /* it all hangs together */
    if (!findings.length) {
      checks.push({
        stage: 'suspicious', status: 'pass', id: 'logic-clean', label: 'No logical or statistical anomalies',
        detail: 'No repeated lines, no round-number discrepancies, no missing identifiers and no impossible totals were found.',
      });
    }

    return { checks, findings };
  }

  /* ── stage 7: scoring ────────────────────────────────────── */
  function score(findings) {
    const risk = U.clamp(findings.reduce((s, f) => s + (WEIGHT[f.severity] || 0), 0), 0, 100);
    const band = BANDS.find((b) => risk <= b.max) || BANDS[BANDS.length - 1];
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach((f) => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
    return { risk: Math.round(risk), band: band.band, tone: band.tone, counts };
  }

  function composeVerdict(input) {
    const { math, suspicious, receipt, meta } = input;
    const visual = input.visual || { regions: [], findings: [], file: null };
    const sym = receipt.currency.symbol;
    const m = (v) => U.fmtMoney(v, sym);
    const parts = [];

    if (!math.checks.length || !receipt.items.length) {
      parts.push('Very little could be read from this document, so the arithmetic behind it is largely unverified.');
    } else if (math.reconciles) {
      parts.push('Every equation this receipt asserts checks out: the item lines add up to the subtotal and the printed grand total follows from the numbers the document itself provides.');
    } else {
      const bad = math.checks.filter((c) => c.status === 'fail').sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
      const worst = bad[0];
      if (worst) {
        const named = /^Line \d+:/.test(worst.label)
          ? 'the “' + worst.label.replace(/^Line \d+: /, '') + '” line'
          : '“' + worst.label + '”';
        parts.push('The arithmetic does not reconcile: ' + named + ' supports ' + m(worst.computed) +
          ' while the receipt prints ' + m(worst.printed) + ', a difference of ' + m(Math.abs(worst.delta)) + '.');
      } else {
        parts.push('The arithmetic does not fully reconcile.');
      }
    }

    if (!meta.ranVisual) {
      parts.push('Visual tampering analysis was not run because no image was supplied.');
    } else if (visual.regions.length) {
      const kinds = Array.from(new Set(visual.regions.flatMap((r) => r.kinds || [])));
      parts.push('The image stage flagged ' + visual.regions.length + ' region(s) inconsistent with the rest of the file' +
        (kinds.length ? ' (' + kinds.join(', ') + ')' : '') + '.');
      const tone = visual.findings.find((f) => f.id === 'tone-patch');
      if (tone) parts.push('Most telling: ' + tone.detail.split('.')[0].charAt(0).toLowerCase() + tone.detail.split('.')[0].slice(1) + '.');
    } else {
      parts.push('The image stage found nothing inconsistent in the pixels.');
    }

    if (meta.editor) parts.push('The file container names ' + meta.editor + ', so the image has been through an editor at least once.');
    if (suspicious.findings.length) {
      parts.push(suspicious.findings.length + ' separate suspicious-information signal(s) also fired.');
    }

    return parts.join(' ');
  }

  /* ── assembly ────────────────────────────────────────────── */
  /**
   * @param {object} ctx {receipt, math, visual, suspicious, ocr, meta}
   * @returns the report object shared by the UI and the JSON export
   */
  function build(ctx) {
    const { receipt, math, visual, suspicious, ocr, meta } = ctx;

    /* math checks → findings */
    const mathFindings = [];
    (math.checks || []).forEach((c) => {
      if (c.status === 'fail' || c.status === 'warn') {
        const sev = c.status === 'warn' ? downgrade(c.severity) : c.severity;
        mathFindings.push({
          stage: 'math',
          severity: sev,
          id: 'math-' + c.id,
          title: c.label,
          detail: c.detail,
          evidence: c.equation + '\nprinted  ' + (Number.isFinite(c.printed) ? U.fmtMoney(c.printed, receipt.currency.symbol) : '—') +
            '\nrecomputed ' + (Number.isFinite(c.computed) ? U.fmtMoney(c.computed, receipt.currency.symbol) : '—') +
            (Number.isFinite(c.delta) ? '\ndifference ' + U.fmtDelta(c.delta) : ''),
          region: null,
        });
      }
    });

    /* a few passes are worth showing as evidence of work done */
    const NOTABLE_PASS = ['items-sum-subtotal', 'net-tax-total', 'line-qty-unit'];
    (math.checks || []).forEach((c) => {
      if (c.status === 'pass' && NOTABLE_PASS.indexOf(c.id) !== -1) {
        mathFindings.push({
          stage: 'math',
          severity: 'info',
          id: 'math-ok-' + c.id,
          title: c.label + ' — verified',
          detail: c.detail,
          evidence: c.equation,
          region: null,
        });
      }
    });

    const findings = [
      ...mathFindings,
      ...(visual.findings || []),
      ...(suspicious.findings || []),
    ].sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.title.localeCompare(b.title));

    const risk = score(findings);

    const allChecks = [
      ...(math.checks || []),
      ...((visual.checks) || []),
      ...((suspicious.checks) || []),
    ];
    const passed = allChecks.filter((c) => c.status === 'pass').length;
    const failed = allChecks.filter((c) => c.status === 'fail').length;

    const stagesRun = ['upload', 'ocr', 'parse', 'math', 'visual', 'suspicious', 'report'];

    const verdict = composeVerdict({
      math, visual, suspicious, receipt,
      meta: {
        ...meta,
        editor: (visual.file && (visual.file.software || (visual.file.editorTags || [])[0])) || null,
      },
    });

    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: meta.source,
      stages: stagesRun.map((id) => ({
        id,
        label: STAGE_LABEL[id],
        status: meta.ranVisual || id !== 'visual' ? 'ran' : 'skipped',
      })),
      risk,
      verdict,
      summary: {
        ocrConfidence: ocr && ocr.words && ocr.words.length ? Math.round(ocr.conf) : null,
        linesRead: ocr ? (ocr.lines || []).length : 0,
        wordsRead: ocr ? (ocr.words || []).length : 0,
        items: receipt.items.length,
        checksPassed: passed,
        checksFailed: failed,
        checksTotal: allChecks.length,
        findings: findings.length,
        ranVisual: !!meta.ranVisual,
      },
      receipt: {
        currency: receipt.currency,
        merchant: receipt.meta.merchant || null,
        invoiceNo: receipt.meta.invoiceNo || null,
        date: receipt.meta.date || null,
        time: receipt.meta.time || null,
        gstin: receipt.meta.gstin || null,
        payment: receipt.meta.payment || null,
        items: receipt.items.map((i) => ({
          name: i.name,
          qty: i.qty,
          qtyStated: i.qtyStated,
          unit: i.unit,
          unitStated: i.unitStated,
          unitDerived: i.unitDerived,
          amount: i.amount,
          confidence: i.geo && i.geo.conf !== null && i.geo.conf !== undefined ? Math.round(i.geo.conf) : null,
          raw: i.raw,
        })),
        taxes: receipt.taxes.map((t) => ({ label: t.label, amount: t.amount, rate: t.rate })),
        totals: receipt.totals,
        itemsSum: receipt.itemsSum,
      },
      math: {
        reconciles: math.reconciles,
        computedTotal: math.computedTotal,
        summary: math.summary,
        checks: math.checks,
      },
      visual: {
        ran: !!meta.ranVisual,
        note: visual.note || '',
        stats: visual.ela ? {
          errorLevelMedian: Number(visual.ela.stats.median.toFixed(2)),
          errorLevelP99: Number(visual.ela.stats.p99.toFixed(2)),
          paperTone: visual.tone ? Number(visual.tone.tone.toFixed(1)) : null,
          paperToneSpread: visual.tone ? Number(visual.tone.spread.toFixed(2)) : null,
          amountWordsCompared: visual.typo ? visual.typo.amountWords : 0,
        } : null,
        file: visual.file ? {
          isJpeg: visual.file.isJpeg,
          editorTags: visual.file.editorTags,
          creatorTool: visual.file.software,
          appSegments: visual.file.appSegments,
          bytes: visual.file.size,
        } : null,
        checks: visual.checks || [],
        regions: (visual.regions || []).map((r) => ({
          index: r.index, x: r.x, y: r.y, width: r.w, height: r.h,
          signals: r.kinds, score: Number(r.score.toFixed(2)), why: r.why,
        })),
      },
      suspicious: suspicious.checks,
      findings: findings.map((f) => ({
        ...f,
        // hand the consumer a region reference, not a raw pixel box
        region: f.region && f.region.index ? f.region.index : null,
      })),
    };
  }

  RS.report = { build, detectSuspicious, score, composeVerdict, WEIGHT, SEV_LABEL, STAGE_LABEL, ORDER };
})(window);
