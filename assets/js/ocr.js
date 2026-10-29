
/* ==========================================================================
   ReceiptShield — ocr.js
   Stage 2: Improved OCR extraction.

   Features:
   - Contrast-enhanced image preprocessing
   - Optional adaptive image thresholding
   - Multiple OCR recognition attempts
   - Word-level confidence and bounding boxes
   - Low-confidence warnings for manual review
   - Compatible RS.ocr interface

   Exposes window.RS.ocr
   ========================================================================== */

(function (global) {
  'use strict';

  const RS = global.RS;

  if (!RS || !RS.util) {
    throw new Error(
      'ReceiptShield: RS.util must load before ocr.js'
    );
  }

  const U = RS.util;

  let workerPromise = null;
  let currentLogger = null;

  const OCR_CONFIDENCE_REVIEW_THRESHOLD = 60;

  /* ----------------------------------------------------------
     Check whether Tesseract.js is available
     ---------------------------------------------------------- */

  function available() {
    return (
      typeof global.Tesseract !== 'undefined' &&
      typeof global.Tesseract.createWorker === 'function'
    );
  }

  const PHASES = [
    [/loading tesseract core/i, 'Loading OCR engine'],
    [/initializing tesseract/i, 'Starting OCR engine'],
    [/loading language traineddata/i, 'Downloading language data'],
    [/initializing api/i, 'Initialising recogniser'],
    [/recognizing text/i, 'Reading the receipt']
  ];

  function phaseLabel(status) {
    for (const [pattern, label] of PHASES) {
      if (pattern.test(status || '')) {
        return label;
      }
    }

    return status ? String(status) : 'Working...';
  }

  /* ----------------------------------------------------------
     Create one reusable Tesseract worker
     ---------------------------------------------------------- */

  function ensureWorker() {
    if (workerPromise) {
      return workerPromise;
    }

    if (!available()) {
      return Promise.reject(
        new Error(
          'The OCR engine could not be loaded. Check your internet ' +
          'connection and the Tesseract.js script in index.html.'
        )
      );
    }

    workerPromise = (async function () {
      const worker = await global.Tesseract.createWorker(
        'eng',
        1,
        {
          logger: function (message) {
            if (currentLogger) {
              currentLogger(message);
            }
          },
          errorHandler: function (error) {
            console.error('[ReceiptShield OCR]', error);
          }
        }
      );

      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });

      return worker;
    })().catch(function (error) {
      workerPromise = null;
      throw error;
    });

    return workerPromise;
  }

  /* ----------------------------------------------------------
     Image preprocessing

     mode = "contrast": grayscale and contrast enhancement
     mode = "binary": high-contrast black-and-white image

     The original source image is never modified.
     ---------------------------------------------------------- */

  function preprocess(source, targetWidth, mode) {
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;

    if (!sw || !sh) {
      throw new Error('The image has no usable dimensions.');
    }

    const requestedWidth = targetWidth || 2000;
    const scale = U.clamp(requestedWidth / sw, 1, 3);

    const width = Math.round(sw * scale);
    const height = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext(
      '2d',
      { willReadFrequently: true }
    );

    if (!context) {
      throw new Error('Could not prepare the receipt image.');
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);

    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;

    const histogram = new Uint32Array(256);

    /* Convert pixels to grayscale. */
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = Math.round(
        pixels[i] * 0.299 +
        pixels[i + 1] * 0.587 +
        pixels[i + 2] * 0.114
      );

      pixels[i] = gray;
      pixels[i + 1] = gray;
      pixels[i + 2] = gray;

      histogram[gray]++;
    }

    const totalPixels = width * height;

    /* Find percentile limits to reduce the effect of extreme pixels. */
    let lower = 0;
    let upper = 255;
    let accumulated = 0;

    for (let value = 0; value < 256; value++) {
      accumulated += histogram[value];

      if (accumulated >= totalPixels * 0.02) {
        lower = value;
        break;
      }
    }

    accumulated = 0;

    for (let value = 255; value >= 0; value--) {
      accumulated += histogram[value];

      if (accumulated >= totalPixels * 0.02) {
        upper = value;
        break;
      }
    }

    const span = Math.max(1, upper - lower);
    const lookup = new Uint8ClampedArray(256);

    for (let value = 0; value < 256; value++) {
      lookup[value] = U.clamp(
        ((value - lower) * 255) / span,
        0,
        255
      );
    }

    /* Apply contrast enhancement. */
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = lookup[pixels[i]];

      pixels[i] = gray;
      pixels[i + 1] = gray;
      pixels[i + 2] = gray;
      pixels[i + 3] = 255;
    }

    /*
     * Optional Otsu thresholding.
     * This can help faded thermal-paper receipts, but can also
     * remove faint characters. We compare its OCR result rather
     * than assuming it is always better.
     */
    if (mode === 'binary') {
      let weightedSum = 0;

      for (let value = 0; value < 256; value++) {
        weightedSum += value * histogram[value];
      }

      let backgroundWeight = 0;
      let backgroundSum = 0;
      let bestVariance = -1;
      let threshold = 127;

      for (let value = 0; value < 256; value++) {
        backgroundWeight += histogram[value];

        if (backgroundWeight === 0) {
          continue;
        }

        const foregroundWeight =
          totalPixels - backgroundWeight;

        if (foregroundWeight === 0) {
          break;
        }

        backgroundSum += value * histogram[value];

        const backgroundMean =
          backgroundSum / backgroundWeight;

        const foregroundMean =
          (weightedSum - backgroundSum) / foregroundWeight;

        const difference = backgroundMean - foregroundMean;

        const variance =
          backgroundWeight *
          foregroundWeight *
          difference *
          difference;

        if (variance > bestVariance) {
          bestVariance = variance;
          threshold = value;
        }
      }

      for (let i = 0; i < pixels.length; i += 4) {
        const gray = pixels[i] < threshold ? 0 : 255;

        pixels[i] = gray;
        pixels[i + 1] = gray;
        pixels[i + 2] = gray;
      }
    }

    context.putImageData(image, 0, 0);

    return canvas;
  }

  /* ----------------------------------------------------------
     Convert Tesseract TSV into structured word records
     ---------------------------------------------------------- */

  function parseTsv(tsv) {
    const words = [];

    if (!tsv) {
      return words;
    }

    const rows = String(tsv).split(/\r?\n/);
    const start = rows.length && /level/.test(rows[0]) ? 1 : 0;

    for (let i = start; i < rows.length; i++) {
      const columns = rows[i].split('\t');

      if (columns.length < 12) {
        continue;
      }

      /* Level 5 means a word. */
      if (columns[0] !== '5') {
        continue;
      }

      const text = columns[11];

      if (!text || !text.trim()) {
        continue;
      }

      const confidence = Number(columns[10]);
      const left = Number(columns[6]);
      const top = Number(columns[7]);
      const width = Number(columns[8]);
      const height = Number(columns[9]);

      if (
        ![left, top, width, height].every(Number.isFinite) ||
        width < 0 ||
        height < 0
      ) {
        continue;
      }

      const blockKey = columns[2] + '-' + columns[3];
      const lineKey = blockKey + '-' + columns[4];

      words.push({
        text,
        conf:
          Number.isFinite(confidence) && confidence >= 0
            ? confidence
            : 0,
        x0: left,
        y0: top,
        x1: left + width,
        y1: top + height,
        lineKey,
        blockKey,
        index: Number(columns[5])
      });
    }

    return words;
  }

  /* ----------------------------------------------------------
     Fallback when structured word data is available
     ---------------------------------------------------------- */

  function parseStructuredWords(data) {
    if (!data || !Array.isArray(data.words)) {
      return [];
    }

    return data.words
      .filter(function (word) {
        return (
          word &&
          typeof word.text === 'string' &&
          word.text.trim() &&
          word.bbox
        );
      })
      .map(function (word, index) {
        const box = word.bbox;

        return {
          text: word.text,
          conf: Number.isFinite(word.confidence)
            ? word.confidence
            : 0,
          x0: box.x0,
          y0: box.y0,
          x1: box.x1,
          y1: box.y1,
          lineKey: word.line
            ? String(word.line)
            : 'fallback-' + index,
          blockKey: 'fallback-block-' + index,
          index
        };
      })
      .filter(function (word) {
        return [
          word.x0,
          word.y0,
          word.x1,
          word.y1
        ].every(Number.isFinite);
      });
  }

  /* ----------------------------------------------------------
     Rebuild line text using word positions
     ---------------------------------------------------------- */

  function joinWords(words) {
    let output = '';

    for (let i = 0; i < words.length; i++) {
      const word = words[i];

      if (i === 0) {
        output = word.text;
        continue;
      }

      const previous = words[i - 1];
      const gap = word.x0 - previous.x1;

      const referenceHeight = Math.max(
        1,
        U.median(
          words.map(function (item) {
            return item.y1 - item.y0;
          })
        )
      );

      const spaces =
        gap > referenceHeight * 4
          ? 3
          : gap > referenceHeight * 1.6
            ? 2
            : 1;

      output += ' '.repeat(spaces) + word.text;
    }

    return output;
  }

  /* ----------------------------------------------------------
     Group words into lines
     ---------------------------------------------------------- */

  function groupWords(words) {
    const byLine = new Map();

    words.forEach(function (word) {
      if (!byLine.has(word.lineKey)) {
        byLine.set(word.lineKey, []);
      }

      byLine.get(word.lineKey).push(word);
    });

    const lines = [];

    byLine.forEach(function (lineWords, key) {
      lineWords.sort(function (a, b) {
        return a.x0 - b.x0;
      });

      const heights = lineWords.map(function (word) {
        return word.y1 - word.y0;
      });

      const baseline = U.median(
        lineWords.map(function (word) {
          return word.y1;
        })
      );

      const x0 = Math.min.apply(
        null,
        lineWords.map(function (word) {
          return word.x0;
        })
      );

      const x1 = Math.max.apply(
        null,
        lineWords.map(function (word) {
          return word.x1;
        })
      );

      const y0 = Math.min.apply(
        null,
        lineWords.map(function (word) {
          return word.y0;
        })
      );

      const y1 = Math.max.apply(
        null,
        lineWords.map(function (word) {
          return word.y1;
        })
      );

      const gaps = [];

      for (let i = 1; i < lineWords.length; i++) {
        gaps.push(
          lineWords[i].x0 - lineWords[i - 1].x1
        );
      }

      lines.push({
        key,
        words: lineWords,
        text: joinWords(lineWords),
        x0,
        x1,
        y0,
        y1,
        height: U.median(heights),
        baseline,
        center: lineWords.reduce(function (sum, word) {
          return sum + (word.y0 + word.y1) / 2;
        }, 0) / lineWords.length,
        conf: U.mean(
          lineWords.map(function (word) {
            return word.conf;
          })
        ),
        minConf: Math.min.apply(
          null,
          lineWords.map(function (word) {
            return word.conf;
          })
        ),
        width: x1 - x0,
        gaps
      });
    });

    lines.sort(function (a, b) {
      return (a.y0 - b.y0) || (a.x0 - b.x0);
    });

    return lines;
  }

  /* ----------------------------------------------------------
     Run one recognition attempt
     ---------------------------------------------------------- */

  async function runAttempt(worker, image, pageSegmentationMode) {
    await worker.setParameters({
      tessedit_pageseg_mode: String(pageSegmentationMode),
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });

    const result = await worker.recognize(
      image,
      {},
      {
        tsv: true,
        blocks: true
      }
    );

    const data = (result && result.data) || {};

    let words = parseTsv(data.tsv);

    if (!words.length) {
      words = parseStructuredWords(data);
    }

    const confidence = words.length
      ? U.mean(
          words.map(function (word) {
            return word.conf;
          })
        )
      : 0;

    const text = String(data.text || '').trim();

    /*
     * Confidence alone is not sufficient to determine whether
     * financial values are correct. Keep all attempts available
     * for scoring and preserve the original recognized text.
     */
    return {
      data,
      words,
      text,
      confidence,
      pageSegmentationMode
    };
  }

  /* ----------------------------------------------------------
     Score OCR attempts

     This score helps choose an attempt. It does not prove that
     the extracted amounts or tax rates are correct.
     ---------------------------------------------------------- */

  function scoreAttempt(attempt) {
    const text = attempt.text || '';
    const words = attempt.words || [];

    if (!words.length || !text.trim()) {
      return -1;
    }

    const confidentWords = words.filter(function (word) {
      return word.conf >= 40;
    }).length;

    const wordCoverage = confidentWords / words.length;

    const financialLabels = [
      /subtotal/i,
      /taxable/i,
      /grand\s*total/i,
      /discount/i,
      /sgst/i,
      /cgst/i,
      /gst/i
    ];

    let labelCount = 0;

    financialLabels.forEach(function (pattern) {
      if (pattern.test(text)) {
        labelCount++;
      }
    });

    return (
      attempt.confidence * 0.65 +
      wordCoverage * 25 +
      labelCount * 1.5
    );
  }

  /* ----------------------------------------------------------
     Recognize a receipt

     Attempts:
     1. Contrast-enhanced image, PSM 6
     2. Contrast-enhanced image, PSM 11
     3. Thresholded image, PSM 6

     The best-scoring attempt is returned. Always inspect the
     resulting financial values before trusting a fraud score.
     ---------------------------------------------------------- */

  async function recognize(source, onProgress) {
    const sourceWidth =
      source.width || source.naturalWidth;

    const sourceHeight =
      source.height || source.naturalHeight;

    if (!sourceWidth || !sourceHeight) {
      throw new Error(
        'The image has no usable dimensions.'
      );
    }

    const worker = await ensureWorker();

    currentLogger = function (message) {
      if (!onProgress) {
        return;
      }

      onProgress({
        phase: phaseLabel(message.status),
        progress:
          typeof message.progress === 'number'
            ? message.progress
            : 0,
        raw: message.status
      });
    };

    let attempts = [];
    let selected = null;

    try {
      const contrastImage = preprocess(
        source,
        2000,
        'contrast'
      );

      const binaryImage = preprocess(
        source,
        2000,
        'binary'
      );

      const configurations = [
        {
          image: contrastImage,
          psm: 6,
          label: 'contrast-psm6'
        },
        {
          image: contrastImage,
          psm: 11,
          label: 'contrast-psm11'
        },
        {
          image: binaryImage,
          psm: 6,
          label: 'binary-psm6'
        }
      ];

      for (let i = 0; i < configurations.length; i++) {
        const configuration = configurations[i];

        if (onProgress) {
          onProgress({
            phase:
              'Reading receipt (attempt ' +
              (i + 1) +
              ' of ' +
              configurations.length +
              ')',
            progress: i / configurations.length,
            raw: configuration.label
          });
        }

        const attempt = await runAttempt(
          worker,
          configuration.image,
          configuration.psm
        );

        attempt.label = configuration.label;
        attempt.score = scoreAttempt(attempt);

        attempts.push(attempt);
      }

      selected = attempts.reduce(function (best, attempt) {
        if (!best || attempt.score > best.score) {
          return attempt;
        }

        return best;
      }, null);

      if (!selected || !selected.words.length) {
        throw new Error(
          'No readable text was detected. Try a clearer, ' +
          'well-lit image with the full receipt visible.'
        );
      }
    } finally {
      currentLogger = null;

      /*
       * Restore the standard page segmentation mode for any
       * subsequent call using the shared worker.
       */
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
          user_defined_dpi: '300'
        });
      } catch (error) {
        console.warn(
          '[ReceiptShield OCR] Could not restore OCR parameters.',
          error
        );
      }
    }

    const scale = Math.min(
      3,
      Math.max(1, 2000 / sourceWidth)
    );

    const words = selected.words.map(function (word) {
      return {
        ...word,
        x0: word.x0 / scale,
        x1: word.x1 / scale,
        y0: word.y0 / scale,
        y1: word.y1 / scale
      };
    });

    const lines = groupWords(words);

    const text = (
      selected.text ||
      lines.map(function (line) {
        return line.text;
      }).join('\n')
    ).replace(/[ \t]+$/gm, '');

    const confidence = words.length
      ? U.mean(
          words.map(function (word) {
            return word.conf;
          })
        )
      : 0;

    const lowConfidence =
      confidence < OCR_CONFIDENCE_REVIEW_THRESHOLD;

    const result = {
      text,
      words,
      lines,
      width: sourceWidth,
      height: sourceHeight,
      conf: confidence,
      scale,
      empty: !words.length,

      /* New diagnostic fields; existing fields remain available. */
      needsReview: lowConfidence,
      reviewReasons: lowConfidence
        ? [
            'OCR confidence is low. Verify extracted prices, tax rates, and totals manually.'
          ]
        : [],
      selectedAttempt: selected.label,
      attemptSummary: attempts.map(function (attempt) {
        return {
          label: attempt.label,
          confidence: attempt.confidence,
          score: attempt.score,
          wordCount: attempt.words.length
        };
      })
    };

    if (onProgress) {
      onProgress({
        phase: lowConfidence
          ? 'OCR complete — manual review recommended'
          : 'OCR complete',
        progress: 1,
        raw: selected.label
      });
    }

    return result;
  }

  /* ----------------------------------------------------------
     Terminate the reusable worker
     ---------------------------------------------------------- */

  async function terminate() {
    if (!workerPromise) {
      return;
    }

    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch (error) {
      console.warn(
        '[ReceiptShield OCR] Worker cleanup failed.',
        error
      );
    }

    workerPromise = null;
  }

  /* Preserve the interface used by the rest of ReceiptShield. */
  RS.ocr = {
    available,
    recognize,
    ensureWorker,
    terminate,
    preprocess
  };

})(window);
