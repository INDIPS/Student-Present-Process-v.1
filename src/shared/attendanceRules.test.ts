import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEntryExitTransition,
  calculateAttendanceMetrics,
  cosineSimilarity,
  findBestFacialMatch,
  validateStudentRegistration,
} from './attendanceRules';

test('morning entry marks on-time student as present', () => {
  const res = evaluateEntryExitTransition({
    action: 'entry',
    existingEntryTime: null,
    existingExitTime: null,
    currentHHMM: '07:55',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(res.allowed, true);
  assert.equal(res.code, 'ENTRY_GRANTED');
  assert.equal(res.attendanceStatus, 'present');
});

test('morning entry marks arrival after cutoff as late', () => {
  const res = evaluateEntryExitTransition({
    action: 'entry',
    existingEntryTime: null,
    existingExitTime: null,
    currentHHMM: '08:28',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(res.allowed, true);
  assert.equal(res.code, 'ENTRY_LATE_GRANTED');
  assert.equal(res.attendanceStatus, 'late');
});

test('blocks duplicate morning entry on the same day', () => {
  const res = evaluateEntryExitTransition({
    action: 'entry',
    existingEntryTime: '07:58:12',
    existingExitTime: null,
    currentHHMM: '08:05',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(res.allowed, false);
  assert.equal(res.code, 'DUPLICATE_ENTRY');
});

test('blocks exit if no morning entry exists', () => {
  const res = evaluateEntryExitTransition({
    action: 'exit',
    existingEntryTime: null,
    existingExitTime: null,
    currentHHMM: '14:30',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(res.allowed, false);
  assert.equal(res.code, 'NO_ENTRY_FOUND');
});

test('allows valid evening exit and flags early departure', () => {
  const early = evaluateEntryExitTransition({
    action: 'exit',
    existingEntryTime: '08:02:00',
    existingExitTime: null,
    currentHHMM: '12:15',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(early.allowed, true);
  assert.equal(early.code, 'EXIT_EARLY_GRANTED');
  assert.equal(early.isEarlyDeparture, true);

  const regular = evaluateEntryExitTransition({
    action: 'exit',
    existingEntryTime: '08:02:00',
    existingExitTime: null,
    currentHHMM: '14:40',
    lateCutoffHHMM: '08:15',
  });
  assert.equal(regular.allowed, true);
  assert.equal(regular.code, 'EXIT_GRANTED');
  assert.equal(regular.isEarlyDeparture, false);
});

test('calculates attendance percentage and frequently absent flag accurately', () => {
  const summary = calculateAttendanceMetrics([
    'present',
    'late',
    'absent',
    'absent',
    'excused',
  ]);
  assert.equal(summary.totalDays, 5);
  assert.equal(summary.presentDays, 1);
  assert.equal(summary.lateDays, 1);
  assert.equal(summary.absentDays, 2);
  assert.equal(summary.excusedDays, 1);
  // 2 attended out of 4 non-excused days = 50%
  assert.equal(summary.attendancePercentage, 50);
  assert.equal(summary.isFrequentlyAbsent, true);
});

test('facial matching enforces liveness and cosine similarity threshold', () => {
  const vecA = [1, 0, 0, 0];
  const vecB = [0.98, 0.1, 0, 0];
  const vecC = [0, 1, 0, 0];

  assert.ok(cosineSimilarity(vecA, vecB) > 0.98);
  assert.equal(cosineSimilarity(vecA, vecC), 0);

  const spoofFail = findBestFacialMatch(
    vecA,
    [{ studentId: 1, admissionNumber: 'STU-001', descriptor: vecB }],
    { livenessVerified: false, livenessScore: 0.2 }
  );
  assert.equal(spoofFail.matched, false);

  const matchOk = findBestFacialMatch(
    vecA,
    [
      { studentId: 1, admissionNumber: 'STU-001', descriptor: vecC },
      { studentId: 2, admissionNumber: 'STU-002', descriptor: vecB },
    ],
    { livenessVerified: true, livenessScore: 0.88 }
  );
  assert.equal(matchOk.matched, true);
  assert.equal(matchOk.studentId, 2);
  assert.equal(matchOk.admissionNumber, 'STU-002');
});

test('student registration validator enforces DPDP consent and required contacts', () => {
  const invalid = validateStudentRegistration({
    admissionNumber: 'STU-2026-999',
    fullName: 'Kabir Mehta',
    parentConsentGiven: false,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((e) => e.includes('consent')));

  const valid = validateStudentRegistration({
    admissionNumber: 'STU-2026-999',
    fullName: 'Kabir Mehta',
    dob: '2010-05-14',
    gender: 'Male',
    homeAddress: '14 MG Road, Bengaluru',
    classId: 1,
    sectionId: 1,
    rollNumber: '12',
    academicSessionId: 1,
    fatherName: 'Rajesh Mehta',
    motherName: 'Sunita Mehta',
    guardianName: 'Rajesh Mehta',
    primaryPhone: '+91 9876543210',
    parentEmail: 'rajesh.mehta@example.com',
    emergencyPhone: '+91 9876500000',
    completeAddress: '14 MG Road, Bengaluru 560001',
    parentConsentGiven: true,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});
