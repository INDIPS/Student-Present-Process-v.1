import { useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent } from 'react';
import { CheckCircle2, ShieldCheck, Upload, UserPlus } from 'lucide-react';
import type { AcademicSession, ClassItem, SchoolBranch, SectionItem } from '../shared/types';
import { apiFetch } from '../utils/api';
import { extractDescriptorFromImageUrl, readImageFileAsDataUrl } from '../utils/faceEngine';
import { StudentAvatar } from './StudentAvatar';

interface StudentRegistrationProps {
  branches: SchoolBranch[];
  sessions: AcademicSession[];
  classes: ClassItem[];
  sections: SectionItem[];
  onRegistered: () => void;
}

export function StudentRegistration({
  branches,
  sessions,
  classes,
  sections,
  onRegistered,
}: StudentRegistrationProps) {
  const [admissionNumber, setAdmissionNumber] = useState('');
  const [fullName, setFullName] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [faceDescriptor, setFaceDescriptor] = useState<number[]>([]);
  const [dob, setDob] = useState('2010-06-15');
  const [gender, setGender] = useState('Female');
  const [bloodGroup, setBloodGroup] = useState('O+');
  const [homeAddress, setHomeAddress] = useState('');
  const [classId, setClassId] = useState<number>(classes[0]?.id || 1);
  const filteredSections = sections.filter((s) => s.classId === classId);
  const [sectionId, setSectionId] = useState<number>(filteredSections[0]?.id || 1);
  const [rollNumber, setRollNumber] = useState('');
  const [academicSessionId, setAcademicSessionId] = useState<number>(
    sessions.find((s) => s.isActive)?.id || sessions[0]?.id || 1
  );
  const [branchId, setBranchId] = useState<number>(branches[0]?.id || 1);

  // Parent / Guardian
  const [fatherName, setFatherName] = useState('');
  const [motherName, setMotherName] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [primaryPhone, setPrimaryPhone] = useState('');
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [completeAddress, setCompleteAddress] = useState('');
  const [parentConsentGiven, setParentConsentGiven] = useState(false);

  // Digital Signature Enrollment Pad
  const sigRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasSig, setHasSig] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  async function handlePhotoUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await readImageFileAsDataUrl(file);
    setPhotoUrl(dataUrl);
    const desc = await extractDescriptorFromImageUrl(dataUrl);
    setFaceDescriptor(desc);
  }

  function startDraw(e: PointerEvent<HTMLCanvasElement>) {
    const canvas = sigRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawingRef.current = true;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  }

  function moveDraw(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !sigRef.current) return;
    const rect = sigRef.current.getBoundingClientRect();
    const ctx = sigRef.current.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
    setHasSig(true);
  }

  function clearSig() {
    if (!sigRef.current) return;
    sigRef.current.getContext('2d')?.clearRect(0, 0, sigRef.current.width, sigRef.current.height);
    setHasSig(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);
    try {
      const signatureDataUrl = hasSig && sigRef.current ? sigRef.current.toDataURL('image/png') : undefined;
      const res = await apiFetch<{ id: number; admissionNumber: string; qrTokenId: string }>('/api/students', {
        method: 'POST',
        body: JSON.stringify({
          admissionNumber,
          fullName,
          photoUrl,
          dob,
          gender,
          bloodGroup,
          homeAddress,
          classId,
          sectionId,
          rollNumber,
          academicSessionId,
          branchId,
          fatherName,
          motherName,
          guardianName: guardianName || fatherName,
          primaryPhone,
          secondaryPhone,
          parentEmail,
          emergencyPhone,
          completeAddress: completeAddress || homeAddress,
          parentConsentGiven,
          faceDescriptor,
          signatureDataUrl,
        }),
      });
      setSuccessMsg(
        `Registered ${fullName} (${res.admissionNumber}) once with encrypted biometrics and QR token ${res.qrTokenId}.`
      );
      setAdmissionNumber('');
      setFullName('');
      setRollNumber('');
      setPhotoUrl('');
      setFaceDescriptor([]);
      clearSig();
      onRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Student registration failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="glass-panel rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-white">One-Time Student Registration & Biometric Enrollment</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Duplicate Admission IDs and Roll Numbers are blocked automatically. Templates are AES-256-GCM encrypted.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <ShieldCheck className="w-4 h-4" />
            <span>DPDP Act Compliant Enrollment</span>
          </div>
        </div>

        {/* Personal Details */}
        <div>
          <h3 className="text-sm font-semibold text-sky-300 mb-3">01. Student Personal & Academic Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="reg-adm" className="block text-xs text-slate-300 mb-1">
                Student ID / Admission Number *
              </label>
              <input
                id="reg-adm"
                required
                value={admissionNumber}
                onChange={(e) => setAdmissionNumber(e.target.value)}
                placeholder="STU-2026-007"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-name" className="block text-xs text-slate-300 mb-1">
                Full Name *
              </label>
              <input
                id="reg-name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Kavya Krishnan"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-dob" className="block text-xs text-slate-300 mb-1">
                Date of Birth *
              </label>
              <input
                id="reg-dob"
                type="date"
                required
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="reg-gender" className="block text-xs text-slate-300 mb-1">
                Gender *
              </label>
              <select
                id="reg-gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              >
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label htmlFor="reg-blood" className="block text-xs text-slate-300 mb-1">
                Blood Group (Optional)
              </label>
              <input
                id="reg-blood"
                value={bloodGroup}
                onChange={(e) => setBloodGroup(e.target.value)}
                placeholder="O+"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-roll" className="block text-xs text-slate-300 mb-1">
                Roll Number *
              </label>
              <input
                id="reg-roll"
                required
                value={rollNumber}
                onChange={(e) => setRollNumber(e.target.value)}
                placeholder="14"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="reg-class" className="block text-xs text-slate-300 mb-1">
                Class *
              </label>
              <select
                id="reg-class"
                value={classId}
                onChange={(e) => {
                  const cid = Number(e.target.value);
                  setClassId(cid);
                  const firstSec = sections.find((s) => s.classId === cid);
                  if (firstSec) setSectionId(firstSec.id);
                }}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              >
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reg-section" className="block text-xs text-slate-300 mb-1">
                Section *
              </label>
              <select
                id="reg-section"
                value={sectionId}
                onChange={(e) => setSectionId(Number(e.target.value))}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              >
                {filteredSections.map((s) => (
                  <option key={s.id} value={s.id}>
                    Section {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reg-session" className="block text-xs text-slate-300 mb-1">
                Academic Session *
              </label>
              <select
                id="reg-session"
                value={academicSessionId}
                onChange={(e) => setAcademicSessionId(Number(e.target.value))}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              >
                {sessions.map((ses) => (
                  <option key={ses.id} value={ses.id}>
                    {ses.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="reg-branch" className="block text-xs text-slate-300 mb-1">
                School Branch *
              </label>
              <select
                id="reg-branch"
                value={branchId}
                onChange={(e) => setBranchId(Number(e.target.value))}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="reg-home" className="block text-xs text-slate-300 mb-1">
                Home Address *
              </label>
              <input
                id="reg-home"
                required
                value={homeAddress}
                onChange={(e) => setHomeAddress(e.target.value)}
                placeholder="Flat 302, HSR Layout Sector 2, Bengaluru 560102"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
          </div>
        </div>

        {/* Parent / Guardian Details */}
        <div className="pt-4 border-t border-slate-800">
          <h3 className="text-sm font-semibold text-sky-300 mb-3">02. Parent & Emergency Contact Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="reg-father" className="block text-xs text-slate-300 mb-1">
                Father's Name *
              </label>
              <input
                id="reg-father"
                required
                value={fatherName}
                onChange={(e) => setFatherName(e.target.value)}
                placeholder="Suresh Krishnan"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-mother" className="block text-xs text-slate-300 mb-1">
                Mother's Name *
              </label>
              <input
                id="reg-mother"
                required
                value={motherName}
                onChange={(e) => setMotherName(e.target.value)}
                placeholder="Radha Krishnan"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-guardian" className="block text-xs text-slate-300 mb-1">
                Guardian Name
              </label>
              <input
                id="reg-guardian"
                value={guardianName}
                onChange={(e) => setGuardianName(e.target.value)}
                placeholder="Optional if same as parent"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="reg-pphone" className="block text-xs text-slate-300 mb-1">
                Primary Contact Number *
              </label>
              <input
                id="reg-pphone"
                required
                value={primaryPhone}
                onChange={(e) => setPrimaryPhone(e.target.value)}
                placeholder="+91 98450 99881"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-sphone" className="block text-xs text-slate-300 mb-1">
                Secondary Contact Number
              </label>
              <input
                id="reg-sphone"
                value={secondaryPhone}
                onChange={(e) => setSecondaryPhone(e.target.value)}
                placeholder="+91 98450 99882"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label htmlFor="reg-ephone" className="block text-xs text-slate-300 mb-1">
                Emergency Contact Number *
              </label>
              <input
                id="reg-ephone"
                required
                value={emergencyPhone}
                onChange={(e) => setEmergencyPhone(e.target.value)}
                placeholder="+91 98450 99999"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-sky-400"
              />
            </div>

            <div>
              <label htmlFor="reg-pemail" className="block text-xs text-slate-300 mb-1">
                Parent Email *
              </label>
              <input
                id="reg-pemail"
                type="email"
                required
                value={parentEmail}
                onChange={(e) => setParentEmail(e.target.value)}
                placeholder="parent@example.in"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="reg-caddr" className="block text-xs text-slate-300 mb-1">
                Complete Guardian Address *
              </label>
              <input
                id="reg-caddr"
                required
                value={completeAddress}
                onChange={(e) => setCompleteAddress(e.target.value)}
                placeholder="Complete postal address for official notices"
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-400"
              />
            </div>
          </div>
        </div>

        {/* Biometric & Consent */}
        <div className="pt-4 border-t border-slate-800 space-y-4">
          <h3 className="text-sm font-semibold text-sky-300">03. Biometric & Identity Card Enrollment</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="rounded-xl bg-slate-950/70 border border-slate-800 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <StudentAvatar src={photoUrl} name={fullName || 'Student'} sizeClass="w-14 h-14 text-base" />
                <div>
                  <div className="text-xs font-medium text-white">Student Photograph & Facial Template</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {faceDescriptor.length > 0
                      ? `Extracted ${faceDescriptor.length}-dim encrypted facial vector`
                      : 'Upload ID photo to extract encrypted facial descriptor'}
                  </div>
                </div>
              </div>
              <label className="cursor-pointer inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-sky-500/40 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-sky-200 transition-colors">
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Student Portrait</span>
                <input type="file" accept="image/*" className="sr-only" onChange={handlePhotoUpload} />
              </label>
            </div>

            <div className="rounded-xl bg-slate-950/70 border border-slate-800 p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-white">Digital Signature Specimen</span>
                <button type="button" onClick={clearSig} className="text-xs text-slate-400 hover:text-white">
                  Clear
                </button>
              </div>
              <canvas
                ref={sigRef}
                width={420}
                height={100}
                onPointerDown={startDraw}
                onPointerMove={moveDraw}
                onPointerUp={() => (drawingRef.current = false)}
                onPointerLeave={() => (drawingRef.current = false)}
                className="w-full h-24 rounded-lg bg-slate-900 border border-slate-700 touch-none cursor-crosshair"
              />
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-xl bg-slate-900/70 border border-sky-500/25 p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={parentConsentGiven}
              onChange={(e) => setParentConsentGiven(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-600 text-sky-500 focus:ring-sky-400"
            />
            <span className="text-xs text-slate-300 leading-relaxed">
              Verifiable parental/guardian consent collected under the Digital Personal Data Protection (DPDP) Act for biometric attendance processing, encrypted template storage, and automated entry/exit safety alerts.
            </span>
          </label>
        </div>

        {error && (
          <div role="alert" className="rounded-lg bg-red-950/60 border border-red-500/40 px-4 py-3 text-xs text-red-200">
            {error}
          </div>
        )}
        {successMsg && (
          <div role="status" className="flex items-center gap-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 px-4 py-3 text-xs text-emerald-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            {submitting ? 'Enrolling Student...' : 'Complete One-Time Registration'}
          </button>
        </div>
      </section>
    </form>
  );
}
