/**
 * OMR (Optical Mark Recognition) processing for AutoKorek
 * Uses OpenCV.js (loaded globally as `cv`) to detect and read answer bubbles
 * from a photographed answer sheet.
 */

import { getBubblePositions, SHEET_TEMPLATE } from './template.js';

// ---------------------------------------------------------------------------
// Maximum width used when down-scaling large images for processing
// ---------------------------------------------------------------------------
const MAX_PROCESSING_WIDTH = 1200;

// Fill-ratio threshold: a bubble is considered "filled" when the ratio of
// dark pixels to total pixels in its ROI exceeds this value.
const FILL_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// OpenCV readiness helpers
// ---------------------------------------------------------------------------

/**
 * Check if OpenCV.js is ready
 * @returns {boolean}
 */
export function isOpenCVReady() {
  return typeof cv !== 'undefined' && cv.Mat !== undefined;
}

/**
 * Wait for OpenCV.js to be ready
 * @returns {Promise<void>}
 */
export function waitForOpenCV() {
  return new Promise((resolve, reject) => {
    if (isOpenCVReady()) {
      resolve();
      return;
    }
    let elapsed = 0;
    const interval = setInterval(() => {
      if (isOpenCVReady()) {
        clearInterval(interval);
        resolve();
      }
      elapsed += 100;
      if (elapsed > 30000) {
        clearInterval(interval);
        reject(new Error('OpenCV.js load timeout (30 s)'));
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Full OMR processing pipeline
 * @param {HTMLCanvasElement} canvasElement - Canvas with the captured image
 * @returns {Object} { answers: [{number, selected}], confidence: number, debugInfo: {} }
 */
export function processAnswerSheet(canvasElement) {
  console.log('[OMR] Starting answer-sheet processing pipeline');
  let src = null;
  let gray = null;
  let downscaled = null;
  let warped = null;

  try {
    // 1. Read image from canvas
    src = cv.imread(canvasElement);
    console.log('[OMR] Image read from canvas:', src.cols, '×', src.rows);

    // 2. Downscale if necessary
    downscaled = _maybeDownscale(src);

    // 3. Convert to grayscale for detection
    gray = new cv.Mat();
    cv.cvtColor(downscaled, gray, cv.COLOR_RGBA2GRAY);

    // 4. Attempt document detection
    const corners = detectDocument(gray);

    if (corners) {
      console.log('[OMR] Document boundary detected – applying perspective correction');
      warped = perspectiveCorrect(downscaled, corners);
    } else {
      console.log('[OMR] No document boundary found – using raw image');
      warped = downscaled.clone();
    }

    // 5 & 6. Read bubbles from the (optionally warped) image
    const bubbleReadings = readBubbles(warped);

    // 7. Map to answers
    const answers = mapToAnswers(bubbleReadings);

    // Calculate an overall confidence score:
    // – filled bubbles far above threshold → high confidence
    // – readings near the threshold → low confidence
    const confidence = _computeConfidence(bubbleReadings);

    console.log('[OMR] Pipeline complete – confidence:', confidence.toFixed(2));

    return {
      answers,
      confidence,
      debugInfo: {
        documentDetected: corners !== null,
        imageSize: { width: downscaled.cols, height: downscaled.rows },
        warpedSize: warped ? { width: warped.cols, height: warped.rows } : null,
        totalBubbles: bubbleReadings.length,
        filledBubbles: bubbleReadings.filter((b) => b.isFilled).length,
      },
    };
  } finally {
    _safeDelete(src);
    _safeDelete(gray);
    _safeDelete(downscaled);
    _safeDelete(warped);
  }
}

// ---------------------------------------------------------------------------
// Document detection
// ---------------------------------------------------------------------------

/**
 * Detect document boundary in the image
 * @param {cv.Mat} gray - Grayscale image
 * @returns {Array|null} 4 corner points [{x,y},...] ordered TL, TR, BR, BL or null
 */
export function detectDocument(gray) {
  console.log('[OMR] Detecting document boundary');

  let blurred = null;
  let edges = null;
  let dilated = null;
  let contours = null;
  let hierarchy = null;
  let kernel = null;

  try {
    // 1. Gaussian blur
    blurred = new cv.Mat();
    const ksize = new cv.Size(5, 5);
    cv.GaussianBlur(gray, blurred, ksize, 0);

    // 2. Canny edge detection
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 200);

    // 3. Dilate to connect nearby edges
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel);

    // 4. Find contours
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = gray.rows * gray.cols;
    const minArea = imageArea * 0.1;

    // 5. Collect contour areas and sort descending
    const contourData = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      contourData.push({ index: i, area });
      cnt.delete();
    }
    contourData.sort((a, b) => b.area - a.area);

    // 6. Look for a quadrilateral among the largest contours
    for (const { index, area } of contourData) {
      if (area < minArea) break; // remaining are even smaller

      const cnt = contours.get(index);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();

      try {
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4) {
          const points = [];
          for (let j = 0; j < 4; j++) {
            points.push({
              x: approx.data32S[j * 2],
              y: approx.data32S[j * 2 + 1],
            });
          }
          const ordered = orderPoints(points);
          console.log('[OMR] Found document quadrilateral with area', area);
          return ordered;
        }
      } finally {
        cnt.delete();
        approx.delete();
      }
    }

    console.log('[OMR] No suitable document quadrilateral found');
    return null;
  } finally {
    _safeDelete(blurred);
    _safeDelete(edges);
    _safeDelete(dilated);
    _safeDelete(kernel);
    _safeDelete(hierarchy);
    if (contours) {
      contours.delete();
    }
  }
}

// ---------------------------------------------------------------------------
// Point ordering
// ---------------------------------------------------------------------------

/**
 * Order 4 points in: top-left, top-right, bottom-right, bottom-left order
 * @param {Array} points - Array of {x, y} objects (length 4)
 * @returns {Array} Ordered points [TL, TR, BR, BL]
 */
function orderPoints(points) {
  // Sum = x + y  → smallest sum → top-left, largest sum → bottom-right
  // Diff = y - x → smallest diff → top-right, largest diff → bottom-left
  const sorted = [...points];

  const sums = sorted.map((p) => p.x + p.y);
  const diffs = sorted.map((p) => p.y - p.x);

  const tlIdx = sums.indexOf(Math.min(...sums));
  const brIdx = sums.indexOf(Math.max(...sums));
  const trIdx = diffs.indexOf(Math.min(...diffs));
  const blIdx = diffs.indexOf(Math.max(...diffs));

  return [sorted[tlIdx], sorted[trIdx], sorted[brIdx], sorted[blIdx]];
}

// ---------------------------------------------------------------------------
// Perspective correction
// ---------------------------------------------------------------------------

/**
 * Apply perspective correction
 * @param {cv.Mat} src - Source image
 * @param {Array} corners - 4 corner points [{x,y},...] in order: TL, TR, BR, BL
 * @returns {cv.Mat} Warped top-down view (caller must delete!)
 */
export function perspectiveCorrect(src, corners) {
  console.log('[OMR] Applying perspective correction');

  let srcMat = null;
  let dstMat = null;
  let M = null;
  let warped = null;

  try {
    const [tl, tr, br, bl] = corners;

    // Calculate output width (max of top edge and bottom edge)
    const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
    const outWidth = Math.round(Math.max(widthTop, widthBottom));

    // Calculate output height (max of left edge and right edge)
    const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
    const outHeight = Math.round(Math.max(heightLeft, heightRight));

    // Source points
    srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y,
      tr.x, tr.y,
      br.x, br.y,
      bl.x, bl.y,
    ]);

    // Destination points (rectangle)
    dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      outWidth - 1, 0,
      outWidth - 1, outHeight - 1,
      0, outHeight - 1,
    ]);

    M = cv.getPerspectiveTransform(srcMat, dstMat);
    warped = new cv.Mat();
    const dsize = new cv.Size(outWidth, outHeight);
    cv.warpPerspective(src, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    console.log('[OMR] Perspective corrected to', outWidth, '×', outHeight);

    // We need to return warped, so we clone it and let finally clean up all temps
    const result = warped.clone();
    return result;
  } finally {
    _safeDelete(srcMat);
    _safeDelete(dstMat);
    _safeDelete(M);
    _safeDelete(warped);
  }
}

// ---------------------------------------------------------------------------
// Bubble reading
// ---------------------------------------------------------------------------

/**
 * Read bubble fill levels from the perspective-corrected image
 * @param {cv.Mat} warped - Perspective-corrected image (can be color or grayscale)
 * @returns {Array} Array of {questionNumber, option, fillRatio, isFilled}
 */
export function readBubbles(warped) {
  console.log('[OMR] Reading bubbles');

  let gray = null;
  let thresh = null;

  try {
    // 1. Convert to grayscale if needed
    if (warped.channels() > 1) {
      gray = new cv.Mat();
      cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
    } else {
      gray = warped.clone();
    }

    // 2. Adaptive threshold (inverted so filled bubbles are white)
    thresh = new cv.Mat();
    cv.adaptiveThreshold(
      gray,
      thresh,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      11, // block size
      2   // C constant
    );

    // 3. Get bubble positions for this image size
    const positions = getBubblePositions(warped.cols, warped.rows);
    console.log('[OMR] Template provides', positions.length, 'bubble positions');

    // 4. Sample each bubble ROI
    const results = [];
    for (const pos of positions) {
      // Clamp ROI to image bounds
      const x = Math.max(0, Math.round(pos.x));
      const y = Math.max(0, Math.round(pos.y));
      const w = Math.min(Math.round(pos.width), thresh.cols - x);
      const h = Math.min(Math.round(pos.height), thresh.rows - y);

      if (w <= 0 || h <= 0) {
        results.push({
          questionNumber: pos.questionNumber,
          option: pos.option,
          fillRatio: 0,
          isFilled: false,
        });
        continue;
      }

      const roi = thresh.roi(new cv.Rect(x, y, w, h));
      try {
        const totalPixels = w * h;
        const nonZero = cv.countNonZero(roi);
        const fillRatio = nonZero / totalPixels;

        results.push({
          questionNumber: pos.questionNumber,
          option: pos.option,
          fillRatio,
          isFilled: fillRatio > FILL_THRESHOLD,
        });
      } finally {
        roi.delete();
      }
    }

    console.log(
      '[OMR] Bubble reading complete –',
      results.filter((r) => r.isFilled).length,
      'filled out of',
      results.length
    );
    return results;
  } finally {
    _safeDelete(gray);
    _safeDelete(thresh);
  }
}

// ---------------------------------------------------------------------------
// Answer mapping
// ---------------------------------------------------------------------------

/**
 * Convert bubble readings to answer selections
 * @param {Array} bubbleReadings - From readBubbles()
 * @returns {Array} Array of {number, selected: ['A','C',...]} for each question 1-30
 */
export function mapToAnswers(bubbleReadings) {
  // Group by question number
  const groups = {};
  for (const reading of bubbleReadings) {
    const q = reading.questionNumber;
    if (!groups[q]) {
      groups[q] = [];
    }
    groups[q].push(reading);
  }

  // Build answer list for questions 1–30
  const totalQuestions = 30;
  const answers = [];

  for (let q = 1; q <= totalQuestions; q++) {
    const bubbles = groups[q] || [];
    const selected = bubbles.filter((b) => b.isFilled).map((b) => b.option);

    answers.push({
      number: q,
      selected,
    });
  }

  console.log('[OMR] Mapped answers for', answers.length, 'questions');
  return answers;
}

// ---------------------------------------------------------------------------
// Manual-corner fallback
// ---------------------------------------------------------------------------

/**
 * Process with manual corner selection (fallback when auto-detect fails)
 * @param {HTMLCanvasElement} canvasElement
 * @param {Array} manualCorners - 4 corner points [{x,y},...] selected by user
 * @returns {Object} Same format as processAnswerSheet
 */
export function processWithManualCorners(canvasElement, manualCorners) {
  console.log('[OMR] Processing with manual corners');

  if (!manualCorners || manualCorners.length !== 4) {
    throw new Error('Exactly 4 corner points are required');
  }

  let src = null;
  let downscaled = null;
  let warped = null;

  try {
    src = cv.imread(canvasElement);
    downscaled = _maybeDownscale(src);

    // Scale manual corners if image was downscaled
    const scaleX = downscaled.cols / src.cols;
    const scaleY = downscaled.rows / src.rows;
    const scaledCorners = manualCorners.map((c) => ({
      x: Math.round(c.x * scaleX),
      y: Math.round(c.y * scaleY),
    }));

    const ordered = orderPoints(scaledCorners);
    warped = perspectiveCorrect(downscaled, ordered);

    const bubbleReadings = readBubbles(warped);
    const answers = mapToAnswers(bubbleReadings);
    const confidence = _computeConfidence(bubbleReadings);

    console.log('[OMR] Manual-corner pipeline complete – confidence:', confidence.toFixed(2));

    return {
      answers,
      confidence,
      debugInfo: {
        documentDetected: true,
        manualCorners: true,
        imageSize: { width: downscaled.cols, height: downscaled.rows },
        warpedSize: { width: warped.cols, height: warped.rows },
        totalBubbles: bubbleReadings.length,
        filledBubbles: bubbleReadings.filter((b) => b.isFilled).length,
      },
    };
  } finally {
    _safeDelete(src);
    _safeDelete(downscaled);
    _safeDelete(warped);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Downscale a cv.Mat if its width exceeds MAX_PROCESSING_WIDTH.
 * Returns a new Mat (caller must delete) or a clone if no scaling needed.
 * @param {cv.Mat} src
 * @returns {cv.Mat}
 */
function _maybeDownscale(src) {
  if (src.cols <= MAX_PROCESSING_WIDTH) {
    return src.clone();
  }

  const scale = MAX_PROCESSING_WIDTH / src.cols;
  const newWidth = MAX_PROCESSING_WIDTH;
  const newHeight = Math.round(src.rows * scale);

  const dst = new cv.Mat();
  const dsize = new cv.Size(newWidth, newHeight);
  cv.resize(src, dst, dsize, 0, 0, cv.INTER_AREA);

  console.log('[OMR] Downscaled from', src.cols, '×', src.rows, 'to', newWidth, '×', newHeight);
  return dst;
}

/**
 * Compute an overall confidence score from bubble readings.
 * Bubbles with fill ratios far from the threshold contribute positively;
 * ambiguous readings (near the threshold) lower confidence.
 * @param {Array} readings
 * @returns {number} 0–1
 */
function _computeConfidence(readings) {
  if (readings.length === 0) return 0;

  let totalClarity = 0;
  for (const r of readings) {
    // Distance from the decision boundary (FILL_THRESHOLD)
    const distance = Math.abs(r.fillRatio - FILL_THRESHOLD);
    // Normalise so that 0.35 distance → 1.0 clarity
    const clarity = Math.min(distance / FILL_THRESHOLD, 1.0);
    totalClarity += clarity;
  }

  return totalClarity / readings.length;
}

/**
 * Safely delete an OpenCV Mat / MatVector if it exists.
 * @param {cv.Mat|cv.MatVector|null} mat
 */
function _safeDelete(mat) {
  if (mat && !mat.isDeleted()) {
    mat.delete();
  }
}
