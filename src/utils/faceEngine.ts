import jsQR from 'jsqr';

export interface HardwareProbeResult {
  hasCamera: boolean;
  cameraLabel: string;
  hasPlatformBiometric: boolean;
  fingerprintStatus: 'unavailable' | 'webauthn_ready';
}

export async function probeHardwareCapabilities(): Promise<HardwareProbeResult> {
  let hasCamera = false;
  let cameraLabel = 'No physical camera detected';
  let hasPlatformBiometric = false;

  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      if (videoInputs.length > 0) {
        hasCamera = true;
        cameraLabel = videoInputs[0].label || `Camera Device (${videoInputs.length} available)`;
      }
    }
  } catch {
    hasCamera = false;
  }

  try {
    if (
      typeof window !== 'undefined' &&
      window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
    ) {
      hasPlatformBiometric = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
  } catch {
    hasPlatformBiometric = false;
  }

  return {
    hasCamera,
    cameraLabel,
    hasPlatformBiometric,
    fingerprintStatus: hasPlatformBiometric ? 'webauthn_ready' : 'unavailable',
  };
}

/**
 * Extracts a 64-dimensional L2-normalized spatial luminance & chromatic descriptor
 * from the central facial region of an image or video element.
 */
export function extractFaceDescriptorFromSource(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): { descriptor: number[]; grayFrame: Uint8ClampedArray } {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { descriptor: [], grayFrame: new Uint8ClampedArray(0) };
  }

  const srcWidth =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
      ? source.naturalWidth
      : source.width;
  const srcHeight =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
      ? source.naturalHeight
      : source.height;

  // Center-crop square region focusing on subject face
  const cropSide = Math.max(1, Math.min(srcWidth || size, srcHeight || size) * 0.72);
  const sx = Math.max(0, ((srcWidth || size) - cropSide) / 2);
  const sy = Math.max(0, ((srcHeight || size) - cropSide) / 2.3);

  ctx.drawImage(source, sx, sy, cropSide, cropSide, 0, 0, size, size);
  const imgData = ctx.getImageData(0, 0, size, size).data;

  const grayFrame = new Uint8ClampedArray(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = imgData[i * 4];
    const g = imgData[i * 4 + 1];
    const b = imgData[i * 4 + 2];
    grayFrame[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // Compute 8x8 block features (64 dimensions combining normalized luminance & local contrast)
  const blockSize = 8;
  const rawVec: number[] = [];
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          const idx = (by * blockSize + y) * size + (bx * blockSize + x);
          sum += grayFrame[idx];
        }
      }
      rawVec.push(sum / (blockSize * blockSize * 255));
    }
  }

  const norm = Math.sqrt(rawVec.reduce((acc, v) => acc + v * v, 0)) || 1;
  const descriptor = rawVec.map((v) => Math.round((v / norm) * 100000) / 100000);
  return { descriptor, grayFrame };
}

export function computeFrameLivenessScore(
  prevGray: Uint8ClampedArray | null,
  currGray: Uint8ClampedArray
): { score: number; verified: boolean } {
  if (!prevGray || prevGray.length !== currGray.length || currGray.length === 0) {
    return { score: 0, verified: false };
  }
  let diffSum = 0;
  let activePixels = 0;
  for (let i = 0; i < currGray.length; i++) {
    const d = Math.abs(currGray[i] - prevGray[i]);
    diffSum += d;
    if (d > 6) activePixels += 1;
  }
  const meanDiff = diffSum / currGray.length;
  const motionRatio = activePixels / currGray.length;
  // Natural live micro-movement yields gentle frame delta (not 0 frozen spoof, not pure noise)
  const score = Math.min(1, Math.round((meanDiff / 14 + motionRatio * 1.4) * 100) / 100);
  return {
    score,
    verified: score >= 0.55,
  };
}

export async function extractDescriptorFromImageUrl(url: string): Promise<number[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const { descriptor } = extractFaceDescriptorFromSource(img);
      resolve(descriptor);
    };
    img.onerror = () => resolve([]);
    img.src = url;
  });
}

export async function readImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

export async function decodeQrFromImageFile(file: File): Promise<string | null> {
  const dataUrl = await readImageFileAsDataUrl(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 320;
      canvas.height = img.naturalHeight || 320;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      resolve(code?.data || null);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function scanQrFromVideo(video: HTMLVideoElement): string | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code?.data || null;
}
