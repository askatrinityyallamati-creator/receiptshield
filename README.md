# ReceiptShield

**AI-based receipt fraud & tampering detection.** ReceiptShield reads a digital
receipt or bill and checks whether it may have been altered — and whether its
information is mathematically and logically consistent.

Everything runs in the browser. No server, no account, no API key, and the
receipt never leaves the device.

```
Receipt Upload → OCR Extraction → Item/Price/Tax Detection → Mathematical Validation
   → Visual Tampering Analysis → Suspicious Information Detection → Fraud Risk Report
```

Open `index.html` through a local server and you get a landing page plus a
working detector.

---

## Run it

```bash
npm start          # http://127.0.0.1:4177
# or, without Node:
python -m http.server 4177 --bind 127.0.0.1
```

Then open <http://127.0.0.1:4177/>.

Serve it over HTTP rather than opening the file directly: the OCR engine runs
in a web worker and downloads its language model on first use, and browsers
treat `file://` workers differently.

The OCR engine (~4 MB of WebAssembly plus the English model) is fetched from
jsDelivr on first analysis and then cached by the browser. If it cannot be
reached, the page says so and **Paste text** mode still exercises stages 3, 4, 6
and 7.

---

## Try it in ten seconds

The detector ships two synthetic receipts it generates on demand, so the demo
works offline and with no personal data:

| Button | What it is |
| --- | --- |
| **Load genuine sample** | A clean, arithmetically consistent receipt. Scores **0 / 100**. |
| **Load tampered sample** | The same receipt with two amounts rewritten. Scores **100 / 100**. |

The tampered sample is built the way a real forgery happens. The receipt is
first encoded as a heavily compressed JPEG, as if it had been forwarded over a
messaging app. The two forged figures are then pasted on top from a separately
saved snippet, in a different typeface, on a background patch lifted from
another image, nudged off the value column — and the result is re-saved through
an image editor that stamps its name into the file.

Each fraud leaves four independent traces, and ReceiptShield finds all four:

| Traces left by the forgery | Stage that catches it |
| --- | --- |
| `₹200.00 → ₹700.00` breaks qty × unit and the item sum | Mathematical Validation |
| `₹708.50 → ₹1,708.50` breaks net + tax + rounding | Mathematical Validation |
| The gap is an exactly round `₹1,000.00` | Suspicious Information Detection |
| Pasted glyphs are bigger, wider and 8 px off the column | Visual Tampering Analysis (typography) |
| The patch's paper tone is 7 luminance levels darker | Visual Tampering Analysis (tone) |
| The pasted region has a different compression history | Visual Tampering Analysis (error level) |
| The file names `Adobe Photoshop 24.0` | Visual Tampering Analysis (container) |

The genuine sample produces **zero** regions and **zero** findings above
informational, which is the number that actually matters. See
*Verification* below.

---

## The seven stages

### 1 · Receipt Upload
The image is decoded to a canvas at natural resolution, checked for a usable
size, and kept local. The original pixels are never pre-processed — only OCR
gets a cleaned copy, because the forensic stages must analyse what the user
actually has. The raw file bytes are retained separately for the container
check.

### 2 · OCR Extraction
Tesseract.js runs in a web worker. The OCR input is upscaled toward 2000 px and
given a grayscale percentile contrast stretch, both of which measurably improve
recognition on low-contrast scans. Tesseract returns word-level TSV, which is
parsed into words carrying a bounding box, a baseline and a confidence, then
grouped into lines and blocks with per-line typographic metrics.

### 3 · Item / Price / Tax Detection
Lines are classified as items, discounts, taxes, totals, payment rows or
metadata. Three things make the amount scanner reliable:

- **Dates and times are masked first**, so `12/03/2026` and `19:42` cannot be
  read as money.
- **Boundary tests** reject digits welded to letters, so `GSTIN
  27AABCU9603R1ZM` and `INV-2291` yield nothing.
- **Length rules**: without a currency symbol, decimal point or digit grouping,
  a 1–3 digit integer is a quantity and a 6+ digit integer is an identifier.
  On a row already identified as a money row (`Subtotal`, `GST`, `Total`) a
  bare integer is accepted, because `Subtotal 710` is perfectly normal print.

`35:5` is repaired to `35.5` — the classic OCR colon-for-decimal confusion.

### 4 · Mathematical Validation
Every equation the document asserts is recomputed from the document's own
figures and compared with the printed answer. Tolerance is scaled: two paise per
line for rounding noise, 0.2 % for sums of many lines.

- `qty × unit = line total` on every line
- `Σ line totals = subtotal`
- `subtotal − discount = taxable value`
- `net + tax + rounding = grand total`
- each tax line's own percentage applied to the net amount
- the rounding adjustment is within ±0.50
- payment covers the total; change equals paid − total
- no line carries a non-positive amount

A failing check is not just a flag: it reports the printed value, the
recomputed value, the delta and the tolerance used.

### 5 · Visual Tampering Analysis
Four independent passes over the pixels:

**Error-level analysis.** The image is re-compressed at JPEG quality 0.70 and
each pixel's change is measured. A region pasted after the original was saved
has a different compression history, so it moves differently. The critical
detail is the comparison *baseline*: error level rises with how much ink is in a
cell, so **a cell is only ever compared with cells carrying a similar amount of
ink**, in four bands (blank paper, light text, moderate text, dense text). The
grid is snapped to the 8×8 JPEG block lattice so cells straddling block
boundaries cannot inherit spurious residue.

Without that conditioning, ordinary text looks anomalous next to blank paper and
*every* receipt reads as tampered — the single most common way ELA produces
nonsense. With it, the clean sample produces exactly zero flagged cells.

**Paper-tone mapping.** Blank pixels are found per 14 px cell by variance, the
sheet's baseline tone is the median of them, and contiguous patches deviating
from it are reported with their measured luminance delta. A paste almost always
carries a slightly different white.

**Typography forensics.** Quantities and prices are compared on glyph height,
character width and right-edge alignment. Amounts are first clustered into
columns by right edge, so the unit-price column is never compared against the
total column. A figure is only accused when *two* weak signals agree or one
strong signal fires, because OCR word boxes wobble a few pixels horizontally and
glyph height is the only fully reliable measurement.

**Container check.** JPEG APP segments and PNG text chunks are scanned for
image-editor signatures (`CreatorTool`, `Software`, and 20+ product names).

### 6 · Suspicious Information Detection
Anomalies that are neither pure arithmetic nor pure pixels:

- repeated identical line items, or one description at two different prices
- a multi-item retail receipt with no tax line at all
- tax rows with no percentage, so the rate cannot be verified
- no invoice number *and* no date
- **a discrepancy that is an exactly round amount** — rounding and tax produce
  fractional differences; a person typing an edit produces `₹1,000.00`
- **a discrepancy equal to exactly one line item** — the signature of a line
  being added, doubled or retyped
- a grand total smaller than one of its own line items

### 7 · Fraud Risk Report
Findings are weighted by severity — critical 34, high 22, medium 12, low 5 —
summed into a 0–100 score and banded:

| Score | Band |
| --- | --- |
| 0–19 | Low risk |
| 20–44 | Elevated risk |
| 45–69 | Suspicious |
| 70–100 | High risk |

The report then shows every finding with the evidence behind it, the extracted
fields, the full arithmetic reconciliation, the flagged regions drawn on the
image, and a machine-readable JSON payload you can download.

---

## Verification

Both samples were run end to end through the real UI (OCR included) at
900 × 906 px:

| | Genuine | Tampered |
| --- | --- | --- |
| OCR confidence | 94 % | 94 % |
| Line items extracted | 4 / 4 | 4 / 4 |
| Mathematical validation | **0 failures** | 2 critical + 2 high failures |
| Error-level analysis | pass — 0 cells flagged in any ink band | fail — 11 + 5 cells flagged |
| Paper-tone consistency | pass — one tone, ± 0.01 | fail — 3 patches, −7.4 luminance |
| Amount typography | pass — 0 outliers of 15 amounts | fail — exactly `700.00` and `1708.50` |
| Container metadata | pass | fail — `Adobe Photoshop 24.0 (Windows)` |
| Suspicious information | pass | 1 high signal |
| Suspicious regions | **0** | **6** |
| Findings above informational | **0** | 9 (2 critical, 5 high, 2 medium) |
| **Risk score** | **0 / 100 — Low risk** | **100 / 100 — High risk** |

The typography stage flags exactly the two forged amounts and nothing else.
Earlier iterations flagged the unit-price column, a postal code and one
clean amount; those are the false positives the column clustering, the
parser-authoritative source set and the two-signal rule were added to remove.

---

## What this can and cannot claim

ReceiptShield is a **triage** tool. A flagged receipt is a reason to look closer,
not a finding of fraud. Compression, scanning, glare and phone cameras all
produce artefacts that resemble tampering.

**Strongest at:** edited amounts that break the arithmetic; text pasted from
another font; patches whose background tone does not match; files re-saved by an
image editor.

**Blind to:** a forger who retypes the whole receipt in one font, keeps the
arithmetic consistent and exports a clean PNG. Very low-resolution or heavily
compressed receipts defeat the pixel-level stages.

The two synthetic samples are built to be *demonstrative*, not adversarial. They
show each detector working on a trace it is designed for; they are not a
benchmark, and a passing score on them is not evidence of real-world accuracy.

---

## Project layout

```
index.html               landing page + detector UI
assets/css/styles.css    all styling
assets/js/util.js        DOM, currency parsing, robust statistics, geometry
assets/js/samples.js     synthetic genuine/tampered receipts (PNG, editor tEXt chunk)
assets/js/ocr.js         Tesseract worker, preprocessing, TSV → words/lines
assets/js/parse.js       line classification, item/tax/total extraction
assets/js/validate.js    mathematical validation engine
assets/js/visual.js      ELA, paper-tone mapping, typography, container checks
assets/js/report.js      suspicious-information detection, scoring, assembly
assets/js/app.js         pipeline orchestration and report rendering
tools/serve.js           dependency-free static server
```

Each `assets/js/*.js` file exposes one namespace on `window.RS`, loaded as a
plain script, so the site runs with no build step and no toolchain.

### JSON report
The **JSON** tab (and the download button) emits the same object the UI
renders: `risk`, `verdict`, `summary`, `receipt` (items, taxes, totals with
per-item OCR confidence), `math.checks`, `visual.regions` and `findings`, each
finding carrying its severity, stage and a `region` index pointing into
`visual.regions`.

---

## Extending it

- **Swap in server-side OCR.** `RS.ocr.recognize()` is the only place Tesseract
  is touched. Returning `{text, words, lines, width, height, conf}` from a
  different engine (Textract, Document AI, Mindee) drops straight in and keeps
  `words[].x0/x1/y0/y1` live for the typography stage.
- **Add detectors** by pushing `{stage, id, severity, title, detail, evidence}`
  into the findings array before scoring in `report.js`.
- **Tune thresholds** — every tolerance is a named constant (`lineTol`,
  `sumTol` in `validate.js`; the ink bands, cluster tolerance and two-signal rule
  in `visual.js`).
