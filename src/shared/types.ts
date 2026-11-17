export type UserRole = 'admin' | 'teacher';

export type VerificationMethod =
  | 'face_recognition'
  | 'qr_code'
  | 'digital_signature'
  | 'student_id'
  | 'fingerprint'
  | 'manual_override';

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
  assignedClassIds: number[];
  assignedSectionIds: number[];
  branchId: number;
  expiresAt: number;
}

export interface SchoolBranch {
  id: number;
  name: string;
  code: string;
  city: string;
}

export interface AcademicSession {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  isActive: number;
}

export interface ClassItem {
  id: number;
  name: string;
  gradeLevel: number;
  branchId: number;
}

export interface SectionItem {
  id: number;
  classId: number;
  name: string;
  roomNumber: string;
}

export interface SubjectItem {
  id: number;
  classId: number;
  name: string;
  code: string;
}

export interface StudentRecord {
  id: number;
  admissionNumber: string;
  fullName: string;
  photoUrl: string;
  dob: string;
  gender: string;
  bloodGroup: string | null;
  homeAddress: string;
  classId: number;
  className: string;
  sectionId: number;
  sectionName: string;
  rollNumber: string;
  academicSessionId: number;
  sessionName: string;
  branchId: number;
  branchName: string;
  status: 'active' | 'inactive';
  // Parent info
  fatherName: string;
  motherName: string;
  guardianName: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  parentEmail: string;
  emergencyPhone: string;
  completeAddress: string;
  // Biometric metadata (never raw templates!)
  hasFaceTemplate: boolean;
  hasFingerprintTemplate: boolean;
  hasDigitalSignature: boolean;
  qrTokenId: string;
  parentConsentGiven: boolean;
  consentTimestamp: string | null;
  // Computed attendance summary
  todayStatus?: AttendanceStatus | 'not_marked';
  todayEntryTime?: string | null;
  todayExitTime?: string | null;
  attendancePercentage?: number;
  isFrequentlyAbsent?: boolean;
}

export interface EntryExitLogItem {
  id: number;
  studentId: number;
  admissionNumber: string;
  studentName: string;
  photoUrl: string;
  className: string;
  sectionName: string;
  logDate: string;
  logType: 'entry' | 'exit';
  logTime: string;
  verificationMethod: VerificationMethod;
  confidenceScore: number | null;
  livenessVerified: boolean;
  accessResult: 'granted' | 'denied';
  denialReason: string | null;
  branchName: string;
  deviceId: string;
}

export interface KioskVerificationResult {
  accessResult: 'granted' | 'denied';
  message: string;
  code: string;
  logType: 'entry' | 'exit';
  method: VerificationMethod;
  confidenceScore: number | null;
  livenessVerified: boolean;
  timestamp: string;
  attendanceStatus?: AttendanceStatus | null;
  student?: {
    id: number;
    admissionNumber: string;
    fullName: string;
    photoUrl: string;
    className: string;
    sectionName: string;
    rollNumber: string;
    primaryPhone: string;
  };
}

export interface KioskDashboardState {
  date: string;
  lateCutoffTime: string;
  totalStudents: number;
  presentStudents: number;
  absentStudents: number;
  lateStudents: number;
  exitedStudents: number;
  recentLogs: EntryExitLogItem[];
  alerts: Array<{
    id: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    detail: string;
    timestamp: string;
  }>;
}

export interface NotificationItem {
  id: number;
  studentId: number;
  studentName: string;
  admissionNumber: string;
  parentPhone: string;
  parentEmail: string;
  eventType: 'entry' | 'exit' | 'absent' | 'late' | 'manual_alert';
  channel: 'sms' | 'email' | 'app';
  message: string;
  status: 'sent' | 'queued';
  createdAt: string;
}

export interface ActivityLogItem {
  id: number;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetEntity: string;
  details: string;
  createdAt: string;
}

export interface OfflineAttendanceEvent {
  localId: string;
  admissionNumber: string;
  action: 'entry' | 'exit';
  method: VerificationMethod;
  capturedAtIso: string;
}
