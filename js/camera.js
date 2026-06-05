/**
 * Camera management for AutoKorek
 * Handles getUserMedia, frame capture, camera switching, and flashlight
 */

let currentStream = null;
let currentFacingMode = 'environment';
let torchState = false;

/**
 * Initialize camera and attach to video element
 * @param {HTMLVideoElement} videoElement
 * @returns {Promise<MediaStream>}
 */
export async function initCamera(videoElement) {
  // Stop any existing stream first
  stopCamera();

  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: currentFacingMode },
      width: { min: 1280, ideal: 1920 },
      height: { min: 720, ideal: 1080 },
    },
  };

  try {
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // If the preferred facing mode is overconstrained, fall back to any camera
    if (err.name === 'OverconstrainedError') {
      console.warn('[Camera] Overconstrained – retrying without facingMode preference');
      const fallbackConstraints = {
        audio: false,
        video: {
          width: { min: 1280, ideal: 1920 },
          height: { min: 720, ideal: 1080 },
        },
      };

      try {
        currentStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      } catch (fallbackErr) {
        throw _wrapCameraError(fallbackErr);
      }
    } else {
      throw _wrapCameraError(err);
    }
  }

  videoElement.srcObject = currentStream;

  // Wait for the video to be ready to play
  await new Promise((resolve, reject) => {
    videoElement.onloadedmetadata = () => {
      videoElement.play().then(resolve).catch(reject);
    };
    // Safety timeout – if metadata never loads
    setTimeout(() => reject(new Error('Video metadata load timeout')), 10000);
  });

  torchState = false;
  console.log('[Camera] Initialized', {
    facingMode: currentFacingMode,
    width: videoElement.videoWidth,
    height: videoElement.videoHeight,
  });

  return currentStream;
}

/**
 * Capture current video frame to a canvas
 * @param {HTMLVideoElement} videoElement
 * @param {HTMLCanvasElement} canvasElement
 * @returns {ImageData} The captured frame data
 */
export function captureFrame(videoElement, canvasElement) {
  if (!videoElement || videoElement.readyState < 2) {
    throw new Error('Video is not ready for capture');
  }

  const width = videoElement.videoWidth;
  const height = videoElement.videoHeight;

  canvasElement.width = width;
  canvasElement.height = height;

  const ctx = canvasElement.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, width, height);

  return ctx.getImageData(0, 0, width, height);
}

/**
 * Switch between front and back camera
 * @param {HTMLVideoElement} videoElement
 * @returns {Promise<void>}
 */
export async function switchCamera(videoElement) {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  console.log('[Camera] Switching to', currentFacingMode);
  await initCamera(videoElement);
}

/**
 * Toggle flashlight/torch
 * @returns {Promise<boolean>} New torch state
 */
export async function toggleFlash() {
  if (!currentStream) {
    throw new Error('No active camera stream');
  }

  const videoTrack = currentStream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error('No video track available');
  }

  // Check if torch is supported
  const capabilities = videoTrack.getCapabilities();
  if (!capabilities.torch) {
    throw new Error('Torch/flashlight is not supported on this device');
  }

  torchState = !torchState;

  await videoTrack.applyConstraints({
    advanced: [{ torch: torchState }],
  });

  console.log('[Camera] Torch', torchState ? 'ON' : 'OFF');
  return torchState;
}

/**
 * Stop camera and release all tracks
 */
export function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => {
      track.stop();
    });
    currentStream = null;
    torchState = false;
    console.log('[Camera] Stopped');
  }
}

/**
 * Check if camera is currently active
 * @returns {boolean}
 */
export function isCameraActive() {
  return currentStream !== null && currentStream.active;
}

/**
 * Get the current facing mode
 * @returns {string} 'environment' or 'user'
 */
export function getCurrentFacingMode() {
  return currentFacingMode;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw getUserMedia error with a user-friendly message
 * @param {Error} err
 * @returns {Error}
 */
function _wrapCameraError(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return new Error(
        'Camera access was denied. Please allow camera permissions in your browser settings.'
      );
    case 'NotFoundError':
      return new Error(
        'No camera found on this device. Please connect a camera and try again.'
      );
    case 'OverconstrainedError':
      return new Error(
        'Camera does not meet the minimum resolution requirements (1280×720).'
      );
    case 'NotReadableError':
      return new Error(
        'Camera is already in use by another application. Please close it and try again.'
      );
    default:
      return new Error(`Camera error: ${err.message}`);
  }
}
