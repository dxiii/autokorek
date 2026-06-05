/**
 * @module template
 * @description Answer sheet template definition for the AutoKorek application.
 *
 * The answer sheet layout consists of 30 multiple-choice questions arranged in
 * three columns:
 *
 * | Column 1 (Q 1–10)  | Column 2 (Q 11–20)        | Column 3 (Q 21–30) |
 * |---------------------|---------------------------|---------------------|
 * | PG – options A-D    | Q11-15 PG A-D             | PGK – options A-E   |
 * |                     | Q16-20 PGK A-E            |                     |
 *
 * All coordinate values are expressed as ratios (0–1) relative to either the
 * full document or the answer area, as noted.
 */

/**
 * The template object defining relative positions of answer bubbles on the
 * sheet. All positions are ratios (0–1) relative to the answer area
 * dimensions unless otherwise noted.
 *
 * @type {Object}
 */
export const SHEET_TEMPLATE = {
  /**
   * The answer grid area relative to the full document dimensions.
   * Values are ratios of the full image width / height.
   */
  answerArea: { top: 0.40, bottom: 0.83, left: 0.03, right: 0.76 },

  /**
   * Column definitions. Each column specifies which questions it contains,
   * the available options, and its horizontal extent within the answer area.
   */
  columns: [
    {
      // Column 1: Questions 1–10 (Pilihan Ganda, 4 options)
      startQuestion: 1,
      endQuestion: 10,
      options: ['A', 'B', 'C', 'D'],
      left: 0.0,
      right: 0.33,
    },
    {
      // Column 2: Questions 11–20
      // Q11-15 are PG (4 options), Q16-20 are PGK (5 options)
      startQuestion: 11,
      endQuestion: 20,
      optionsByQuestion: {
        default: ['A', 'B', 'C', 'D', 'E'],
        11: ['A', 'B', 'C', 'D'],
        12: ['A', 'B', 'C', 'D'],
        13: ['A', 'B', 'C', 'D'],
        14: ['A', 'B', 'C', 'D'],
        15: ['A', 'B', 'C', 'D'],
      },
      left: 0.33,
      right: 0.66,
    },
    {
      // Column 3: Questions 21–30 (PGK, 5 options)
      startQuestion: 21,
      endQuestion: 30,
      options: ['A', 'B', 'C', 'D', 'E'],
      left: 0.66,
      right: 1.0,
    },
  ],

  /** Bubble width relative to column width. */
  bubbleRelativeWidth: 0.12,

  /** Bubble height relative to row height. */
  bubbleRelativeHeight: 0.08,

  /** Horizontal padding at the start of each column (space for question numbers). */
  columnPaddingLeft: 0.15,

  /** Horizontal padding at the end of each column. */
  columnPaddingRight: 0.05,

  /** Vertical padding at the top of the question rows. */
  rowPaddingTop: 0.02,

  /** Vertical padding at the bottom of the question rows. */
  rowPaddingBottom: 0.02,
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get the question type based on question number.
 *
 * - Questions 1–15  → `'pg'`  (Pilihan Ganda)
 * - Questions 16–30 → `'pgk'` (Pilihan Ganda Kompleks)
 * - Questions 31+   → `'uraian'`
 *
 * @param {number} questionNumber - 1-based question number.
 * @returns {'pg'|'pgk'|'uraian'} The question type.
 */
export function getQuestionType(questionNumber) {
  if (questionNumber >= 1 && questionNumber <= 15) return 'pg';
  if (questionNumber >= 16 && questionNumber <= 30) return 'pgk';
  return 'uraian';
}

/**
 * Get the available options for a specific question number.
 *
 * @param {number} questionNumber - 1-based question number.
 * @returns {string[]} Array of option labels (e.g. `['A','B','C','D']`).
 *   Returns an empty array for uraian questions (31+).
 */
export function getOptionsForQuestion(questionNumber) {
  for (const col of SHEET_TEMPLATE.columns) {
    if (questionNumber >= col.startQuestion && questionNumber <= col.endQuestion) {
      // If the column uses per-question option maps
      if (col.optionsByQuestion) {
        return col.optionsByQuestion[questionNumber] || col.optionsByQuestion.default || [];
      }
      return col.options || [];
    }
  }
  // Question is outside the bubble grid (e.g. uraian)
  return [];
}

/**
 * Calculate the pixel positions of every bubble on the answer sheet given the
 * warped (perspective-corrected) image dimensions.
 *
 * @param {number} imageWidth  - Width of the warped image in pixels.
 * @param {number} imageHeight - Height of the warped image in pixels.
 * @returns {{ questionNumber: number, option: string, x: number, y: number, width: number, height: number }[]}
 *   Array of bubble descriptors with pixel coordinates.
 */
export function getBubblePositions(imageWidth, imageHeight) {
  const { answerArea, columns } = SHEET_TEMPLATE;

  // Absolute pixel bounds of the answer area
  const areaLeft   = answerArea.left   * imageWidth;
  const areaRight  = answerArea.right  * imageWidth;
  const areaTop    = answerArea.top    * imageHeight;
  const areaBottom = answerArea.bottom * imageHeight;
  const areaWidth  = areaRight - areaLeft;
  const areaHeight = areaBottom - areaTop;

  const bubbles = [];

  for (const col of columns) {
    const questionCount = col.endQuestion - col.startQuestion + 1;

    // Column pixel bounds (relative to answer area)
    const colPixelLeft  = areaLeft + col.left  * areaWidth;
    const colPixelRight = areaLeft + col.right * areaWidth;
    const colWidth      = colPixelRight - colPixelLeft;

    // Usable width for bubbles (excluding question-number label area)
    const bubbleAreaLeft  = colPixelLeft + SHEET_TEMPLATE.columnPaddingLeft * colWidth;
    const bubbleAreaRight = colPixelRight - SHEET_TEMPLATE.columnPaddingRight * colWidth;
    const bubbleAreaWidth = bubbleAreaRight - bubbleAreaLeft;

    // Row height with padding
    const rowHeight = areaHeight / questionCount;
    const paddedRowTop    = SHEET_TEMPLATE.rowPaddingTop * rowHeight;
    const paddedRowBottom = SHEET_TEMPLATE.rowPaddingBottom * rowHeight;
    const usableRowHeight = rowHeight - paddedRowTop - paddedRowBottom;

    for (let q = col.startQuestion; q <= col.endQuestion; q++) {
      const rowIndex = q - col.startQuestion;
      const options = getOptionsForQuestion(q);
      const optionCount = options.length;

      if (optionCount === 0) continue;

      // Bubble dimensions
      const bubbleWidth  = SHEET_TEMPLATE.bubbleRelativeWidth * colWidth;
      const bubbleHeight = SHEET_TEMPLATE.bubbleRelativeHeight * usableRowHeight;

      // Distribute bubbles evenly across the usable width
      const optionSpacing = bubbleAreaWidth / optionCount;

      for (let i = 0; i < optionCount; i++) {
        const x = bubbleAreaLeft + optionSpacing * i + (optionSpacing - bubbleWidth) / 2;
        const y = areaTop + rowHeight * rowIndex + paddedRowTop + (usableRowHeight - bubbleHeight) / 2;

        bubbles.push({
          questionNumber: q,
          option: options[i],
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(bubbleWidth),
          height: Math.round(bubbleHeight),
        });
      }
    }
  }

  return bubbles;
}
