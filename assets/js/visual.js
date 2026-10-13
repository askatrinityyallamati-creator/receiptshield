/* ==========================================================================
   ReceiptShield — visual.js
   Stage 5: visual tampering analysis.

   Four independent looks at the pixels and the typography:

     1. Error-level analysis (ELA) — re-compress the image and measure how much
        each pixel moves. A region pasted in after the original was saved has a
        different compression history and lights up next to the rest of the file.
     2. Paper-tone mapping — find flat background pixels and look for patches
        whose tone does not match the rest of the sheet. A paste almost always
        carries a slightly different white.
     3. Typography forensics — glyph height, character width and right-edge
        alignment of every amount-like word. A figure typed in a different face,
        at a different size, or nudged off the value column breaks the pattern.
     4. Suspicious-file check — image-editor metadata and APP segments left in
        the container.

   Exposes window.RS.visual
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  /* ── shared helpers ──────────────────────────────────────── */
  function blank(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  const px = (ctx, w, h) => ctx.getImageData(0, 0, w, h);

  /* ── 1. error-level analysis ─────────────────────────────── */
  async function errorLevel(canvas, quality) {
    const w = canvas.width, h = canvas.height;
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    const a = src.data;

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality || 0.70));
    const bmp = await createImageBitmap(blob);
    const tmp = blank(w, h);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(bmp, 0, 0);
    bmp.close();
    const b = tctx.getImageData(0, 0, w, h).data;

    const ela = new Float32Array(w * h);
    for (let i = 0, p = 0; i < a.length; i += 4, p++) {
      const d0 = Math.abs(a[i] - b[i]);
      const d1 = Math.abs(a[i + 1] - b[i + 1]);
      const d2 = Math.abs(a[i + 2] - b[i + 2]);
      ela[p] = Math.max(d0, Math.max(d1, d2));
    }

    // Snap the grid to the 8×8 JPEG block lattice: cells that straddle block
    // boundaries inherit spurious residue and would read as false hot spots.
    const cell = Math.max(24, Math.round(Math.round(Math.min(w, h) / 26) / 8) * 8);
    const cols = Math.max(1, Math.ceil(w / cell));
    const rows = Math.max(1, Math.ceil(h / cell));
    const cells = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = cx * cell, y0 = cy * cell;
        const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
        let sum = 0, n = 0, mx = 0, dark = 0;
        for (let y = y0; y < y1; y++) {
          const base = y * w;
          for (let x = x0; x < x1; x++) {
            const v = ela[base + x];
            sum += v; n++;
            if (v > mx) mx = v;
            const i = (base + x) * 4;
            if (0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2] < 150) dark++;
          }
        }
        cells.push({
          cx, cy, x: x0, y: y0, w: x1 - x0, h: y1 - y0,
          mean: n ? sum / n : 0, max: mx,
          ink: n ? dark / n : 0,        // how much of the cell is actually ink
        });
      }
    }

    const means = cells.map((c) => c.mean);
    const med = U.median(means);
    const spread = U.mad(means);
    const p99 = U.percentile(Array.from(ela), 99);

    // Error level rises with how much ink is in a cell, so a cell must only ever
    // be compared with cells carrying a similar amount of ink. Without this,
    // ordinary text looks anomalous next to blank paper and every receipt reads
    // as tampered — the single most common way ELA produces nonsense.
    const INK_GROUPS = [
      { id: 'blank paper', test: (c) => c.ink <= 0.005 },
      { id: 'light text', test: (c) => c.ink > 0.005 && c.ink <= 0.06 },
      { id: 'moderate text', test: (c) => c.ink > 0.06 && c.ink <= 0.18 },
      { id: 'dense text', test: (c) => c.ink > 0.18 },
    ];

    const hotspots = [];
    const groupStats = [];
    INK_GROUPS.forEach((grp) => {
      const g = cells.filter(grp.test);
      if (g.length < 8) return;
      const vals = g.map((c) => c.mean);
      const gMed = U.median(vals);
      const gSpread = Math.max(U.mad(vals), 0.35);
      let flagged = 0;
      g.forEach((c) => {
        const z = U.robustZ(c.mean, gMed, gSpread);
        if (z > 3.5 && c.mean - gMed > 0.6 && c.mean > 0.8) {
          c.z = z;
          c.group = grp.id;
          c.groupMedian = gMed;
          hotspots.push(c);
          flagged++;
        }
      });
      groupStats.push({ id: grp.id, cells: g.length, median: gMed, mad: gSpread, flagged });
    });

    const hot = hotspots;

    return {
      ela, w, h, cells, hot, groups: groupStats,
      stats: { median: med, mad: spread, p99, max: U.percentile(Array.from(ela), 100), mean: U.mean(Array.from(ela)) },
      norm: normalize(ela, p99 || 255),
    };
  }

  function normalize(ela, ceil) {
    const out = new Uint8ClampedArray(ela.length);
    const c = Math.max(1, ceil);
    for (let i = 0; i < ela.length; i++) out[i] = U.clamp((ela[i] / c) * 255, 0, 255);
    return out;
  }

  /** Group grid cells into connected blobs and return bounding boxes. */
  function groupCells(cells, w, h, minCells) {
    const map = new Map();
    cells.forEach((c) => map.set(c.cx + ',' + c.cy, c));
    const seen = new Set();
    const blobs = [];

    cells.forEach((start) => {
      const key = start.cx + ',' + start.cy;
      if (seen.has(key)) return;
      const stack = [start];
      seen.add(key);
      const members = [];
      while (stack.length) {
        const c = stack.pop();
        members.push(c);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const k = (c.cx + dx) + ',' + (c.cy + dy);
            if (seen.has(k) || !map.has(k)) continue;
            seen.add(k);
            stack.push(map.get(k));
          }
        }
      }
      if (members.length < (minCells || 2)) return;
      const x0 = Math.min(...members.map((c) => c.x));
      const y0 = Math.min(...members.map((c) => c.y));
      const x1 = Math.max(...members.map((c) => c.x + c.w));
      const y1 = Math.max(...members.map((c) => c.y + c.h));
      blobs.push({
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
        cells: members.length,
        members,
        strength: U.mean(members.map((c) => c.z === undefined ? 0 : c.z)),
      });
    });
    return blobs.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  }

  /* ── 2. paper-tone mapping ───────────────────────────────── */
  function paperTone(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const cell = 14;
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    const grid = [];

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = cx * cell, y0 = cy * cell;
        const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
        let sum = 0, sum2 = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sum += lum; sum2 += lum * lum; n++;
          }
        }
        if (!n) continue;
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        grid.push({ cx, cy, x: x0, y: y0, w: x1 - x0, h: y1 - y0, mean, sd });
      }
    }

    // only pixels that look like blank paper can define the paper tone
    const flat = grid.filter((c) => c.sd < 9 && c.mean > 140);
    const tone = U.median(flat.map((c) => c.mean));
    const spread = U.mad(flat.map((c) => c.mean));

    const off = flat.filter((c) => Math.abs(c.mean - tone) >= Math.max(4, spread * 4));
    const blobs = groupCells(off.map((c) => ({ ...c })), w, h, 4);

    return {
      tone,
      spread,
      flatCells: flat.length,
      offCells: off.length,
      regions: blobs.map((b) => ({
        ...b,
        delta: (() => {
          const inside = flat.filter((c) => c.x >= b.x && c.x < b.x + b.w && c.y >= b.y && c.y < b.y + b.h);
          return inside.length ? U.mean(inside.map((c) => c.mean)) - tone : 0;
        })(),
      })),
    };
  }

  /* ── 3. typography forensics ─────────────────────────────── */
  function typography(ocr, receipt) {
    // Only amounts the parser actually treated as money take part. Text that is
    // amount-shaped but not money — a postal code, a registration number — would
    // otherwise be compared against a currency column it never belonged to.
    const metrics = [];
    const seen = new Set();
    const add = (w) => {
      if (!w || !w.text) return;
      const key = Math.round(w.x0) + ':' + Math.round(w.y0) + ':' + w.text;
      if (seen.has(key)) return;
      seen.add(key);
      const h = w.y1 - w.y0;
      const cw = (w.x1 - w.x0) / Math.max(1, w.text.length);
      if (h < 5 || cw <= 0) return;
      metrics.push({ text: w.text, conf: w.conf, x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, h, cw, right: w.x1 });
    };

    receipt.items.forEach((i) => {
      if (!i.geo) return;
      if (i.unitStated) add(i.geo.unitWord);
      add(i.geo.amountWord);
    });
    ['subtotal', 'taxable', 'total', 'roundOff', 'tendered', 'change'].forEach((k) => {
      const f = receipt.fields[k];
      if (f && f.geo) add(f.geo.amountWord);
    });
    receipt.taxes.forEach((t) => add(t.geo && t.geo.amountWord));
    receipt.adjustments.forEach((a) => add(a.geo && a.geo.amountWord));

    if (metrics.length < 4) {
      return { enough: false, amountWords: metrics.length, outliers: [], columns: [], regions: [] };
    }

    // A receipt has several money columns (unit price, line total, grand total).
    // They must be compared against themselves, not against each other, so first
    // group the amounts by right edge. Single linkage with a tolerance a little
    // wider than typical OCR jitter keeps one column together while a figure
    // nudged off it still lands inside its own column and can be measured.
    const tol = Math.max(8, canvasIndependentTol(metrics));
    const columns = clusterByRight(metrics, tol).filter((c) => c.items.length >= 3);

    const outliers = [];
    const summary = [];
    columns.forEach((col) => {
      const ms = col.items;
      const medH = U.median(ms.map((m) => m.h));
      const madH = U.mad(ms.map((m) => m.h));
      const medW = U.median(ms.map((m) => m.cw));
      const madW = U.mad(ms.map((m) => m.cw));
      const medR = U.median(ms.map((m) => m.right));
      const madR = U.mad(ms.map((m) => m.right));
      summary.push({ right: medR, size: ms.length, height: medH, charWidth: medW, madRight: madR });

      ms.forEach((m) => {
        const zH = U.robustZ(m.h, medH, madH);
        const zW = U.robustZ(m.cw, medW, madW);
        const ratioH = m.h / medH;
        const ratioW = m.cw / medW;
        const align = m.right - medR;

        const sizeBad = Math.abs(zH) > 3.5 && (ratioH > 1.16 || ratioH < 0.86);
        const widthBad = Math.abs(zW) > 3.5 && (ratioW > 1.12 || ratioW < 0.89);
        const alignBad = Math.abs(align) > Math.max(3, madR * 4);

        // Glyph height is the reliable measurement; OCR word boxes wobble by a few
        // pixels horizontally, so a lone width or a lone small alignment deviation
        // is not enough to accuse an amount of being retyped. Two weak signals, or
        // one strong one, is the bar.
        const flagged =
          sizeBad ||
          (widthBad && alignBad) ||
          (alignBad && Math.abs(align) > 10) ||
          (widthBad && ratioW > 1.4);
        if (!flagged) return;

        outliers.push({
          text: m.text,
          x: m.x0, y: m.y0, w: m.x1 - m.x0, h: m.h,
          column: Math.round(medR),
          reasons: [
            sizeBad ? 'glyph height ' + (ratioH * 100).toFixed(0) + '% of its column’s median' : null,
            widthBad ? 'character width ' + (ratioW * 100).toFixed(0) + '% of its column’s median' : null,
            alignBad ? 'right edge ' + (align > 0 ? '+' : '') + align.toFixed(1) + 'px off the column' : null,
          ].filter(Boolean),
          zH, zW, align,
          weight: (sizeBad ? 0.42 : 0) + (widthBad ? 0.44 : 0) + (alignBad ? 0.3 : 0),
        });
      });
    });

    return {
      enough: true,
      amountWords: metrics.length,
      columns: summary,
      median: summary[0] || { height: U.median(metrics.map((m) => m.h)), charWidth: U.median(metrics.map((m) => m.cw)) },
      outliers,
      regions: outliers.map((o) => ({
        x: Math.max(0, o.x - 6), y: Math.max(0, o.y - 6), w: o.w + 12, h: o.h + 12,
        cells: 1, score: U.clamp(o.weight, 0, 1), label: 'typography',
        why: o.text + ' — ' + o.reasons.join('; '),
      })),
    };
  }

  /** Group amounts by right edge with single-linkage clustering. */
  function clusterByRight(metrics, tol) {
    const sorted = metrics.slice().sort((a, b) => a.right - b.right);
    const clusters = [];
    sorted.forEach((m) => {
      const last = clusters[clusters.length - 1];
      if (last && m.right - last.max <= tol) {
        last.items.push(m);
        last.max = Math.max(last.max, m.right);
      } else {
        clusters.push({ items: [m], max: m.right });
      }
    });
    return clusters;
  }

  /**
   * Column tolerance, derived from the amount metrics themselves rather than
   * from the image size, so it works for a phone snap and a flatbed scan alike.
   */
  function canvasIndependentTol(metrics) {
    const chars = metrics.map((m) => m.cw).filter(Number.isFinite).sort((a, b) => a - b);
    const med = chars.length ? chars[chars.length >> 1] : 10;
    return med * 0.9;
  }

  /* ── 4. suspicious-file check ────────────────────────────── */
  const EDITOR_TAGS = [
    'Adobe Photoshop', 'Adobe Lightroom', 'Adobe Illustrator', 'Photoshop',
    'GIMP', 'Canva', 'Pixlr', 'Photopea', 'Snapseed', 'Picsart', 'Fotor',
    'Paint.NET', 'IrfanView', 'XnView', 'Affinity Photo', 'Capture One',
    'AcdSee', 'CorelDRAW', 'Sketch', 'Meitu', 'Aviary', 'inPixio', 'Movavi',
  ];

  async function fileCheck(blob) {
    const out = { available: !!blob, isJpeg: false, editorTags: [], software: null, appSegments: 0, size: 0 };
    if (!blob || typeof blob.slice !== 'function') return out;
    out.size = blob.size;
    const head = await blob.slice(0, 384 * 1024).arrayBuffer();
    const bytes = new Uint8Array(head);

    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) out.isJpeg = true;

    // count JPEG APP segments
    if (out.isJpeg) {
      let i = 2;
      while (i + 4 < bytes.length && bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        if (marker === 0xda || marker === 0xd9) break;
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xe0 && marker <= 0xef) out.appSegments++;
        if (len < 2) break;
        i += 2 + len;
      }
    }

    const ascii = new TextDecoder('latin1').decode(bytes);
    EDITOR_TAGS.forEach((tag) => {
      if (ascii.indexOf(tag) !== -1 && out.editorTags.indexOf(tag) === -1) out.editorTags.push(tag);
    });
    const sw = ascii.match(/<xmp:CreatorTool>([^<]{1,80})<\/xmp:CreatorTool>/i)
      || ascii.match(/xmp:CreatorTool="([^"]{1,80})"/i)
      || ascii.match(/Software["']?\s*[:=]\s*["']?([^"'\r\n]{1,60})/i);
    if (sw) out.software = sw[1].trim();
    return out;
  }

  /* ── combine ─────────────────────────────────────────────── */
  function mergeRegions(candidates) {
    const merged = [];
    candidates.filter(Boolean).forEach((c) => {
      const found = merged.find((m) => U.overlapRatio(m, c) > 0.28 || contains(m, c));
      if (found) {
        found.signals.push(c);
        found.x = Math.min(found.x, c.x);
        found.y = Math.min(found.y, c.y);
        found.x1 = Math.max(found.x1, c.x + c.w);
        found.y1 = Math.max(found.y1, c.y + c.h);
        found.w = found.x1 - found.x;
        found.h = found.y1 - found.y;
      } else {
        merged.push({ x: c.x, y: c.y, x1: c.x + c.w, y1: c.y + c.h, w: c.w, h: c.h, signals: [c] });
      }
    });
    merged.forEach((m) => {
      const kinds = {};
      m.signals.forEach((s) => { kinds[s.label] = (kinds[s.label] || 0) + 1; });
      m.kinds = Object.keys(kinds);
      m.score = U.clamp(m.signals.reduce((s, x) => s + (x.score || 0.3), 0), 0, 1);
      m.why = Array.from(new Set(m.signals.map((s) => s.why).filter(Boolean))).slice(0, 4);
    });
    return merged.sort((a, b) => b.score - a.score || (b.w * b.h) - (a.w * a.h));
  }
  const contains = (a, b) =>
    a.x <= b.x && a.y <= b.y && (a.x1 !== undefined ? a.x1 : a.x + a.w) >= b.x + b.w && a.y1 >= b.y + b.h;

  /* ── main ────────────────────────────────────────────────── */
  /**
   * @param {HTMLCanvasElement} canvas  the receipt at natural resolution
   * @param {object} receipt            RS.parse output
   * @param {object} ocr                RS.ocr output
   * @param {Blob}   blob               the original file, for the container check
   */
  async function analyze(canvas, receipt, ocr, blob) {
    const findings = [];
    const checks = [];
    const note = [];

    const ela = await errorLevel(canvas, 0.70);
    const tone = paperTone(canvas);
    const typo = typography(ocr, receipt);
    const file = await fileCheck(blob);

    /* 1 — error level */
    const elaBlobs = groupCells(ela.hot, canvas.width, canvas.height, 4).map((b) => {
      const members = b.members || [];
      const groups = Array.from(new Set(members.map((m) => m.group)));
      const zs = members.map((m) => m.z).filter(Number.isFinite);
      const meanZ = zs.length ? U.mean(zs) : 0;
      const strongest = members.reduce((a, b2) => (b2.z > a.z ? b2 : a), members[0] || { z: 0 });
      return {
        x: b.x, y: b.y, w: b.w, h: b.h, cells: members.length, label: 're-compression',
        strong: members.length >= 6 || meanZ >= 5,
        score: U.clamp(0.45 + members.length / 50 + Math.min(meanZ, 12) / 40, 0, 1),
        why: members.length + ' adjacent cells of ' + (groups.join(' / ') || 'similar') +
          ' carry more re-compression residue than that content normally does here (error level ' +
          (strongest.mean || 0).toFixed(1) + ' against ' + (strongest.groupMedian || 0).toFixed(1) + ' typical)',
      };
    });
    const elaAll = elaBlobs;
    const strongEla = elaAll.filter((b) => b.strong);

    const groupLine = (ela.groups || [])
      .map((g) => g.id + ' ' + g.cells + ' cells, ' + g.flagged + ' flagged')
      .join(' · ');
    checks.push({
      stage: 'visual',
      status: strongEla.length ? 'fail' : (elaAll.length ? 'warn' : 'pass'),
      label: 'Error-level analysis', id: 'ela',
      detail: (elaAll.length
        ? strongEla.length + ' of ' + elaAll.length + ' region(s) show re-compression residue well above what the same kind of content shows elsewhere in this file.'
        : 'Re-compression residue is consistent with the content of each region; nothing stands out.') +
        (groupLine ? ' Comparisons were made within ink-coverage bands: ' + groupLine + '.' : ''),
    });
    note.push('Error level compares each region only against other regions carrying a similar amount of ink, so ordinary text is never mistaken for tampering.');

    /* 2 — paper tone */
    const toneRegions = tone.regions.map((r) => ({
      x: r.x, y: r.y, w: r.w, h: r.h, cells: r.cells, label: 'tone mismatch',
      score: U.clamp(0.35 + Math.abs(r.delta) / 30, 0, 1),
      why: 'blank paper here reads ' + (r.delta > 0 ? '+' : '') + r.delta.toFixed(1) +
        ' luminance away from the sheet average (' + tone.tone.toFixed(0) + ') across ' + r.cells + ' patches',
    }));

    checks.push({
      stage: 'visual', status: toneRegions.length ? 'fail' : 'pass',
      label: 'Paper-tone consistency', id: 'tone',
      detail: toneRegions.length
        ? toneRegions.length + ' patch(es) of blank paper do not match the sheet’s baseline tone of ' +
          tone.tone.toFixed(0) + ' — consistent with content pasted from a different image.'
        : 'Every blank area of the sheet shares one paper tone (' + tone.tone.toFixed(0) + ' ± ' + tone.spread.toFixed(2) + ').',
    });

    /* 3 — typography */
    const typoRegions = typo.enough ? typo.regions.map((r) => ({ ...r, points: r.score })) : [];
    checks.push({
      stage: 'visual',
      status: !typo.enough ? 'skip' : (typo.outliers.length ? 'fail' : 'pass'),
      label: 'Amount typography consistency', id: 'typo',
      detail: !typo.enough
        ? 'Not enough amount-like words were recognised to compare glyph metrics.'
        : typo.outliers.length
          ? typo.outliers.length + ' amount(s) break the value column’s type pattern: ' +
            typo.outliers.map((o) => o.text + ' (' + o.reasons.join(', ') + ')').join(' · ')
          : 'All ' + typo.amountWords + ' amounts share the column’s glyph height, character width and right edge.',
    });

    /* 4 — container */
    const editorHit = file.editorTags.length > 0 || !!file.software;
    checks.push({
      stage: 'visual',
      status: editorHit ? 'fail' : 'pass',
      label: 'Suspicious file metadata', id: 'filemeta',
      detail: editorHit
        ? 'The file container names an image editor: ' + (file.software || file.editorTags.join(', ')) +
          (file.isJpeg ? ' (JPEG, ' + file.appSegments + ' APP segment(s))' : '') + '.'
        : file.available
          ? 'No image-editor signature found in the file container' + (file.isJpeg ? ' (JPEG, ' + file.appSegments + ' APP segment(s))' : '') + '.'
          : 'Container analysis not available for this input.',
    });

    /* 5 — confidence clusters (supporting evidence only) */
    const lowConf = (ocr.words || []).filter((w) => w.conf < 55 && w.text.trim().length > 1);
    const docConf = ocr.conf || 0;
    let confRegions = [];
    if (lowConf.length && docConf > 70) {
      const blobs = groupCells(
        lowConf.map((w) => ({
          cx: Math.round(w.x0 / 40), cy: Math.round(w.y0 / 18),
          x: Math.round(w.x0), y: Math.round(w.y0),
          w: Math.round(w.x1 - w.x0), h: Math.round(w.y1 - w.y0),
        })),
        canvas.width, canvas.height, 2
      );
      confRegions = blobs.map((b) => ({
        x: b.x, y: b.y, w: b.w, h: b.h, cells: b.cells, label: 'low confidence',
        score: 0.22,
        why: b.cells + ' low-confidence word(s) clustered together while the document averages ' + docConf.toFixed(0) + '% confidence',
      }));
    }

    /* merge everything the image stage found */
    const regions = mergeRegions([...elaAll, ...toneRegions, ...typoRegions, ...confRegions]);
    regions.forEach((r, i) => {
      r.index = i + 1;
      r.kinds = r.kinds || [];
      if (!r.why.length) r.why = ['region flagged by the image stage'];
    });

    /* findings */
    if (toneRegions.length) findings.push({
      stage: 'visual', id: 'tone-patch', severity: 'high',
      title: 'Background patch does not match the paper',
      detail: 'One or more blank areas of the sheet have a different paper tone from the rest of the image. When content is copied from another file, the surrounding background usually comes with it.',
      evidence: toneRegions.map((r) => 'at (' + r.x + ',' + r.y + ') ' + r.w + '×' + r.h + ': ' + r.why).join('\n'),
      region: toneRegions[0],
    });
    if (elaAll.length) findings.push({
      stage: 'visual', id: 'ela', severity: strongEla.length ? 'high' : 'low',
      title: 'Re-compression residue outlines edited regions',
      detail: 'Error-level analysis highlights where the file’s compression history is inconsistent. Content added after the original was saved has been through fewer compression cycles than the rest of the sheet.',
      evidence: elaAll.slice(0, 4).map((r) => 'at (' + r.x + ',' + r.y + ') ' + r.w + '×' + r.h + ': ' + r.why).join('\n'),
      region: elaAll[0],
    });
    if (typo.enough && typo.outliers.length) findings.push({
      stage: 'visual', id: 'typo', severity: 'high',
      title: 'Amounts break the value column’s type pattern',
      detail: 'Glyph height, character width and right-edge alignment are compared across every amount on the receipt. Words typed in another face, at another size, or nudged off the column stand out.',
      evidence: typo.outliers.map((o) => '“' + o.text + '” — ' + o.reasons.join('; ')).join('\n'),
      region: typoRegions[0],
    });
    if (editorHit) findings.push({
      stage: 'visual', id: 'filemeta', severity: 'medium',
      title: 'File carries image-editor metadata',
      detail: 'The container names an image editor and/or an XMP creator tool. That is normal for a legitimately exported or resized receipt, but it also means the pixels have been through an editor at least once.',
      evidence: (file.software ? 'CreatorTool: ' + file.software + '\n' : '') +
        (file.editorTags.length ? 'Matched in file bytes: ' + file.editorTags.join(', ') : ''),
      region: null,
    });
    if (confRegions.length) findings.push({
      stage: 'visual', id: 'lowconf', severity: 'low',
      title: 'Clustered low-confidence characters',
      detail: 'A group of characters was read with much lower confidence than the rest of the document. Pasted text that was never part of the original render often scans less cleanly. This is supporting evidence only.',
      evidence: confRegions.map((r) => 'at (' + r.x + ',' + r.y + ') ' + r.why).join('\n'),
      region: confRegions[0],
    });

    // Repoint every finding at the merged region it actually lives in, so the
    // report can link straight from a written finding to the picture.
    findings.forEach((f) => {
      if (!f.region) return;
      const hit = regions.find((r) => U.overlapRatio(r, f.region) > 0.2 || contains(r, f.region));
      if (hit) f.region = hit;
    });

    return {
      ela, tone, typo, file,
      checks,
      findings,
      regions: regions.slice(0, 14),
      note: note.join(' '),
      ok: true,
    };
  }

  /* ── rendering ───────────────────────────────────────────── */
  const HEAT_LUT = (() => {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      lut[i * 3] = Math.round(U.clamp(t < 0.5 ? t * 2 * 90 : 255, 0, 255));
      lut[i * 3 + 1] = Math.round(U.clamp(t < 0.5 ? t * 2 * 40 : 120 + (t - 0.5) * 2 * 20, 0, 255));
      lut[i * 3 + 2] = Math.round(U.clamp(40 * (1 - t), 0, 255));
    }
    return lut;
  })();

  function renderHeat(target, norm, w, h, amplify) {
    target.width = w; target.height = h;
    const ctx = target.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const amp = amplify || 1;
    for (let i = 0, p = 0; i < norm.length; i++, p += 4) {
      const v = U.clamp(norm[i] * amp, 0, 255) | 0;
      const k = v * 3;
      d[p] = HEAT_LUT[k]; d[p + 1] = HEAT_LUT[k + 1]; d[p + 2] = HEAT_LUT[k + 2]; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawOverlay(target, opts) {
    const { image, regions, words, showRegions, showHeat, showText, heat, amplify } = opts;
    const w = image.width, h = image.height;
    target.width = w; target.height = h;
    const ctx = target.getContext('2d');
    ctx.drawImage(image, 0, 0);

    if (showHeat && heat) {
      const layer = blank(w, h);
      renderHeat(layer, heat, w, h, amplify ? 8 : 1);
      ctx.globalAlpha = 0.45;
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(layer, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    if (showText && words && words.length) {
      ctx.lineWidth = 1;
      words.forEach((wd) => {
        const c = wd.conf >= 80 ? 'rgba(61,220,132,.45)' : (wd.conf >= 55 ? 'rgba(245,165,36,.5)' : 'rgba(244,83,106,.6)');
        ctx.strokeStyle = c;
        ctx.strokeRect(wd.x0 + 0.5, wd.y0 + 0.5, wd.x1 - wd.x0 - 1, wd.y1 - wd.y0 - 1);
      });
    }

    if (showRegions && regions && regions.length) {
      const scale = Math.max(1.5, w / 700);
      regions.forEach((r) => {
        const hot = r.score >= 0.55;
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = hot ? 'rgba(255,45,85,.95)' : 'rgba(245,165,36,.95)';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = hot ? 'rgba(255,45,85,.14)' : 'rgba(245,165,36,.12)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        const label = '#' + r.index;
        ctx.font = 'bold ' + Math.round(11 * scale) + 'px ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 8 * scale;
        const th = 15 * scale;
        const ly = r.y - th - 2 >= 0 ? r.y - th - 2 : r.y + 2;
        ctx.fillStyle = hot ? 'rgba(255,45,85,.92)' : 'rgba(245,165,36,.92)';
        ctx.fillRect(r.x, ly, tw, th);
        ctx.fillStyle = '#0b0f16';
        ctx.fillText(label, r.x + 4 * scale, ly + th * 0.72);
      });
    }
  }

  RS.visual = { analyze, drawOverlay, renderHeat, errorLevel, paperTone, typography, fileCheck };
})(window);
