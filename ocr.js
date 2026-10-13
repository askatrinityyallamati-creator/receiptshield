/* ==========================================================================
   ReceiptShield — ocr.js
   Stage 2: OCR extraction.

   Wraps Tesseract.js in a single reusable worker and turns its word-level TSV
   output into something the rest of the pipeline can reason about: words with
   bounding boxes, baselines and confidence, grouped into lines and blocks,
   plus per-line typographic metrics used later for tamper detection.

   Exposes window.RS.ocr
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  let workerPromise = null;
  let currentLogger = null;

  /** Is the Tesseract library on the page? */
  function available() {
    return typeof global.Tesseract !== 'undefined' && typeof global.Tesseract.createWorker === 'function';
  }

  const PHASES = [
    [/loading tesseract core/i, 'Loading OCR engine'],
    [/initializing tesseract/i, 'Starting OCR engine'],
    [/loading language traineddata/i, 'Downloading language data'],
    [/initializing api/i, 'Initialising recogniser'],
    [/recognizing text/i, 'Reading the receipt'],
  ];
  function phaseLabel(status) {
    for (const [re, label] of PHASES) if (re.test(status || '')) return label;
    return status ? String(status) : 'Working…';
  }

  /** Lazily create (and memoise) the shared Tesseract worker. */
  function ensureWorker() {
    if (workerPromise) return workerPromise;
    if (!available()) {
      return Promise.reject(new Error(
        'The OCR engine could not be loaded from the CDN. Check your connection, ' +
        'or switch to “Paste text” mode to run the validation engine on its own.'
      ));
    }
    workerPromise = (async () => {
      const worker = await global.Tesseract.createWorker('eng', 1, {
        logger: (m) => { if (currentLogger) currentLogger(m); },
        errorHandler: (e) => console.error('[tesseract]', e),
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6',        // assume a single uniform block of text
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;               // allow a retry after a failed load
      throw err;
    });
    return workerPromise;
  }

  /**
   * Prepare an OCR-friendly copy of the receipt. The original pixels are left
   * untouched — visual forensics must analyse what the user actually has.
   */
  function preprocess(source, targetWidth) {
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    const scale = U.clamp((targetWidth || 2000) / sw, 1, 3);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);

    // Grayscale + percentile contrast stretch: receipts are usually low-contrast
    // scans where this measurably improves recognition.
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    const total = (w * h) || 1;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = U.clamp(((v - lo) * 255) / span, 0, 255);
    for (let i = 0; i < d.length; i += 4) {
      const g = lut[d[i]];
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* ── TSV → structured words ──────────────────────────────── */
  const TSV_HEADER = ['level', 'page_num', 'block_num', 'par_num', 'line_num', 'word_num',
    'left', 'top', 'width', 'height', 'conf', 'text'];

  function parseTsv(tsv) {
    const words = [];
    if (!tsv) return words;
    const rows = String(tsv).split(/\r?\n/);
    let start = rows.length && /level/.test(rows[0]) ? 1 : 0;
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const cols = row.split('\t');
      if (cols.length < 12) continue;
      if (cols[0] !== '5') continue;                 // 5 = word level
      const text = cols[11];
      if (!text || !text.trim()) continue;
      const conf = Number(cols[10]);
      const left = Number(cols[6]), top = Number(cols[7]);
      const width = Number(cols[8]), height = Number(cols[9]);
      if (![left, top, width, height].every(Number.isFinite)) continue;
      const blockKey = cols[2] + '-' + cols[3];
      const lineKey = blockKey + '-' + cols[4];
      words.push({
        text,
        conf: Number.isFinite(conf) && conf >= 0 ? conf : 0,
        x0: left, y0: top, x1: left + width, y1: top + height,
        lineKey, blockKey,
        index: Number(cols[5]),
      });
    }
    return words;
  }

  /** Group words into lines and derive per-line geometry + typography metrics. */
  function groupWords(words) {
    const byLine = new Map();
    words.forEach((w) => {
      if (!byLine.has(w.lineKey)) byLine.set(w.lineKey, []);
      byLine.get(w.lineKey).push(w);
    });

    const lines = [];
    byLine.forEach((ws, key) => {
      ws.sort((a, b) => a.x0 - b.x0);
      const heights = ws.map((w) => w.y1 - w.y0);
      const hMed = U.median(heights);
      const baseline = U.median(ws.map((w) => w.y1));
      const text = joinWords(ws);
      const gaps = [];
      for (let i = 1; i < ws.length; i++) gaps.push(ws[i].x0 - ws[i - 1].x1);

      lines.push({
        key,
        words: ws,
        text,
        x0: Math.min(...ws.map((w) => w.x0)),
        x1: Math.max(...ws.map((w) => w.x1)),
        y0: Math.min(...ws.map((w) => w.y0)),
        y1: Math.max(...ws.map((w) => w.y1)),
        height: hMed,
        baseline,
        center: ws.reduce((s, w) => s + (w.y0 + w.y1) / 2, 0) / ws.length,
        conf: U.mean(ws.map((w) => w.conf)),
        minConf: Math.min(...ws.map((w) => w.conf)),
        width: Math.max(...ws.map((w) => w.x1)) - Math.min(...ws.map((w) => w.x0)),
        gaps,
      });
    });

    lines.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return lines;
  }

  /** Rebuild a line of text, restoring a space where the words were far apart. */
  function joinWords(ws) {
    let out = '';
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (i === 0) { out = w.text; continue; }
      const prev = ws[i - 1];
      const gap = w.x0 - prev.x1;
      const ref = Math.max(1, U.median(ws.map((x) => x.y1 - x.y0)));
      const spaces = gap > ref * 1.6 ? (gap > ref * 4 ? 4 : 2) : 1;
      out += ' '.repeat(spaces) + w.text;
    }
    return out;
  }

  /**
   * Run OCR over an image source (canvas / bitmap / img / blob url).
   * @returns {Promise<{text,words,lines,width,height,conf,scale}>}
   */
  async function recognize(source, onProgress) {
    const worker = await ensureWorker();
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error('The image has no usable dimensions.');

    const prepared = preprocess(source, 2000);
    currentLogger = (m) => {
      if (!onProgress) return;
      onProgress({
        phase: phaseLabel(m.status),
        progress: typeof m.progress === 'number' ? m.progress : 0,
        raw: m.status,
      });
    };

    let result;
    try {
      result = await worker.recognize(prepared, {}, { tsv: true, blocks: true });
    } finally {
      currentLogger = null;
    }

    const data = (result && result.data) || {};
    let words = parseTsv(data.tsv);

    // Fallback for engine builds that return the structured object instead.
    if (!words.length && Array.isArray(data.words)) {
      words = data.words
        .filter((w) => w && w.text && w.text.trim())
        .map((w, i) => ({
          text: w.text,
          conf: Number.isFinite(w.confidence) ? w.confidence : 0,
          x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
          lineKey: 'fb-line-' + i,
          blockKey: 'fb-block-' + i,
          index: i,
        }));
    }

    const scale = prepared.width / sw;
    words.forEach((w) => {
      w.x0 /= scale; w.x1 /= scale; w.y0 /= scale; w.y1 /= scale;
    });

    const lines = groupWords(words);
    const text = (data.text || lines.map((l) => l.text).join('\n')).replace(/[ \t]+$/gm, '');
    const conf = words.length ? U.mean(words.map((w) => w.conf)) : 0;

    return {
      text,
      words,
      lines,
      width: sw,
      height: sh,
      conf,
      scale,
      empty: !words.length,
    };
  }

  async function terminate() {
    if (!workerPromise) return;
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch (e) { /* nothing to clean up */ }
    workerPromise = null;
  }

  RS.ocr = { available, recognize, ensureWorker, terminate, preprocess };
})(window);
