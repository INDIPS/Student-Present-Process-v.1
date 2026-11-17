import type { DatabaseSync } from 'node:sqlite';
import { encryptBiometricTemplate, hashPassword, sha256Hex } from './crypto.ts';

function deterministicDescriptor(seedIndex: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < 64; i++) {
    const val = Math.sin((seedIndex + 1) * 17.31 + i * 0.73) * 0.5 + 0.5;
    vec.push(Math.round(val * 10000) / 10000);
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => Math.round((v / norm) * 100000) / 100000);
}

function getDateOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export function seedDatabaseIfEmpty(db: DatabaseSync): void {
  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM students').get() as { count: number };
  if (existingCount.count > 0) return;

  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Branches
    db.prepare('INSERT INTO school_branches (name, code, city) VALUES (?, ?, ?)').run(
      'Main North Campus',
      'BR-BLR-01',
      'Bengaluru'
    );
    db.prepare('INSERT INTO school_branches (name, code, city) VALUES (?, ?, ?)').run(
      'South Science Wing',
      'BR-BLR-02',
      'Bengaluru'
    );

    // 2. Academic Sessions
    db.prepare(
      'INSERT INTO academic_sessions (name, start_date, end_date, is_active) VALUES (?, ?, ?, ?)'
    ).run('2026-2027', '2026-04-01', '2027-03-31', 1);
    db.prepare(
      'INSERT INTO academic_sessions (name, start_date, end_date, is_active) VALUES (?, ?, ?, ?)'
    ).run('2025-2026', '2025-04-01', '2026-03-31', 0);

    // 3. User Roles
    db.prepare(
      'INSERT INTO user_roles (role_key, display_name, permissions_json) VALUES (?, ?, ?)'
    ).run(
      'admin',
      'School Administrator',
      JSON.stringify([
        'students:read',
        'students:write',
        'teachers:manage',
        'academics:manage',
        'attendance:override',
        'devices:manage',
        'backups:manage',
        'reports:export',
        'logs:read',
      ])
    );
    db.prepare(
      'INSERT INTO user_roles (role_key, display_name, permissions_json) VALUES (?, ?, ?)'
    ).run(
      'teacher',
      'Authorized Faculty',
      JSON.stringify([
        'students:read_assigned',
        'attendance:mark_assigned',
        'attendance:correct_assigned',
        'parents:notify_assigned',
        'reports:export_assigned',
      ])
    );

    // 4. Administrators
    db.prepare(
      'INSERT INTO administrators (email, full_name, password_hash, role_id, branch_id) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'admin@aegiscampus.edu.in',
      'Dr. Vikramaditya Rao',
      hashPassword('Admin@2026'),
      1,
      1
    );

    // 5. Classes
    const insertClass = db.prepare('INSERT INTO classes (name, grade_level, branch_id) VALUES (?, ?, ?)');
    insertClass.run('Grade 10', 10, 1);
    insertClass.run('Grade 11', 11, 1);
    insertClass.run('Grade 12', 12, 1);

    // 6. Teachers
    const insertTeacher = db.prepare(
      `INSERT INTO teachers (
        employee_code, email, full_name, phone, department, password_hash,
        role_id, branch_id, assigned_class_ids_json, assigned_section_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertTeacher.run(
      'TCH-101',
      'priya.menon@aegiscampus.edu.in',
      'Prof. Priya Menon',
      '+91 98450 11223',
      'Mathematics & Physics',
      hashPassword('Teacher@2026'),
      2,
      1,
      JSON.stringify([1, 2]),
      JSON.stringify([1, 2, 3])
    );
    insertTeacher.run(
      'TCH-102',
      'arjun.kulkarni@aegiscampus.edu.in',
      'Mr. Arjun Kulkarni',
      '+91 98450 44556',
      'Computer Science',
      hashPassword('Teacher@2026'),
      2,
      1,
      JSON.stringify([3]),
      JSON.stringify([4])
    );

    // 7. Sections
    const insertSection = db.prepare(
      'INSERT INTO sections (class_id, name, room_number, class_teacher_id) VALUES (?, ?, ?, ?)'
    );
    insertSection.run(1, 'A', 'NB-201', 1); // id 1
    insertSection.run(1, 'B', 'NB-202', 1); // id 2
    insertSection.run(2, 'Science', 'SB-301', 1); // id 3
    insertSection.run(3, 'CS', 'SB-402', 2); // id 4

    // 8. Subjects
    const insertSubject = db.prepare('INSERT INTO subjects (class_id, name, code) VALUES (?, ?, ?)');
    insertSubject.run(1, 'Mathematics', 'MTH-10'); // id 1
    insertSubject.run(1, 'Physics', 'PHY-10'); // id 2
    insertSubject.run(2, 'Applied Physics', 'PHY-11'); // id 3
    insertSubject.run(2, 'Chemistry', 'CHM-11'); // id 4
    insertSubject.run(3, 'Computer Science', 'CSC-12'); // id 5
    insertSubject.run(3, 'Calculus', 'MTH-12'); // id 6

    // 9. Timetables
    const insertTimetable = db.prepare(
      'INSERT INTO timetables (class_id, section_id, subject_id, teacher_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertTimetable.run(1, 1, 1, 1, 'Monday', '08:30', '09:20');
    insertTimetable.run(1, 1, 2, 1, 'Monday', '09:30', '10:20');
    insertTimetable.run(2, 3, 3, 1, 'Tuesday', '08:30', '09:20');
    insertTimetable.run(3, 4, 5, 2, 'Monday', '10:30', '11:20');

    // 10. Seed Students + Parents + Encrypted Biometrics
    const seededStudents = [
      {
        admissionNumber: 'STU-2026-001',
        fullName: 'Aarav Sharma',
        photoUrl: '/src/assets/images/student_aarav_sharma_1794924866963.jpg',
        dob: '2010-03-14',
        gender: 'Male',
        bloodGroup: 'O+',
        homeAddress: '42 Indiranagar 2nd Stage, Bengaluru 560038',
        classId: 1,
        sectionId: 1,
        rollNumber: '01',
        fatherName: 'Rajesh Sharma',
        motherName: 'Kavita Sharma',
        guardianName: 'Rajesh Sharma',
        primaryPhone: '+91 98451 23001',
        secondaryPhone: '+91 98451 23002',
        parentEmail: 'rajesh.sharma@example.in',
        emergencyPhone: '+91 98451 23999',
      },
      {
        admissionNumber: 'STU-2026-002',
        fullName: 'Ananya Iyer',
        photoUrl: '/src/assets/images/student_ananya_iyer_1794924868029.jpg',
        dob: '2010-07-22',
        gender: 'Female',
        bloodGroup: 'A+',
        homeAddress: '18 Jayanagar 4th Block, Bengaluru 560011',
        classId: 1,
        sectionId: 1,
        rollNumber: '02',
        fatherName: 'Subramanian Iyer',
        motherName: 'Lakshmi Iyer',
        guardianName: 'Subramanian Iyer',
        primaryPhone: '+91 98452 34001',
        secondaryPhone: null,
        parentEmail: 's.iyer@example.in',
        emergencyPhone: '+91 98452 34999',
      },
      {
        admissionNumber: 'STU-2026-003',
        fullName: 'Rohan Verma',
        photoUrl: '/src/assets/images/student_rohan_verma_1794924868657.jpg',
        dob: '2009-11-05',
        gender: 'Male',
        bloodGroup: 'B+',
        homeAddress: '77 Koramangala 6th Block, Bengaluru 560095',
        classId: 2,
        sectionId: 3,
        rollNumber: '05',
        fatherName: 'Sanjay Verma',
        motherName: 'Neha Verma',
        guardianName: 'Sanjay Verma',
        primaryPhone: '+91 98453 45001',
        secondaryPhone: '+91 98453 45002',
        parentEmail: 'sanjay.verma@example.in',
        emergencyPhone: '+91 98453 45999',
      },
      {
        admissionNumber: 'STU-2026-004',
        fullName: 'Meera Nair',
        photoUrl: '/src/assets/images/student_meera_nair_1794924868695.jpg',
        dob: '2011-01-19',
        gender: 'Female',
        bloodGroup: 'AB+',
        homeAddress: '9 Malleswaram 8th Cross, Bengaluru 560003',
        classId: 1,
        sectionId: 2,
        rollNumber: '03',
        fatherName: 'Harish Nair',
        motherName: 'Deepa Nair',
        guardianName: 'Harish Nair',
        primaryPhone: '+91 98454 56001',
        secondaryPhone: null,
        parentEmail: 'harish.nair@example.in',
        emergencyPhone: '+91 98454 56999',
      },
      {
        admissionNumber: 'STU-2026-005',
        fullName: 'Siddharth Joshi',
        photoUrl: '',
        dob: '2009-08-30',
        gender: 'Male',
        bloodGroup: 'O-',
        homeAddress: '105 Sadashivanagar, Bengaluru 560080',
        classId: 2,
        sectionId: 3,
        rollNumber: '08',
        fatherName: 'Prakash Joshi',
        motherName: 'Anjali Joshi',
        guardianName: 'Prakash Joshi',
        primaryPhone: '+91 98455 67001',
        secondaryPhone: null,
        parentEmail: 'prakash.joshi@example.in',
        emergencyPhone: '+91 98455 67999',
      },
      {
        admissionNumber: 'STU-2026-006',
        fullName: 'Diya Deshmukh',
        photoUrl: '',
        dob: '2008-12-11',
        gender: 'Female',
        bloodGroup: 'B-',
        homeAddress: '24 Whitefield Main Rd, Bengaluru 560066',
        classId: 3,
        sectionId: 4,
        rollNumber: '01',
        fatherName: 'Vivek Deshmukh',
        motherName: 'Pallavi Deshmukh',
        guardianName: 'Vivek Deshmukh',
        primaryPhone: '+91 98456 78001',
        secondaryPhone: '+91 98456 78002',
        parentEmail: 'vivek.deshmukh@example.in',
        emergencyPhone: '+91 98456 78999',
      },
    ];

    const insertStudent = db.prepare(
      `INSERT INTO students (
        admission_number, full_name, photo_url, dob, gender, blood_group,
        home_address, class_id, section_id, roll_number, academic_session_id, branch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertParent = db.prepare(
      `INSERT INTO parents (
        student_id, father_name, mother_name, guardian_name,
        primary_phone, secondary_phone, parent_email, emergency_phone, complete_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertBiometric = db.prepare(
      `INSERT INTO student_biometrics (
        student_id, encrypted_face_template, encrypted_fingerprint_template,
        encrypted_signature_data, qr_token_id, qr_token_hash,
        parent_consent_given, consent_timestamp, retention_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const studentIds: number[] = [];

    seededStudents.forEach((s, idx) => {
      const res = insertStudent.run(
        s.admissionNumber,
        s.fullName,
        s.photoUrl,
        s.dob,
        s.gender,
        s.bloodGroup,
        s.homeAddress,
        s.classId,
        s.sectionId,
        s.rollNumber,
        1,
        1
      );
      const studentId = Number(res.lastInsertRowid);
      studentIds.push(studentId);

      insertParent.run(
        studentId,
        s.fatherName,
        s.motherName,
        s.guardianName,
        s.primaryPhone,
        s.secondaryPhone,
        s.parentEmail,
        s.emergencyPhone,
        s.homeAddress
      );

      const qrTokenId = `AEGIS-QR-${s.admissionNumber}`;
      insertBiometric.run(
        studentId,
        encryptBiometricTemplate(deterministicDescriptor(idx + 1)),
        null,
        encryptBiometricTemplate({ strokeCount: 2, enrolledBy: 'admin@aegiscampus.edu.in' }),
        qrTokenId,
        sha256Hex(qrTokenId),
        1,
        '2026-04-02T09:15:00Z',
        '2028-03-31'
      );
    });

    // 11. Historical attendance for past 8 school days (leaves today clean or partially marked!)
    const insertAttendance = db.prepare(
      `INSERT INTO attendance (
        student_id, class_id, section_id, subject_id, attendance_date, status, source, marked_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let dayOffset = 8; dayOffset >= 1; dayOffset--) {
      const dateStr = getDateOffset(dayOffset);
      seededStudents.forEach((s, idx) => {
        const studentId = studentIds[idx];
        // Give STU-2026-005 (Siddharth) lower attendance (~50%) so Frequently Absent alert triggers authentically
        let status: 'present' | 'absent' | 'late' = 'present';
        if (idx === 4 && dayOffset % 2 === 0) status = 'absent';
        else if (idx === 2 && dayOffset === 3) status = 'late';
        else if (idx === 3 && dayOffset === 5) status = 'absent';

        insertAttendance.run(
          studentId,
          s.classId,
          s.sectionId,
          null,
          dateStr,
          status,
          'gate_biometric',
          'system:gate_01'
        );
      });
    }

    // Seed 2 morning entries for today so the main dashboard immediately displays live metrics & entry records,
    // while leaving STU-2026-001 (Aarav Sharma), STU-2026-003 (Rohan Verma), STU-2026-005, STU-2026-006 ready to scan!
    const today = getDateOffset(0);
    // Ananya Iyer (id 2) -> Present on time
    insertAttendance.run(studentIds[1], 1, 1, null, today, 'present', 'gate_biometric', 'system:gate_01');
    db.prepare(
      `INSERT INTO entry_exit_logs (
        student_id, log_date, log_type, log_time, verification_method,
        confidence_score, liveness_verified, access_result, branch_id, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(studentIds[1], today, 'entry', '07:54:18', 'face_recognition', 0.96, 1, 'granted', 1, 'GATE-NORTH-01');

    // Meera Nair (id 4) -> Late arrival
    insertAttendance.run(studentIds[3], 1, 2, null, today, 'late', 'gate_biometric', 'system:gate_01');
    db.prepare(
      `INSERT INTO entry_exit_logs (
        student_id, log_date, log_type, log_time, verification_method,
        confidence_score, liveness_verified, access_result, branch_id, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(studentIds[3], today, 'entry', '08:23:41', 'qr_code', 1.0, 1, 'granted', 1, 'GATE-NORTH-01');

    // 12. Initial notifications
    db.prepare(
      `INSERT INTO notifications (
        student_id, event_type, channel, recipient_phone, recipient_email, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      studentIds[1],
      'entry',
      'sms',
      '+91 98452 34001',
      's.iyer@example.in',
      'AegisCampus: Ananya Iyer checked in at Main North Campus at 07:54:18.',
      'sent'
    );
    db.prepare(
      `INSERT INTO notifications (
        student_id, event_type, channel, recipient_phone, recipient_email, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      studentIds[3],
      'late',
      'sms',
      '+91 98454 56001',
      'harish.nair@example.in',
      'AegisCampus Alert: Meera Nair arrived late at 08:23:41 (cutoff 08:15).',
      'sent'
    );

    // 13. Activity Logs
    db.prepare(
      `INSERT INTO activity_logs (actor_email, actor_role, action, target_entity, details) VALUES (?, ?, ?, ?, ?)`
    ).run(
      'admin@aegiscampus.edu.in',
      'admin',
      'SYSTEM_INITIALIZED',
      'academic_sessions:2026-2027',
      'Initialized academic session 2026-2027 with DPDP biometric encryption enabled.'
    );

    // 14. System Settings
    const insertSetting = db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)');
    insertSetting.run('school_name', 'AegisCampus Public Senior Secondary School');
    insertSetting.run('late_cutoff_time', '08:15');
    insertSetting.run('early_departure_cutoff_time', '13:30');
    insertSetting.run('face_similarity_threshold', '0.88');
    insertSetting.run('liveness_min_score', '0.55');
    insertSetting.run('biometric_retention_days', '730');
    insertSetting.run('auto_parent_notifications', 'true');
    insertSetting.run('dpdp_compliance_mode', 'strict');

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
