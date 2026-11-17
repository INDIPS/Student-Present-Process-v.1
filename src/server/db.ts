import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const DB_FILE_PATH = path.join(DATA_DIR, 'aegiscampus.sqlite');

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS school_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS academic_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  permissions_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS administrators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES user_roles(id),
  branch_id INTEGER NOT NULL REFERENCES school_branches(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  department TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES user_roles(id),
  branch_id INTEGER NOT NULL REFERENCES school_branches(id),
  assigned_class_ids_json TEXT NOT NULL DEFAULT '[]',
  assigned_section_ids_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade_level INTEGER NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES school_branches(id),
  UNIQUE(name, branch_id)
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  room_number TEXT NOT NULL,
  class_teacher_id INTEGER REFERENCES teachers(id),
  UNIQUE(class_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  UNIQUE(class_id, code)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  photo_url TEXT NOT NULL,
  dob TEXT NOT NULL,
  gender TEXT NOT NULL,
  blood_group TEXT,
  home_address TEXT NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  roll_number TEXT NOT NULL,
  academic_session_id INTEGER NOT NULL REFERENCES academic_sessions(id),
  branch_id INTEGER NOT NULL REFERENCES school_branches(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_id, section_id, roll_number, academic_session_id)
);

CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  father_name TEXT NOT NULL,
  mother_name TEXT NOT NULL,
  guardian_name TEXT NOT NULL,
  primary_phone TEXT NOT NULL,
  secondary_phone TEXT,
  parent_email TEXT NOT NULL,
  emergency_phone TEXT NOT NULL,
  complete_address TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_biometrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  encrypted_face_template TEXT,
  encrypted_fingerprint_template TEXT,
  encrypted_signature_data TEXT,
  qr_token_id TEXT NOT NULL UNIQUE,
  qr_token_hash TEXT NOT NULL,
  parent_consent_given INTEGER NOT NULL DEFAULT 0,
  consent_timestamp TEXT,
  retention_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  subject_id INTEGER REFERENCES subjects(id),
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present', 'absent', 'late', 'excused')),
  source TEXT NOT NULL DEFAULT 'gate_biometric',
  marked_by TEXT NOT NULL,
  correction_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, attendance_date, subject_id)
);

CREATE TABLE IF NOT EXISTS entry_exit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  log_type TEXT NOT NULL CHECK(log_type IN ('entry', 'exit')),
  log_time TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  confidence_score REAL,
  liveness_verified INTEGER NOT NULL DEFAULT 0,
  access_result TEXT NOT NULL CHECK(access_result IN ('granted', 'denied')),
  denial_reason TEXT,
  branch_id INTEGER NOT NULL REFERENCES school_branches(id),
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timetables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  day_of_week TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    dbInstance = new DatabaseSync(DB_FILE_PATH);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec(SCHEMA_SQL);
  }
  return dbInstance;
}
