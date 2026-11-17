import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  Download,
  Mail,
  Phone,
  QrCode,
  Search,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { AuthUser, ClassItem, SectionItem, StudentRecord } from '../shared/types';
import { apiFetch } from '../utils/api';
import { exportStudentIdCardPdf } from '../utils/exportReports';
import { StudentAvatar } from './StudentAvatar';

interface StudentDirectoryProps {
  user: AuthUser;
  classes: ClassItem[];
  sections: SectionItem[];
  refreshKey: number;
}

interface HistoryPayload {
  attendanceHistory: Array<{
    id: number;
    attendanceDate: string;
    status: string;
    source: string;
    subjectName: string | null;
  }>;
  entryExitHistory: Array<{
    id: number;
    logDate: string;
    logType: string;
    logTime: string;
    verificationMethod: string;
    accessResult: string;
  }>;
}

export function StudentDirectory({ user, classes, sections, refreshKey }: StudentDirectoryProps) {
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState<string>('');
  const [onlyLowAttendance, setOnlyLowAttendance] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selectedStudent, setSelectedStudent] = useState<StudentRecord | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [qrModalStudent, setQrModalStudent] = useState<StudentRecord | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const [notifyText, setNotifyText] = useState('');
  const [notifyStatus, setNotifyStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadStudents();
  }, [query, classFilter, refreshKey]);

  async function loadStudents() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim());
      if (classFilter) qs.set('classId', classFilter);
      const res = await apiFetch<{ students: StudentRecord[] }>(`/api/students?${qs.toString()}`);
      setStudents(res.students);
    } finally {
      setLoading(false);
    }
  }

  async function openStudentDetail(student: StudentRecord) {
    setSelectedStudent(student);
    setNotifyStatus(null);
    setNotifyText(`AegisCampus Notice regarding ${student.fullName} (${student.admissionNumber}): `);
    const hist = await apiFetch<HistoryPayload>(`/api/students/${student.id}/history`);
    setHistory(hist);
  }

  async function openQrCard(student: StudentRecord) {
    setQrModalStudent(student);
    const dataUrl = await QRCode.toDataURL(student.qrTokenId, {
      width: 240,
      margin: 2,
      color: { dark: '#020617', light: '#ffffff' },
    });
    setQrDataUrl(dataUrl);
  }

  async function handleSendParentNotification() {
    if (!selectedStudent || !notifyText.trim()) return;
    try {
      await apiFetch('/api/notifications/send', {
        method: 'POST',
        body: JSON.stringify({
          studentId: selectedStudent.id,
          channel: 'sms',
          eventType: 'manual_alert',
          message: notifyText.trim(),
        }),
      });
      setNotifyStatus(`Notification dispatched to ${selectedStudent.primaryPhone}`);
    } catch (err) {
      setNotifyStatus(err instanceof Error ? err.message : 'Notification failed');
    }
  }

  const visibleStudents = onlyLowAttendance
    ? students.filter((s) => s.isFrequentlyAbsent)
    : students;

  const allowedClasses =
    user.role === 'teacher'
      ? classes.filter((c) => sections.some((s) => s.classId === c.id && user.assignedSectionIds.includes(s.id)))
      : classes;

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Student Directory & Parent Contacts</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {user.role === 'teacher'
                ? 'Scoped to your assigned classes and sections'
                : 'Complete institutional directory across all enrolled classes'}
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {visibleStudents.length} records
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-60">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Search students by name or admission ID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by student name or Admission ID (e.g., STU-2026-001)"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
            />
          </div>

          <select
            aria-label="Filter by Class"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
          >
            <option value="">All Authorized Classes</option>
            {allowedClasses.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            aria-pressed={onlyLowAttendance}
            onClick={() => setOnlyLowAttendance((v) => !v)}
            className={`px-3.5 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
              onlyLowAttendance
                ? 'bg-rose-950/60 border-rose-500/50 text-rose-200'
                : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
            }`}
          >
            Frequently Absent (&lt;75%)
          </button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-slate-400">Loading student records...</div>
        ) : visibleStudents.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">No matching student records found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 pr-4 font-medium">Student</th>
                  <th className="py-2.5 pr-4 font-medium">Class / Roll</th>
                  <th className="py-2.5 pr-4 font-medium">Parent Contact</th>
                  <th className="py-2.5 pr-4 font-medium">Today Gate Log</th>
                  <th className="py-2.5 pr-4 font-medium text-right">Attendance %</th>
                  <th className="py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {visibleStudents.map((st) => (
                  <tr key={st.id} className="hover:bg-slate-900/40">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-3">
                        <StudentAvatar src={st.photoUrl} name={st.fullName} sizeClass="w-10 h-10 text-xs" />
                        <div>
                          <div className="font-medium text-white">{st.fullName}</div>
                          <div className="font-mono text-slate-400">{st.admissionNumber}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-slate-300">
                      {st.className} - {st.sectionName} · Roll {st.rollNumber}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="text-slate-200">{st.guardianName}</div>
                      <div className="font-mono text-slate-400">{st.primaryPhone}</div>
                    </td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-slate-300">
                      {st.todayEntryTime ? `In ${st.todayEntryTime}` : 'No Entry'}
                      {st.todayExitTime ? ` · Out ${st.todayExitTime}` : ''}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums">
                      <span className={st.isFrequentlyAbsent ? 'text-rose-400 font-semibold' : 'text-emerald-400'}>
                        {(st.attendancePercentage ?? 100).toFixed(1)}%
                      </span>
                      {st.isFrequentlyAbsent && (
                        <div className="text-[11px] text-rose-300 inline-flex items-center gap-1 ml-1">
                          <AlertCircle className="w-3 h-3" /> Low
                        </div>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openQrCard(st)}
                          className="px-2.5 py-1.5 rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 inline-flex items-center gap-1 whitespace-nowrap"
                        >
                          <QrCode className="w-3.5 h-3.5 text-sky-400" />
                          ID Card
                        </button>
                        <button
                          type="button"
                          onClick={() => openStudentDetail(st)}
                          className="px-2.5 py-1.5 rounded-md bg-sky-500/20 border border-sky-500/40 hover:bg-sky-500/30 text-sky-200 font-medium whitespace-nowrap"
                        >
                          View Profile
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Student Profile Detail Modal */}
      {selectedStudent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Profile for ${selectedStudent.fullName}`}
        >
          <div className="glass-panel-active w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-800">
              <div className="flex items-center gap-4">
                <StudentAvatar src={selectedStudent.photoUrl} name={selectedStudent.fullName} sizeClass="w-16 h-16 text-lg" />
                <div>
                  <h3 className="text-xl font-semibold text-white">{selectedStudent.fullName}</h3>
                  <div className="text-xs font-mono text-sky-300 mt-0.5">
                    {selectedStudent.admissionNumber} · {selectedStudent.className} - {selectedStudent.sectionName} · Roll {selectedStudent.rollNumber}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    DOB {selectedStudent.dob} · {selectedStudent.gender} · Blood {selectedStudent.bloodGroup || 'N/A'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close student profile"
                onClick={() => setSelectedStudent(null)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-4 space-y-2">
                <div className="font-semibold text-sky-300">Parent & Emergency Contacts</div>
                <div className="text-slate-300">Father: {selectedStudent.fatherName}</div>
                <div className="text-slate-300">Mother: {selectedStudent.motherName}</div>
                <div className="flex items-center gap-2 font-mono text-white">
                  <Phone className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Primary: {selectedStudent.primaryPhone}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-rose-300">
                  <Phone className="w-3.5 h-3.5 text-rose-400" />
                  <span>Emergency: {selectedStudent.emergencyPhone}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Mail className="w-3.5 h-3.5 text-sky-400" />
                  <span>{selectedStudent.parentEmail}</span>
                </div>
                <div className="text-slate-400 pt-1">{selectedStudent.completeAddress}</div>
              </div>

              <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-4 space-y-2">
                <div className="font-semibold text-sky-300">Biometric & Privacy Status</div>
                <div className="text-slate-300">
                  Face Template: {selectedStudent.hasFaceTemplate ? 'Encrypted AES-256-GCM Enrolled' : 'Not Enrolled'}
                </div>
                <div className="text-slate-300">
                  Digital Signature: {selectedStudent.hasDigitalSignature ? 'Enrolled' : 'Not Enrolled'}
                </div>
                <div className="text-slate-300 font-mono">QR Token: {selectedStudent.qrTokenId}</div>
                <div className="flex items-center gap-1.5 text-emerald-400 pt-1">
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    DPDP Consent {selectedStudent.parentConsentGiven ? 'Verified' : 'Pending'}
                  </span>
                </div>
              </div>
            </div>

            {/* Parent Communication */}
            <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-4 space-y-2.5">
              <div className="text-xs font-semibold text-white">Contact Parent / Dispatch Alert</div>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  aria-label="Message to parent"
                  value={notifyText}
                  onChange={(e) => setNotifyText(e.target.value)}
                  className="flex-1 min-w-60 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={handleSendParentNotification}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold whitespace-nowrap"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send Parent Alert
                </button>
              </div>
              {notifyStatus && <div className="text-xs text-emerald-300">{notifyStatus}</div>}
            </div>

            {/* Recent Entry/Exit & Attendance */}
            {history && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-white">Recent Entry/Exit & Attendance History</div>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/70 text-xs">
                  {history.entryExitHistory.slice(0, 8).map((ev) => (
                    <div key={ev.id} className="px-3 py-2 flex items-center justify-between">
                      <span className="font-mono text-slate-300">
                        {ev.logDate} {ev.logTime}
                      </span>
                      <span className="uppercase text-slate-200">{ev.logType}</span>
                      <span className="text-slate-400">{ev.verificationMethod.replace('_', ' ')}</span>
                      <span className={ev.accessResult === 'granted' ? 'text-emerald-400' : 'text-rose-400'}>
                        {ev.accessResult}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Printable QR Student ID Card Modal */}
      {qrModalStudent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Student ID Card for ${qrModalStudent.fullName}`}
        >
          <div className="glass-panel-active w-full max-w-md rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-semibold text-white">Smart QR Student Identity Card</h3>
              <button
                type="button"
                aria-label="Close ID card modal"
                onClick={() => setQrModalStudent(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl bg-[#070d1d] border border-sky-400/50 p-5 flex items-center justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="text-[11px] font-semibold text-sky-400 tracking-wide">
                  AEGISCAMPUS SMART IDENTITY
                </div>
                <div className="text-base font-bold text-white truncate">{qrModalStudent.fullName}</div>
                <div className="text-xs font-mono text-slate-300">{qrModalStudent.admissionNumber}</div>
                <div className="text-xs text-slate-400">
                  {qrModalStudent.className} - {qrModalStudent.sectionName} · Roll {qrModalStudent.rollNumber}
                </div>
                <div className="text-[11px] font-mono text-slate-400">
                  Emergency: {qrModalStudent.emergencyPhone}
                </div>
              </div>
              {qrDataUrl && (
                <img
                  src={qrDataUrl}
                  alt={`QR Code for ${qrModalStudent.fullName}`}
                  className="w-24 h-24 rounded-lg bg-white p-1.5 shrink-0"
                />
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => exportStudentIdCardPdf(qrModalStudent, qrDataUrl)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                Download Printable PDF Card
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
