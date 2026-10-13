/* ==========================================================================
   ReceiptShield — app.js
   Runs the pipeline end to end and paints the report.

   Exposes window.RS.app (for debugging from the console)
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;
  const { $, $$, esc } = U;

  const DIAL_C = 2 * Math.PI * 72;
  const TONE_COLOR = { ok: '#3ddc84', info: '#60a5fa', warn: '#f5a524', danger: '#f4536a' };
  const STAGE_NUM = { upload: '01', ocr: '02', parse: '03', math: '04', visual: '05', suspicious: '06', report: '07' };

  const DEFAULT_NOTES = {
    upload: 'Image accepted and normalised',
    ocr: 'Text, word boxes and confidence',
    parse: 'Fields pulled from the text',
    math: 'Line, subtotal and total arithmetic',
    visual: 'Error-level, tone and typography forensics',
    suspicious: 'Logical and statistical anomalies',
    report: 'Weighted score, findings, evidence',
  };

  const state = {
    mode: 'image',
    file: null,
    canvas: null,
    ocr: null,
    receipt: null,
    math: null,
    visual: null,
    suspicious: null,
    report: null,
    truth: null,
    filter: 'all',
    view: { regions: true, heat: true, text: true, amp: false },
    running: false,
  };

  /* ── tiny UI helpers ─────────────────────────────────────── */
  function showBanner(kind, html) {
    const b = $('#banner');
    b.className = 'banner banner--' + kind;
    b.innerHTML = html;
    b.hidden = false;
  }
  const hideBanner = () => { $('#banner').hidden = true; };

  function setTag(text, cls) {
    const t = $('#runTag');
    t.textContent = text;
    t.className = 'tag' + (cls ? ' ' + cls : '');
  }

  function live(msg) { $('#statusLive').textContent = msg; }

  const stageLi = (id) => $('#stages li[data-stage="' + id + '"]');
  function setStage(id, status, note) {
    const li = stageLi(id);
    if (!li) return;
    li.className = status ? 'is-' + status : '';
    if (note !== undefined) li.querySelector('div > span').textContent = note;
  }
  function resetStages() {
    $$('#stages li').forEach((li) => {
      li.className = '';
      li.querySelector('div > span').textContent = DEFAULT_NOTES[li.dataset.stage] || '';
    });
  }

  function updateOcr(p) {
    const pct = Math.round((p.progress || 0) * 100);
    $('#ocrPhase').textContent = p.phase || 'Working…';
    $('#ocrPct').textContent = pct + '%';
    $('#ocrFill').style.width = pct + '%';
  }

  /* ── file / image handling ───────────────────────────────── */
  function blobToCanvas(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
          resolve(c);
        } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be decoded as an image.')); };
      img.src = url;
    });
  }

  function setFile(blob, name, note) {
    if (state.file && state.file.url) URL.revokeObjectURL(state.file.url);
    state.file = {
      blob,
      name: name || 'receipt',
      url: URL.createObjectURL(blob),
      type: blob.type || 'image/png',
    };
    state.truth = note || null;
    renderDropzone();
    markReady();
  }

  function renderDropzone() {
    const file = state.file;
    $('#dzDefault').hidden = !!file;
    const box = $('#dzFile');
    box.hidden = !file;
    if (!file) return;
    box.innerHTML =
      '<img src="' + file.url + '" alt="Receipt preview" />' +
      '<p><strong>' + esc(file.name) + '</strong>' +
      (file.blob.size / 1024).toFixed(0) + ' KB · ' + esc(file.type) + '<br />Click to replace, or drop another file.</p>';

    const sn = $('#sampleNote');
    if (state.truth) {
      sn.hidden = false;
      sn.innerHTML = '<strong>Sample ground truth, shown for reference only:</strong> ' + esc(state.truth);
    } else {
      sn.hidden = true;
    }
  }

  function markReady() {
    const ready = state.mode === 'image' ? !!state.file : !!$('#textInput').value.trim();
    $('#btnRun').disabled = !ready;
  }

  /* ── samples ─────────────────────────────────────────────── */
  async function loadSample(kind) {
    hideBanner();
    const btn = kind === 'tampered' ? $('#btnTampered') : $('#btnGenuine');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const s = await RS.samples.build(kind);
      setFile(s.blob, s.name, s.truth.note);
      showBanner('ok', 'Loaded the <strong>' + kind + '</strong> sample. Press <strong>Run detection</strong> to analyse it.');
    } catch (err) {
      console.error(err);
      showBanner('err', 'Could not generate the sample: ' + esc(err.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ── the pipeline ────────────────────────────────────────── */
  async function run() {
    if (state.running) return;
    state.running = true;
    $('#btnRun').disabled = true;
    $('#results').hidden = true;
    hideBanner();
    resetStages();
    setTag('running', 'is-run');
    live('Analysis started');

    try {
      const report = state.mode === 'image' ? await runImage() : await runText();
      paint(report);
      finishBanner(report);
      setTag('complete', 'is-done');
      live('Analysis complete. Risk score ' + report.risk.risk + ' of 100, ' + report.risk.band + '.');
    } catch (err) {
      console.error(err);
      const active = $('#stages li.is-active');
      if (active) active.className = 'is-fail';
      showBanner('err', '<strong>Analysis stopped.</strong> ' + esc(err.message || String(err)));
      setTag('failed', 'is-fail');
      live('Analysis stopped: ' + (err.message || String(err)));
    } finally {
      state.running = false;
      $('#ocrbar').hidden = true;
      $('#btnRun').disabled = false;
      $('#btnReset').hidden = false;
    }
  }

  async function runImage() {
    const src = state.file;

    /* 1 — upload */
    setStage('upload', 'active', 'Decoding the image…');
    const canvas = await blobToCanvas(src.blob);
    state.canvas = canvas;
    if (canvas.width < 200 || canvas.height < 120) {
      throw new Error('That image is too small to analyse (' + canvas.width + '×' + canvas.height + '). Receipts need at least a few hundred pixels of width.');
    }
    setStage('upload', 'done', canvas.width + ' × ' + canvas.height + ' px · ' + esc(src.type));
    live('Receipt loaded');

    /* 2 — OCR */
    setStage('ocr', 'active', 'Starting the OCR engine…');
    $('#ocrbar').hidden = false;
    updateOcr({ phase: 'Starting the OCR engine…', progress: 0 });
    state.ocr = await RS.ocr.recognize(canvas, (p) => {
      updateOcr(p);
      setStage('ocr', 'active', p.phase + ' — ' + Math.round((p.progress || 0) * 100) + '%');
    });
    $('#ocrbar').hidden = true;

    if (state.ocr.empty) {
      setStage('ocr', 'fail', 'No readable text found');
      throw new Error('No text could be read from this image. Try a sharper photo, more contrast, or paste the receipt text instead.');
    }
    setStage('ocr', 'done', state.ocr.words.length + ' words · ' + Math.round(state.ocr.conf) + '% confidence');
    live('OCR finished');

    return await finishStages(state.ocr.text, state.ocr.lines, 'image', src.blob);
  }

  async function runText() {
    const text = $('#textInput').value;
    setStage('upload', 'skip', 'Skipped — text was pasted directly');
    setStage('ocr', 'skip', 'Skipped — no image to read');
    state.canvas = null;
    state.ocr = null;
    live('Using pasted text');
    return await finishStages(text, null, 'text', null);
  }

  async function finishStages(text, lines, source, blob) {
    /* 3 — parse */
    setStage('parse', 'active', 'Classifying lines…');
    await U.sleep(30);
    const receipt = RS.parse.parse({ text, lines, source });
    state.receipt = receipt;
    setStage('parse', 'done',
      receipt.counts.items + ' item(s), ' + receipt.taxes.length + ' tax row(s), ' + receipt.adjustments.length + ' adjustment(s)');
    live('Receipt parsed');

    /* 4 — maths */
    setStage('math', 'active', 'Recomputing every equation…');
    await U.sleep(30);
    const math = RS.validate.validate(receipt);
    state.math = math;
    setStage('math', math.summary.fail ? 'warn' : 'done',
      math.summary.pass + ' passed · ' + math.summary.warn + ' warning(s) · ' + math.summary.fail + ' failed');
    live('Arithmetic validated');

    /* 5 — visual */
    let visual;
    if (source === 'image') {
      setStage('visual', 'active', 'Running error-level analysis…');
      await U.sleep(30);
      visual = await RS.visual.analyze(state.canvas, receipt, state.ocr, blob);
      visual.ran = true;
      state.visual = visual;
      setStage('visual', visual.regions.length ? 'warn' : 'done',
        visual.regions.length + ' suspicious region(s) · ' + visual.typo.amountWords + ' amounts compared');
      live('Image forensics done');
    } else {
      visual = {
        ran: false,
        checks: [{
          stage: 'visual', status: 'skip', label: 'Visual Tampering Analysis', id: 'skipped',
          detail: 'No image was supplied. Stages 1 and 5 need a picture of the receipt to work on.',
        }],
        findings: [], regions: [], note: '', file: null, ela: null, tone: null, typo: { amountWords: 0 },
      };
      state.visual = visual;
      setStage('visual', 'skip', 'Skipped — no image supplied');
    }

    /* 6 — suspicious information */
    setStage('suspicious', 'active', 'Looking for logical anomalies…');
    await U.sleep(30);
    const suspicious = RS.report.detectSuspicious(receipt, math);
    state.suspicious = suspicious;
    const suspiciousBad = suspicious.checks.filter((c) => c.status === 'fail' || c.status === 'warn').length;
    setStage('suspicious', suspiciousBad ? 'warn' : 'done',
      suspiciousBad ? suspiciousBad + ' anomaly signal(s)' : 'no anomalies found');
    live('Anomaly scan done');

    /* 7 — report */
    setStage('report', 'active', 'Weighting findings…');
    await U.sleep(30);
    const report = RS.report.build({
      receipt, math, visual, suspicious,
      ocr: state.ocr,
      meta: { ranVisual: source === 'image', source },
    });
    state.report = report;
    setStage('report', report.risk.risk >= 45 ? 'warn' : 'done',
      report.risk.risk + '/100 · ' + report.risk.band);
    return report;
  }

  function finishBanner(report) {
    const s = report.summary;
    if (s.ranVisual && s.ocrConfidence !== null && s.ocrConfidence < 60) {
      showBanner('warn',
        '<strong>Low OCR confidence (' + s.ocrConfidence + '%).</strong> Some figures may have been misread, which can create false positives in the arithmetic stage. Treat the extracts below as approximate, or retry with a sharper image.');
    } else if (!s.ranVisual) {
      showBanner('warn',
        '<strong>Text-mode run.</strong> Stages 3, 4, 6 and 7 ran against the pasted text. Visual tampering analysis needs a receipt image.');
    } else {
      showBanner('ok',
        '<strong>Analysis complete.</strong> ' + s.items + ' line item(s) extracted at ' + s.ocrConfidence +
        '% OCR confidence · ' + s.checksPassed + ' of ' + s.checksTotal + ' checks passed · ' +
        s.findings + ' finding(s) across ' + (report.risk.counts.critical + report.risk.counts.high + report.risk.counts.medium + report.risk.counts.low) + ' flagged.');
    }
  }

  /* ── painting ────────────────────────────────────────────── */
  function paint(report) {
    $('#results').hidden = false;
    $('#reportSubtitle').innerHTML =
      'Source: <strong>' + esc(state.mode === 'image' ? (state.file && state.file.name || 'image') : 'pasted text') +
      '</strong> · generated ' + new Date(report.generatedAt).toLocaleString() +
      ' · the entire analysis ran on this device.';

    renderRisk(report);
    renderTiles(report);
    renderFindings();
    renderExtraction(report);
    renderMath(report);
    renderJson(report);
    renderVisual(report);
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'findings'));
    $$('.tabpanel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === 'findings'));
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderRisk(report) {
    const r = report.risk;
    $('#riskScore').textContent = r.risk;
    const dv = $('#dialValue');
    dv.style.strokeDasharray = DIAL_C;
    dv.style.strokeDashoffset = DIAL_C;
    requestAnimationFrame(() => {
      dv.style.stroke = TONE_COLOR[r.tone];
      dv.style.strokeDashoffset = DIAL_C * (1 - r.risk / 100);
    });
    const band = $('#riskBand');
    band.textContent = r.band;
    band.style.color = TONE_COLOR[r.tone];
    $('#riskVerdict').textContent = report.verdict;

    const labels = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Passed' };
    $('#riskCounts').innerHTML = ['critical', 'high', 'medium', 'low', 'info']
      .filter((k) => r.counts[k])
      .map((k) => '<li><span class="dot dot--' + k + '"></span>' + labels[k] + ' <b>' + r.counts[k] + '</b></li>')
      .join('') || '<li class="muted">No findings</li>';
  }

  function renderTiles(report) {
    const s = report.summary;
    const set = (id, html) => { $('#' + id).innerHTML = html; };
    set('tileConf', s.ocrConfidence === null ? '<span class="muted">n/a</span>' : s.ocrConfidence + '<small>%</small>');
    set('tileLines', s.linesRead || '<span class="muted">—</span>');
    set('tileItems', s.items);
    set('tileChecks', s.checksPassed + '<small>/' + s.checksTotal + '</small>');
    set('tileFlags', s.findings);
    set('tileStages', (s.ranVisual ? 7 : 6) + '<small>/7</small>');
  }

  function renderFindings() {
    const report = state.report;
    if (!report) return;
    const filter = state.filter;
    const list = report.findings.filter((f) => filter === 'all' || f.severity === filter);
    const host = $('#findingsList');

    if (!list.length) {
      host.innerHTML = '<div class="empty">' +
        (filter === 'all'
          ? 'No findings at all — the arithmetic reconciles and the image stage found nothing inconsistent.'
          : 'No findings in this severity band.') + '</div>';
      return;
    }

    host.innerHTML = list.map((f) => {
      const region = f.region
        ? '<button class="linkish" data-region="' + f.region + '">Evidence region #' + f.region + ' in the visual viewer →</button>'
        : '';
      return '<article class="finding finding--' + f.severity + '">' +
        '<div class="finding__top">' +
          '<span class="finding__sev sev-' + f.severity + '">' + RS.report.SEV_LABEL[f.severity] + '</span>' +
          '<span class="finding__stage">Stage ' + (STAGE_NUM[f.stage] || '--') + ' · ' + esc(RS.report.STAGE_LABEL[f.stage] || f.stage) + '</span>' +
        '</div>' +
        '<h4>' + esc(f.title) + '</h4>' +
        '<p>' + esc(f.detail) + '</p>' +
        (f.evidence ? '<pre class="finding__ev">' + esc(f.evidence) + '</pre>' : '') +
        (region ? '<p class="finding__where">' + region + '</p>' : '') +
        '</article>';
    }).join('');
  }

  function renderExtraction(report) {
    const r = report.receipt;
    const sym = r.currency.symbol;

    $('#tblItems tbody').innerHTML = r.items.length
      ? r.items.map((i, n) => '<tr>' +
          '<td class="num">' + (n + 1) + '</td>' +
          '<td class="desc">' + esc(i.name) + '</td>' +
          '<td class="num">' + (i.qtyStated ? i.qty : '<span class="muted">' + i.qty + '*</span>') + '</td>' +
          '<td class="num">' + (i.unitDerived
            ? '<span class="muted" title="Derived from the line total ÷ quantity">' + U.fmtMoney(i.unit, sym) + '</span>'
            : U.fmtMoney(i.unit, sym)) + '</td>' +
          '<td class="num">' + U.fmtMoney(i.amount, sym) + '</td>' +
          '<td class="num">' + (i.confidence === null ? '<span class="muted">—</span>' :
            '<span class="' + (i.confidence >= 80 ? 'pos' : i.confidence >= 55 ? '' : 'neg') + '">' + i.confidence + '</span>') + '</td>' +
        '</tr>').join('')
      : '<tr><td colspan="6" class="muted">No priced line items could be extracted.</td></tr>';

    const row = (k, v, cls) => '<dt>' + esc(k) + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</dd>';
    let html = '';
    html += row('Merchant', esc(r.merchant || '—'));
    html += row('Invoice no.', esc(r.invoiceNo || '—'));
    html += row('Date', esc([r.date, r.time].filter(Boolean).join(' ') || '—'));
    html += row('GSTIN / tax id', esc(r.gstin || '—'));
    html += row('Currency detected', r.currency.code ? esc(r.currency.code + ' ' + r.currency.symbol) : '—');
    html += row('Items total (Σ lines)', U.fmtMoney(r.itemsSum, sym));
    if (Number.isFinite(r.totals.subtotal)) html += row('Printed subtotal', U.fmtMoney(r.totals.subtotal, sym));
    if (Number.isFinite(r.totals.discount)) html += row('Discount', U.fmtMoney(r.totals.discount, sym));
    if (Number.isFinite(r.totals.taxable)) html += row('Taxable value', U.fmtMoney(r.totals.taxable, sym));
    r.taxes.forEach((t) => { html += row(t.label.replace(/\s+/g, ' '), U.fmtMoney(t.amount, sym)); });
    if (Number.isFinite(r.totals.roundOff)) html += row('Rounding', U.fmtMoney(r.totals.roundOff, sym));
    html += row('<strong>Printed grand total</strong>', '<strong>' + U.fmtMoney(r.totals.total, sym) + '</strong>');
    if (report.math.computedTotal !== null) {
      const diff = U.round2(r.totals.total - report.math.computedTotal);
      html += row('Total from the receipt’s own figures', U.fmtMoney(report.math.computedTotal, sym));
      html += row('Difference', '<span class="' + (Math.abs(diff) < 0.02 ? 'pos' : 'neg') + '">' + U.fmtDelta(diff) + '</span>');
    }
    if (Number.isFinite(r.totals.tendered)) html += row('Paid', U.fmtMoney(r.totals.tendered, sym));
    if (Number.isFinite(r.totals.change)) html += row('Change', U.fmtMoney(r.totals.change, sym));
    $('#dlTotals').innerHTML = html;

    $('#rawText').textContent = state.ocr ? state.ocr.text : ($('#textInput').value || '');
  }

  function renderMath(report) {
    const sym = report.receipt.currency.symbol;
    const rows = report.math.checks.map((c) => {
      const pill = { pass: 'pass', warn: 'warn', fail: 'fail', skip: 'skip' }[c.status];
      const label = { pass: 'Pass', warn: 'Warning', fail: 'Fail', skip: 'Skipped' }[c.status];
      const num = (v) => (Number.isFinite(v) ? U.fmtMoney(v, sym) : '<span class="muted">—</span>');
      const deltaCls = !Number.isFinite(c.delta) ? '' : (Math.abs(c.delta) <= (c.tol || 0) ? 'pos' : 'neg');
      return '<tr>' +
        '<td class="desc">' + esc(c.label) + '</td>' +
        '<td class="mono muted">' + esc(c.equation || '') + '</td>' +
        '<td class="num">' + num(c.printed) + '</td>' +
        '<td class="num">' + num(c.computed) + '</td>' +
        '<td class="num ' + deltaCls + '">' + (Number.isFinite(c.delta) ? U.fmtDelta(c.delta) : '—') + '</td>' +
        '<td><span class="pill pill--' + pill + '">' + label + '</span></td>' +
      '</tr>';
    }).join('');
    $('#tblMath tbody').innerHTML = rows || '<tr><td colspan="6" class="muted">No arithmetic could be checked.</td></tr>';
  }

  function renderVisual(report) {
    const v = report.visual;
    const note = $('#visualNote');
    $('#tblRegions tbody').innerHTML = (v.regions || []).length
      ? v.regions.map((r) => '<tr>' +
          '<td class="num">#' + r.index + '</td>' +
          '<td class="mono">' + r.x + ', ' + r.y + ' · ' + r.width + ' × ' + r.height + '</td>' +
          '<td>' + (r.signals || []).map((s) => '<span class="pill pill--warn">' + esc(s) + '</span>').join(' ') + '</td>' +
          '<td class="num">' + r.score.toFixed(2) + '</td>' +
          '<td class="desc">' + esc((r.why || []).join(' · ')) + '</td>' +
        '</tr>').join('')
      : '<tr><td colspan="5" class="muted">No suspicious regions.</td></tr>';

    const cvOriginal = $('#cvOriginal');
    const cvEla = $('#cvEla');
    const cvBoxes = $('#cvBoxes');

    if (!v.ran || !state.canvas) {
      note.innerHTML = 'No image was supplied, so the pixel-level stages were skipped. Run an image through the detector to see error-level analysis, paper-tone mapping and typography forensics here.';
      [cvOriginal, cvEla, cvBoxes].forEach((c) => {
        c.width = 320; c.height = 120;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0a0f17'; ctx.fillRect(0, 0, 320, 120);
        ctx.fillStyle = '#6d7f94';
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('not available in text mode', 160, 64);
      });
      return;
    }

    const st = v.stats || {};
    note.innerHTML = 'Error-level baseline (median) ' + st.errorLevelMedian + ', 99th percentile ' + st.errorLevelP99 +
      ' · paper tone ' + st.paperTone + ' ± ' + st.paperToneSpread +
      ' · ' + st.amountWordsCompared + ' amounts compared on glyph height, character width and right-edge alignment. ' +
      esc(v.note || '');

    drawVisual();
  }

  function drawVisual() {
    const visual = state.visual;
    if (!visual || !visual.ran || !state.canvas) return;
    const cvOriginal = $('#cvOriginal');
    const cvEla = $('#cvEla');

    cvOriginal.width = state.canvas.width;
    cvOriginal.height = state.canvas.height;
    cvOriginal.getContext('2d').drawImage(state.canvas, 0, 0);

    RS.visual.renderHeat(cvEla, visual.ela.norm, state.canvas.width, state.canvas.height, state.view.amp ? 8 : 1);

    RS.visual.drawOverlay($('#cvBoxes'), {
      image: state.canvas,
      regions: visual.regions,
      words: state.ocr ? state.ocr.words : [],
      showRegions: state.view.regions,
      showHeat: state.view.heat,
      showText: state.view.text,
      heat: visual.ela.norm,
      amplify: state.view.amp,
    });
  }

  function renderJson(report) {
    $('#jsonOut').textContent = JSON.stringify(report, null, 2);
  }

  /* ── tabs, filters, toggles ──────────────────────────────── */
  function selectTab(name) {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.tabpanel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  }

  function wire() {
    /* modes */
    $$('.mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        $$('.mode').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $$('.mode-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === state.mode));
        markReady();
      });
    });

    /* file input + drop */
    const dz = $('#dropzone');
    const input = $('#fileInput');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { showBanner('err', 'That file is not an image. ReceiptShield needs a PNG, JPG or WEBP.'); return; }
      hideBanner();
      setFile(f, f.name);
    });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { showBanner('err', 'That file is not an image.'); return; }
      hideBanner();
      setFile(f, f.name);
    });
    document.addEventListener('paste', (e) => {
      if (state.mode !== 'image') return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) { hideBanner(); setFile(f, 'pasted-image.' + (f.type.split('/')[1] || 'png')); }
          break;
        }
      }
    });

    /* samples */
    $('#btnGenuine').addEventListener('click', () => loadSample('genuine'));
    $('#btnTampered').addEventListener('click', () => loadSample('tampered'));
    $('#btnTextGenuine').addEventListener('click', () => {
      $('#textInput').value = RS.samples.docToText(RS.samples.genuineDoc());
      markReady();
    });
    $('#btnTextTampered').addEventListener('click', () => {
      $('#textInput').value = RS.samples.docToText(RS.samples.tamperedDoc());
      markReady();
    });

    /* run / reset */
    $('#btnRun').addEventListener('click', run);
    $('#btnReset').addEventListener('click', () => {
      if (state.file && state.file.url) URL.revokeObjectURL(state.file.url);
      state.file = null; state.canvas = null; state.ocr = null;
      state.receipt = state.math = state.visual = state.suspicious = state.report = null;
      state.truth = null;
      $('#fileInput').value = '';
      $('#textInput').value = '';
      renderDropzone();
      $('#sampleNote').hidden = true;
      $('#results').hidden = true;
      $('#btnReset').hidden = true;
      resetStages();
      setTag('idle');
      hideBanner();
      markReady();
      $('#detector').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#textInput').addEventListener('input', markReady);

    /* tabs */
    $$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

    /* filters */
    $$('.filters .chip').forEach((c) => c.addEventListener('click', () => {
      state.filter = c.dataset.filter;
      $$('.filters .chip').forEach((x) => x.classList.toggle('is-active', x === c));
      renderFindings();
    }));

    /* region deep-link */
    $('#findingsList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-region]');
      if (!b) return;
      selectTab('visual');
      const row = $('#tblRegions tbody').querySelector('tr:nth-child(' + b.dataset.region + ')');
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background .3s';
        row.style.background = 'rgba(244,83,106,.16)';
        setTimeout(() => { row.style.background = ''; }, 1600);
      }
    });

    /* visual toggles */
    const bind = (id, key) => {
      const box = $('#' + id);
      box.checked = state.view[key];
      box.addEventListener('change', () => { state.view[key] = box.checked; drawVisual(); });
    };
    bind('tglBoxes', 'regions');
    bind('tglHeat', 'heat');
    bind('tglText', 'text');
    bind('tglAmp', 'amp');

    /* zoom */
    const dlg = document.createElement('dialog');
    dlg.className = 'zoom';
    dlg.innerHTML = '<button class="zoom__close" type="button" aria-label="Close">Close</button><img alt="Enlarged receipt view" />';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target !== dlg.querySelector('img')) dlg.close(); });
    $$('.viewer canvas').forEach((c) => {
      c.style.cursor = 'zoom-in';
      c.addEventListener('click', () => {
        const img = dlg.querySelector('img');
        img.src = c.toDataURL('image/png');
        dlg.showModal();
      });
    });

    /* json */
    $('#btnCopyJson').addEventListener('click', async () => {
      const btn = $('#btnCopyJson');
      try {
        await navigator.clipboard.writeText($('#jsonOut').textContent);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
      } catch (err) {
        showBanner('warn', 'Clipboard access was blocked by the browser. Select the JSON and copy it manually.');
      }
    });
    $('#btnDownloadJson').addEventListener('click', () => {
      if (!state.report) return;
      const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'receiptshield-report-' + new Date(state.report.generatedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  /* ── hero flourish ───────────────────────────────────────── */
  function startHero() {
    const amt = $('#heroAmount');
    if (!amt) return;
    setTimeout(() => {
      amt.style.transition = 'color .4s, text-shadow .4s';
      amt.textContent = '₹1,500.00';
      amt.style.color = '#f4536a';
      amt.style.textShadow = '0 0 18px rgba(244,83,106,.55)';
    }, 1400);
  }

  /* ── boot ────────────────────────────────────────────────── */
  function init() {
    wire();
    startHero();
    const dv = $('#dialValue');
    dv.style.strokeDasharray = DIAL_C;
    dv.style.strokeDashoffset = DIAL_C;
    renderDropzone();
    markReady();
    if (!RS.ocr.available()) {
      showBanner('warn',
        '<strong>The OCR engine did not load from the CDN.</strong> Image analysis is unavailable, but you can still switch to <strong>Paste text</strong> mode and run the validation engine on receipt text.');
    }
    setTag('idle');
    RS.app = { state, run, paint };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
