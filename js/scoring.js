/**
 * @module scoring
 * @description Scoring and grading logic for the AutoKorek application.
 *
 * Scoring rules
 * ─────────────
 * PG  (Pilihan Ganda, Q1–15):
 *   • Single correct answer per question.
 *   • Correct = 1 point, wrong/blank = 0.
 *   • Max per question: 1 · Total PG max: 15.
 *
 * PGK (Pilihan Ganda Kompleks, Q16–30):
 *   • Multiple correct answers possible.
 *   • Max per question: 4.
 *   • Score = max(0, 4 − missed − extra)
 *     where  missed = correct options NOT selected by student,
 *            extra  = options selected by student NOT in the key.
 *   • Total PGK max: 60.
 *
 * Uraian (Q31–35):
 *   • Manually scored, max 5 per question.
 *   • Total Uraian max: 25.
 *
 * Grand total max = 15 + 60 + 25 = 100.
 */

import { getQuestionType } from './template.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {number} Maximum score for a single PG question. */
const PG_MAX = 1;

/** @type {number} Maximum score for a single PGK question. */
const PGK_MAX = 4;

/** @type {number} Maximum score for a single Uraian question. */
const URAIAN_MAX = 5;

/** @type {number} Total number of PG questions. */
const PG_COUNT = 15;

/** @type {number} Total number of PGK questions. */
const PGK_COUNT = 15;

/** @type {number} Total number of Uraian questions. */
const URAIAN_COUNT = 5;

/** @type {number} Overall maximum score. */
const TOTAL_MAX = PG_COUNT * PG_MAX + PGK_COUNT * PGK_MAX + URAIAN_COUNT * URAIAN_MAX; // 100

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Grade a student's answers against an answer key.
 *
 * @param {Array<{number: number, answers: string[]}>} studentAnswers
 *   Array of student answer objects. `answers` is always an array even for PG
 *   (e.g. `['A']`).
 * @param {Object} answerKey
 *   The answer key object. Must contain an `answers` array of
 *   `{ number: number, type: string, correct: string[] }`.
 * @param {number[]} [uraianScores=[0,0,0,0,0]]
 *   Array of 5 manual uraian scores (each 0–5).
 * @returns {Object} A grading result object. The `id` and `studentName` fields
 *   are left for the caller to populate.
 */
export function gradeAnswers(studentAnswers, answerKey, uraianScores = [0, 0, 0, 0, 0]) {
  // Normalise inputs -------------------------------------------------------
  const safeStudentAnswers = Array.isArray(studentAnswers) ? studentAnswers : [];
  const keyAnswers = (answerKey && Array.isArray(answerKey.answers)) ? answerKey.answers : [];
  const safeUraian = Array.isArray(uraianScores) ? uraianScores : [0, 0, 0, 0, 0];

  // Build a lookup: questionNumber → student answer array (upper-cased)
  /** @type {Map<number, string[]>} */
  const studentMap = new Map();
  for (const sa of safeStudentAnswers) {
    if (sa && typeof sa.number === 'number') {
      const answers = Array.isArray(sa.answers)
        ? sa.answers.map((a) => String(a).toUpperCase())
        : [];
      studentMap.set(sa.number, answers);
    }
  }

  // Build a lookup: questionNumber → correct answer array (upper-cased)
  /** @type {Map<number, string[]>} */
  const keyMap = new Map();
  for (const ka of keyAnswers) {
    if (ka && typeof ka.number === 'number') {
      const correct = Array.isArray(ka.correct)
        ? ka.correct.map((a) => String(a).toUpperCase())
        : [];
      keyMap.set(ka.number, correct);
    }
  }

  // Prepare the result object -----------------------------------------------
  const result = {
    id: null,
    studentName: '',
    date: new Date().toISOString(),
    answerKeyId: answerKey ? answerKey.id : null,
    answerKeyName: answerKey ? (answerKey.subject || '') : '',
    details: [],
    pgCorrect: 0,
    pgWrong: 0,
    pgBlank: 0,
    pgScore: 0,
    pgkScore: 0,
    uraianScores: safeUraian.slice(0, URAIAN_COUNT),
    uraianTotal: 0,
    totalScore: 0,
    maxScore: TOTAL_MAX,
    percentage: 0,
  };

  // Grade PG and PGK (Q1–30) -----------------------------------------------
  for (let q = 1; q <= PG_COUNT + PGK_COUNT; q++) {
    const type = getQuestionType(q);
    const studentAns = studentMap.get(q) || [];
    const correctAns = keyMap.get(q) || [];

    /** @type {{ number: number, type: string, studentAnswer: string[], correctAnswer: string[], score: number, maxScore: number, status: string }} */
    const detail = {
      number: q,
      type,
      studentAnswer: studentAns,
      correctAnswer: correctAns,
      score: 0,
      maxScore: type === 'pg' ? PG_MAX : PGK_MAX,
      status: 'wrong', // will be updated
    };

    if (type === 'pg') {
      // PG: single correct answer
      const selected = studentAns.length > 0 ? studentAns[0] : null;
      const expected = correctAns.length > 0 ? correctAns[0] : null;

      if (selected === null || selected === '') {
        detail.score = 0;
        detail.status = 'blank';
        result.pgBlank++;
      } else if (selected === expected) {
        detail.score = PG_MAX;
        detail.status = 'correct';
        result.pgCorrect++;
      } else {
        detail.score = 0;
        detail.status = 'wrong';
        result.pgWrong++;
      }

      result.pgScore += detail.score;
    } else {
      // PGK: multiple correct answers
      // Score = max(0, 4 − missed − extra)
      const correctSet = new Set(correctAns);
      const selectedSet = new Set(studentAns);

      let missed = 0;
      for (const c of correctSet) {
        if (!selectedSet.has(c)) missed++;
      }

      let extra = 0;
      for (const s of selectedSet) {
        if (!correctSet.has(s)) extra++;
      }

      detail.score = Math.max(0, PGK_MAX - missed - extra);
      detail.maxScore = PGK_MAX;

      if (detail.score === PGK_MAX) {
        detail.status = 'correct';
      } else if (detail.score > 0) {
        detail.status = 'partial';
      } else if (selectedSet.size === 0) {
        detail.status = 'blank';
      } else {
        detail.status = 'wrong';
      }

      result.pgkScore += detail.score;
    }

    result.details.push(detail);
  }

  // Grade Uraian (Q31–35) ---------------------------------------------------
  for (let i = 0; i < URAIAN_COUNT; i++) {
    const q = PG_COUNT + PGK_COUNT + 1 + i; // 31–35
    const score = Math.min(URAIAN_MAX, Math.max(0, Number(safeUraian[i]) || 0));

    result.details.push({
      number: q,
      type: 'uraian',
      studentAnswer: [],
      correctAnswer: [],
      score,
      maxScore: URAIAN_MAX,
      status: score === URAIAN_MAX ? 'correct' : score > 0 ? 'partial' : 'blank',
    });

    result.uraianTotal += score;
  }

  // Totals ------------------------------------------------------------------
  result.totalScore = result.pgScore + result.pgkScore + result.uraianTotal;
  result.percentage = TOTAL_MAX > 0
    ? Math.round((result.totalScore / TOTAL_MAX) * 100)
    : 0;

  return result;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Calculate descriptive statistics from an array of grading results.
 *
 * @param {Object[]} results - Array of grading result objects (each must have
 *   a `percentage` field).
 * @returns {{
 *   count: number,
 *   mean: number,
 *   median: number,
 *   min: number,
 *   max: number,
 *   standardDeviation: number,
 *   distribution: { excellent: number, good: number, fair: number, poor: number }
 * }} Statistics object.
 */
export function calculateStatistics(results) {
  const stats = {
    count: 0,
    mean: 0,
    median: 0,
    min: 0,
    max: 0,
    standardDeviation: 0,
    distribution: {
      excellent: 0, // percentage >= 90
      good: 0,      // 70–89
      fair: 0,      // 50–69
      poor: 0,      // < 50
    },
  };

  if (!Array.isArray(results) || results.length === 0) {
    return stats;
  }

  const scores = results
    .map((r) => (typeof r.percentage === 'number' ? r.percentage : 0))
    .sort((a, b) => a - b);

  stats.count = scores.length;
  stats.min = scores[0];
  stats.max = scores[scores.length - 1];

  // Mean
  const sum = scores.reduce((acc, s) => acc + s, 0);
  stats.mean = parseFloat((sum / stats.count).toFixed(2));

  // Median
  const mid = Math.floor(stats.count / 2);
  if (stats.count % 2 === 0) {
    stats.median = parseFloat(((scores[mid - 1] + scores[mid]) / 2).toFixed(2));
  } else {
    stats.median = scores[mid];
  }

  // Standard deviation (population)
  const meanVal = sum / stats.count;
  const variance = scores.reduce((acc, s) => acc + (s - meanVal) ** 2, 0) / stats.count;
  stats.standardDeviation = parseFloat(Math.sqrt(variance).toFixed(2));

  // Distribution buckets
  for (const s of scores) {
    if (s >= 90) {
      stats.distribution.excellent++;
    } else if (s >= 70) {
      stats.distribution.good++;
    } else if (s >= 50) {
      stats.distribution.fair++;
    } else {
      stats.distribution.poor++;
    }
  }

  return stats;
}
