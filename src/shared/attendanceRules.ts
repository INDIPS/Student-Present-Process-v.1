import type { AttendanceStatus } from './types';

export interface EntryExitEvaluationInput {
  action: 'entry' | 'exit';
  existingEntryTime: string | null;
  existingExitTime: string | null;
  currentHHMM: string;
  lateCutoffHHMM: string;
  earlyDepartureCutoffHHMM?: string;
}

export interface EntryExitEvaluationResult {
  allowed: boolean;
  code:
    | 'ENTRY_GRANTED'
    | 'ENTRY_LATE_GRANTED'
    | 'EXIT_GRANTED'
    | 'EXIT_EARLY_GRANTED'
    | 'DUPLICATE_ENTRY'
    | 'DUPLICATE_EXIT'
    | 'NO_ENTRY_FOUND';
  reason: string;
  attendanceStatus: AttendanceStatus | null;
  isEarlyDeparture: boolean;
}

export function evaluateEntryExitTransition(
  input: EntryExitEvaluationInput
): EntryExitEvaluationResult {
  const earlyCutoff = input.earlyDepartureCutoffHHMM ?? '13:30';

  if (input.action === 'entry') {
    if (input.existingEntryTime) {
      return {
        allowed: false,
        code: 'DUPLICATE_ENTRY',
        reason: `Duplicate entry blocked: Morning entry already recorded at ${input.existingEntryTime}.`,
        attendanceStatus: null,
        isEarlyDeparture: false,
      };
    }

    const isLate = input.currentHHMM > input.lateCutoffHHMM;
    return {
      allowed: true,
      code: isLate ? 'ENTRY_LATE_GRANTED' : 'ENTRY_GRANTED',
      reason: isLate
        ? `Morning entry recorded (Late arrival after ${input.lateCutoffHHMM}).`
        : 'Morning entry verified on schedule.',
      attendanceStatus: isLate ? 'late' : 'present',
      isEarlyDeparture: false,
    };
  }

  // Exit workflow
  if (!input.existingEntryTime) {
    return {
      allowed: false,
      code: 'NO_ENTRY_FOUND',
      reason: 'Exit blocked: No morning entry record exists for today.',
      attendanceStatus: null,
      isEarlyDeparture: false,
    };
  }

  if (input.existingExitTime) {
    return {
      allowed: false,
      code: 'DUPLICATE_EXIT',
      reason: `Duplicate exit blocked: Departure already recorded at ${input.existingExitTime}.`,
      attendanceStatus: null,
      isEarlyDeparture: false,
    };
  }

  const isEarly = input.currentHHMM < earlyCutoff;
  return {
    allowed: true,
    code: isEarly ? 'EXIT_EARLY_GRANTED' : 'EXIT_GRANTED',
    reason: isEarly
      ? `Early departure recorded before ${earlyCutoff}.`
      : 'Evening exit verified and logged.',
    attendanceStatus: null,
    isEarlyDeparture: isEarly,
  };
}

export interface AttendanceMetricsSummary {
  totalDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  excusedDays: number;
  attendancePercentage: number;
  isFrequentlyAbsent: boolean;
}

export function calculateAttendanceMetrics(
  statuses: AttendanceStatus[],
  lowAttendanceThreshold = 75
): AttendanceMetricsSummary {
  const totalDays = statuses.length;
  let presentDays = 0;
  let lateDays = 0;
  let absentDays = 0;
  let excusedDays = 0;

  for (const status of statuses) {
    if (status === 'present') presentDays += 1;
    else if (status === 'late') lateDays += 1;
    else if (status === 'absent') absentDays += 1;
    else if (status === 'excused') excusedDays += 1;
  }

  const effectiveTotal = totalDays - excusedDays;
  const attended = presentDays + lateDays;
  const attendancePercentage =
    effectiveTotal <= 0 ? 100 : Math.round((attended / effectiveTotal) * 1000) / 10;

  return {
    totalDays,
    presentDays,
    lateDays,
    absentDays,
    excusedDays,
    attendancePercentage,
    isFrequentlyAbsent: effectiveTotal >= 3 && attendancePercentage < lowAttendanceThreshold,
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface BiometricCandidate {
  studentId: number;
  admissionNumber: string;
  descriptor: number[];
}

export interface FacialMatchOutcome {
  matched: boolean;
  studentId: number | null;
  admissionNumber: string | null;
  similarity: number;
  reason: string;
}

export function findBestFacialMatch(
  probeDescriptor: number[],
  candidates: BiometricCandidate[],
  options: {
    similarityThreshold?: number;
    livenessVerified: boolean;
    livenessScore: number;
    minLivenessScore?: number;
  }
): FacialMatchOutcome {
  const threshold = options.similarityThreshold ?? 0.9;
  const minLiveness = options.minLivenessScore ?? 0.55;

  if (!options.livenessVerified || options.livenessScore < minLiveness) {
    return {
      matched: false,
      studentId: null,
      admissionNumber: null,
      similarity: 0,
      reason: 'Anti-spoofing liveness check failed. Please blink or move slightly in front of the camera.',
    };
  }

  if (!Array.isArray(probeDescriptor) || probeDescriptor.length === 0) {
    return {
      matched: false,
      studentId: null,
      admissionNumber: null,
      similarity: 0,
      reason: 'Invalid facial feature descriptor.',
    };
  }

  let bestCandidate: BiometricCandidate | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = cosineSimilarity(probeDescriptor, candidate.descriptor);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  const rounded = Math.round(Math.max(0, bestScore) * 1000) / 1000;

  if (!bestCandidate || bestScore < threshold) {
    return {
      matched: false,
      studentId: null,
      admissionNumber: null,
      similarity: rounded,
      reason: `No registered face matched above confidence threshold (${Math.round(rounded * 100)}% < ${Math.round(threshold * 100)}%).`,
    };
  }

  return {
    matched: true,
    studentId: bestCandidate.studentId,
    admissionNumber: bestCandidate.admissionNumber,
    similarity: rounded,
    reason: `Facial biometric matched (${Math.round(rounded * 100)}% confidence).`,
  };
}

export interface StudentRegistrationInput {
  admissionNumber: string;
  fullName: string;
  dob: string;
  gender: string;
  homeAddress: string;
  classId: number;
  sectionId: number;
  rollNumber: string;
  academicSessionId: number;
  fatherName: string;
  motherName: string;
  guardianName: string;
  primaryPhone: string;
  parentEmail: string;
  emergencyPhone: string;
  completeAddress: string;
  parentConsentGiven: boolean;
}

export function validateStudentRegistration(
  input: Partial<StudentRegistrationInput>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.admissionNumber?.trim()) errors.push('Admission Number / Student ID is required.');
  if (!input.fullName?.trim()) errors.push('Student full name is required.');
  if (!input.dob?.trim()) errors.push('Date of birth is required.');
  if (!input.gender?.trim()) errors.push('Gender is required.');
  if (!input.homeAddress?.trim()) errors.push('Home address is required.');
  if (!input.classId || Number(input.classId) <= 0) errors.push('Class selection is required.');
  if (!input.sectionId || Number(input.sectionId) <= 0) errors.push('Section selection is required.');
  if (!input.rollNumber?.trim()) errors.push('Roll number is required.');
  if (!input.academicSessionId || Number(input.academicSessionId) <= 0) {
    errors.push('Academic session is required.');
  }
  if (!input.fatherName?.trim() && !input.guardianName?.trim()) {
    errors.push("Father's name or Guardian's name is required.");
  }
  if (!input.primaryPhone?.trim() || input.primaryPhone.replace(/\D/g, '').length < 10) {
    errors.push('Valid primary parent contact number (at least 10 digits) is required.');
  }
  if (!input.emergencyPhone?.trim() || input.emergencyPhone.replace(/\D/g, '').length < 10) {
    errors.push('Valid emergency contact number (at least 10 digits) is required.');
  }
  if (!input.parentEmail?.trim() || !input.parentEmail.includes('@')) {
    errors.push('Valid parent email address is required.');
  }
  if (!input.completeAddress?.trim()) {
    errors.push('Complete parent/guardian address is required.');
  }
  if (!input.parentConsentGiven) {
    errors.push('Parent/guardian biometric consent (DPDP Act compliance) is mandatory.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
