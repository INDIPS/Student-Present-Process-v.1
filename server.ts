import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { backup } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  decryptBiometricTemplate,
  encryptBiometricTemplate,
  hashPassword,
  sha256Hex,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
  type SessionTokenPayload,
} from './src/server/crypto.ts';
import { DB_FILE_PATH, getDb, SCHEMA_SQL } from './src/server/db.ts';
import { seedDatabaseIfEmpty } from './src/server/seed.ts';
import {
  calculateAttendanceMetrics,
  evaluateEntryExitTransition,
  findBestFacialMatch,
  validateStudentRegistration,
} from './src/shared/attendanceRules.ts';
import type {
  AttendanceStatus,
  EntryExitLogItem,
  KioskDashboardState,
  OfflineAttendanceEvent,
  VerificationMethod,
} from './src/shared/types.ts';

interface AuthedRequest extends Request {
  user?: SessionTokenPayload;
}

const db = getDb();
seedDatabaseIfEmpty(db);

const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWs(type: string, payload: unknown): void {
  const frame = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frame);
    }
  }
}

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'connected',
      payload: { clients: wss.clients.size },
      timestamp: new Date().toISOString(),
    })
  );
});

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentHHMMSS(): string {
  return new Date().toTimeString().slice(0, 8);
}

function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

function logActivity(
  actorEmail: string,
  actorRole: string,
  action: string,
  targetEntity: string,
  details: string
): void {
  db.prepare(
    'INSERT INTO activity_logs (actor_email, actor_role, action, target_entity, details) VALUES (?, ?, ?, ?, ?)'
  ).run(actorEmail, actorRole, action, targetEntity, details);
}

function parseBearerUser(req: Request): SessionTokenPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return verifySessionToken(token);
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = parseBearerUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required. Session missing or expired.' });
    return;
  }
  req.user = user;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = parseBearerUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required for this action.' });
    return;
  }
  req.user = user;
  next();
}

function buildKioskState(branchId?: number): KioskDashboardState {
  const today = getTodayDate();
  const lateCutoff = getSetting('late_cutoff_time', '08:15');

  const branchFilter = branchId ? 'AND s.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM students s WHERE s.status = 'active' ${branchFilter}`)
    .get(...params) as { count: number };

  const presentRow = db
    .prepare(
      `SELECT COUNT(DISTINCT a.student_id) AS count
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.attendance_date = ? AND a.subject_id IS NULL AND a.status IN ('present', 'late') ${branchFilter}`
    )
    .get(today, ...params) as { count: number };

  const lateRow = db
    .prepare(
      `SELECT COUNT(DISTINCT a.student_id) AS count
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.attendance_date = ? AND a.subject_id IS NULL AND a.status = 'late' ${branchFilter}`
    )
    .get(today, ...params) as { count: number };

  const exitedRow = db
    .prepare(
      `SELECT COUNT(DISTINCT l.student_id) AS count
       FROM entry_exit_logs l
       JOIN students s ON s.id = l.student_id
       WHERE l.log_date = ? AND l.log_type = 'exit' AND l.access_result = 'granted' ${branchFilter}`
    )
    .get(today, ...params) as { count: number };

  const recentLogsRaw = db
    .prepare(
      `SELECT
        l.id, l.student_id AS studentId, s.admission_number AS admissionNumber,
        s.full_name AS studentName, s.photo_url AS photoUrl,
        c.name AS className, sec.name AS sectionName,
        l.log_date AS logDate, l.log_type AS logType, l.log_time AS logTime,
        l.verification_method AS verificationMethod, l.confidence_score AS confidenceScore,
        l.liveness_verified AS livenessVerified, l.access_result AS accessResult,
        l.denial_reason AS denialReason, b.name AS branchName, l.device_id AS deviceId
       FROM entry_exit_logs l
       JOIN students s ON s.id = l.student_id
       JOIN classes c ON c.id = s.class_id
       JOIN sections sec ON sec.id = s.section_id
       JOIN school_branches b ON b.id = l.branch_id
       WHERE 1=1 ${branchFilter}
       ORDER BY l.id DESC
       LIMIT 30`
    )
    .all(...params) as Array<Omit<EntryExitLogItem, 'livenessVerified'> & { livenessVerified: number }>;

  const recentLogs: EntryExitLogItem[] = recentLogsRaw.map((row) => ({
    ...row,
    livenessVerified: Boolean(row.livenessVerified),
  }));

  const deniedRecent = recentLogs.filter((l) => l.accessResult === 'denied').slice(0, 3);
  const alerts: KioskDashboardState['alerts'] = [
    ...deniedRecent.map((d) => ({
      id: `denied-${d.id}`,
      severity: 'critical' as const,
      title: `Verification Denied · ${d.studentName}`,
      detail: d.denialReason || 'Verification policy check failed at gate.',
      timestamp: `${d.logDate} ${d.logTime}`,
    })),
    {
      id: 'cutoff-policy',
      severity: 'info',
      title: 'Morning Gate Cutoff Active',
      detail: `Arrivals after ${lateCutoff} are automatically classified as Late and notify parents.`,
      timestamp: today,
    },
  ];

  const totalStudents = totalRow.count;
  const presentStudents = presentRow.count;
  const lateStudents = lateRow.count;
  const absentStudents = Math.max(0, totalStudents - presentStudents);

  return {
    date: today,
    lateCutoffTime: lateCutoff,
    totalStudents,
    presentStudents,
    absentStudents,
    lateStudents,
    exitedStudents: exitedRow.count,
    recentLogs,
    alerts,
  };
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();

  const admin = db
    .prepare('SELECT id, email, full_name, password_hash, branch_id, is_active FROM administrators WHERE lower(email) = ?')
    .get(normalizedEmail) as
    | { id: number; email: string; full_name: string; password_hash: string; branch_id: number; is_active: number }
    | undefined;

  if (admin) {
    if (!admin.is_active || !verifyPassword(password, admin.password_hash)) {
      logActivity(normalizedEmail, 'unknown', 'LOGIN_FAILED', 'administrators', 'Invalid administrator credentials.');
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    const token = signSessionToken({
      userId: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      role: 'admin',
      assignedClassIds: [],
      assignedSectionIds: [],
      branchId: admin.branch_id,
    });
    const decoded = verifySessionToken(token)!;
    logActivity(admin.email, 'admin', 'LOGIN_SUCCESS', `administrators:${admin.id}`, 'Administrator signed in.');
    res.json({ token, user: decoded });
    return;
  }

  const teacher = db
    .prepare(
      `SELECT id, email, full_name, password_hash, branch_id, assigned_class_ids_json, assigned_section_ids_json, is_active
       FROM teachers WHERE lower(email) = ?`
    )
    .get(normalizedEmail) as
    | {
        id: number;
        email: string;
        full_name: string;
        password_hash: string;
        branch_id: number;
        assigned_class_ids_json: string;
        assigned_section_ids_json: string;
        is_active: number;
      }
    | undefined;

  if (teacher) {
    if (!teacher.is_active || !verifyPassword(password, teacher.password_hash)) {
      logActivity(normalizedEmail, 'unknown', 'LOGIN_FAILED', 'teachers', 'Invalid teacher credentials.');
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    const assignedClassIds = JSON.parse(teacher.assigned_class_ids_json) as number[];
    const assignedSectionIds = JSON.parse(teacher.assigned_section_ids_json) as number[];
    const token = signSessionToken({
      userId: teacher.id,
      email: teacher.email,
      fullName: teacher.full_name,
      role: 'teacher',
      assignedClassIds,
      assignedSectionIds,
      branchId: teacher.branch_id,
    });
    const decoded = verifySessionToken(token)!;
    logActivity(teacher.email, 'teacher', 'LOGIN_SUCCESS', `teachers:${teacher.id}`, 'Faculty member signed in.');
    res.json({ token, user: decoded });
    return;
  }

  res.status(401).json({ error: 'No active administrator or teacher account found for that email.' });
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  const user = parseBearerUser(req);
  if (user) {
    logActivity(user.email, user.role, 'LOGOUT', `${user.role}:${user.userId}`, 'User signed out.');
  }
  res.json({ ok: true });
});

// ---------- BOOTSTRAP REFERENCE DATA ----------
app.get('/api/bootstrap', (_req, res) => {
  const branches = db.prepare('SELECT id, name, code, city FROM school_branches ORDER BY id').all();
  const sessions = db
    .prepare('SELECT id, name, start_date AS startDate, end_date AS endDate, is_active AS isActive FROM academic_sessions ORDER BY is_active DESC, id DESC')
    .all();
  const classes = db
    .prepare('SELECT id, name, grade_level AS gradeLevel, branch_id AS branchId FROM classes ORDER BY grade_level')
    .all();
  const sections = db
    .prepare('SELECT id, class_id AS classId, name, room_number AS roomNumber FROM sections ORDER BY class_id, name')
    .all();
  const subjects = db
    .prepare('SELECT id, class_id AS classId, name, code FROM subjects ORDER BY class_id, name')
    .all();
  const settingsRows = db.prepare('SELECT key, value FROM system_settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  res.json({ branches, sessions, classes, sections, subjects, settings });
});

// ---------- KIOSK & MULTI-MODAL VERIFICATION ----------
app.get('/api/kiosk/state', (req, res) => {
  const branchId = req.query.branchId ? Number(req.query.branchId) : undefined;
  res.json(buildKioskState(branchId));
});

function executeStudentEntryExit(params: {
  studentId: number;
  action: 'entry' | 'exit';
  method: VerificationMethod;
  confidenceScore: number | null;
  livenessVerified: boolean;
  deviceId: string;
  overrideTimeHHMM?: string;
}) {
  const today = getTodayDate();
  const nowTime = params.overrideTimeHHMM ? `${params.overrideTimeHHMM}:00` : getCurrentHHMMSS();
  const currentHHMM = nowTime.slice(0, 5);
  const lateCutoff = getSetting('late_cutoff_time', '08:15');
  const earlyCutoff = getSetting('early_departure_cutoff_time', '13:30');

  const student = db
    .prepare(
      `SELECT
        s.id, s.admission_number AS admissionNumber, s.full_name AS fullName,
        s.photo_url AS photoUrl, s.class_id AS classId, s.section_id AS sectionId,
        s.roll_number AS rollNumber, s.branch_id AS branchId,
        c.name AS className, sec.name AS sectionName, b.name AS branchName,
        p.primary_phone AS primaryPhone, p.parent_email AS parentEmail
       FROM students s
       JOIN classes c ON c.id = s.class_id
       JOIN sections sec ON sec.id = s.section_id
       JOIN school_branches b ON b.id = s.branch_id
       JOIN parents p ON p.student_id = s.id
       WHERE s.id = ? AND s.status = 'active'`
    )
    .get(params.studentId) as
    | {
        id: number;
        admissionNumber: string;
        fullName: string;
        photoUrl: string;
        classId: number;
        sectionId: number;
        rollNumber: string;
        branchId: number;
        className: string;
        sectionName: string;
        branchName: string;
        primaryPhone: string;
        parentEmail: string;
      }
    | undefined;

  if (!student) {
    return {
      statusCode: 404,
      result: {
        accessResult: 'denied' as const,
        message: 'Student record not found or inactive.',
        code: 'STUDENT_NOT_FOUND',
        logType: params.action,
        method: params.method,
        confidenceScore: params.confidenceScore,
        livenessVerified: params.livenessVerified,
        timestamp: nowTime,
      },
    };
  }

  const entryRow = db
    .prepare(
      `SELECT log_time FROM entry_exit_logs
       WHERE student_id = ? AND log_date = ? AND log_type = 'entry' AND access_result = 'granted'
       ORDER BY id ASC LIMIT 1`
    )
    .get(student.id, today) as { log_time: string } | undefined;

  const exitRow = db
    .prepare(
      `SELECT log_time FROM entry_exit_logs
       WHERE student_id = ? AND log_date = ? AND log_type = 'exit' AND access_result = 'granted'
       ORDER BY id ASC LIMIT 1`
    )
    .get(student.id, today) as { log_time: string } | undefined;

  const evaluation = evaluateEntryExitTransition({
    action: params.action,
    existingEntryTime: entryRow?.log_time ?? null,
    existingExitTime: exitRow?.log_time ?? null,
    currentHHMM,
    lateCutoffHHMM: lateCutoff,
    earlyDepartureCutoffHHMM: earlyCutoff,
  });

  if (!evaluation.allowed) {
    db.prepare(
      `INSERT INTO entry_exit_logs (
        student_id, log_date, log_type, log_time, verification_method,
        confidence_score, liveness_verified, access_result, denial_reason, branch_id, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?)`
    ).run(
      student.id,
      today,
      params.action,
      nowTime,
      params.method,
      params.confidenceScore,
      params.livenessVerified ? 1 : 0,
      evaluation.reason,
      student.branchId,
      params.deviceId
    );

    const kioskState = buildKioskState();
    broadcastWs('attendance:update', kioskState);

    return {
      statusCode: 200,
      result: {
        accessResult: 'denied' as const,
        message: evaluation.reason,
        code: evaluation.code,
        logType: params.action,
        method: params.method,
        confidenceScore: params.confidenceScore,
        livenessVerified: params.livenessVerified,
        timestamp: nowTime,
        student: {
          id: student.id,
          admissionNumber: student.admissionNumber,
          fullName: student.fullName,
          photoUrl: student.photoUrl,
          className: student.className,
          sectionName: student.sectionName,
          rollNumber: student.rollNumber,
          primaryPhone: student.primaryPhone,
        },
      },
    };
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare(
      `INSERT INTO entry_exit_logs (
        student_id, log_date, log_type, log_time, verification_method,
        confidence_score, liveness_verified, access_result, branch_id, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'granted', ?, ?)`
    ).run(
      student.id,
      today,
      params.action,
      nowTime,
      params.method,
      params.confidenceScore,
      params.livenessVerified ? 1 : 0,
      student.branchId,
      params.deviceId
    );

    if (params.action === 'entry' && evaluation.attendanceStatus) {
      const existingDaily = db
        .prepare(
          'SELECT id FROM attendance WHERE student_id = ? AND attendance_date = ? AND subject_id IS NULL'
        )
        .get(student.id, today) as { id: number } | undefined;

      if (existingDaily) {
        db.prepare(
          `UPDATE attendance SET status = ?, source = ?, marked_by = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(evaluation.attendanceStatus, params.method, `device:${params.deviceId}`, existingDaily.id);
      } else {
        db.prepare(
          `INSERT INTO attendance (student_id, class_id, section_id, subject_id, attendance_date, status, source, marked_by)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
        ).run(
          student.id,
          student.classId,
          student.sectionId,
          today,
          evaluation.attendanceStatus,
          params.method,
          `device:${params.deviceId}`
        );
      }
    }

    if (getSetting('auto_parent_notifications', 'true') === 'true') {
      const eventType =
        params.action === 'exit'
          ? 'exit'
          : evaluation.attendanceStatus === 'late'
          ? 'late'
          : 'entry';
      const notifMsg =
        eventType === 'entry'
          ? `AegisCampus: ${student.fullName} (${student.admissionNumber}) entered ${student.branchName} at ${nowTime}.`
          : eventType === 'late'
          ? `AegisCampus Alert: ${student.fullName} arrived late at ${nowTime} (cutoff ${lateCutoff}).`
          : `AegisCampus: ${student.fullName} exited ${student.branchName} at ${nowTime}.`;

      db.prepare(
        `INSERT INTO notifications (student_id, event_type, channel, recipient_phone, recipient_email, message, status)
         VALUES (?, ?, 'sms', ?, ?, ?, 'sent')`
      ).run(student.id, eventType, student.primaryPhone, student.parentEmail, notifMsg);
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const kioskState = buildKioskState();
  broadcastWs('attendance:update', kioskState);

  return {
    statusCode: 200,
    result: {
      accessResult: 'granted' as const,
      message: evaluation.reason,
      code: evaluation.code,
      logType: params.action,
      method: params.method,
      confidenceScore: params.confidenceScore,
      livenessVerified: params.livenessVerified,
      timestamp: nowTime,
      attendanceStatus: evaluation.attendanceStatus,
      student: {
        id: student.id,
        admissionNumber: student.admissionNumber,
        fullName: student.fullName,
        photoUrl: student.photoUrl,
        className: student.className,
        sectionName: student.sectionName,
        rollNumber: student.rollNumber,
        primaryPhone: student.primaryPhone,
      },
    },
  };
}

app.post('/api/kiosk/verify', (req, res) => {
  const {
    action = 'entry',
    method,
    admissionNumber,
    qrPayload,
    descriptor,
    livenessVerified = false,
    livenessScore = 0,
    signatureDataUrl,
    deviceId = 'GATE-NORTH-01',
    authorizedBy,
  } = req.body as {
    action?: 'entry' | 'exit';
    method: VerificationMethod;
    admissionNumber?: string;
    qrPayload?: string;
    descriptor?: number[];
    livenessVerified?: boolean;
    livenessScore?: number;
    signatureDataUrl?: string;
    deviceId?: string;
    authorizedBy?: string;
  };

  if (method === 'fingerprint') {
    res.status(503).json({
      accessResult: 'denied',
      code: 'HARDWARE_NOT_CONNECTED',
      message:
        'No physical fingerprint scanner hardware detected on this terminal. Connect a WebAuthn/HID scanner bridge or use Face, QR, or Digital Signature verification.',
      logType: action,
      method,
      confidenceScore: null,
      livenessVerified: false,
      timestamp: getCurrentHHMMSS(),
    });
    return;
  }

  if (method === 'face_recognition') {
    const threshold = Number(getSetting('face_similarity_threshold', '0.88'));
    const minLiveness = Number(getSetting('liveness_min_score', '0.55'));
    const rows = db
      .prepare(
        `SELECT sb.student_id AS studentId, s.admission_number AS admissionNumber, sb.encrypted_face_template AS enc
         FROM student_biometrics sb
         JOIN students s ON s.id = sb.student_id
         WHERE s.status = 'active' AND sb.encrypted_face_template IS NOT NULL`
      )
      .all() as Array<{ studentId: number; admissionNumber: string; enc: string }>;

    const candidates = rows
      .map((r) => ({
        studentId: r.studentId,
        admissionNumber: r.admissionNumber,
        descriptor: decryptBiometricTemplate<number[]>(r.enc) || [],
      }))
      .filter((c) => c.descriptor.length > 0);

    const match = findBestFacialMatch(descriptor || [], candidates, {
      similarityThreshold: threshold,
      livenessVerified: Boolean(livenessVerified),
      livenessScore: Number(livenessScore),
      minLivenessScore: minLiveness,
    });

    if (!match.matched || !match.studentId) {
      res.status(200).json({
        accessResult: 'denied',
        code: 'FACE_VERIFICATION_FAILED',
        message: match.reason,
        logType: action,
        method,
        confidenceScore: match.similarity,
        livenessVerified: Boolean(livenessVerified),
        timestamp: getCurrentHHMMSS(),
      });
      return;
    }

    const out = executeStudentEntryExit({
      studentId: match.studentId,
      action,
      method,
      confidenceScore: match.similarity,
      livenessVerified: Boolean(livenessVerified),
      deviceId,
    });
    res.status(out.statusCode).json(out.result);
    return;
  }

  if (method === 'qr_code') {
    const tokenValue = (qrPayload || '').trim();
    if (!tokenValue) {
      res.status(400).json({ error: 'QR code token payload is required.' });
      return;
    }
    const tokenHash = sha256Hex(tokenValue);
    const bio = db
      .prepare(
        `SELECT sb.student_id AS studentId FROM student_biometrics sb
         JOIN students s ON s.id = sb.student_id
         WHERE (sb.qr_token_hash = ? OR sb.qr_token_id = ? OR s.admission_number = ?) AND s.status = 'active'`
      )
      .get(tokenHash, tokenValue, tokenValue) as { studentId: number } | undefined;

    if (!bio) {
      res.status(200).json({
        accessResult: 'denied',
        code: 'INVALID_QR',
        message: 'Unrecognized student QR identity card.',
        logType: action,
        method,
        confidenceScore: 0,
        livenessVerified: true,
        timestamp: getCurrentHHMMSS(),
      });
      return;
    }

    const out = executeStudentEntryExit({
      studentId: bio.studentId,
      action,
      method,
      confidenceScore: 1,
      livenessVerified: true,
      deviceId,
    });
    res.status(out.statusCode).json(out.result);
    return;
  }

  if (method === 'digital_signature') {
    if (!admissionNumber?.trim() || !signatureDataUrl?.startsWith('data:image/')) {
      res.status(400).json({ error: 'Student ID and drawn digital signature are required.' });
      return;
    }
    const student = db
      .prepare("SELECT id FROM students WHERE upper(admission_number) = ? AND status = 'active'")
      .get(admissionNumber.trim().toUpperCase()) as { id: number } | undefined;

    if (!student) {
      res.status(200).json({
        accessResult: 'denied',
        code: 'STUDENT_NOT_FOUND',
        message: `No active student found with Admission ID ${admissionNumber}.`,
        logType: action,
        method,
        confidenceScore: null,
        livenessVerified: false,
        timestamp: getCurrentHHMMSS(),
      });
      return;
    }

    const out = executeStudentEntryExit({
      studentId: student.id,
      action,
      method,
      confidenceScore: 1,
      livenessVerified: true,
      deviceId,
    });
    if (out.result.accessResult === 'granted') {
      logActivity(
        authorizedBy || 'gate_operator',
        'operator',
        'DIGITAL_SIGNATURE_VERIFIED',
        `students:${student.id}`,
        `Verified ${action} via digital signature pad (${signatureDataUrl.length} bytes).`
      );
    }
    res.status(out.statusCode).json(out.result);
    return;
  }

  if (method === 'student_id' || method === 'manual_override') {
    if (!admissionNumber?.trim()) {
      res.status(400).json({ error: 'Student Admission Number is required.' });
      return;
    }
    const student = db
      .prepare("SELECT id FROM students WHERE upper(admission_number) = ? AND status = 'active'")
      .get(admissionNumber.trim().toUpperCase()) as { id: number } | undefined;

    if (!student) {
      res.status(200).json({
        accessResult: 'denied',
        code: 'STUDENT_NOT_FOUND',
        message: `Student ID "${admissionNumber.trim()}" is not registered in the active directory.`,
        logType: action,
        method,
        confidenceScore: null,
        livenessVerified: false,
        timestamp: getCurrentHHMMSS(),
      });
      return;
    }

    const out = executeStudentEntryExit({
      studentId: student.id,
      action,
      method,
      confidenceScore: 1,
      livenessVerified: false,
      deviceId,
    });
    res.status(out.statusCode).json(out.result);
    return;
  }

  res.status(400).json({ error: 'Unsupported verification method.' });
});

app.post('/api/sync/offline-batch', (req, res) => {
  const { events } = req.body as { events?: OfflineAttendanceEvent[] };
  if (!Array.isArray(events)) {
    res.status(400).json({ error: 'events array is required.' });
    return;
  }
  const results = events.map((ev) => {
    const student = db
      .prepare("SELECT id FROM students WHERE upper(admission_number) = ? AND status = 'active'")
      .get(ev.admissionNumber.trim().toUpperCase()) as { id: number } | undefined;
    if (!student) {
      return { localId: ev.localId, synced: false, reason: 'Student not found' };
    }
    const hhmm = ev.capturedAtIso.slice(11, 16) || '08:05';
    const outcome = executeStudentEntryExit({
      studentId: student.id,
      action: ev.action,
      method: ev.method,
      confidenceScore: 1,
      livenessVerified: false,
      deviceId: 'OFFLINE-SYNC',
      overrideTimeHHMM: hhmm,
    });
    return {
      localId: ev.localId,
      synced: outcome.result.accessResult === 'granted',
      reason: outcome.result.message,
    };
  });
  res.json({ results });
});

// ---------- STUDENTS & REGISTRATION ----------
app.get('/api/students', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const q = (req.query.q as string | undefined)?.trim().toLowerCase() || '';
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const sectionId = req.query.sectionId ? Number(req.query.sectionId) : null;
  const today = getTodayDate();

  let sql = `
    SELECT
      s.id, s.admission_number AS admissionNumber, s.full_name AS fullName,
      s.photo_url AS photoUrl, s.dob, s.gender, s.blood_group AS bloodGroup,
      s.home_address AS homeAddress, s.class_id AS classId, c.name AS className,
      s.section_id AS sectionId, sec.name AS sectionName, s.roll_number AS rollNumber,
      s.academic_session_id AS academicSessionId, ses.name AS sessionName,
      s.branch_id AS branchId, b.name AS branchName, s.status,
      p.father_name AS fatherName, p.mother_name AS motherName, p.guardian_name AS guardianName,
      p.primary_phone AS primaryPhone, p.secondary_phone AS secondaryPhone,
      p.parent_email AS parentEmail, p.emergency_phone AS emergencyPhone,
      p.complete_address AS completeAddress,
      (sb.encrypted_face_template IS NOT NULL) AS hasFaceTemplate,
      (sb.encrypted_fingerprint_template IS NOT NULL) AS hasFingerprintTemplate,
      (sb.encrypted_signature_data IS NOT NULL) AS hasDigitalSignature,
      sb.qr_token_id AS qrTokenId,
      sb.parent_consent_given AS parentConsentGiven,
      sb.consent_timestamp AS consentTimestamp
    FROM students s
    JOIN classes c ON c.id = s.class_id
    JOIN sections sec ON sec.id = s.section_id
    JOIN academic_sessions ses ON ses.id = s.academic_session_id
    JOIN school_branches b ON b.id = s.branch_id
    JOIN parents p ON p.student_id = s.id
    JOIN student_biometrics sb ON sb.student_id = s.id
    WHERE 1=1
  `;
  const params: Array<string | number> = [];

  if (user.role === 'teacher') {
    if (user.assignedSectionIds.length === 0) {
      res.json({ students: [] });
      return;
    }
    const placeholders = user.assignedSectionIds.map(() => '?').join(',');
    sql += ` AND s.section_id IN (${placeholders})`;
    params.push(...user.assignedSectionIds);
  }

  if (classId) {
    sql += ' AND s.class_id = ?';
    params.push(classId);
  }
  if (sectionId) {
    sql += ' AND s.section_id = ?';
    params.push(sectionId);
  }
  if (q) {
    sql += ' AND (lower(s.full_name) LIKE ? OR lower(s.admission_number) LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += ' ORDER BY c.grade_level, sec.name, CAST(s.roll_number AS INTEGER), s.full_name';
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const students = rows.map((row) => {
    const sid = Number(row.id);
    const attRows = db
      .prepare('SELECT status FROM attendance WHERE student_id = ? AND subject_id IS NULL')
      .all(sid) as Array<{ status: AttendanceStatus }>;
    const metrics = calculateAttendanceMetrics(attRows.map((a) => a.status));

    const todayAtt = db
      .prepare('SELECT status FROM attendance WHERE student_id = ? AND attendance_date = ? AND subject_id IS NULL')
      .get(sid, today) as { status: AttendanceStatus } | undefined;
    const entryLog = db
      .prepare(
        "SELECT log_time FROM entry_exit_logs WHERE student_id = ? AND log_date = ? AND log_type = 'entry' AND access_result = 'granted' ORDER BY id ASC LIMIT 1"
      )
      .get(sid, today) as { log_time: string } | undefined;
    const exitLog = db
      .prepare(
        "SELECT log_time FROM entry_exit_logs WHERE student_id = ? AND log_date = ? AND log_type = 'exit' AND access_result = 'granted' ORDER BY id DESC LIMIT 1"
      )
      .get(sid, today) as { log_time: string } | undefined;

    return {
      ...row,
      hasFaceTemplate: Boolean(row.hasFaceTemplate),
      hasFingerprintTemplate: Boolean(row.hasFingerprintTemplate),
      hasDigitalSignature: Boolean(row.hasDigitalSignature),
      parentConsentGiven: Boolean(row.parentConsentGiven),
      todayStatus: todayAtt?.status ?? 'not_marked',
      todayEntryTime: entryLog?.log_time ?? null,
      todayExitTime: exitLog?.log_time ?? null,
      attendancePercentage: metrics.attendancePercentage,
      isFrequentlyAbsent: metrics.isFrequentlyAbsent,
    };
  });

  res.json({ students });
});

app.get('/api/students/:id/history', requireAuth, (req: AuthedRequest, res) => {
  const studentId = Number(req.params.id);
  const student = db
    .prepare('SELECT id, section_id AS sectionId FROM students WHERE id = ?')
    .get(studentId) as { id: number; sectionId: number } | undefined;

  if (!student) {
    res.status(404).json({ error: 'Student not found.' });
    return;
  }
  if (req.user!.role === 'teacher' && !req.user!.assignedSectionIds.includes(student.sectionId)) {
    res.status(403).json({ error: 'Access denied: student is not in your assigned classes/sections.' });
    return;
  }

  const attendanceHistory = db
    .prepare(
      `SELECT a.id, a.attendance_date AS attendanceDate, a.status, a.source, a.marked_by AS markedBy,
              a.correction_reason AS correctionReason, sub.name AS subjectName
       FROM attendance a
       LEFT JOIN subjects sub ON sub.id = a.subject_id
       WHERE a.student_id = ?
       ORDER BY a.attendance_date DESC, a.id DESC
       LIMIT 60`
    )
    .all(studentId);

  const entryExitHistory = db
    .prepare(
      `SELECT id, log_date AS logDate, log_type AS logType, log_time AS logTime,
              verification_method AS verificationMethod, confidence_score AS confidenceScore,
              liveness_verified AS livenessVerified, access_result AS accessResult, device_id AS deviceId
       FROM entry_exit_logs
       WHERE student_id = ?
       ORDER BY id DESC
       LIMIT 40`
    )
    .all(studentId);

  res.json({ attendanceHistory, entryExitHistory });
});

app.post('/api/students', requireAdmin, (req: AuthedRequest, res) => {
  const body = req.body as {
    admissionNumber: string;
    fullName: string;
    photoUrl?: string;
    dob: string;
    gender: string;
    bloodGroup?: string;
    homeAddress: string;
    classId: number;
    sectionId: number;
    rollNumber: string;
    academicSessionId: number;
    branchId?: number;
    fatherName: string;
    motherName: string;
    guardianName: string;
    primaryPhone: string;
    secondaryPhone?: string;
    parentEmail: string;
    emergencyPhone: string;
    completeAddress: string;
    parentConsentGiven: boolean;
    faceDescriptor?: number[];
    signatureDataUrl?: string;
  };

  const validation = validateStudentRegistration(body);
  if (!validation.valid) {
    res.status(400).json({ error: validation.errors.join(' '), errors: validation.errors });
    return;
  }

  const admNo = body.admissionNumber.trim().toUpperCase();
  const duplicate = db
    .prepare('SELECT id FROM students WHERE upper(admission_number) = ?')
    .get(admNo) as { id: number } | undefined;
  if (duplicate) {
    res.status(409).json({ error: `Duplicate prevented: Student ID "${admNo}" is already registered.` });
    return;
  }

  const rollConflict = db
    .prepare(
      'SELECT id FROM students WHERE class_id = ? AND section_id = ? AND roll_number = ? AND academic_session_id = ?'
    )
    .get(Number(body.classId), Number(body.sectionId), body.rollNumber.trim(), Number(body.academicSessionId)) as
    | { id: number }
    | undefined;
  if (rollConflict) {
    res.status(409).json({
      error: `Duplicate prevented: Roll number "${body.rollNumber}" is already assigned in this class/section.`,
    });
    return;
  }

  const retentionDays = Number(getSetting('biometric_retention_days', '730'));
  const retentionDate = new Date(Date.now() + retentionDays * 86400 * 1000).toISOString().slice(0, 10);
  const qrTokenId = `AEGIS-QR-${admNo}`;

  db.exec('BEGIN TRANSACTION;');
  try {
    const insertRes = db
      .prepare(
        `INSERT INTO students (
          admission_number, full_name, photo_url, dob, gender, blood_group,
          home_address, class_id, section_id, roll_number, academic_session_id, branch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        admNo,
        body.fullName.trim(),
        body.photoUrl || '',
        body.dob,
        body.gender,
        body.bloodGroup?.trim() || null,
        body.homeAddress.trim(),
        Number(body.classId),
        Number(body.sectionId),
        body.rollNumber.trim(),
        Number(body.academicSessionId),
        Number(body.branchId || 1)
      );

    const studentId = Number(insertRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO parents (
        student_id, father_name, mother_name, guardian_name,
        primary_phone, secondary_phone, parent_email, emergency_phone, complete_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      studentId,
      body.fatherName.trim(),
      body.motherName?.trim() || 'Not Specified',
      body.guardianName?.trim() || body.fatherName.trim(),
      body.primaryPhone.trim(),
      body.secondaryPhone?.trim() || null,
      body.parentEmail.trim(),
      body.emergencyPhone.trim(),
      body.completeAddress.trim()
    );

    db.prepare(
      `INSERT INTO student_biometrics (
        student_id, encrypted_face_template, encrypted_fingerprint_template,
        encrypted_signature_data, qr_token_id, qr_token_hash,
        parent_consent_given, consent_timestamp, retention_until
      ) VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?)`
    ).run(
      studentId,
      body.faceDescriptor?.length ? encryptBiometricTemplate(body.faceDescriptor) : null,
      body.signatureDataUrl ? encryptBiometricTemplate({ dataUrl: body.signatureDataUrl }) : null,
      qrTokenId,
      sha256Hex(qrTokenId),
      new Date().toISOString(),
      retentionDate
    );

    logActivity(
      req.user!.email,
      req.user!.role,
      'STUDENT_REGISTERED',
      `students:${admNo}`,
      `Enrolled ${body.fullName.trim()} (${admNo}) with DPDP consent and encrypted biometric template.`
    );

    db.exec('COMMIT;');
    broadcastWs('attendance:update', buildKioskState());
    res.status(201).json({ id: studentId, admissionNumber: admNo, qrTokenId });
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
});

app.patch('/api/students/:id/biometrics', requireAdmin, (req: AuthedRequest, res) => {
  const studentId = Number(req.params.id);
  const { faceDescriptor, photoUrl } = req.body as { faceDescriptor?: number[]; photoUrl?: string };
  if (!Array.isArray(faceDescriptor) || faceDescriptor.length === 0) {
    res.status(400).json({ error: 'faceDescriptor array is required.' });
    return;
  }
  const encrypted = encryptBiometricTemplate(faceDescriptor);
  db.prepare(
    "UPDATE student_biometrics SET encrypted_face_template = ?, updated_at = datetime('now') WHERE student_id = ?"
  ).run(encrypted, studentId);

  if (photoUrl) {
    db.prepare('UPDATE students SET photo_url = ? WHERE id = ?').run(photoUrl, studentId);
  }
  logActivity(
    req.user!.email,
    req.user!.role,
    'BIOMETRIC_TEMPLATE_UPDATED',
    `students:${studentId}`,
    'Updated encrypted AES-256-GCM facial recognition template.'
  );
  res.json({ ok: true });
});

// ---------- CLASSROOM ATTENDANCE ----------
app.get('/api/attendance/class', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const classId = Number(req.query.classId);
  const sectionId = Number(req.query.sectionId);
  const subjectId = req.query.subjectId ? Number(req.query.subjectId) : null;
  const date = (req.query.date as string | undefined) || getTodayDate();

  if (!classId || !sectionId) {
    res.status(400).json({ error: 'classId and sectionId are required.' });
    return;
  }

  if (user.role === 'teacher' && !user.assignedSectionIds.includes(sectionId)) {
    res.status(403).json({ error: 'You are not authorized to access attendance for this section.' });
    return;
  }

  const rows = db
    .prepare(
      `SELECT
        s.id AS studentId, s.admission_number AS admissionNumber, s.full_name AS fullName,
        s.roll_number AS rollNumber, s.photo_url AS photoUrl,
        a.id AS attendanceId, a.status, a.source, a.marked_by AS markedBy, a.correction_reason AS correctionReason
       FROM students s
       LEFT JOIN attendance a
         ON a.student_id = s.id
         AND a.attendance_date = ?
         AND ${subjectId ? 'a.subject_id = ?' : 'a.subject_id IS NULL'}
       WHERE s.class_id = ? AND s.section_id = ? AND s.status = 'active'
       ORDER BY CAST(s.roll_number AS INTEGER), s.full_name`
    )
    .all(...(subjectId ? [date, subjectId, classId, sectionId] : [date, classId, sectionId]));

  res.json({ date, classId, sectionId, subjectId, records: rows });
});

app.post('/api/attendance/mark', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const { classId, sectionId, subjectId = null, date, entries, correctionReason } = req.body as {
    classId: number;
    sectionId: number;
    subjectId?: number | null;
    date: string;
    entries: Array<{ studentId: number; status: AttendanceStatus }>;
    correctionReason?: string;
  };

  if (user.role === 'teacher' && !user.assignedSectionIds.includes(Number(sectionId))) {
    res.status(403).json({ error: 'Unauthorized: section outside assigned classes.' });
    return;
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: 'entries array is required.' });
    return;
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const item of entries) {
      const existing = db
        .prepare(
          `SELECT id, status FROM attendance
           WHERE student_id = ? AND attendance_date = ? AND ${subjectId ? 'subject_id = ?' : 'subject_id IS NULL'}`
        )
        .get(...(subjectId ? [item.studentId, date, subjectId] : [item.studentId, date])) as
        | { id: number; status: string }
        | undefined;

      if (existing) {
        db.prepare(
          `UPDATE attendance
           SET status = ?, source = 'classroom_manual', marked_by = ?, correction_reason = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(item.status, user.email, correctionReason || (existing.status !== item.status ? 'Manual teacher update' : null), existing.id);
      } else {
        db.prepare(
          `INSERT INTO attendance (student_id, class_id, section_id, subject_id, attendance_date, status, source, marked_by, correction_reason)
           VALUES (?, ?, ?, ?, ?, ?, 'classroom_manual', ?, ?)`
        ).run(
          item.studentId,
          Number(classId),
          Number(sectionId),
          subjectId ? Number(subjectId) : null,
          date,
          item.status,
          user.email,
          correctionReason || null
        );
      }
    }

    logActivity(
      user.email,
      user.role,
      'CLASS_ATTENDANCE_SAVED',
      `section:${sectionId}:${date}`,
      `Updated ${entries.length} classroom attendance records${correctionReason ? ` (Note: ${correctionReason})` : ''}.`
    );

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  broadcastWs('attendance:update', buildKioskState());
  res.json({ ok: true, count: entries.length });
});

app.get('/api/attendance/monthly', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const monthPrefix = (req.query.month as string | undefined) || getTodayDate().slice(0, 7);
  const classId = req.query.classId ? Number(req.query.classId) : null;
  const sectionId = req.query.sectionId ? Number(req.query.sectionId) : null;

  let sql = `
    SELECT s.id AS studentId, s.admission_number AS admissionNumber, s.full_name AS fullName,
           c.name AS className, sec.name AS sectionName, p.primary_phone AS primaryPhone
    FROM students s
    JOIN classes c ON c.id = s.class_id
    JOIN sections sec ON sec.id = s.section_id
    JOIN parents p ON p.student_id = s.id
    WHERE s.status = 'active'
  `;
  const params: Array<string | number> = [];

  if (user.role === 'teacher') {
    const placeholders = user.assignedSectionIds.map(() => '?').join(',');
    sql += ` AND s.section_id IN (${placeholders})`;
    params.push(...user.assignedSectionIds);
  }
  if (classId) {
    sql += ' AND s.class_id = ?';
    params.push(classId);
  }
  if (sectionId) {
    sql += ' AND s.section_id = ?';
    params.push(sectionId);
  }

  const students = db.prepare(sql).all(...params) as Array<{
    studentId: number;
    admissionNumber: string;
    fullName: string;
    className: string;
    sectionName: string;
    primaryPhone: string;
  }>;

  const summary = students.map((st) => {
    const logs = db
      .prepare(
        `SELECT attendance_date AS date, status FROM attendance
         WHERE student_id = ? AND subject_id IS NULL AND attendance_date LIKE ?
         ORDER BY attendance_date ASC`
      )
      .all(st.studentId, `${monthPrefix}%`) as Array<{ date: string; status: AttendanceStatus }>;

    const metrics = calculateAttendanceMetrics(logs.map((l) => l.status));
    return {
      ...st,
      ...metrics,
      dailyRecords: logs,
    };
  });

  res.json({ month: monthPrefix, summary });
});

// ---------- REPORTS & PARENT NOTIFICATIONS ----------
app.get('/api/reports', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const reportType = (req.query.type as string | undefined) || 'daily';
  const fromDate = (req.query.from as string | undefined) || getTodayDate();
  const toDate = (req.query.to as string | undefined) || getTodayDate();
  const classId = req.query.classId ? Number(req.query.classId) : null;

  let teacherSectionFilter = '';
  const teacherParams: number[] = [];
  if (user.role === 'teacher') {
    const placeholders = user.assignedSectionIds.map(() => '?').join(',');
    teacherSectionFilter = ` AND s.section_id IN (${placeholders})`;
    teacherParams.push(...user.assignedSectionIds);
  }
  const classFilter = classId ? ' AND s.class_id = ?' : '';
  const classParams = classId ? [classId] : [];

  if (reportType === 'entry_exit' || reportType === 'early_departure') {
    const extraFilter = reportType === 'early_departure' ? " AND l.log_type = 'exit' AND l.log_time < '13:30:00'" : '';
    const rows = db
      .prepare(
        `SELECT l.log_date AS date, s.admission_number AS admissionNumber, s.full_name AS studentName,
                c.name AS className, sec.name AS sectionName, l.log_type AS logType,
                l.log_time AS logTime, l.verification_method AS method, l.access_result AS result,
                l.device_id AS deviceId
         FROM entry_exit_logs l
         JOIN students s ON s.id = l.student_id
         JOIN classes c ON c.id = s.class_id
         JOIN sections sec ON sec.id = s.section_id
         WHERE l.log_date BETWEEN ? AND ? ${teacherSectionFilter} ${classFilter} ${extraFilter}
         ORDER BY l.log_date DESC, l.log_time DESC`
      )
      .all(fromDate, toDate, ...teacherParams, ...classParams);
    res.json({ reportType, fromDate, toDate, rows });
    return;
  }

  let statusFilter = '';
  if (reportType === 'late') statusFilter = " AND a.status = 'late'";
  else if (reportType === 'absent') statusFilter = " AND a.status = 'absent'";

  const rows = db
    .prepare(
      `SELECT a.attendance_date AS date, s.admission_number AS admissionNumber, s.full_name AS studentName,
              c.name AS className, sec.name AS sectionName, a.status, a.source,
              a.marked_by AS markedBy, p.primary_phone AS parentPhone
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       JOIN classes c ON c.id = s.class_id
       JOIN sections sec ON sec.id = s.section_id
       JOIN parents p ON p.student_id = s.id
       WHERE a.subject_id IS NULL AND a.attendance_date BETWEEN ? AND ?
       ${teacherSectionFilter} ${classFilter} ${statusFilter}
       ORDER BY a.attendance_date DESC, c.grade_level, s.full_name`
    )
    .all(fromDate, toDate, ...teacherParams, ...classParams);

  res.json({ reportType, fromDate, toDate, rows });
});

app.get('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  let sql = `
    SELECT n.id, n.student_id AS studentId, s.full_name AS studentName,
           s.admission_number AS admissionNumber, n.recipient_phone AS parentPhone,
           n.recipient_email AS parentEmail, n.event_type AS eventType,
           n.channel, n.message, n.status, n.created_at AS createdAt
    FROM notifications n
    JOIN students s ON s.id = n.student_id
    WHERE 1=1
  `;
  const params: number[] = [];
  if (user.role === 'teacher') {
    const placeholders = user.assignedSectionIds.map(() => '?').join(',');
    sql += ` AND s.section_id IN (${placeholders})`;
    params.push(...user.assignedSectionIds);
  }
  sql += ' ORDER BY n.id DESC LIMIT 50';
  const notifications = db.prepare(sql).all(...params);
  res.json({ notifications });
});

app.post('/api/notifications/send', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  const { studentId, channel = 'sms', eventType = 'manual_alert', message } = req.body as {
    studentId: number;
    channel?: 'sms' | 'email' | 'app';
    eventType?: 'entry' | 'exit' | 'absent' | 'late' | 'manual_alert';
    message: string;
  };

  if (!studentId || !message?.trim()) {
    res.status(400).json({ error: 'studentId and message are required.' });
    return;
  }

  const student = db
    .prepare(
      `SELECT s.id, s.section_id AS sectionId, s.full_name AS fullName,
              p.primary_phone AS primaryPhone, p.parent_email AS parentEmail
       FROM students s JOIN parents p ON p.student_id = s.id WHERE s.id = ?`
    )
    .get(Number(studentId)) as
    | { id: number; sectionId: number; fullName: string; primaryPhone: string; parentEmail: string }
    | undefined;

  if (!student) {
    res.status(404).json({ error: 'Student not found.' });
    return;
  }
  if (user.role === 'teacher' && !user.assignedSectionIds.includes(student.sectionId)) {
    res.status(403).json({ error: 'Unauthorized: student outside your assigned classes.' });
    return;
  }

  db.prepare(
    `INSERT INTO notifications (student_id, event_type, channel, recipient_phone, recipient_email, message, status)
     VALUES (?, ?, ?, ?, ?, ?, 'sent')`
  ).run(student.id, eventType, channel, student.primaryPhone, student.parentEmail, message.trim());

  logActivity(
    user.email,
    user.role,
    'PARENT_NOTIFIED',
    `students:${student.id}`,
    `Dispatched ${channel.toUpperCase()} parent alert for ${student.fullName}.`
  );

  res.status(201).json({ ok: true });
});

// ---------- ADMIN MANAGEMENT ----------
app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const teachers = db
    .prepare(
      `SELECT id, employee_code AS employeeCode, email, full_name AS fullName, phone, department,
              branch_id AS branchId, assigned_class_ids_json AS assignedClassIdsJson,
              assigned_section_ids_json AS assignedSectionIdsJson, is_active AS isActive
       FROM teachers ORDER BY id`
    )
    .all()
    .map((t: Record<string, unknown>) => ({
      ...t,
      assignedClassIds: JSON.parse(String(t.assignedClassIdsJson)),
      assignedSectionIds: JSON.parse(String(t.assignedSectionIdsJson)),
      isActive: Boolean(t.isActive),
    }));

  const timetables = db
    .prepare(
      `SELECT t.id, c.name AS className, sec.name AS sectionName, sub.name AS subjectName,
              tch.full_name AS teacherName, t.day_of_week AS dayOfWeek, t.start_time AS startTime, t.end_time AS endTime
       FROM timetables t
       JOIN classes c ON c.id = t.class_id
       JOIN sections sec ON sec.id = t.section_id
       JOIN subjects sub ON sub.id = t.subject_id
       JOIN teachers tch ON tch.id = t.teacher_id
       ORDER BY t.id`
    )
    .all();

  const activityLogs = db
    .prepare(
      `SELECT id, actor_email AS actorEmail, actor_role AS actorRole, action,
              target_entity AS targetEntity, details, created_at AS createdAt
       FROM activity_logs ORDER BY id DESC LIMIT 60`
    )
    .all();

  res.json({ teachers, timetables, activityLogs });
});

app.post('/api/admin/teachers', requireAdmin, (req: AuthedRequest, res) => {
  const { employeeCode, email, fullName, phone, department, password, assignedClassIds, assignedSectionIds } =
    req.body as {
      employeeCode: string;
      email: string;
      fullName: string;
      phone: string;
      department: string;
      password: string;
      assignedClassIds: number[];
      assignedSectionIds: number[];
    };

  if (!employeeCode?.trim() || !email?.trim() || !fullName?.trim() || !password) {
    res.status(400).json({ error: 'Employee code, email, full name, and initial password are required.' });
    return;
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO teachers (employee_code, email, full_name, phone, department, password_hash, role_id, branch_id, assigned_class_ids_json, assigned_section_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, 2, 1, ?, ?)`
      )
      .run(
        employeeCode.trim().toUpperCase(),
        email.trim().toLowerCase(),
        fullName.trim(),
        phone?.trim() || '+91 98000 00000',
        department?.trim() || 'General Faculty',
        hashPassword(password),
        JSON.stringify(assignedClassIds || [1]),
        JSON.stringify(assignedSectionIds || [1])
      );

    logActivity(
      req.user!.email,
      req.user!.role,
      'TEACHER_CREATED',
      `teachers:${employeeCode.trim()}`,
      `Registered faculty member ${fullName.trim()} (${email.trim()}).`
    );

    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Teacher already exists.' });
  }
});

app.post('/api/admin/academics', requireAdmin, (req: AuthedRequest, res) => {
  const { type, name, gradeLevel, classId, roomNumber, code, startDate, endDate, branchId = 1 } = req.body as {
    type: 'class' | 'section' | 'subject' | 'session';
    name: string;
    gradeLevel?: number;
    classId?: number;
    roomNumber?: string;
    code?: string;
    startDate?: string;
    endDate?: string;
    branchId?: number;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: 'Name is required.' });
    return;
  }

  try {
    if (type === 'class') {
      db.prepare('INSERT INTO classes (name, grade_level, branch_id) VALUES (?, ?, ?)').run(
        name.trim(),
        Number(gradeLevel || 10),
        Number(branchId)
      );
    } else if (type === 'section') {
      db.prepare('INSERT INTO sections (class_id, name, room_number) VALUES (?, ?, ?)').run(
        Number(classId),
        name.trim(),
        roomNumber?.trim() || 'Room-101'
      );
    } else if (type === 'subject') {
      db.prepare('INSERT INTO subjects (class_id, name, code) VALUES (?, ?, ?)').run(
        Number(classId),
        name.trim(),
        (code || name.slice(0, 3)).toUpperCase()
      );
    } else if (type === 'session') {
      db.prepare('INSERT INTO academic_sessions (name, start_date, end_date, is_active) VALUES (?, ?, ?, 0)').run(
        name.trim(),
        startDate || '2027-04-01',
        endDate || '2028-03-31'
      );
    }
    logActivity(req.user!.email, req.user!.role, 'ACADEMIC_STRUCTURE_ADDED', type, `Created ${type}: ${name.trim()}`);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Duplicate academic entry.' });
  }
});

app.patch('/api/admin/settings', requireAdmin, (req: AuthedRequest, res) => {
  const updates = req.body as Record<string, string>;
  const stmt = db.prepare(
    "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  );
  for (const [k, v] of Object.entries(updates)) {
    stmt.run(k, String(v));
  }
  logActivity(
    req.user!.email,
    req.user!.role,
    'SETTINGS_UPDATED',
    'system_settings',
    `Updated keys: ${Object.keys(updates).join(', ')}`
  );
  res.json({ ok: true });
});

app.get('/api/admin/schema-sql', requireAdmin, (_req, res) => {
  res.type('text/sql').send(SCHEMA_SQL);
});

app.get('/api/admin/backup', requireAdmin, async (req: AuthedRequest, res) => {
  const backupPath = path.join(path.dirname(DB_FILE_PATH), `backup-${Date.now()}.sqlite`);
  try {
    await backup(db, backupPath);
    logActivity(
      req.user!.email,
      req.user!.role,
      'DATABASE_BACKUP_EXPORTED',
      'sqlite_database',
      'Generated consistent SQLite snapshot backup.'
    );
    res.download(backupPath, `aegiscampus-backup-${getTodayDate()}.sqlite`, () => {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed.' });
  }
});

// ---------- VITE / STATIC SERVING ----------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(3000, '0.0.0.0', () => {
    console.log('AegisCampus server listening on http://localhost:3000');
  });
}

startServer();
