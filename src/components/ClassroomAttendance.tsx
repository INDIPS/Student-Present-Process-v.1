import { useEffect, useState } from 'react';
import { AlertCircle, Calendar, Check, Clock, Save, Users, X } from 'lucide-react';
import type {
  AttendanceStatus,
  AuthUser,
  ClassItem,
  SectionItem,
  SubjectItem,
} from '../shared/types';
import { apiFetch } from '../utils/api';
import { StudentAvatar } from './StudentAvatar';

interface ClassroomAttendanceProps {
  user: AuthUser;
  classes: ClassItem[];
  sections: SectionItem[];
  subjects: SubjectItem[];
}

interface ClassroomRow {
  studentId: number;
  admissionNumber: string;
  fullName: string;
  rollNumber: string;
  photoUrl: string;
  attendanceId: number | null;
  status: AttendanceStatus | null;
  source: string | null;
  markedBy: string | null;
  correctionReason: string | null;
}

interface MonthlySummaryRow {
  studentId: number;
  admissionNumber: string;
  fullName: string;
  className: string;
  sectionName: string;
  primaryPhone: string;
  totalDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  excusedDays: number;
  attendancePercentage: number;
  isFrequentlyAbsent: boolean;
}

export function ClassroomAttendance({ user, classes, sections, subjects }: ClassroomAttendanceProps) {
  const allowedSections =
    user.role === 'teacher'
      ? sections.filter((s) => user.assignedSectionIds.includes(s.id))
      : sections;
  const allowedClasses =
    user.role === 'teacher'
      ? classes.filter((c) => allowedSections.some((s) => s.classId === c.id))
      : classes;

  const [viewMode, setViewMode] = useState<'daily' | 'monthly'>('daily');
  const [selectedClassId, setSelectedClassId] = useState<number>(allowedClasses[0]?.id || 1);
  const availableSections = allowedSections.filter((s) => s.classId === selectedClassId);
  const [selectedSectionId, setSelectedSectionId] = useState<number>(availableSections[0]?.id || 1);
  const availableSubjects = subjects.filter((sub) => sub.classId === selectedClassId);
  const [selectedSubjectId, setSelectedSubjectId] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [selectedMonth, setSelectedMonth] = useState<string>(new Date().toISOString().slice(0, 7));

  const [records, setRecords] = useState<ClassroomRow[]>([]);
  const [draftStatuses, setDraftStatuses] = useState<Record<number, AttendanceStatus>>({});
  const [correctionReason, setCorrectionReason] = useState('');
  const [monthlyRows, setMonthlyRows] = useState<MonthlySummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const firstSec = allowedSections.find((s) => s.classId === selectedClassId);
    if (firstSec && !availableSections.some((s) => s.id === selectedSectionId)) {
      setSelectedSectionId(firstSec.id);
    }
  }, [selectedClassId]);

  useEffect(() => {
    if (viewMode === 'daily') {
      void loadDailyAttendance();
    } else {
      void loadMonthlySummary();
    }
  }, [viewMode, selectedClassId, selectedSectionId, selectedSubjectId, selectedDate, selectedMonth]);

  async function loadDailyAttendance() {
    if (!selectedClassId || !selectedSectionId) return;
    setLoading(true);
    setFeedback(null);
    try {
      const qs = new URLSearchParams({
        classId: String(selectedClassId),
        sectionId: String(selectedSectionId),
        date: selectedDate,
      });
      if (selectedSubjectId) qs.set('subjectId', String(selectedSubjectId));
      const data = await apiFetch<{ records: ClassroomRow[] }>(`/api/attendance/class?${qs.toString()}`);
      setRecords(data.records);
      const initialDraft: Record<number, AttendanceStatus> = {};
      for (const r of data.records) {
        initialDraft[r.studentId] = r.status || 'present';
      }
      setDraftStatuses(initialDraft);
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load class roster.' });
    } finally {
      setLoading(false);
    }
  }

  async function loadMonthlySummary() {
    setLoading(true);
    setFeedback(null);
    try {
      const qs = new URLSearchParams({
        month: selectedMonth,
        classId: String(selectedClassId),
        sectionId: String(selectedSectionId),
      });
      const data = await apiFetch<{ summary: MonthlySummaryRow[] }>(`/api/attendance/monthly?${qs.toString()}`);
      setMonthlyRows(data.summary);
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load monthly matrix.' });
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveAttendance() {
    if (records.length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const entries = records.map((r) => ({
        studentId: r.studentId,
        status: draftStatuses[r.studentId] || 'present',
      }));
      await apiFetch('/api/attendance/mark', {
        method: 'POST',
        body: JSON.stringify({
          classId: selectedClassId,
          sectionId: selectedSectionId,
          subjectId: selectedSubjectId,
          date: selectedDate,
          entries,
          correctionReason: correctionReason.trim() || undefined,
        }),
      });
      setFeedback({
        type: 'success',
        text: `Saved ${entries.length} attendance records for ${selectedDate}.`,
      });
      setCorrectionReason('');
      await loadDailyAttendance();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save attendance.' });
    } finally {
      setSaving(false);
    }
  }

  function markAll(status: AttendanceStatus) {
    const next: Record<number, AttendanceStatus> = {};
    for (const r of records) {
      next[r.studentId] = status;
    }
    setDraftStatuses(next);
  }

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <section className="glass-panel rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Classroom Attendance Management</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Authorized as {user.fullName} ({user.role === 'admin' ? 'All Classes' : 'Assigned Sections Only'})
            </p>
          </div>

          <div className="flex items-center p-1 rounded-lg bg-slate-900/90 border border-slate-800">
            <button
              type="button"
              onClick={() => setViewMode('daily')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                viewMode === 'daily' ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-300 hover:text-white'
              }`}
            >
              Daily & Subject Sheet
            </button>
            <button
              type="button"
              onClick={() => setViewMode('monthly')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                viewMode === 'monthly' ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-300 hover:text-white'
              }`}
            >
              Monthly Analytics
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label htmlFor="att-class" className="block text-xs text-slate-400 mb-1">
              Class
            </label>
            <select
              id="att-class"
              value={selectedClassId}
              onChange={(e) => setSelectedClassId(Number(e.target.value))}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
            >
              {allowedClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="att-section" className="block text-xs text-slate-400 mb-1">
              Section
            </label>
            <select
              id="att-section"
              value={selectedSectionId}
              onChange={(e) => setSelectedSectionId(Number(e.target.value))}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
            >
              {availableSections.map((s) => (
                <option key={s.id} value={s.id}>
                  Section {s.name} ({s.roomNumber})
                </option>
              ))}
            </select>
          </div>

          {viewMode === 'daily' ? (
            <>
              <div>
                <label htmlFor="att-subject" className="block text-xs text-slate-400 mb-1">
                  Scope / Subject
                </label>
                <select
                  id="att-subject"
                  value={selectedSubjectId ?? ''}
                  onChange={(e) => setSelectedSubjectId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
                >
                  <option value="">Homeroom Daily Attendance</option>
                  {availableSubjects.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name} ({sub.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="att-date" className="block text-xs text-slate-400 mb-1">
                  Date
                </label>
                <input
                  id="att-date"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
                />
              </div>
            </>
          ) : (
            <div>
              <label htmlFor="att-month" className="block text-xs text-slate-400 mb-1">
                Month
              </label>
              <input
                id="att-month"
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>
          )}
        </div>
      </section>

      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          className={`rounded-xl px-4 py-3 border text-xs font-medium ${
            feedback.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
              : 'bg-red-950/60 border-red-500/40 text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {viewMode === 'daily' ? (
        <section className="glass-panel rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Users className="w-4 h-4 text-sky-400" />
              <span>Class Roster ({records.length} students)</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => markAll('present')}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 whitespace-nowrap"
              >
                Mark All Present
              </button>
              <button
                type="button"
                onClick={() => markAll('absent')}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 whitespace-nowrap"
              >
                Mark All Absent
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-10 text-center text-xs text-slate-400">Loading class attendance roster...</div>
          ) : records.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              No active students enrolled in this class and section.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2.5 pr-4 font-medium">Roll</th>
                    <th className="py-2.5 pr-4 font-medium">Student</th>
                    <th className="py-2.5 pr-4 font-medium">Recorded Source</th>
                    <th className="py-2.5 font-medium text-right">Attendance Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {records.map((row) => {
                    const current = draftStatuses[row.studentId] || 'present';
                    return (
                      <tr key={row.studentId} className="hover:bg-slate-900/40">
                        <td className="py-3 pr-4 font-mono tabular-nums text-slate-300">{row.rollNumber}</td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2.5">
                            <StudentAvatar src={row.photoUrl} name={row.fullName} sizeClass="w-9 h-9 text-xs" />
                            <div>
                              <div className="font-medium text-white">{row.fullName}</div>
                              <div className="font-mono text-slate-400">{row.admissionNumber}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-slate-400">
                          {row.source ? `${row.source.replace('_', ' ')} (${row.markedBy})` : 'Not marked yet'}
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
                            {(
                              [
                                { id: 'present', label: 'Present', icon: Check, active: 'bg-emerald-500 text-slate-950' },
                                { id: 'late', label: 'Late', icon: Clock, active: 'bg-amber-400 text-slate-950' },
                                { id: 'absent', label: 'Absent', icon: X, active: 'bg-rose-500 text-white' },
                                { id: 'excused', label: 'Excused', icon: Calendar, active: 'bg-sky-500 text-slate-950' },
                              ] as const
                            ).map((opt) => {
                              const active = current === opt.id;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  onClick={() =>
                                    setDraftStatuses((prev) => ({ ...prev, [row.studentId]: opt.id }))
                                  }
                                  aria-label={`Mark ${row.fullName} ${opt.label}`}
                                  aria-pressed={active}
                                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                                    active ? opt.active : 'text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {records.length > 0 && (
            <div className="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <input
                type="text"
                aria-label="Manual correction authorization note"
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="Optional audit note for manual attendance overrides (e.g., Medical excuse verified)"
                className="flex-1 min-w-64 rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
              />
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveAttendance}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save Classroom Attendance'}
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="glass-panel rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-base font-semibold text-white">
              Monthly Attendance Percentage & Low-Attendance Alerts ({selectedMonth})
            </h3>
            <span className="text-xs text-slate-400">Threshold: 75% minimum</span>
          </div>

          {loading ? (
            <div className="py-10 text-center text-xs text-slate-400">Calculating monthly percentages...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2.5 pr-4 font-medium">Student</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Days Logged</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Present</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Late</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Absent</th>
                    <th className="py-2.5 pr-4 font-medium text-right">Attendance %</th>
                    <th className="py-2.5 font-medium text-right">Standing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {monthlyRows.map((m) => (
                    <tr key={m.studentId} className="hover:bg-slate-900/40">
                      <td className="py-3 pr-4">
                        <div className="font-medium text-white">{m.fullName}</div>
                        <div className="font-mono text-slate-400">
                          {m.admissionNumber} · {m.className}-{m.sectionName}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums text-slate-300">{m.totalDays}</td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums text-emerald-400">{m.presentDays}</td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums text-amber-400">{m.lateDays}</td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums text-rose-400">{m.absentDays}</td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums font-semibold text-white">
                        {m.attendancePercentage.toFixed(1)}%
                      </td>
                      <td className="py-3 text-right">
                        {m.isFrequentlyAbsent ? (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                            <AlertCircle className="w-3.5 h-3.5" />
                            Frequently Absent
                          </span>
                        ) : (
                          <span className="text-emerald-400 font-medium">Satisfactory</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
