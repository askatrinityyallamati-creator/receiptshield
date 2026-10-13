/* ==========================================================================
   ReceiptShield — samples.js
   Builds two synthetic receipt files entirely on the client so the demo can
   run with no network and no personal data:

     genuine  — a clean, arithmetically consistent receipt
     tampered — the same receipt after a forged "save": two amounts are pasted
                in a different font, shifted off the amount column, over a
                patch whose paper tone does not quite match, and sitting on a
                re-compression boundary.

   The tampered file is produced by first JPEG-encoding the genuine receipt
   (simulating "the file as it was originally saved") and then drawing the
   forged values on top of the decoded pixels. That is exactly the history
   error-level analysis is designed to reveal.

   Exposes window.RS.samples
   ========================================================================== */
(function (global) {
  'use strict';

  const RS = global.RS;
  const U = RS.util;

  const W = 900;
  const PAD = 74;
  const RIGHT = W - PAD;
  const UNIT_COL = RIGHT - 190;
  const PAPER = '#ffffff';
  const FONT = '"Courier New", Courier, monospace';

  /* ── the receipt document ────────────────────────────────── */
  /**
   * A block list drives both the renderer and the plain-text export, so the
   * image and the text sample can never drift apart.
   */
  function genuineDoc() {
    return [
      { t: 'title', text: 'GRAND CAFÉ & CO.' },
      { t: 'center', text: '12 Marine Drive, Mumbai 400020' },
      { t: 'center', text: 'GSTIN: 27AABCU9603R1ZM' },
      { t: 'rule' },
      { t: 'kv', left: 'Invoice:', right: 'INV-2291' },
      { t: 'kv', left: 'Date:', right: '12/03/2026 19:42' },
      { t: 'rule' },
      { t: 'label', text: 'ITEMS' },
      { t: 'item', qty: '2', name: 'Filter Coffee', unit: 150.00, amount: 300.00 },
      { t: 'item', qty: '1', name: 'Club Sandwich', unit: 200.00, amount: 200.00 },
      { t: 'item', qty: '3', name: 'Masala Chai', unit: 30.00, amount: 90.00 },
      { t: 'item', qty: '1', name: 'Chocolate Brownie', unit: 120.00, amount: 120.00 },
      { t: 'rule' },
      { t: 'kv', left: 'Subtotal', right: 710.00 },
      { t: 'kv', left: 'Discount 5%', right: 35.50 },
      { t: 'kv', left: 'Taxable Value', right: 674.50 },
      { t: 'kv', left: 'CGST 2.5%', right: 16.86 },
      { t: 'kv', left: 'SGST 2.5%', right: 16.86 },
      { t: 'kv', left: 'Round Off', right: 0.28 },
      { t: 'rule' },
      { t: 'total', left: 'GRAND TOTAL', right: 708.50 },
      { t: 'rule' },
      { t: 'kv', left: 'Paid by:', right: 'UPI ****4417' },
      { t: 'center', text: 'Thank you for visiting!' },
    ];
  }

  /**
   * Apply the fraud to a copy of the document.
   * Two numbers change; both are marked `paste` so the renderer draws them the
   * way a forger would — different typeface, nudged off the column, on top of
   * a background patch lifted from somewhere else.
   */
  function tamper(doc) {
    doc.forEach((b) => {
      if (b.t === 'item' && b.name === 'Club Sandwich') {
        b.amount = 700.00;   // printed line total no longer equals qty x unit (200.00)
        b.paste = true;
      }
      if (b.t === 'total') {
        b.right = 1708.50;   // ₹708.50 rewritten as ₹1,708.50
        b.paste = true;
      }
    });
    return doc;
  }

  const PASTE_STYLE = {
    bg: '#f9f9ee',                 // paper tone that does not match the sheet
    font: 'bold 25px Georgia, "Times New Roman", serif',
    dx: 7,
    dy: 1,
  };

  /** The imaging tool a real forgery is most often re-saved through. */
  const EDITOR = 'Adobe Photoshop 24.0 (Windows)';

  /* ── text export ─────────────────────────────────────────── */
  function docToText(doc) {
    const out = [];
    // Only numeric rows are money. Invoice numbers, dates and payment names
    // must be passed through untouched.
    const amt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v === null || v === undefined ? '' : v));
    doc.forEach((b) => {
      if (b.t === 'rule') return;
      if (b.t === 'kv') { out.push(padRow(b.left, amt(b.right))); return; }
      if (b.t === 'item') {
        const desc = b.qty + ' x ' + b.name;
        out.push(padTriple(desc, amt(b.unit), amt(b.amount)));
        return;
      }
      if (b.t === 'total') { out.push(padRow(b.left, amt(b.right))); return; }
      if (b.t === 'title' || b.t === 'label') { out.push(b.text); return; }
      out.push(b.text);
    });
    return out.join('\n');
  }
  function padRow(left, right) {
    const width = 40;
    const gap = Math.max(1, width - stripTags(left).length - String(right).length);
    return left + ' '.repeat(gap) + right;
  }
  function padTriple(desc, unit, amount) {
    const width = 46;
    const gap = Math.max(1, width - desc.length - unit.length - amount.length);
    return desc + ' '.repeat(gap) + unit + '  ' + amount;
  }
  const stripTags = (s) => String(s).replace(/<[^>]+>/g, '');

  /* ── canvas helpers ──────────────────────────────────────── */
  function blank(w, h, fill) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h); }
    return c;
  }

  function drawDoc(doc) {
    const LINE = 34;
    const rough = 260 + doc.length * LINE;
    const c = blank(W, rough, PAPER);
    const ctx = c.getContext('2d');
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, rough);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#12161c';

    let y = 96;
    const pasteOps = [];

    doc.forEach((b) => {
      const pasted = !!b.paste;
      const baseFont = '22px ' + FONT;

      if (b.t === 'rule') {
        ctx.strokeStyle = '#12161c';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(PAD, y - 12.5);
        ctx.lineTo(RIGHT, y - 12.5);
        ctx.stroke();
        y += 16;
        return;
      }

      // background patch first, so pasted text sits on mismatched paper
      if (pasted) {
        ctx.fillStyle = PASTE_STYLE.bg;
        ctx.fillRect(PAD - 14 + PASTE_STYLE.dx, y + PASTE_STYLE.dy - 24, RIGHT - PAD + 28, 34);
        ctx.fillStyle = '#12161c';
      }

      const dx = pasted ? PASTE_STYLE.dx : 0;
      const dy = pasted ? PASTE_STYLE.dy : 0;
      const font = pasted ? PASTE_STYLE.font : baseFont;
      ctx.font = font;

      if (b.t === 'title') {
        ctx.font = 'bold 27px ' + FONT;
        const w = ctx.measureText(b.text).width;
        ctx.fillText(b.text, (W - w) / 2, y + dy);
        y += 42;
      } else if (b.t === 'center') {
        const w = ctx.measureText(b.text).width;
        ctx.fillText(b.text, (W - w) / 2, y + dy);
        y += LINE;
      } else if (b.t === 'label') {
        ctx.font = 'bold 22px ' + FONT;
        ctx.fillText(b.text, PAD, y + dy);
        y += LINE - 4;
      } else if (b.t === 'kv') {
        ctx.fillText(b.left, PAD, y + dy);
        rightAlign(ctx, String(b.right), RIGHT + dx, y + dy);
        y += LINE;
      } else if (b.t === 'item') {
        ctx.fillText(b.qty + ' x ' + b.name, PAD, y + dy);
        ctx.fillText(U.parseAmount(String(b.unit)).toFixed(2), UNIT_COL - ctx.measureText(U.parseAmount(String(b.unit)).toFixed(2)).width, y + dy);
        rightAlign(ctx, U.parseAmount(String(b.amount)).toFixed(2), RIGHT + dx, y + dy);
        y += LINE;
      } else if (b.t === 'total') {
        ctx.font = pasted ? PASTE_STYLE.font : 'bold 25px ' + FONT;
        ctx.fillText(b.left, PAD, y + dy);
        rightAlign(ctx, U.parseAmount(String(b.right)).toFixed(2), RIGHT + dx, y + dy);
        y += 44;
      }

      if (pasted) {
        pasteOps.push({
          x0: PAD - 16 + PASTE_STYLE.dx,
          x1: RIGHT + 16,
          y0: y - 46 + PASTE_STYLE.dy,
          y1: y + 6 + PASTE_STYLE.dy,
        });
      }
    });

    // trim to content
    const height = Math.min(rough, Math.ceil(y + 70));
    const out = blank(W, height, PAPER);
    out.getContext('2d').drawImage(c, 0, 0);
    const ctx2 = out.getContext('2d');
    grainify(ctx2, W, height, 1.4);
    return { canvas: out, pasteOps };
  }

  function rightAlign(ctx, text, right, y) {
    ctx.fillText(text, right - ctx.measureText(text).width, y);
  }

  /** Very light paper grain so no region is mathematically flat. */
  function grainify(ctx, w, h, amp) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250 && Math.random() < 0.35) continue;
      const n = (Math.random() - 0.5) * 2 * amp;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ── JPEG round-trip ─────────────────────────────────────── */
  /** Encode a canvas to JPEG and decode it back, giving it real JPEG history. */
  function jpegRoundTrip(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = blank(canvas.width, canvas.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        resolve(c);
      }, 'image/jpeg', quality);
    });
  }

  /**
   * Export as PNG. Lossless on purpose: the two forged regions carry a different
   * compression history from the rest of the sheet, and a lossy export would
   * homogenise it and erase the very evidence error-level analysis looks for.
   * Pass `software` to stamp the file the way an image editor would.
   */
  function toPng(canvas, software) {
    return new Promise((resolve) => {
      canvas.toBlob(async (blob) => {
        const bytes = await blob.arrayBuffer();
        const out = software
          ? new Blob([injectPngText(bytes, 'Software', software)], { type: 'image/png' })
          : blob;
        resolve({ url: URL.createObjectURL(out), blob: out, name: 'receipt.png', type: 'image/png' });
      }, 'image/png');
    });
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Insert a tEXt chunk after IHDR. This is how a PNG records the software that
   * wrote it, and it is what the suspicious-file check looks for.
   */
  function injectPngText(buffer, keyword, text) {
    const bytes = new Uint8Array(buffer);
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !SIG.every((b, i) => bytes[i] === b)) return buffer;
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return buffer;

    const ihdrLen = (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11];
    const insertAt = 8 + 4 + 4 + ihdrLen + 4;   // right after the IHDR chunk

    const payload = new Uint8Array(new TextEncoder().encode(keyword + '\u0000' + text));
    const chunk = new Uint8Array(4 + 4 + payload.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length);
    chunk[4] = 0x74; chunk[5] = 0x45; chunk[6] = 0x58; chunk[7] = 0x74;  // 'tEXt'
    chunk.set(payload, 8);
    view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));

    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(bytes.subarray(insertAt), insertAt + chunk.length);
    return out.buffer;
  }

  /* ── public API ──────────────────────────────────────────── */
  /**
   * Build a sample receipt.
   * @param {'genuine'|'tampered'} kind
   * @returns {Promise<{url, blob, name, text, truth}>}
   */
  async function build(kind) {
    const doc = kind === 'tampered' ? tamper(genuineDoc()) : genuineDoc();
    const text = docToText(doc);

    let working = { canvas: drawDoc(doc).canvas, pasteOps: [] };
    let file;

    if (kind === 'tampered') {
      // The sheet was forwarded as a heavily re-compressed JPEG long before the
      // forgery landed, so its pixels are smoothed and its high-frequency detail
      // is gone. The snippet the forger pasted came from somewhere else at high
      // quality, so it carries a different compression history — and it is that
      // mismatch, preserved in the lossless export, that error-level analysis
      // measures.
      const aged = await jpegRoundTrip(working.canvas, 0.70);
      const forgedRaw = drawDoc(doc);
      const forged = { canvas: await jpegRoundTrip(forgedRaw.canvas, 0.95), pasteOps: forgedRaw.pasteOps };

      const base = blank(W, aged.height);
      const bctx = base.getContext('2d', { willReadFrequently: true });
      bctx.drawImage(aged, 0, 0);
      forged.pasteOps.forEach((op) => {
        const sx = Math.max(0, U.clamp(op.x0 - 14, 0, base.width));
        const sy = Math.max(0, U.clamp(op.y0 - 12, 0, base.height));
        const sw = Math.min(op.x1 - op.x0 + 30, base.width - sx);
        const sh = Math.min(op.y1 - op.y0 + 26, base.height - sy);
        if (sw <= 0 || sh <= 0) return;
        bctx.drawImage(forged.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
      });

      working.pasteOps = forged.pasteOps;
      file = await toPng(base, EDITOR);
    } else {
      file = await toPng(working.canvas);
    }
    return {
      ...file,
      text,
      truth: {
        kind,
        note: kind === 'tampered'
          ? 'Two amounts were rewritten: “Club Sandwich” line total ₹200.00 → ₹700.00 and “GRAND TOTAL” ₹708.50 → ₹1,708.50, pasted over an already-compressed copy of the receipt and re-saved through an image editor.'
          : 'A clean, arithmetically consistent receipt with no edits.',
        regions: working.pasteOps || [],
        expectedTotal: kind === 'tampered' ? 1708.50 : 708.50,
      },
    };
  }

  /** The forged document on its own, for the text-mode sample. */
  function tamperedDoc() { return tamper(genuineDoc()); }

  RS.samples = { build, genuineDoc, tamperedDoc, docToText, injectPngText };
})(window);
