
/* ==========================================================================
   ReceiptShield — report.js
   Stages 6 and 7: suspicious information detection, then the fraud risk report.
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  const WEIGHT = { critical: 34, high: 22, medium: 12, low: 5, info: 0 };
  const ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const SEV_LABEL = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    info: 'Passed'
  };

  const STAGE_LABEL = {
    upload: 'Receipt Upload',
    ocr: 'OCR Extraction',
    parse: 'Item / Price / Tax Detection',
    math: 'Mathematical Validation',
    visual: 'Visual Tampering Analysis',
    suspicious: 'Suspicious Information Detection',
    report: 'Fraud Risk Report'
  };

  const BANDS = [
    { max: 19, band: 'Low risk', tone: 'ok' },
    { max: 44, band: 'Elevated risk', tone: 'info' },
    { max: 69, band: 'Suspicious', tone: 'warn' },
    { max: 100, band: 'High risk', tone: 'danger' }
  ];

  /* Helpers */
  const normName = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  const downgrade = (sev) => ({
    critical: 'medium',
    high: 'medium',
    medium: 'low',
    low: 'low',
    info: 'info'
  }[sev] || 'low');

  function roundUnit(delta) {
    const a = Math.abs(delta);

    if (!Number.isFinite(a) || a < 40) return null;

    for (const unit of [10000, 5000, 1000, 500, 100, 50]) {
      if (
        Math.abs(a % unit) < 0.02 ||
        Math.abs((a % unit) - unit) < 0.02
      ) {
        return unit;
      }
    }

    return null;
  }

  /* Stage 6: suspicious information detection */
  function detectSuspicious(receipt, math) {
    const checks = [];
    const findings = [];
    const items = receipt.items || [];
    const sym = receipt.currency.symbol;
    const m = (v) => U.fmtMoney(v, sym);

    /* Repeated descriptions */
    const groups = new Map();

    items.forEach((item) => {
      const key = normName(item.name);

      if (key.length < 4) return;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const dupExact = [];
    const dupPrice = [];

    groups.forEach((group) => {
      if (group.length < 2) return;

      const amounts = new Set(
        group.map((item) => item.amount.toFixed(2))
      );

      if (amounts.size === 1) {
        dupExact.push(group);
      } else {
        dupPrice.push(group);
      }
    });

    if (dupExact.length) {
      checks.push({
        stage: 'suspicious',
        status: 'warn',
        id: 'dup-lines',
        label: 'Repeated identical line items',
        detail:
          dupExact.map((group) =>
            '“' + group[0].name + '” appears ' +
            group.length + ' times at ' + m(group[0].amount)
          ).join('; ') +
          '. Genuine duplicates do happen, but a repeated line can also inflate a bill.'
      });

      findings.push({
        stage: 'suspicious',
        severity: 'medium',
        id: 'dup-lines',
        title: 'The same line item is repeated',
        detail:
          'Identical descriptions at identical prices appear more than once. ' +
          'This may indicate a duplicated charge and should be reviewed.',
        evidence: dupExact
          .map((group) => group.map((item) => item.raw).join('\n'))
          .join('\n---\n')
      });
    }

    if (dupPrice.length) {
      checks.push({
        stage: 'suspicious',
        status: 'fail',
        id: 'dup-name-two-prices',
        label: 'Same item, two different prices',
        detail:
          dupPrice.map((group) =>
            '“' + group[0].name + '” is priced at ' +
            group.map((item) => m(item.amount)).join(' and ')
          ).join('; ') + '.'
      });

      findings.push({
        stage: 'suspicious',
        severity: 'medium',
        id: 'dup-name-two-prices',
        title: 'One item carries two different prices',
        detail:
          'The same description is billed at two different line totals. ' +
          'Verify both figures against the original receipt.',
        evidence: dupPrice
          .map((group) => group.map((item) => item.raw).join('\n'))
          .join('\n---\n')
      });
    }

    /* Missing tax */
    if (items.length >= 3 && !receipt.taxes.length) {
      checks.push({
        stage: 'suspicious',
        status: 'warn',
        id: 'no-tax',
        label: 'No tax line on the receipt',
        detail:
          'No tax or VAT line was recognised. Some merchants may be exempt ' +
          'or include tax in prices, so verify the original receipt.'
      });

      findings.push({
        stage: 'suspicious',
        severity: 'low',
        id: 'no-tax',
        title: 'No tax line anywhere on the document',
        detail:
          'No tax line was recognised for cross-checking the net amount. ' +
          'This alone does not establish fraud.',
        evidence: items.length + ' line items, 0 tax rows recognised'
      });
    }

    /* Tax rows without rates */
    const taxesWithoutRate = receipt.taxes.filter(
      (tax) => !Number.isFinite(tax.rate)
    );

    if (
      receipt.taxes.length &&
      taxesWithoutRate.length === receipt.taxes.length
    ) {
      checks.push({
        stage: 'suspicious',
        status: 'warn',
        id: 'tax-no-rate',
        label: 'Tax rows carry no percentage',
        detail:
          'Tax amounts were found, but their rates could not be verified.'
      });
    }

    /* Transaction identifiers */
    const hasInvoice = !!receipt.meta.invoiceNo;
    const hasDate = !!receipt.meta.date;

    if (!hasInvoice && !hasDate) {
      checks.push({
        stage: 'suspicious',
        status: 'warn',
        id: 'no-ids',
        label: 'No transaction identifiers',
        detail:
          'Neither an invoice number nor a date could be read. ' +
          'Verify these details on the original document.'
      });

      findings.push({
        stage: 'suspicious',
        severity: 'low',
        id: 'no-ids',
        title: 'No invoice number or date on the receipt',
        detail:
          'No invoice number or date was recognised for transaction verification.',
        evidence: 'merchant: ' + (receipt.meta.merchant || 'unknown')
      });
    }

    /* Round-number discrepancies and discrepancies matching a line item */
    const deltas = (math.checks || []).filter(
      (check) =>
        (check.status === 'fail' || check.status === 'warn') &&
        Number.isFinite(check.delta) &&
        check.delta !== 0
    );

    const roundHits = [];
    const lineHits = [];

    deltas.forEach((check) => {
      const unit = roundUnit(check.delta);

      if (unit) roundHits.push({ check, unit });

      const item = items.find(
        (entry) =>
          Math.abs(Math.abs(check.delta) - entry.amount) <= 0.03
      );

      if (item) lineHits.push({ check, item });
    });

    if (roundHits.length) {
      const biggest = roundHits
        .slice()
        .sort((a, b) => b.unit - a.unit)[0];

      roundHits.forEach((hit) => {
        checks.push({
          stage: 'suspicious',
          status: 'fail',
          id: 'round-gap-' + hit.check.id,
          label: 'Discrepancy is an exactly round amount',
          detail:
            'The difference between the printed and recomputed figures is ' +
            m(Math.abs(hit.check.delta)) +
            ', a round multiple of ' + m(hit.unit) +
            '. Verify the source figures before drawing conclusions.'
        });
      });

      findings.push({
        stage: 'suspicious',
        severity: biggest.unit >= 500 ? 'high' : 'medium',
        id: 'round-gap',
        title: 'The arithmetic gap is an exactly round amount',
        detail:
          'A round-number discrepancy was detected. This can result from ' +
          'an edited figure, but OCR errors must also be considered.',
        evidence: roundHits.map((hit) =>
          '“' + hit.check.label + '”: printed ' +
          m(hit.check.printed) + ' vs computed ' +
          m(hit.check.computed) + ' → gap of ' +
          m(Math.abs(hit.check.delta))
        ).join('\n'),
        region: null
      });
    }

    if (lineHits.length) {
      const best = lineHits[0];

      checks.push({
        stage: 'suspicious',
        status: 'fail',
        id: 'gap-equals-line',
        label: 'Discrepancy equals a single line item',
        detail:
          'The discrepancy matches the value of the “' +
          best.item.name + '” line (' + m(best.item.amount) + ').'
      });

      findings.push({
        stage: 'suspicious',
        severity: 'high',
        id: 'gap-equals-line',
        title: 'The discrepancy equals exactly one line item',
        detail:
          'A discrepancy matches a line-item amount. Verify the extracted ' +
          'figures against the original receipt.',
        evidence: lineHits.map((hit) =>
          '“' + hit.check.label + '” gap ' +
          m(Math.abs(hit.check.delta)) + ' = “' +
          hit.item.name + '” at ' + m(hit.item.amount)
        ).join('\n')
      });
    }

    /* Grand total below a line item */
    if (
      items.length >= 2 &&
      Number.isFinite(receipt.totals.total)
    ) {
      const maxItem = items.reduce(
        (a, b) => b.amount > a.amount ? b : a,
        items[0]
      );

      if (receipt.totals.total < maxItem.amount - 0.05) {
        checks.push({
          stage: 'suspicious',
          status: 'fail',
          id: 'total-below-item',
          label: 'Grand total is below a line item',
          detail:
            'The printed total ' + m(receipt.totals.total) +
            ' is less than the line “' + maxItem.name +
            '” at ' + m(maxItem.amount) +
            '. Verify the OCR results and printed figures.'
        });

        findings.push({
          stage: 'suspicious',
          severity: 'high',
          id: 'total-below-item',
          title: 'Grand total is smaller than one of its own line items',
          detail:
            'The recognised grand total is below one of the recognised ' +
            'line items. At least one figure needs verification.',
          evidence:
            'total ' + m(receipt.totals.total) + ' < “' +
            maxItem.name + '” ' + m(maxItem.amount)
        });
      }
    }

    /* No anomalies detected */
    if (!findings.length) {
      checks.push({
        stage: 'suspicious',
        status: 'pass',
        id: 'logic-clean',
        label: 'No logical or statistical anomalies',
        detail:
          'No repeated lines, round-number discrepancies, missing identifiers ' +
          'or impossible totals were detected by these checks.'
      });
    }

    return { checks, findings };
  }

  /* Stage 7: risk scoring */

  /**
   * When OCR confidence is below 75%, return an unverified score of zero.
   * This prevents unreliable extracted figures from producing a misleading
   * fraud score. Findings remain visible for manual review.
   *
   * This is a reporting policy, not proof that the receipt is genuine.
   */
  function score(findings, ocrConfidence) {
    const list = Array.isArray(findings) ? findings : [];
    const confidence = Number(ocrConfidence);

    const counts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };

    list.forEach((finding) => {
      if (
        finding &&
        Object.prototype.hasOwnProperty.call(counts, finding.severity)
      ) {
        counts[finding.severity]++;
      }
    });

    // Low OCR confidence: do not assign a fraud score.
    if (Number.isFinite(confidence) && confidence < 75) {
      return {
        risk: 0,
        band: 'Unverified',
        tone: 'info',
        counts
      };
    }

    // Normal scoring when OCR confidence is sufficient.
    const eligible = list.filter(
      (finding) => finding && finding.severity !== 'info'
    );

    const risk = U.clamp(
      eligible.reduce(
        (sum, finding) =>
          sum + (WEIGHT[finding.severity] || 0),
        0
      ),
      0,
      100
    );

    const band =
      BANDS.find((entry) => risk <= entry.max) ||
      BANDS[BANDS.length - 1];

    return {
      risk: Math.round(risk),
      band: band.band,
      tone: band.tone,
      counts
    };
  }

  /* Compose report verdict */
  function composeVerdict(input) {
    const { math, suspicious, receipt, meta } = input;
    const visual = input.visual || {
      regions: [],
      findings: [],
      file: null
    };

    const sym = receipt.currency.symbol;
    const m = (v) => U.fmtMoney(v, sym);
    const parts = [];

    if (!math.checks.length || !receipt.items.length) {
      parts.push(
        'Very little could be read from this document, so the arithmetic ' +
        'behind it is largely unverified.'
      );
    } else if (math.reconciles) {
      parts.push(
        'Every equation this receipt asserts checks out: the item lines ' +
        'add up to the subtotal and the printed grand total follows from ' +
        'the numbers the document itself provides.'
      );
    } else {
      const bad = math.checks
        .filter((check) => check.status === 'fail')
        .sort(
          (a, b) =>
            Math.abs(b.delta || 0) - Math.abs(a.delta || 0)
        );

      const worst = bad[0];

      if (worst) {
        const named = /^Line \d+:/.test(worst.label)
          ? 'the “' + worst.label.replace(/^Line \d+: /, '') + '” line'
          : '“' + worst.label + '”';

        parts.push(
          'The arithmetic does not reconcile: ' + named +
          ' supports ' + m(worst.computed) +
          ' while the receipt prints ' + m(worst.printed) +
          ', a difference of ' + m(Math.abs(worst.delta)) + '.'
        );
      } else {
        parts.push('The arithmetic does not fully reconcile.');
      }
    }

    if (!meta.ranVisual) {
      parts.push(
        'Visual tampering analysis was not run because no image was supplied.'
      );
    } else if (visual.regions.length) {
      const kinds = Array.from(
        new Set(
          visual.regions.flatMap((region) => region.kinds || [])
        )
      );

      parts.push(
        'The image stage flagged ' + visual.regions.length +
        ' region(s) inconsistent with the rest of the file' +
        (kinds.length ? ' (' + kinds.join(', ') + ')' : '') + '.'
      );

      const tone = visual.findings.find(
        (finding) => finding.id === 'tone-patch'
      );

      if (tone) {
        const firstSentence = tone.detail.split('.')[0];

        parts.push(
          'Most telling: ' +
          firstSentence.charAt(0).toLowerCase() +
          firstSentence.slice(1) + '.'
        );
      }
    } else {
      parts.push(
        'The image stage found nothing inconsistent in the pixels.'
      );
    }

    if (meta.editor) {
      parts.push(
        'The file container names ' + meta.editor +
        ', so the image has been through an editor at least once.'
      );
    }

    if (suspicious.findings.length) {
      parts.push(
        suspicious.findings.length +
        ' separate suspicious-information signal(s) also fired.'
      );
    }

    return parts.join(' ');
  }

  /* Assemble the report */
  function build(ctx) {
    const {
      receipt,
      math,
      visual,
      suspicious,
      ocr,
      meta
    } = ctx;

    /* Mathematical findings */
    const mathFindings = [];

    (math.checks || []).forEach((check) => {
      if (check.status === 'fail' || check.status === 'warn') {
        const sev =
          check.status === 'warn'
            ? downgrade(check.severity)
            : check.severity;

        mathFindings.push({
          stage: 'math',
          severity: sev,
          id: 'math-' + check.id,
          title: check.label,
          detail: check.detail,
          evidence:
            check.equation +
            '\nprinted  ' +
            (Number.isFinite(check.printed)
              ? U.fmtMoney(check.printed, receipt.currency.symbol)
              : '—') +
            '\nrecomputed ' +
            (Number.isFinite(check.computed)
              ? U.fmtMoney(check.computed, receipt.currency.symbol)
              : '—') +
            (Number.isFinite(check.delta)
              ? '\ndifference ' + U.fmtDelta(check.delta)
              : ''),
          region: null
        });
      }
    });

    /* Show selected passed checks */
    const NOTABLE_PASS = [
      'items-sum-subtotal',
      'net-tax-total',
      'line-qty-unit'
    ];

    (math.checks || []).forEach((check) => {
      if (
        check.status === 'pass' &&
        NOTABLE_PASS.indexOf(check.id) !== -1
      ) {
        mathFindings.push({
          stage: 'math',
          severity: 'info',
          id: 'math-ok-' + check.id,
          title: check.label + ' — verified',
          detail: check.detail,
          evidence: check.equation,
          region: null
        });
      }
    });

    const findings = [
      ...mathFindings,
      ...(visual.findings || []),
      ...(suspicious.findings || [])
    ].sort(
      (a, b) =>
        ORDER[a.severity] - ORDER[b.severity] ||
        a.title.localeCompare(b.title)
    );

    const risk = score(findings, ocr && ocr.conf);

    const allChecks = [
      ...(math.checks || []),
      ...(visual.checks || []),
      ...(suspicious.checks || [])
    ];

    const passed = allChecks.filter(
      (check) => check.status === 'pass'
    ).length;

    const failed = allChecks.filter(
      (check) => check.status === 'fail'
    ).length;

    const stagesRun = [
      'upload',
      'ocr',
      'parse',
      'math',
      'visual',
      'suspicious',
      'report'
    ];

    const verdict = composeVerdict({
      math,
      visual,
      suspicious,
      receipt,
      meta: {
        ...meta,
        editor:
          (visual.file &&
            (visual.file.software ||
              (visual.file.editorTags || [])[0])) ||
          null
      }
    });

    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: meta.source,

      stages: stagesRun.map((id) => ({
        id,
        label: STAGE_LABEL[id],
        status: meta.ranVisual || id !== 'visual'
          ? 'ran'
          : 'skipped'
      })),

      risk,
      verdict,

      summary: {
        ocrConfidence:
          ocr && ocr.words && ocr.words.length
            ? Math.round(ocr.conf)
            : null,
        linesRead: ocr ? (ocr.lines || []).length : 0,
        wordsRead: ocr ? (ocr.words || []).length : 0,
        items: receipt.items.length,
        checksPassed: passed,
        checksFailed: failed,
        checksTotal: allChecks.length,
        findings: findings.length,
        ranVisual: !!meta.ranVisual
      },

      receipt: {
        currency: receipt.currency,
        merchant: receipt.meta.merchant || null,
        invoiceNo: receipt.meta.invoiceNo || null,
        date: receipt.meta.date || null,
        time: receipt.meta.time || null,
        gstin: receipt.meta.gstin || null,
        payment: receipt.meta.payment || null,

        items: receipt.items.map((item) => ({
          name: item.name,
          qty: item.qty,
          qtyStated: item.qtyStated,
          unit: item.unit,
          unitStated: item.unitStated,
          unitDerived: item.unitDerived,
          amount: item.amount,
          confidence:
            item.geo &&
            item.geo.conf !== null &&
            item.geo.conf !== undefined
              ? Math.round(item.geo.conf)
              : null,
          raw: item.raw
        })),

        taxes: receipt.taxes.map((tax) => ({
          label: tax.label,
          amount: tax.amount,
          rate: tax.rate
        })),

        totals: receipt.totals,
        itemsSum: receipt.itemsSum
      },

      math: {
        reconciles: math.reconciles,
        computedTotal: math.computedTotal,
        summary: math.summary,
        checks: math.checks
      },

      visual: {
        ran: !!meta.ranVisual,
        note: visual.note || '',

        stats: visual.ela
          ? {
              errorLevelMedian:
                Number(visual.ela.stats.median.toFixed(2)),
              errorLevelP99:
                Number(visual.ela.stats.p99.toFixed(2)),
              paperTone:
                visual.tone
                  ? Number(visual.tone.tone.toFixed(1))
                  : null,
              paperToneSpread:
                visual.tone
                  ? Number(visual.tone.spread.toFixed(2))
                  : null,
              amountWordsCompared:
                visual.typo ? visual.typo.amountWords : 0
            }
          : null,

        file: visual.file
          ? {
              isJpeg: visual.file.isJpeg,
              editorTags: visual.file.editorTags,
              creatorTool: visual.file.software,
              appSegments: visual.file.appSegments,
              bytes: visual.file.size
            }
          : null,

        checks: visual.checks || [],

        regions: (visual.regions || []).map((region) => ({
          index: region.index,
          x: region.x,
          y: region.y,
          width: region.w,
          height: region.h,
          signals: region.kinds,
          score: Number(region.score.toFixed(2)),
          why: region.why
        }))
      },

      suspicious: suspicious.checks,

      findings: findings.map((finding) => ({
        ...finding,
        // Give the consumer a region reference, not a raw pixel box.
        region:
          finding.region && finding.region.index
            ? finding.region.index
            : null
      }))
    };
  }

  RS.report = {
    build,
    detectSuspicious,
    score,
    composeVerdict,
    WEIGHT,
    SEV_LABEL,
    STAGE_LABEL,
    ORDER
  };
})(window);
