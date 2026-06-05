/**
 * @module app
 * @description Main application controller for AutoKorek.
 * Handles routing, page rendering, event handling, and wiring all modules together.
 */

import { generateId, formatDate, showToast, vibrate } from './utils.js';
import {
  saveAnswerKey, getAnswerKeys, getAnswerKeyById, deleteAnswerKey,
  saveResult, getResults, getResultById, deleteResult, clearResults,
  exportToCSV
} from './storage.js';
import { getQuestionType, getOptionsForQuestion } from './template.js';
import { gradeAnswers, calculateStatistics } from './scoring.js';
import { initCamera, captureFrame, switchCamera, toggleFlash, stopCamera } from './camera.js';
import { processAnswerSheet, waitForOpenCV, isOpenCVReady } from './omr.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  currentPage: 'dashboard',
  scanStep: 1,
  selectedKeyId: null,
  detectedAnswers: [],   // [{number, selected: ['A',...]}]
  currentResult: null,
  editingKeyId: null,     // null = new key, string = editing existing
  opencvReady: false,
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initRouter();
  initNavigation();
  initDashboard();
  initScanPage();
  initKeysPage();
  initResultsPage();
  initModals();
  loadOpenCV();
});

// ---------------------------------------------------------------------------
// OpenCV Loading
// ---------------------------------------------------------------------------

async function loadOpenCV() {
  const bar = $('#opencv-loading');
  if (bar) bar.style.display = 'block';

  try {
    await waitForOpenCV();
    state.opencvReady = true;
    if (bar) bar.style.display = 'none';
    console.log('[App] OpenCV.js ready');
  } catch (e) {
    if (bar) bar.style.display = 'none';
    console.error('[App] OpenCV failed to load:', e);
    showToast('OpenCV gagal dimuat. Fitur scan mungkin tidak berfungsi.', 'warning');
  }
}

// ---------------------------------------------------------------------------
// Router (hash-based)
// ---------------------------------------------------------------------------

function initRouter() {
  window.addEventListener('hashchange', () => {
    const page = location.hash.replace('#', '') || 'dashboard';
    navigateTo(page);
  });

  const initial = location.hash.replace('#', '') || 'dashboard';
  navigateTo(initial);
}

function navigateTo(page) {
  // Stop camera when leaving scan page
  if (state.currentPage === 'scan' && page !== 'scan') {
    stopCamera();
  }

  state.currentPage = page;

  // Update pages visibility
  $$('.page').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Update nav
  $$('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Show/hide header on scan page
  const header = $('#app-header');
  if (header) {
    header.style.display = page === 'scan' ? 'none' : '';
  }

  // Refresh page data
  switch (page) {
    case 'dashboard': refreshDashboard(); break;
    case 'scan': refreshScanPage(); break;
    case 'keys': refreshKeysList(); break;
    case 'results': refreshResultsPage(); break;
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function initNavigation() {
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      location.hash = page;
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function initDashboard() {
  $('#qa-scan')?.addEventListener('click', () => { location.hash = 'scan'; });
  $('#qa-keys')?.addEventListener('click', () => { location.hash = 'keys'; });
  $('#btn-view-all-results')?.addEventListener('click', () => { location.hash = 'results'; });
}

function refreshDashboard() {
  const results = getResults();
  const stats = calculateStatistics(results);

  $('#stat-total-scan').textContent = stats.count;
  $('#stat-avg-score').textContent = stats.count > 0 ? stats.mean : '—';
  $('#stat-highest').textContent = stats.count > 0 ? stats.max : '—';
  $('#stat-lowest').textContent = stats.count > 0 ? stats.min : '—';

  // Recent results (last 5)
  const recentContainer = $('#recent-results-list');
  if (!recentContainer) return;

  if (results.length === 0) {
    recentContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">Belum ada hasil</div>
        <div class="empty-desc">Mulai scan lembar jawaban untuk melihat hasil koreksi</div>
      </div>`;
    return;
  }

  const recent = results.slice(-5).reverse();
  recentContainer.innerHTML = recent.map((r) => renderResultItem(r)).join('');

  recentContainer.querySelectorAll('.result-item').forEach((el) => {
    el.addEventListener('click', () => showResultDetail(el.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Scan Page
// ---------------------------------------------------------------------------

function initScanPage() {
  // Step 1: Key selection
  $('#scan-key-select')?.addEventListener('change', (e) => {
    state.selectedKeyId = e.target.value;
    const btn = $('#btn-start-camera');
    if (btn) btn.disabled = !e.target.value;
  });

  $('#btn-start-camera')?.addEventListener('click', () => goToScanStep(2));
  $('#link-create-key')?.addEventListener('click', (e) => {
    e.preventDefault();
    openKeyEditor(null);
  });

  // File upload
  const uploadArea = $('#upload-area');
  const fileInput = $('#file-input');
  uploadArea?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', handleFileUpload);

  // Step 2: Camera
  $('#btn-capture')?.addEventListener('click', handleCapture);
  $('#btn-flash')?.addEventListener('click', handleFlash);
  $('#btn-switch-cam')?.addEventListener('click', handleSwitchCamera);
  $('#btn-back-step1')?.addEventListener('click', () => {
    stopCamera();
    goToScanStep(1);
  });

  // Step 3: Review
  $('#btn-retake')?.addEventListener('click', () => {
    goToScanStep(2);
  });
  $('#btn-back-step2')?.addEventListener('click', () => goToScanStep(2));
  $('#btn-grade')?.addEventListener('click', handleGrade);

  // Step 4: Results
  $('#btn-scan-another')?.addEventListener('click', () => {
    state.detectedAnswers = [];
    state.currentResult = null;
    goToScanStep(1);
  });
  $('#btn-go-dashboard')?.addEventListener('click', () => { location.hash = 'dashboard'; });
}

function refreshScanPage() {
  // Populate key select dropdown
  const select = $('#scan-key-select');
  if (!select) return;

  const keys = getAnswerKeys();
  select.innerHTML = '<option value="">— Pilih Kunci Jawaban —</option>';
  keys.forEach((k) => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.subject;
    if (k.id === state.selectedKeyId) opt.selected = true;
    select.appendChild(opt);
  });

  const btn = $('#btn-start-camera');
  if (btn) btn.disabled = !state.selectedKeyId;

  // Reset to step 1 if no key selected
  if (!state.selectedKeyId) {
    goToScanStep(1);
  }
}

function goToScanStep(step) {
  state.scanStep = step;

  $$('.scan-step').forEach((el) => {
    el.classList.toggle('active', parseInt(el.dataset.step) === step);
  });

  // Update step dots
  $$('.step-dot').forEach((dot) => {
    const dotStep = parseInt(dot.dataset.step);
    dot.classList.toggle('active', dotStep === step);
    dot.classList.toggle('done', dotStep < step);
  });

  // Start camera for step 2
  if (step === 2) {
    startScanCamera();
  } else {
    stopCamera();
  }

  // Build answer grid for step 3
  if (step === 3) {
    buildDetectedAnswerGrid();
    buildUraianGrid();
  }
}

async function startScanCamera() {
  const video = $('#camera-video');
  if (!video) return;

  try {
    await initCamera(video);
  } catch (err) {
    showToast(err.message, 'error');
    goToScanStep(1);
  }
}

async function handleCapture() {
  const video = $('#camera-video');
  const canvas = $('#camera-canvas');
  if (!video || !canvas) return;

  vibrate([100]);
  const captureBtn = $('#btn-capture');
  if (captureBtn) captureBtn.classList.add('processing');

  try {
    captureFrame(video, canvas);
    stopCamera();

    // Show captured image
    const resultCanvas = $('#result-canvas');
    if (resultCanvas) {
      resultCanvas.width = canvas.width;
      resultCanvas.height = canvas.height;
      const ctx = resultCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
    }

    // Process with OMR if OpenCV is ready
    if (state.opencvReady) {
      showLoading('Memproses lembar jawaban...', 'Mendeteksi jawaban siswa');

      // Use setTimeout to let the UI update before heavy processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        const result = processAnswerSheet(canvas);
        state.detectedAnswers = result.answers;

        const filled = result.debugInfo.filledBubbles;
        const conf = Math.round(result.confidence * 100);
        showToast(`Terdeteksi ${filled} jawaban (keyakinan: ${conf}%)`, 'success');

        const status = $('#detection-status');
        if (status) {
          status.textContent = `Otomatis (${conf}%)`;
          status.className = `badge ${conf > 60 ? 'badge-success' : 'badge-warning'}`;
        }
      } catch (err) {
        console.error('[App] OMR processing error:', err);
        showToast('Gagal memproses gambar. Edit jawaban secara manual.', 'warning');
        // Initialize empty answers
        state.detectedAnswers = [];
        for (let i = 1; i <= 30; i++) {
          state.detectedAnswers.push({ number: i, selected: [] });
        }
      }

      hideLoading();
    } else {
      // No OpenCV - manual entry
      showToast('OpenCV belum dimuat. Silakan edit jawaban secara manual.', 'info');
      state.detectedAnswers = [];
      for (let i = 1; i <= 30; i++) {
        state.detectedAnswers.push({ number: i, selected: [] });
      }
    }

    goToScanStep(3);
  } catch (err) {
    showToast('Gagal mengambil gambar: ' + err.message, 'error');
  } finally {
    if (captureBtn) captureBtn.classList.remove('processing');
  }
}

async function handleFileUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (!state.selectedKeyId) {
    showToast('Pilih kunci jawaban terlebih dahulu', 'warning');
    return;
  }

  const canvas = $('#camera-canvas');
  const resultCanvas = $('#result-canvas');
  if (!canvas) return;

  showLoading('Memuat gambar...', 'Membaca file');

  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    URL.revokeObjectURL(img.src);

    // Show preview
    if (resultCanvas) {
      resultCanvas.width = canvas.width;
      resultCanvas.height = canvas.height;
      const rctx = resultCanvas.getContext('2d');
      rctx.drawImage(canvas, 0, 0);
    }

    // Process with OMR
    if (state.opencvReady) {
      try {
        const result = processAnswerSheet(canvas);
        state.detectedAnswers = result.answers;
        showToast(`Terdeteksi ${result.debugInfo.filledBubbles} jawaban`, 'success');
      } catch (err) {
        console.error('[App] OMR error on uploaded image:', err);
        showToast('Gagal memproses. Edit secara manual.', 'warning');
        initEmptyAnswers();
      }
    } else {
      initEmptyAnswers();
    }

    hideLoading();
    goToScanStep(3);
  } catch (err) {
    hideLoading();
    showToast('Gagal memuat gambar: ' + err.message, 'error');
  }

  // Reset file input
  e.target.value = '';
}

function initEmptyAnswers() {
  state.detectedAnswers = [];
  for (let i = 1; i <= 30; i++) {
    state.detectedAnswers.push({ number: i, selected: [] });
  }
}

async function handleFlash() {
  try {
    const on = await toggleFlash();
    const btn = $('#btn-flash');
    if (btn) btn.classList.toggle('active', on);
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

async function handleSwitchCamera() {
  const video = $('#camera-video');
  if (!video) return;
  try {
    await switchCamera(video);
    showToast('Kamera diganti', 'info');
  } catch (err) {
    showToast('Gagal mengganti kamera', 'error');
  }
}

// ---------------------------------------------------------------------------
// Answer Grid (Detection Review / Edit)
// ---------------------------------------------------------------------------

function buildDetectedAnswerGrid() {
  const pgGrid = $('#detected-pg-grid');
  const pgkGrid = $('#detected-pgk-grid');
  if (!pgGrid || !pgkGrid) return;

  pgGrid.innerHTML = '';
  pgkGrid.innerHTML = '';

  for (let q = 1; q <= 30; q++) {
    const type = getQuestionType(q);
    const options = getOptionsForQuestion(q);
    const detected = state.detectedAnswers.find((a) => a.number === q);
    const selected = detected ? detected.selected : [];

    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `
      <span class="answer-number">${q}.</span>
      <div class="answer-bubbles" data-question="${q}" data-type="${type}">
        ${options.map((opt) => `
          <div class="bubble ${selected.includes(opt) ? 'selected' : ''}"
               data-option="${opt}" data-question="${q}" role="button" tabindex="0">
            ${opt}
          </div>
        `).join('')}
      </div>
    `;

    if (q <= 15) {
      pgGrid.appendChild(row);
    } else {
      pgkGrid.appendChild(row);
    }
  }

  // Add bubble click handlers
  $$('#scan-step-3 .bubble').forEach((bubble) => {
    bubble.addEventListener('click', () => handleBubbleClick(bubble));
  });
}

function handleBubbleClick(bubble) {
  const q = parseInt(bubble.dataset.question);
  const opt = bubble.dataset.option;
  const type = getQuestionType(q);

  vibrate([30]);

  if (type === 'pg') {
    // PG: single selection - deselect all others, toggle this one
    const container = bubble.closest('.answer-bubbles');
    const wasSelected = bubble.classList.contains('selected');

    container.querySelectorAll('.bubble').forEach((b) => b.classList.remove('selected'));

    if (!wasSelected) {
      bubble.classList.add('selected');
    }
  } else {
    // PGK: multi-selection
    bubble.classList.toggle('selected');
  }

  // Update state
  updateDetectedAnswer(q);
}

function updateDetectedAnswer(questionNumber) {
  const container = $(`.answer-bubbles[data-question="${questionNumber}"]`);
  if (!container) return;

  const selected = [];
  container.querySelectorAll('.bubble.selected').forEach((b) => {
    selected.push(b.dataset.option);
  });

  const existing = state.detectedAnswers.find((a) => a.number === questionNumber);
  if (existing) {
    existing.selected = selected;
  } else {
    state.detectedAnswers.push({ number: questionNumber, selected });
  }
}

function buildUraianGrid() {
  const grid = $('#uraian-grid');
  if (!grid) return;

  grid.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const row = document.createElement('div');
    row.className = 'uraian-row';
    row.innerHTML = `
      <span class="uraian-label">Soal ${31 + i}</span>
      <input type="number" class="uraian-input" id="uraian-${i}" min="0" max="5" value="0" step="1">
      <span class="uraian-max">/ 5</span>
    `;
    grid.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

function handleGrade() {
  const keyId = state.selectedKeyId;
  if (!keyId) {
    showToast('Pilih kunci jawaban terlebih dahulu', 'warning');
    return;
  }

  const answerKey = getAnswerKeyById(keyId);
  if (!answerKey) {
    showToast('Kunci jawaban tidak ditemukan', 'error');
    return;
  }

  const studentName = $('#student-name')?.value?.trim() || 'Tanpa Nama';

  // Prepare student answers
  const studentAnswers = state.detectedAnswers.map((a) => ({
    number: a.number,
    answers: a.selected || [],
  }));

  // Get uraian scores
  const uraianScores = [];
  for (let i = 0; i < 5; i++) {
    const input = $(`#uraian-${i}`);
    const val = input ? Math.min(5, Math.max(0, parseInt(input.value) || 0)) : 0;
    uraianScores.push(val);
  }

  // Grade
  const result = gradeAnswers(studentAnswers, answerKey, uraianScores);
  result.id = generateId();
  result.studentName = studentName;

  // Save
  saveResult(result);
  state.currentResult = result;

  showToast(`Skor: ${result.totalScore} / ${result.maxScore}`, 'success');
  vibrate([50, 100, 50]);

  // Show results
  displayScoreResult(result);
  goToScanStep(4);
}

function displayScoreResult(result) {
  // Score circle animation
  const fill = $('#score-fill');
  if (fill) {
    const circumference = 2 * Math.PI * 65; // r=65
    const offset = circumference * (1 - result.percentage / 100);
    fill.style.strokeDasharray = circumference;
    fill.style.strokeDashoffset = circumference;
    // Trigger animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fill.style.strokeDashoffset = offset;
      });
    });
  }

  // Score value
  const scoreValue = $('#score-value');
  if (scoreValue) {
    animateNumber(scoreValue, 0, result.totalScore, 1500);
  }

  // Student name and key name
  $('#result-student-name').textContent = result.studentName;
  $('#result-key-name').textContent = result.answerKeyName;

  // Breakdown
  $('#breakdown-pg').textContent = result.pgScore;
  $('#breakdown-pgk').textContent = result.pgkScore;
  $('#breakdown-uraian').textContent = result.uraianTotal;

  // Stats
  $('#result-pg-correct').textContent = `${result.pgCorrect} / 15`;
  $('#result-pg-wrong').textContent = result.pgWrong;
  $('#result-pg-blank').textContent = result.pgBlank;
  $('#result-pgk-score').textContent = `${result.pgkScore} / 60`;

  // Detail per question
  buildResultDetail(result);
}

function buildResultDetail(result) {
  const container = $('#result-detail-questions');
  if (!container) return;

  container.innerHTML = result.details.map((d) => {
    const statusClass = d.status === 'correct' ? 'correct' : d.status === 'partial' ? 'partial' : d.status === 'wrong' ? 'wrong' : '';
    const typeLabel = d.type === 'pg' ? 'PG' : d.type === 'pgk' ? 'PGK' : 'U';
    const typeClass = d.type === 'pgk' ? 'pgk' : 'pg';

    let answerText = '';
    if (d.type === 'uraian') {
      answerText = `Skor: ${d.score}`;
    } else {
      const student = d.studentAnswer.length > 0 ? d.studentAnswer.join(', ') : '—';
      const correct = d.correctAnswer.join(', ');
      answerText = `${student} <span class="text-muted" style="font-size:0.7rem">(kunci: ${correct})</span>`;
    }

    return `
      <div class="detail-question">
        <span class="detail-q-num">${d.number}</span>
        <span class="detail-q-type ${typeClass}">${typeLabel}</span>
        <span class="detail-q-answer">${answerText}</span>
        <span class="detail-q-score ${statusClass}">${d.score}/${d.maxScore}</span>
      </div>
    `;
  }).join('');
}

function animateNumber(element, start, end, duration) {
  const startTime = performance.now();
  const diff = end - start;

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = Math.round(start + diff * eased);
    element.textContent = current;
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

// ---------------------------------------------------------------------------
// Answer Keys Page
// ---------------------------------------------------------------------------

function initKeysPage() {
  $('#btn-new-key')?.addEventListener('click', () => openKeyEditor(null));
  $('#btn-new-key-empty')?.addEventListener('click', () => openKeyEditor(null));
}

function refreshKeysList() {
  const container = $('#keys-list');
  if (!container) return;

  const keys = getAnswerKeys();

  if (keys.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔑</div>
        <div class="empty-title">Belum ada kunci jawaban</div>
        <div class="empty-desc">Buat kunci jawaban baru untuk mulai mengoreksi</div>
        <button class="btn btn-primary" id="btn-new-key-empty">+ Buat Kunci Jawaban</button>
      </div>`;
    $('#btn-new-key-empty')?.addEventListener('click', () => openKeyEditor(null));
    return;
  }

  container.innerHTML = keys.map((k) => `
    <div class="card key-card" data-id="${k.id}">
      <div class="key-icon">📝</div>
      <div class="key-info">
        <div class="key-name">${escapeHtml(k.subject)}</div>
        <div class="key-meta">${formatDate(new Date(k.createdAt))} · 30 soal</div>
      </div>
      <div class="key-actions">
        <button class="btn btn-ghost btn-icon key-edit" data-id="${k.id}" title="Edit">✏️</button>
        <button class="btn btn-ghost btn-icon key-delete" data-id="${k.id}" title="Hapus">🗑️</button>
      </div>
    </div>
  `).join('');

  // Event listeners
  container.querySelectorAll('.key-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openKeyEditor(btn.dataset.id);
    });
  });

  container.querySelectorAll('.key-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Hapus kunci jawaban ini?')) {
        deleteAnswerKey(btn.dataset.id);
        refreshKeysList();
        showToast('Kunci jawaban dihapus', 'success');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Answer Key Editor (Modal)
// ---------------------------------------------------------------------------

function openKeyEditor(keyId) {
  state.editingKeyId = keyId;

  const modal = $('#modal-key-editor');
  const title = $('#key-editor-title');
  const nameInput = $('#key-subject-name');

  if (!modal) return;

  if (keyId) {
    const key = getAnswerKeyById(keyId);
    if (!key) return;
    title.textContent = 'Edit Kunci Jawaban';
    nameInput.value = key.subject;
    buildKeyEditorGrid(key.answers);
  } else {
    title.textContent = 'Kunci Jawaban Baru';
    nameInput.value = '';
    buildKeyEditorGrid([]);
  }

  openModal('modal-key-editor');
}

function buildKeyEditorGrid(existingAnswers = []) {
  const pgGrid = $('#key-pg-grid');
  const pgkGrid = $('#key-pgk-grid');
  if (!pgGrid || !pgkGrid) return;

  // Build lookup
  const answerMap = {};
  existingAnswers.forEach((a) => {
    answerMap[a.number] = a.correct || [];
  });

  pgGrid.innerHTML = '';
  pgkGrid.innerHTML = '';

  for (let q = 1; q <= 30; q++) {
    const type = getQuestionType(q);
    const options = getOptionsForQuestion(q);
    const selected = answerMap[q] || [];

    const row = document.createElement('div');
    row.className = 'answer-row';
    row.innerHTML = `
      <span class="answer-number">${q}.</span>
      <div class="answer-bubbles" data-question="${q}" data-type="${type}" data-editor="key">
        ${options.map((opt) => `
          <div class="bubble ${selected.includes(opt) ? 'selected' : ''}"
               data-option="${opt}" data-question="${q}" role="button" tabindex="0">
            ${opt}
          </div>
        `).join('')}
      </div>
    `;

    if (q <= 15) {
      pgGrid.appendChild(row);
    } else {
      pgkGrid.appendChild(row);
    }
  }

  // Bubble click handlers in editor
  $$('#modal-key-editor .bubble').forEach((bubble) => {
    bubble.addEventListener('click', () => {
      const q = parseInt(bubble.dataset.question);
      const type = getQuestionType(q);

      vibrate([20]);

      if (type === 'pg') {
        // Single selection
        const container = bubble.closest('.answer-bubbles');
        const wasSelected = bubble.classList.contains('selected');
        container.querySelectorAll('.bubble').forEach((b) => b.classList.remove('selected'));
        if (!wasSelected) bubble.classList.add('selected');
      } else {
        // Multi selection
        bubble.classList.toggle('selected');
      }
    });
  });
}

function initModals() {
  // Key editor
  $('#btn-close-key-editor')?.addEventListener('click', () => closeModal('modal-key-editor'));
  $('#btn-cancel-key')?.addEventListener('click', () => closeModal('modal-key-editor'));
  $('#btn-save-key')?.addEventListener('click', handleSaveKey);

  // Result detail
  $('#btn-close-detail')?.addEventListener('click', () => closeModal('modal-result-detail'));
  $('#btn-close-detail-footer')?.addEventListener('click', () => closeModal('modal-result-detail'));
  $('#btn-delete-result')?.addEventListener('click', handleDeleteResult);

  // Backdrop click
  $('#modal-backdrop')?.addEventListener('click', () => {
    closeModal('modal-key-editor');
    closeModal('modal-result-detail');
  });
}

function handleSaveKey() {
  const nameInput = $('#key-subject-name');
  const subject = nameInput?.value?.trim();

  if (!subject) {
    showToast('Masukkan nama mata pelajaran', 'warning');
    nameInput?.focus();
    return;
  }

  // Collect answers from editor bubbles
  const answers = [];
  for (let q = 1; q <= 30; q++) {
    const container = $(`#modal-key-editor .answer-bubbles[data-question="${q}"]`);
    if (!container) continue;

    const selected = [];
    container.querySelectorAll('.bubble.selected').forEach((b) => {
      selected.push(b.dataset.option);
    });

    const type = getQuestionType(q);
    answers.push({
      number: q,
      type,
      correct: selected,
    });
  }

  // Validate: at least some answers
  const answeredCount = answers.filter((a) => a.correct.length > 0).length;
  if (answeredCount === 0) {
    showToast('Isi minimal 1 jawaban', 'warning');
    return;
  }

  // Save
  const key = {
    id: state.editingKeyId || generateId(),
    subject,
    answers,
    createdAt: state.editingKeyId
      ? (getAnswerKeyById(state.editingKeyId)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveAnswerKey(key);
  closeModal('modal-key-editor');
  refreshKeysList();
  refreshScanPage();
  showToast(`Kunci jawaban "${subject}" disimpan`, 'success');
}

// ---------------------------------------------------------------------------
// Results Page
// ---------------------------------------------------------------------------

function initResultsPage() {
  $('#btn-export-csv')?.addEventListener('click', handleExportCSV);
  $('#btn-clear-results')?.addEventListener('click', handleClearResults);
  $('#results-filter-key')?.addEventListener('change', refreshResultsPage);
}

function refreshResultsPage() {
  const results = getResults();
  const filterKeyId = $('#results-filter-key')?.value || '';

  // Populate filter dropdown
  const filterSelect = $('#results-filter-key');
  if (filterSelect) {
    const keys = getAnswerKeys();
    const currentValue = filterSelect.value;
    filterSelect.innerHTML = '<option value="">Semua Kunci Jawaban</option>';
    keys.forEach((k) => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = k.subject;
      if (k.id === currentValue) opt.selected = true;
      filterSelect.appendChild(opt);
    });
  }

  // Filter results
  const filtered = filterKeyId
    ? results.filter((r) => r.answerKeyId === filterKeyId)
    : results;

  // Stats
  const statsGrid = $('#results-stats');
  if (filtered.length > 0) {
    const stats = calculateStatistics(filtered);
    if (statsGrid) statsGrid.style.display = '';
    $('#rstat-count').textContent = stats.count;
    $('#rstat-avg').textContent = stats.mean;
    $('#rstat-max').textContent = stats.max;
    $('#rstat-min').textContent = stats.min;
  } else {
    if (statsGrid) statsGrid.style.display = 'none';
  }

  // Results list
  const container = $('#results-list');
  if (!container) return;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <div class="empty-title">Belum ada hasil</div>
        <div class="empty-desc">Scan lembar jawaban untuk mulai mengoreksi</div>
      </div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
  container.innerHTML = sorted.map((r) => renderResultItem(r)).join('');

  container.querySelectorAll('.result-item').forEach((el) => {
    el.addEventListener('click', () => showResultDetail(el.dataset.id));
  });
}

function renderResultItem(r) {
  const initials = getInitials(r.studentName || '?');
  const scoreClass = r.percentage >= 70 ? 'score-high' : r.percentage >= 50 ? 'score-mid' : 'score-low';
  const dateStr = formatDate(new Date(r.date));

  return `
    <div class="card result-item" data-id="${r.id}">
      <div class="result-avatar">${initials}</div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(r.studentName || 'Tanpa Nama')}</div>
        <div class="result-meta">${escapeHtml(r.answerKeyName || '')} · ${dateStr}</div>
      </div>
      <div class="result-score ${scoreClass}">${r.totalScore}</div>
    </div>
  `;
}

function showResultDetail(resultId) {
  const result = getResultById(resultId);
  if (!result) return;

  state.currentResult = result;

  const title = $('#detail-modal-title');
  const body = $('#detail-modal-body');
  const deleteBtn = $('#btn-delete-result');

  if (title) title.textContent = result.studentName || 'Detail Hasil';
  if (deleteBtn) deleteBtn.dataset.id = resultId;

  if (body) {
    body.innerHTML = `
      <div class="score-display" style="padding: var(--space-md) 0;">
        <div class="score-circle" style="width:120px;height:120px;">
          <svg viewBox="0 0 140 140">
            <circle class="track" cx="70" cy="70" r="65" style="fill:none;stroke:var(--border-subtle);stroke-width:8;" />
            <circle cx="70" cy="70" r="65"
              style="fill:none;stroke:url(#scoreGradient);stroke-width:8;stroke-linecap:round;
                     stroke-dasharray:${2 * Math.PI * 65};
                     stroke-dashoffset:${2 * Math.PI * 65 * (1 - result.percentage / 100)};
                     transform:rotate(-90deg);transform-origin:center;" />
          </svg>
          <div class="score-text">
            <div class="score-value" style="font-size:var(--text-2xl);">${result.totalScore}</div>
            <div class="score-label">/ ${result.maxScore}</div>
          </div>
        </div>
      </div>

      <div class="score-breakdown mb-md">
        <div class="score-breakdown-item">
          <div class="breakdown-value">${result.pgScore}</div>
          <div class="breakdown-label">PG</div>
          <div class="breakdown-max">/ 15</div>
        </div>
        <div class="score-breakdown-item">
          <div class="breakdown-value">${result.pgkScore}</div>
          <div class="breakdown-label">PGK</div>
          <div class="breakdown-max">/ 60</div>
        </div>
        <div class="score-breakdown-item">
          <div class="breakdown-value">${result.uraianTotal}</div>
          <div class="breakdown-label">Uraian</div>
          <div class="breakdown-max">/ 25</div>
        </div>
      </div>

      <div style="margin-bottom: var(--space-sm);">
        <div class="flex-between mb-sm">
          <span class="text-muted">PG Benar</span>
          <span class="text-mono">${result.pgCorrect} / 15</span>
        </div>
        <div class="flex-between mb-sm">
          <span class="text-muted">PG Salah</span>
          <span class="text-mono text-error">${result.pgWrong}</span>
        </div>
        <div class="flex-between mb-sm">
          <span class="text-muted">PG Kosong</span>
          <span class="text-mono">${result.pgBlank}</span>
        </div>
        <div class="flex-between mb-sm">
          <span class="text-muted">Kunci Jawaban</span>
          <span class="text-mono">${escapeHtml(result.answerKeyName || '')}</span>
        </div>
        <div class="flex-between">
          <span class="text-muted">Tanggal</span>
          <span class="text-mono">${formatDate(new Date(result.date))}</span>
        </div>
      </div>

      <div style="margin-top: var(--space-lg);">
        <h4 style="margin-bottom: var(--space-sm);">Detail Jawaban</h4>
        <div class="detail-questions">
          ${(result.details || []).map((d) => {
            const statusClass = d.status === 'correct' ? 'correct' : d.status === 'partial' ? 'partial' : d.status === 'wrong' ? 'wrong' : '';
            const typeLabel = d.type === 'pg' ? 'PG' : d.type === 'pgk' ? 'PGK' : 'U';
            const typeClass = d.type === 'pgk' ? 'pgk' : 'pg';
            let ansText;
            if (d.type === 'uraian') {
              ansText = `Skor: ${d.score}`;
            } else {
              const s = d.studentAnswer.length > 0 ? d.studentAnswer.join(',') : '—';
              const c = d.correctAnswer.join(',');
              ansText = `${s} <span class="text-muted" style="font-size:0.65rem">(${c})</span>`;
            }
            return `
              <div class="detail-question">
                <span class="detail-q-num">${d.number}</span>
                <span class="detail-q-type ${typeClass}">${typeLabel}</span>
                <span class="detail-q-answer">${ansText}</span>
                <span class="detail-q-score ${statusClass}">${d.score}/${d.maxScore}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  openModal('modal-result-detail');
}

function handleDeleteResult() {
  const btn = $('#btn-delete-result');
  const id = btn?.dataset?.id;
  if (!id) return;

  if (confirm('Hapus hasil koreksi ini?')) {
    deleteResult(id);
    closeModal('modal-result-detail');
    refreshResultsPage();
    refreshDashboard();
    showToast('Hasil koreksi dihapus', 'success');
  }
}

function handleExportCSV() {
  const filterKeyId = $('#results-filter-key')?.value || '';
  const results = getResults();
  const filtered = filterKeyId ? results.filter((r) => r.answerKeyId === filterKeyId) : results;

  if (filtered.length === 0) {
    showToast('Tidak ada data untuk diekspor', 'warning');
    return;
  }

  const key = filterKeyId ? getAnswerKeyById(filterKeyId) : { subject: 'Semua' };
  const csv = exportToCSV(filtered, key);

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AutoKorek_${key?.subject || 'Hasil'}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('File CSV berhasil diunduh', 'success');
}

function handleClearResults() {
  const results = getResults();
  if (results.length === 0) {
    showToast('Tidak ada data untuk dihapus', 'info');
    return;
  }

  if (confirm(`Hapus semua ${results.length} hasil koreksi? Tindakan ini tidak dapat dibatalkan.`)) {
    clearResults();
    refreshResultsPage();
    refreshDashboard();
    showToast('Semua hasil dihapus', 'success');
  }
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function openModal(modalId) {
  const modal = $(`#${modalId}`);
  const backdrop = $('#modal-backdrop');
  if (modal) {
    modal.classList.add('active');
    if (backdrop) backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = $(`#${modalId}`);
  const backdrop = $('#modal-backdrop');
  if (modal) {
    modal.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------

function showLoading(text, subtext) {
  const overlay = $('#loading-overlay');
  if (overlay) {
    overlay.classList.add('active');
    const t = $('#loading-text');
    const s = $('#loading-subtext');
    if (t) t.textContent = text || 'Memproses...';
    if (s) s.textContent = subtext || '';
  }
}

function hideLoading() {
  const overlay = $('#loading-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getInitials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
