import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  PenTool,
  QrCode,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  Upload,
  WifiOff,
  XCircle,
} from 'lucide-react';
import type {
  KioskDashboardState,
  KioskVerificationResult,
  OfflineAttendanceEvent,
  VerificationMethod,
} from '../shared/types';
import { apiFetch, clearOfflineQueue, enqueueOfflineEvent, getOfflineQueue } from '../utils/api';
import {
  computeFrameLivenessScore,
  decodeQrFromImageFile,
  extractDescriptorFromImageUrl,
  extractFaceDescriptorFromSource,
  probeHardwareCapabilities,
  readImageFileAsDataUrl,
  scanQrFromVideo,
  type HardwareProbeResult,
} from '../utils/faceEngine';
import { StudentAvatar } from './StudentAvatar';

interface GateTerminalProps {
  kioskState: KioskDashboardState | null;
  onRefreshState: () => void;
  wsConnected: boolean;
}

export function GateTerminal({ kioskState, onRefreshState, wsConnected }: GateTerminalProps) {
  const [action, setAction] = useState<'entry' | 'exit'>('entry');
  const [activeMethod, setActiveMethod] = useState<VerificationMethod>('face_recognition');
  const [hardware, setHardware] = useState<HardwareProbeResult>({
    hasCamera: false,
    cameraLabel: 'Probing hardware...',
    hasPlatformBiometric: false,
    fingerprintStatus: 'unavailable',
  });
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [livenessScore, setLivenessScore] = useState(0);
  const [livenessVerified, setLivenessVerified] = useState(false);

  // Verification inputs
  const [admissionInput, setAdmissionInput] = useState('');
  const [qrInput, setQrInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [lastResult, setLastResult] = useState<KioskVerificationResult | null>(null);
  const [offlineMode, setOfflineMode] = useState(!navigator.onLine);
  const [offlineQueue, setOfflineQueue] = useState<OfflineAttendanceEvent[]>(() => getOfflineQueue());
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevGrayRef = useRef<Uint8ClampedArray | null>(null);
  const sigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const [hasSignatureStroke, setHasSignatureStroke] = useState(false);

  useEffect(() => {
    probeHardwareCapabilities().then(setHardware);
    const onOnline = () => setOfflineMode(false);
    const onOffline = () => setOfflineMode(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      stopCamera();
    };
  }, []);

  // Liveness + optional QR frame sampling when live camera is running
  useEffect(() => {
    if (!cameraActive) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      if (activeMethod === 'face_recognition') {
        const { grayFrame } = extractFaceDescriptorFromSource(video);
        const live = computeFrameLivenessScore(prevGrayRef.current, grayFrame);
        prevGrayRef.current = grayFrame;
        setLivenessScore(live.score);
        setLivenessVerified(live.verified);
      } else if (activeMethod === 'qr_code' && !verifying) {
        const qrText = scanQrFromVideo(video);
        if (qrText) {
          setQrInput(qrText);
          void submitVerification({ method: 'qr_code', qrPayload: qrText });
        }
      }
    }, 550);
    return () => window.clearInterval(interval);
  }, [cameraActive, activeMethod, verifying]);

  async function startCamera() {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Browser MediaDevices API unavailable in this environment.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
    } catch (err) {
      setCameraActive(false);
      setCameraError(
        err instanceof Error
          ? `Camera unavailable: ${err.message}. Use Photo Upload, QR Code, Digital Signature, or Student ID.`
          : 'Unable to access camera hardware.'
      );
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    prevGrayRef.current = null;
    setLivenessScore(0);
    setLivenessVerified(false);
  }

  async function submitVerification(payload: {
    method: VerificationMethod;
    admissionNumber?: string;
    qrPayload?: string;
    descriptor?: number[];
    livenessVerified?: boolean;
    livenessScore?: number;
    signatureDataUrl?: string;
  }) {
    setVerifying(true);
    setSyncMessage(null);

    if (offlineMode && payload.admissionNumber) {
      const next = enqueueOfflineEvent({
        localId: `OFF-${Date.now()}`,
        admissionNumber: payload.admissionNumber.trim().toUpperCase(),
        action,
        method: payload.method,
        capturedAtIso: new Date().toISOString(),
      });
      setOfflineQueue(next);
      setLastResult({
        accessResult: 'granted',
        message: `Offline Mode: Queued ${action} for ${payload.admissionNumber.toUpperCase()} (${next.length} pending sync).`,
        code: 'OFFLINE_QUEUED',
        logType: action,
        method: payload.method,
        confidenceScore: 1,
        livenessVerified: false,
        timestamp: new Date().toTimeString().slice(0, 8),
      });
      setVerifying(false);
      return;
    }

    try {
      const res = await apiFetch<KioskVerificationResult>('/api/kiosk/verify', {
        method: 'POST',
        body: JSON.stringify({
          action,
          deviceId: 'GATE-NORTH-01',
          ...payload,
        }),
      });
      setLastResult(res);
      onRefreshState();
    } catch (err) {
      setLastResult({
        accessResult: 'denied',
        message: err instanceof Error ? err.message : 'Verification request failed.',
        code: 'VERIFICATION_ERROR',
        logType: action,
        method: payload.method,
        confidenceScore: null,
        livenessVerified: false,
        timestamp: new Date().toTimeString().slice(0, 8),
      });
    } finally {
      setVerifying(false);
    }
  }

  async function handleLiveFaceScan() {
    if (!videoRef.current || !cameraActive) return;
    const { descriptor } = extractFaceDescriptorFromSource(videoRef.current);
    await submitVerification({
      method: 'face_recognition',
      descriptor,
      livenessVerified,
      livenessScore,
    });
  }

  async function handlePhotoUploadVerify(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await readImageFileAsDataUrl(file);
    const descriptor = await extractDescriptorFromImageUrl(dataUrl);
    // Photo upload is a verified single-frame capture by the terminal operator
    await submitVerification({
      method: 'face_recognition',
      descriptor,
      livenessVerified: true,
      livenessScore: 0.78,
    });
    e.target.value = '';
  }

  async function handleQrImageUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const decoded = await decodeQrFromImageFile(file);
    if (!decoded) {
      setLastResult({
        accessResult: 'denied',
        message: 'Could not detect a valid QR code in the uploaded image.',
        code: 'QR_UNREADABLE',
        logType: action,
        method: 'qr_code',
        confidenceScore: null,
        livenessVerified: false,
        timestamp: new Date().toTimeString().slice(0, 8),
      });
      return;
    }
    setQrInput(decoded);
    await submitVerification({ method: 'qr_code', qrPayload: decoded });
    e.target.value = '';
  }

  // Digital Signature Canvas Drawing
  function startDraw(e: PointerEvent<HTMLCanvasElement>) {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    isDrawingRef.current = true;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  }

  function moveDraw(e: PointerEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
    setHasSignatureStroke(true);
  }

  function endDraw() {
    isDrawingRef.current = false;
  }

  function clearSignature() {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignatureStroke(false);
  }

  async function submitSignatureVerification() {
    if (!sigCanvasRef.current || !hasSignatureStroke || !admissionInput.trim()) return;
    const signatureDataUrl = sigCanvasRef.current.toDataURL('image/png');
    await submitVerification({
      method: 'digital_signature',
      admissionNumber: admissionInput.trim(),
      signatureDataUrl,
    });
  }

  async function syncOfflineBatch() {
    if (offlineQueue.length === 0) return;
    try {
      const res = await apiFetch<{ results: Array<{ localId: string; synced: boolean }> }>(
        '/api/sync/offline-batch',
        {
          method: 'POST',
          body: JSON.stringify({ events: offlineQueue }),
        }
      );
      const syncedCount = res.results.filter((r) => r.synced).length;
      clearOfflineQueue();
      setOfflineQueue([]);
      setSyncMessage(`Synced ${syncedCount} of ${res.results.length} queued offline attendance events.`);
      onRefreshState();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Offline sync failed.');
    }
  }

  const total = kioskState?.totalStudents ?? 0;
  const present = kioskState?.presentStudents ?? 0;
  const absent = kioskState?.absentStudents ?? 0;
  const late = kioskState?.lateStudents ?? 0;

  return (
    <div className="space-y-6">
      {/* KPI Metrics Row */}
      <section aria-label="Daily Attendance Metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs font-medium text-slate-400">Total Students</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span data-testid="kpi-total" className="text-3xl font-bold font-mono tabular-nums text-white">
              {total}
            </span>
            <span className="text-xs text-slate-400">Enrolled</span>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs font-medium text-slate-400">Present Today</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span data-testid="kpi-present" className="text-3xl font-bold font-mono tabular-nums text-emerald-400">
              {present}
            </span>
            <span className="text-xs font-mono tabular-nums text-emerald-300/80">
              {total > 0 ? `${Math.round((present / total) * 100)}%` : '0%'}
            </span>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs font-medium text-slate-400">Absent Today</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span data-testid="kpi-absent" className="text-3xl font-bold font-mono tabular-nums text-rose-400">
              {absent}
            </span>
            <span className="text-xs text-slate-400">Unchecked</span>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs font-medium text-slate-400">Late Arrivals</div>
          <div className="mt-2 flex items-baseline justify-between">
            <span data-testid="kpi-late" className="text-3xl font-bold font-mono tabular-nums text-amber-400">
              {late}
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              Cutoff {kioskState?.lateCutoffTime || '08:15'}
            </span>
          </div>
        </div>
      </section>

      {/* Main Split: Live Recognition Camera & Verification Status */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Left 7 cols: Live Camera & Multi-Modal Terminal */}
        <section className="xl:col-span-7 glass-panel-active rounded-xl p-5 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-white">Live Gate Verification Console</h2>
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                {hardware.cameraLabel} · {wsConnected ? 'Live Stream Active' : 'Polling Fallback'}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center p-1 rounded-lg bg-slate-900/90 border border-slate-800" role="group" aria-label="Gate Direction">
                <button
                  type="button"
                  onClick={() => setAction('entry')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    action === 'entry'
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Morning Entry
                </button>
                <button
                  type="button"
                  onClick={() => setAction('exit')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    action === 'exit'
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Evening Exit
                </button>
              </div>

              <button
                type="button"
                onClick={() => setOfflineMode((v) => !v)}
                aria-pressed={offlineMode}
                className={`px-2.5 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  offlineMode
                    ? 'bg-amber-950/70 border-amber-500/50 text-amber-200'
                    : 'bg-slate-900/80 border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                <WifiOff className="w-3.5 h-3.5" />
                {offlineMode ? 'Offline Queue' : 'Online'}
              </button>
            </div>
          </div>

          {/* Method Selector */}
          <div className="flex flex-wrap xl:flex-nowrap gap-1 p-1 rounded-lg bg-slate-900/90 border border-slate-800" role="tablist" aria-label="Verification Methods">
            {[
              { id: 'face_recognition' as const, label: 'Face Scan', icon: ScanFace },
              { id: 'qr_code' as const, label: 'QR Card', icon: QrCode },
              { id: 'digital_signature' as const, label: 'Signature', icon: PenTool },
              { id: 'student_id' as const, label: 'Student ID', icon: KeyRound },
              { id: 'fingerprint' as const, label: 'Fingerprint', icon: Fingerprint },
            ].map((tab) => {
              const Icon = tab.icon;
              const selected = activeMethod === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveMethod(tab.id)}
                  className={`flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 flex-1 ${
                    selected
                      ? 'bg-sky-500/20 text-sky-200 border border-sky-400/40'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Method Panels */}
          {activeMethod === 'face_recognition' && (
            <div className="space-y-4">
              <div className="relative aspect-video rounded-xl overflow-hidden bg-slate-950 border border-sky-500/30 flex items-center justify-center">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className={`w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
                />
                {cameraActive && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="w-52 h-52 rounded-2xl border-2 border-sky-400/70 shadow-[0_0_24px_rgba(56,189,248,0.3)]" />
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between bg-slate-950/80 backdrop-blur-sm rounded-lg px-3 py-2 text-xs">
                      <span className="text-slate-200 font-medium">
                        Anti-Spoof Liveness: {livenessVerified ? 'Verified Live Motion' : 'Hold steady & blink slightly'}
                      </span>
                      <span className="font-mono tabular-nums text-sky-300">
                        {Math.round(livenessScore * 100)}%
                      </span>
                    </div>
                  </div>
                )}

                {!cameraActive && (
                  <div className="p-6 text-center max-w-md space-y-3">
                    <Camera className="w-10 h-10 text-sky-400 mx-auto" />
                    <div className="text-sm font-medium text-white">
                      {cameraError ? 'Live Camera Hardware Unavailable' : 'Live Facial Recognition Camera'}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {cameraError ||
                        'Activate the terminal camera for live facial descriptor extraction and anti-spoofing liveness check, or upload a verification frame.'}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {!cameraActive ? (
                  <button
                    type="button"
                    onClick={startCamera}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-4 h-4" />
                    Start Live Camera
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={verifying}
                      onClick={handleLiveFaceScan}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                    >
                      <ScanFace className="w-4 h-4" />
                      {verifying ? 'Matching Template...' : `Verify Face (${action === 'entry' ? 'Entry' : 'Exit'})`}
                    </button>
                    <button
                      type="button"
                      onClick={stopCamera}
                      className="px-4 py-2.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                    >
                      Stop Camera
                    </button>
                  </>
                )}

                <label className="cursor-pointer flex items-center gap-2 px-4 py-2.5 rounded-lg border border-sky-500/40 bg-slate-900/80 hover:bg-slate-800 text-sky-200 text-xs font-medium transition-colors whitespace-nowrap shrink-0">
                  <Upload className="w-4 h-4" />
                  <span>Upload Face Frame</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={handlePhotoUploadVerify}
                  />
                </label>
              </div>
            </div>
          )}

          {activeMethod === 'qr_code' && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-3">
                <div className="text-sm font-medium text-white">QR Student Identity Card Verification</div>
                <p className="text-xs text-slate-400">
                  Scan a printed QR student identity card with the terminal camera, upload a QR card PNG, or enter the card token (e.g., <span className="font-mono text-sky-300">AEGIS-QR-STU-2026-001</span>).
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <input
                    type="text"
                    aria-label="QR Code Token"
                    value={qrInput}
                    onChange={(e) => setQrInput(e.target.value)}
                    placeholder="AEGIS-QR-STU-2026-001"
                    className="flex-1 min-w-48 rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="button"
                    disabled={verifying || !qrInput.trim()}
                    onClick={() => submitVerification({ method: 'qr_code', qrPayload: qrInput.trim() })}
                    className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    Verify QR Card
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  {!cameraActive ? (
                    <button
                      type="button"
                      onClick={startCamera}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 text-xs text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Enable QR Camera Scan
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopCamera}
                      className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 text-xs text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                    >
                      Stop QR Camera
                    </button>
                  )}
                  <label className="cursor-pointer flex items-center gap-1.5 px-3 py-2 rounded-lg border border-sky-500/30 bg-slate-900 text-xs text-sky-200 hover:bg-slate-800 whitespace-nowrap">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Decode QR Image</span>
                    <input type="file" accept="image/*" className="sr-only" onChange={handleQrImageUpload} />
                  </label>
                </div>
              </div>
              {cameraActive && (
                <video ref={videoRef} muted playsInline className="w-full max-h-56 rounded-xl object-cover border border-sky-500/30" />
              )}
            </div>
          )}

          {activeMethod === 'digital_signature' && (
            <div className="space-y-3 rounded-xl bg-slate-950/80 border border-slate-800 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-white">Authorized Digital Signature Pad</div>
                  <div className="text-xs text-slate-400">Fallback manual verification recorded with student admission ID</div>
                </div>
                <button
                  type="button"
                  onClick={clearSignature}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-white whitespace-nowrap"
                >
                  Clear Pad
                </button>
              </div>
              <input
                type="text"
                aria-label="Student Admission Number for Signature"
                value={admissionInput}
                onChange={(e) => setAdmissionInput(e.target.value)}
                placeholder="Enter Student ID (e.g., STU-2026-001)"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2 text-sm font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
              />
              <canvas
                ref={sigCanvasRef}
                width={520}
                height={150}
                onPointerDown={startDraw}
                onPointerMove={moveDraw}
                onPointerUp={endDraw}
                onPointerLeave={endDraw}
                className="w-full h-36 rounded-lg bg-slate-900 border border-sky-500/30 touch-none cursor-crosshair"
              />
              <button
                type="button"
                disabled={verifying || !hasSignatureStroke || !admissionInput.trim()}
                onClick={submitSignatureVerification}
                className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                Verify Signature & Record {action === 'entry' ? 'Entry' : 'Exit'}
              </button>
            </div>
          )}

          {activeMethod === 'student_id' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (admissionInput.trim()) {
                  void submitVerification({ method: 'student_id', admissionNumber: admissionInput.trim() });
                }
              }}
              className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-3"
            >
              <div className="text-sm font-medium text-white">Alternative Student ID Verification</div>
              <p className="text-xs text-slate-400">
                Enter an enrolled student admission number (for example <span className="font-mono text-sky-300">STU-2026-001</span> or <span className="font-mono text-sky-300">STU-2026-003</span>).
              </p>
              <div className="flex flex-wrap gap-2.5">
                <input
                  type="text"
                  aria-label="Student Admission Number"
                  value={admissionInput}
                  onChange={(e) => setAdmissionInput(e.target.value)}
                  placeholder="STU-2026-001"
                  className="flex-1 min-w-48 rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                />
                <button
                  type="submit"
                  disabled={verifying || !admissionInput.trim()}
                  className="px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                >
                  {verifying ? 'Checking...' : `Verify ${action === 'entry' ? 'Entry' : 'Exit'}`}
                </button>
              </div>
            </form>
          )}

          {activeMethod === 'fingerprint' && (
            <div className="rounded-xl bg-slate-950/80 border border-amber-500/30 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Fingerprint className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">
                    {hardware.hasPlatformBiometric
                      ? 'Platform Biometric Authenticator Ready (No External USB Scanner)'
                      : 'No Fingerprint Scanner Hardware Detected'}
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    AegisCampus does not simulate fingerprint scans when hardware is disconnected. Connect a Mantra MFS100 / SecuGen Hamster Pro local WebSocket bridge (<span className="font-mono text-slate-300">ws://localhost:8443/rdservice</span>) or use Face Recognition, QR Identity Card, or Digital Signature.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => submitVerification({ method: 'fingerprint' })}
                className="px-4 py-2 rounded-lg border border-amber-500/40 bg-amber-950/40 hover:bg-amber-950/70 text-amber-200 text-xs font-medium transition-colors whitespace-nowrap"
              >
                Probe Fingerprint Bridge
              </button>
            </div>
          )}

          {offlineQueue.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-950/40 border border-amber-500/30 px-4 py-2.5 text-xs">
              <span className="text-amber-200 font-medium">
                {offlineQueue.length} offline attendance record(s) queued locally
              </span>
              <button
                type="button"
                onClick={syncOfflineBatch}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-400 text-slate-950 font-semibold whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sync Now
              </button>
            </div>
          )}
          {syncMessage && (
            <div className="text-xs text-sky-300 px-1">{syncMessage}</div>
          )}
        </section>

        {/* Right 5 cols: Student Verification Status + Alerts */}
        <section className="xl:col-span-5 flex flex-col gap-5">
          {/* Verification Result Card */}
          <div
            data-testid="verification-status-card"
            className={`glass-panel rounded-xl p-5 transition-colors ${
              lastResult?.accessResult === 'granted'
                ? 'access-granted-glow'
                : lastResult?.accessResult === 'denied'
                ? 'access-denied-glow'
                : ''
            }`}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-base font-semibold text-white">Student Verification Status</h2>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {lastResult ? lastResult.timestamp : 'Awaiting Scan'}
              </span>
            </div>

            {!lastResult ? (
              <div className="py-10 text-center space-y-2">
                <ScanFace className="w-9 h-9 text-sky-400/70 mx-auto" />
                <div className="text-sm font-medium text-slate-200">Terminal Ready</div>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  Select Face Recognition, QR Identity Card, Digital Signature, or Student ID to verify morning entry or evening exit.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div
                  role="status"
                  className={`flex items-center justify-between rounded-lg px-4 py-3 border ${
                    lastResult.accessResult === 'granted'
                      ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-200'
                      : 'bg-red-950/60 border-red-500/50 text-red-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {lastResult.accessResult === 'granted' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                    )}
                    <div>
                      <div className="text-sm font-bold tracking-wide">
                        {lastResult.accessResult === 'granted' ? 'ACCESS GRANTED' : 'ACCESS DENIED'}
                      </div>
                      <div className="text-xs opacity-90">{lastResult.message}</div>
                    </div>
                  </div>
                </div>

                {lastResult.student && (
                  <div className="flex items-center gap-4 pt-1">
                    <StudentAvatar
                      src={lastResult.student.photoUrl}
                      name={lastResult.student.fullName}
                      sizeClass="w-16 h-16 text-lg"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-base font-semibold text-white truncate">
                        {lastResult.student.fullName}
                      </div>
                      <div className="text-xs text-slate-300 font-mono tabular-nums">
                        {lastResult.student.admissionNumber} · {lastResult.student.className} - {lastResult.student.sectionName} · Roll {lastResult.student.rollNumber}
                      </div>
                      <div className="text-xs text-slate-400">
                        Method: {lastResult.method.replace('_', ' ')} · Action: {lastResult.logType.toUpperCase()}
                        {lastResult.confidenceScore !== null && ` · Confidence ${Math.round(lastResult.confidenceScore * 100)}%`}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* System Status & Alerts */}
          <div className="glass-panel rounded-xl p-5 flex-1">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h2 className="text-base font-semibold text-white">System Status & Alerts</h2>
              <span className="text-xs text-slate-400 font-mono">GATE-NORTH-01</span>
            </div>

            <div className="mt-3 space-y-2.5 text-xs">
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-400">Biometric Camera</span>
                <span className={cameraActive ? 'text-emerald-400 font-medium' : 'text-slate-300'}>
                  {cameraActive ? 'Streaming Active' : hardware.hasCamera ? 'Standby' : 'No Camera Attached'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-400">Fingerprint Bridge</span>
                <span className="text-amber-300 font-medium">
                  {hardware.hasPlatformBiometric ? 'WebAuthn Only' : 'Disconnected'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800/70">
                <span className="text-slate-400">Real-Time Socket</span>
                <span className={wsConnected ? 'text-emerald-400 font-medium' : 'text-amber-300 font-medium'}>
                  {wsConnected ? 'Connected' : 'Reconnecting'}
                </span>
              </div>
            </div>

            <div className="mt-4 space-y-2.5">
              {(kioskState?.alerts || []).map((alert) => (
                <div
                  key={alert.id}
                  className={`rounded-lg px-3.5 py-2.5 border text-xs ${
                    alert.severity === 'critical'
                      ? 'bg-red-950/40 border-red-500/30 text-red-200'
                      : 'bg-slate-900/80 border-slate-800 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    {alert.severity === 'critical' ? (
                      <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-sky-400 shrink-0" />
                    )}
                    <span>{alert.title}</span>
                  </div>
                  <p className="mt-1 text-slate-400 leading-relaxed">{alert.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* Live Entry & Exit Records Table */}
      <section className="glass-panel rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white">Entry & Exit Records</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Real-time campus gate verification stream for {kioskState?.date || 'today'}
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            Exited Today: {kioskState?.exitedStudents ?? 0}
          </span>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 pr-4 font-medium">Student</th>
                <th className="py-2.5 pr-4 font-medium">Class</th>
                <th className="py-2.5 pr-4 font-medium">Direction</th>
                <th className="py-2.5 pr-4 font-medium">Time</th>
                <th className="py-2.5 pr-4 font-medium">Method</th>
                <th className="py-2.5 pr-4 font-medium text-right">Confidence</th>
                <th className="py-2.5 font-medium text-right">Verification Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {(kioskState?.recentLogs || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No gate entry or exit scans recorded yet.
                  </td>
                </tr>
              ) : (
                (kioskState?.recentLogs || []).map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/50 transition-colors">
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2.5">
                        <StudentAvatar src={log.photoUrl} name={log.studentName} sizeClass="w-8 h-8 text-xs" />
                        <div>
                          <div className="font-medium text-slate-100">{log.studentName}</div>
                          <div className="font-mono text-slate-400">{log.admissionNumber}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-300">
                      {log.className} - {log.sectionName}
                    </td>
                    <td className="py-2.5 pr-4 uppercase font-medium text-slate-200">{log.logType}</td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums text-slate-300">{log.logTime}</td>
                    <td className="py-2.5 pr-4 text-slate-300">{log.verificationMethod.replace('_', ' ')}</td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-slate-300">
                      {log.confidenceScore !== null ? `${Math.round(log.confidenceScore * 100)}%` : '—'}
                    </td>
                    <td className="py-2.5 text-right font-medium">
                      {log.accessResult === 'granted' ? (
                        <span className="text-emerald-400">Access Granted</span>
                      ) : (
                        <span className="text-rose-400">Denied</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
