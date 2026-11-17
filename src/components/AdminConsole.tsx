import { useEffect, useState, type FormEvent } from 'react';
import {
  Cpu,
  Database,
  Download,
  Lock,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type {
  AcademicSession,
  ActivityLogItem,
  ClassItem,
  SectionItem,
  StudentRecord,
} from '../shared/types';
import { apiFetch, getStoredToken } from '../utils/api';
import { extractDescriptorFromImageUrl } from '../utils/faceEngine';

interface AdminConsoleProps {
  sessions: AcademicSession[];
  classes: ClassItem[];
  sections: SectionItem[];
  settings: Record<string, string>;
  onBootstrapRefresh: () => void;
}

interface TeacherRow {
  id: number;
  employeeCode: string;
  email: string;
  fullName: string;
  phone: string;
  department: string;
  assignedClassIds: number[];
  assignedSectionIds: number[];
  isActive: boolean;
}

interface TimetableRow {
  id: number;
  className: string;
  sectionName: string;
  subjectName: string;
  teacherName: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
}

export function AdminConsole({
  sessions,
  classes,
  sections,
  settings,
  onBootstrapRefresh,
}: AdminConsoleProps) {
  const [subTab, setSubTab] = useState<'teachers' | 'academics' | 'devices' | 'settings' | 'logs' | 'database'>('teachers');
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [timetables, setTimetables] = useState<TimetableRow[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLogItem[]>([]);
  const [schemaSql, setSchemaSql] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Teacher form
  const [tCode, setTCode] = useState('');
  const [tName, setTName] = useState('');
  const [tEmail, setTEmail] = useState('');
  const [tPhone, setTPhone] = useState('');
  const [tDept, setTDept] = useState('Mathematics');
  const [tPass, setTPass] = useState('Teacher@2026');
  const [tSectionId, setTSectionId] = useState<number>(sections[0]?.id || 1);

  // Academic creation form
  const [acadType, setAcadType] = useState<'class' | 'section' | 'subject' | 'session'>('section');
  const [acadName, setAcadName] = useState('');
  const [acadClassId, setAcadClassId] = useState<number>(classes[0]?.id || 1);
  const [acadExtra, setAcadExtra] = useState('');

  // System settings form
  const [lateCutoff, setLateCutoff] = useState(settings.late_cutoff_time || '08:15');
  const [earlyCutoff, setEarlyCutoff] = useState(settings.early_departure_cutoff_time || '13:30');
  const [faceThreshold, setFaceThreshold] = useState(settings.face_similarity_threshold || '0.88');
  const [retentionDays, setRetentionDays] = useState(settings.biometric_retention_days || '730');
  const [autoNotify, setAutoNotify] = useState(settings.auto_parent_notifications !== 'false');

  useEffect(() => {
    void loadOverview();
  }, []);

  async function loadOverview() {
    try {
      const data = await apiFetch<{
        teachers: TeacherRow[];
        timetables: TimetableRow[];
        activityLogs: ActivityLogItem[];
      }>('/api/admin/overview');
      setTeachers(data.teachers);
      setTimetables(data.timetables);
      setActivityLogs(data.activityLogs);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load admin overview.');
    }
  }

  async function handleAddTeacher(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    const sec = sections.find((s) => s.id === tSectionId);
    try {
      await apiFetch('/api/admin/teachers', {
        method: 'POST',
        body: JSON.stringify({
          employeeCode: tCode,
          fullName: tName,
          email: tEmail,
          phone: tPhone,
          department: tDept,
          password: tPass,
          assignedClassIds: sec ? [sec.classId] : [1],
          assignedSectionIds: [tSectionId],
        }),
      });
      setStatusMsg(`Registered teacher ${tName} (${tCode}).`);
      setTCode('');
      setTName('');
      setTEmail('');
      await loadOverview();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to add teacher.');
    }
  }

  async function handleAddAcademic(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiFetch('/api/admin/academics', {
        method: 'POST',
        body: JSON.stringify({
          type: acadType,
          name: acadName,
          classId: acadClassId,
          roomNumber: acadExtra || 'Room-204',
          code: acadExtra || undefined,
          gradeLevel: Number(acadExtra) || 10,
        }),
      });
      setStatusMsg(`Created ${acadType}: ${acadName}`);
      setAcadName('');
      setAcadExtra('');
      onBootstrapRefresh();
      await loadOverview();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create academic item.');
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          late_cutoff_time: lateCutoff,
          early_departure_cutoff_time: earlyCutoff,
          face_similarity_threshold: faceThreshold,
          biometric_retention_days: retentionDays,
          auto_parent_notifications: String(autoNotify),
        }),
      });
      setStatusMsg('System configuration and DPDP retention policy updated.');
      onBootstrapRefresh();
      await loadOverview();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save settings.');
    }
  }

  async function handleCalibrateSeededPhotos() {
    setErrorMsg(null);
    setStatusMsg('Extracting live 64-dim facial vectors from enrolled student ID photos...');
    try {
      const { students } = await apiFetch<{ students: StudentRecord[] }>('/api/students');
      let updated = 0;
      for (const st of students) {
        if (st.photoUrl) {
          const descriptor = await extractDescriptorFromImageUrl(st.photoUrl);
          if (descriptor.length > 0) {
            await apiFetch(`/api/students/${st.id}/biometrics`, {
              method: 'PATCH',
              body: JSON.stringify({ faceDescriptor: descriptor }),
            });
            updated += 1;
          }
        }
      }
      setStatusMsg(`Calibrated & AES-256-GCM encrypted facial templates for ${updated} photographed students.`);
      await loadOverview();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Calibration failed.');
    }
  }

  async function loadSqlSchema() {
    const sql = await apiFetch<string>('/api/admin/schema-sql');
    setSchemaSql(sql);
  }

  async function downloadBackup() {
    const token = getStoredToken();
    const res = await fetch('/api/admin/backup', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      setErrorMsg('Database backup download failed.');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aegiscampus-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg('Consistent SQLite snapshot backup downloaded.');
  }

  return (
    <div className="space-y-6">
      {/* Sub-navigation */}
      <div className="glass-panel rounded-xl p-2 flex flex-wrap gap-1.5">
        {(
          [
            { id: 'teachers', label: 'Teachers & Roles', icon: Users },
            { id: 'academics', label: 'Classes & Timetables', icon: Plus },
            { id: 'devices', label: 'Biometric Hardware & SDK', icon: Cpu },
            { id: 'settings', label: 'Policy & DPDP Config', icon: Settings },
            { id: 'logs', label: 'Activity Logs', icon: Lock },
            { id: 'database', label: 'Backup & SQL Schema', icon: Database },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setSubTab(tab.id);
                if (tab.id === 'database' && !schemaSql) void loadSqlSchema();
              }}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:bg-slate-900 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {statusMsg && (
        <div role="status" className="rounded-xl bg-emerald-950/60 border border-emerald-500/40 px-4 py-3 text-xs text-emerald-200">
          {statusMsg}
        </div>
      )}
      {errorMsg && (
        <div role="alert" className="rounded-xl bg-red-950/60 border border-red-500/40 px-4 py-3 text-xs text-red-200">
          {errorMsg}
        </div>
      )}

      {subTab === 'teachers' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form onSubmit={handleAddTeacher} className="lg:col-span-5 glass-panel rounded-xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-white">Register Faculty Account</h3>
            <input
              required
              value={tCode}
              onChange={(e) => setTCode(e.target.value)}
              placeholder="Employee Code (e.g. TCH-103)"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs font-mono text-white"
            />
            <input
              required
              value={tName}
              onChange={(e) => setTName(e.target.value)}
              placeholder="Full Name"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <input
              required
              type="email"
              value={tEmail}
              onChange={(e) => setTEmail(e.target.value)}
              placeholder="Institutional Email"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <input
              value={tPhone}
              onChange={(e) => setTPhone(e.target.value)}
              placeholder="Phone (+91 ...)"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs font-mono text-white"
            />
            <input
              value={tDept}
              onChange={(e) => setTDept(e.target.value)}
              placeholder="Department"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <select
              aria-label="Assign Section"
              value={tSectionId}
              onChange={(e) => setTSectionId(Number(e.target.value))}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            >
              {sections.map((s) => {
                const cls = classes.find((c) => c.id === s.classId);
                return (
                  <option key={s.id} value={s.id}>
                    Assign {cls?.name} - Section {s.name}
                  </option>
                );
              })}
            </select>
            <input
              required
              type="password"
              value={tPass}
              onChange={(e) => setTPass(e.target.value)}
              placeholder="Initial Password"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <button
              type="submit"
              className="w-full py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold"
            >
              Create Teacher Account
            </button>
          </form>

          <section className="lg:col-span-7 glass-panel rounded-xl p-5">
            <h3 className="text-base font-semibold text-white pb-3 border-b border-slate-800">
              Registered Teachers & RBAC Scopes
            </h3>
            <div className="divide-y divide-slate-800/70 text-xs mt-2">
              {teachers.map((t) => (
                <div key={t.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-white">
                      {t.fullName} · <span className="font-mono text-sky-300">{t.employeeCode}</span>
                    </div>
                    <div className="text-slate-400">
                      {t.email} · {t.department}
                    </div>
                  </div>
                  <div className="text-right font-mono text-slate-300">
                    Sections: {t.assignedSectionIds.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {subTab === 'academics' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form onSubmit={handleAddAcademic} className="lg:col-span-4 glass-panel rounded-xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-white">Add Class / Section / Subject / Session</h3>
            <select
              aria-label="Entity Type"
              value={acadType}
              onChange={(e) => setAcadType(e.target.value as typeof acadType)}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            >
              <option value="class">New Class</option>
              <option value="section">New Section</option>
              <option value="subject">New Subject</option>
              <option value="session">New Academic Session</option>
            </select>
            {(acadType === 'section' || acadType === 'subject') && (
              <select
                aria-label="Parent Class"
                value={acadClassId}
                onChange={(e) => setAcadClassId(Number(e.target.value))}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
              >
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <input
              required
              value={acadName}
              onChange={(e) => setAcadName(e.target.value)}
              placeholder={acadType === 'session' ? '2027-2028' : 'Name (e.g. C or Biology)'}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <input
              value={acadExtra}
              onChange={(e) => setAcadExtra(e.target.value)}
              placeholder={
                acadType === 'section'
                  ? 'Room Number (e.g. NB-204)'
                  : acadType === 'subject'
                  ? 'Subject Code (e.g. BIO-11)'
                  : 'Grade Level (e.g. 9)'
              }
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-white"
            />
            <button type="submit" className="w-full py-2.5 rounded-lg bg-sky-500 text-slate-950 text-xs font-semibold">
              Add Academic Record
            </button>
          </form>

          <section className="lg:col-span-8 glass-panel rounded-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-white">Active Sessions & Class Timetables</h3>
            <div className="text-xs text-slate-300">
              Sessions: {sessions.map((s) => `${s.name}${s.isActive ? ' (Active)' : ''}`).join(' · ')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-4">Day</th>
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Class / Section</th>
                    <th className="py-2 pr-4">Subject</th>
                    <th className="py-2">Faculty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {timetables.map((tt) => (
                    <tr key={tt.id}>
                      <td className="py-2 pr-4 text-slate-200">{tt.dayOfWeek}</td>
                      <td className="py-2 pr-4 font-mono text-slate-300">
                        {tt.startTime} - {tt.endTime}
                      </td>
                      <td className="py-2 pr-4 text-slate-300">
                        {tt.className} - {tt.sectionName}
                      </td>
                      <td className="py-2 pr-4 text-sky-300">{tt.subjectName}</td>
                      <td className="py-2 text-slate-300">{tt.teacherName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {subTab === 'devices' && (
        <section className="glass-panel rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-base font-semibold text-white">Biometric Devices & Fingerprint SDK Integration</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Configure optical fingerprint bridges and calibrate encrypted facial embeddings from ID portraits
              </p>
            </div>
            <button
              type="button"
              onClick={handleCalibrateSeededPhotos}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Calibrate Enrolled Photo Templates
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-4 space-y-2">
              <div className="font-semibold text-white">1. Fingerprint Hardware Bridge (Mantra MFS100 / SecuGen / ZKTeco)</div>
              <p className="text-slate-400 leading-relaxed">
                Browser sandboxes cannot access raw USB fingerprint minutiae directly without a vendor RD Service or WebHID driver. Install the vendor local RD Service daemon listening on <span className="font-mono text-sky-300">http://127.0.0.1:11100</span> or WebSocket bridge <span className="font-mono text-sky-300">ws://localhost:8443/rdservice</span>, capture ISO-19794-2 templates, and transmit hashed/encrypted templates over TLS to <span className="font-mono text-slate-300">POST /api/kiosk/verify</span>.
              </p>
            </div>
            <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-4 space-y-2">
              <div className="font-semibold text-white">2. Facial Recognition & Anti-Spoofing Pipeline</div>
              <p className="text-slate-400 leading-relaxed">
                Terminal webcam frames run real-time 64-dimensional normalized spatial descriptors paired with consecutive-frame micro-motion liveness validation. Templates are encrypted at rest with AES-256-GCM in <span className="font-mono text-slate-300">student_biometrics</span> and never exposed to client browsers.
              </p>
            </div>
          </div>
        </section>
      )}

      {subTab === 'settings' && (
        <form onSubmit={handleSaveSettings} className="glass-panel rounded-xl p-5 space-y-4 max-w-2xl">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-base font-semibold text-white">Attendance Thresholds & DPDP Act Data Retention</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label htmlFor="set-late" className="block text-slate-300 mb-1">
                Morning Late Arrival Cutoff (HH:MM)
              </label>
              <input
                id="set-late"
                type="time"
                value={lateCutoff}
                onChange={(e) => setLateCutoff(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label htmlFor="set-early" className="block text-slate-300 mb-1">
                Early Departure Cutoff (HH:MM)
              </label>
              <input
                id="set-early"
                type="time"
                value={earlyCutoff}
                onChange={(e) => setEarlyCutoff(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label htmlFor="set-thresh" className="block text-slate-300 mb-1">
                Face Match Cosine Threshold (0.75 - 0.98)
              </label>
              <input
                id="set-thresh"
                type="number"
                step="0.01"
                min="0.75"
                max="0.98"
                value={faceThreshold}
                onChange={(e) => setFaceThreshold(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label htmlFor="set-ret" className="block text-slate-300 mb-1">
                Biometric Data Retention Policy (Days)
              </label>
              <input
                id="set-ret"
                type="number"
                min="30"
                max="1825"
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-white"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoNotify}
              onChange={(e) => setAutoNotify(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 text-sky-500"
            />
            <span>Automatically dispatch parent entry/exit & late-arrival notifications</span>
          </label>

          <button type="submit" className="px-5 py-2.5 rounded-lg bg-sky-500 text-slate-950 text-xs font-semibold">
            Save Configuration
          </button>
        </form>
      )}

      {subTab === 'logs' && (
        <section className="glass-panel rounded-xl p-5 space-y-3">
          <h3 className="text-base font-semibold text-white pb-3 border-b border-slate-800">
            Security & Data Access Audit Logs
          </h3>
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-4">Timestamp</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {activityLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2 pr-4 font-mono text-slate-400 whitespace-nowrap">{log.createdAt}</td>
                    <td className="py-2 pr-4 text-slate-200">{log.actorEmail}</td>
                    <td className="py-2 pr-4 font-mono text-sky-300">{log.action}</td>
                    <td className="py-2 pr-4 font-mono text-slate-400">{log.targetEntity}</td>
                    <td className="py-2 text-slate-300">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {subTab === 'database' && (
        <section className="glass-panel rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-base font-semibold text-white">Relational SQLite Database Backup & Schema</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                15+ normalized relational tables with WAL mode and foreign key enforcement
              </p>
            </div>
            <button
              type="button"
              onClick={downloadBackup}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              Download Consistent SQLite Backup
            </button>
          </div>
          <pre className="rounded-lg bg-slate-950 border border-slate-800 p-4 text-[11px] font-mono text-sky-200/90 overflow-x-auto max-h-96">
            {schemaSql || 'Loading relational SQL DDL schema...'}
          </pre>
        </section>
      )}
    </div>
  );
}
