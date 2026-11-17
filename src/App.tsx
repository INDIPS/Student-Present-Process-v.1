import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  FileBarChart2,
  Lock,
  LogIn,
  LogOut,
  Menu,
  ScanFace,
  Settings2,
  Shield,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type {
  AcademicSession,
  AuthUser,
  ClassItem,
  KioskDashboardState,
  SchoolBranch,
  SectionItem,
  SubjectItem,
} from './shared/types';
import { apiFetch, fetchCurrentUser, setStoredToken } from './utils/api';
import { AdminConsole } from './components/AdminConsole';
import { ClassroomAttendance } from './components/ClassroomAttendance';
import { GateTerminal } from './components/GateTerminal';
import { LoginModal } from './components/LoginModal';
import { ReportsCenter } from './components/ReportsCenter';
import { StudentDirectory } from './components/StudentDirectory';
import { StudentRegistration } from './components/StudentRegistration';

type NavTab = 'terminal' | 'classroom' | 'directory' | 'register' | 'reports' | 'admin';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('terminal');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const [user, setUser] = useState<AuthUser | null>(null);
  const [branches, setBranches] = useState<SchoolBranch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<number>(1);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [sections, setSections] = useState<SectionItem[]>([]);
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [kioskState, setKioskState] = useState<KioskDashboardState | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [nowClock, setNowClock] = useState<Date>(() => new Date());
  const [directoryRefreshKey, setDirectoryRefreshKey] = useState(0);

  const loadBootstrap = useCallback(async () => {
    const data = await apiFetch<{
      branches: SchoolBranch[];
      sessions: AcademicSession[];
      classes: ClassItem[];
      sections: SectionItem[];
      subjects: SubjectItem[];
      settings: Record<string, string>;
    }>('/api/bootstrap');
    setBranches(data.branches);
    setSessions(data.sessions);
    setClasses(data.classes);
    setSections(data.sections);
    setSubjects(data.subjects);
    setSettings(data.settings);
  }, []);

  const loadKioskState = useCallback(async () => {
    const data = await apiFetch<KioskDashboardState>(
      `/api/kiosk/state?branchId=${selectedBranchId}`
    );
    setKioskState(data);
  }, [selectedBranchId]);

  useEffect(() => {
    void fetchCurrentUser().then(setUser);
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    void loadKioskState();
  }, [loadKioskState]);

  // Live 1-second digital clock
  useEffect(() => {
    const timer = window.setInterval(() => setNowClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Real WebSocket subscription for live attendance updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 3500);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { type: string; payload: KioskDashboardState };
          if (msg.type === 'attendance:update' && msg.payload) {
            setKioskState(msg.payload);
          }
        } catch {
          // ignore malformed frames
        }
      };
    }

    connect();
    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  async function handleSignOut() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredToken(null);
    setUser(null);
    setActiveTab('terminal');
  }

  function handleNavClick(tab: NavTab) {
    if (tab !== 'terminal' && !user) {
      setLoginOpen(true);
      return;
    }
    if ((tab === 'register' || tab === 'admin') && user?.role !== 'admin') {
      setLoginOpen(true);
      return;
    }
    setActiveTab(tab);
    setMobileMenuOpen(false);
  }

  const navItems: Array<{ id: NavTab; label: string; icon: typeof ScanFace; roleRequired?: 'auth' | 'admin' }> = [
    { id: 'terminal', label: 'Gate Terminal', icon: ScanFace },
    { id: 'classroom', label: 'Class Attendance', icon: BookOpen, roleRequired: 'auth' },
    { id: 'directory', label: 'Student Directory', icon: Users, roleRequired: 'auth' },
    { id: 'register', label: 'Register Student', icon: UserPlus, roleRequired: 'admin' },
    { id: 'reports', label: 'Reports & Alerts', icon: FileBarChart2, roleRequired: 'auth' },
    { id: 'admin', label: 'Admin Console', icon: Settings2, roleRequired: 'admin' },
  ];

  const tabTitles: Record<NavTab, string> = {
    terminal: 'Smart Gate Terminal',
    classroom: 'Classroom Attendance',
    directory: 'Student Directory & Contacts',
    register: 'One-Time Student Registration',
    reports: 'Reports & Notifications',
    admin: 'System Administration',
  };

  return (
    <div className="min-h-screen bg-[#050914] text-slate-100 flex">
      {/* Sidebar (Desktop) */}
      <aside className="hidden lg:flex lg:w-60 lg:flex-col border-r border-sky-500/20 bg-[#070d1d] shrink-0">
        <div className="h-16 px-5 flex items-center gap-2.5 border-b border-sky-500/20">
          <Shield className="w-5 h-5 text-sky-400 shrink-0" />
          <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
            AegisCampus
          </span>
        </div>

        <nav aria-label="Primary Workspace Navigation" className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            const locked =
              (item.roleRequired === 'auth' && !user) ||
              (item.roleRequired === 'admin' && user?.role !== 'admin');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-sky-500/15 text-sky-200 border border-sky-400/40'
                    : 'text-slate-300 hover:bg-slate-900 hover:text-white border border-transparent'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {locked && <Lock className="w-3 h-3 text-slate-500 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/80 text-xs space-y-2">
          <div className="text-slate-400">Active Campus Branch</div>
          <select
            aria-label="Select School Branch"
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(Number(e.target.value))}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-white"
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-950/75" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative z-10 w-64 bg-[#070d1d] border-r border-sky-500/20 flex flex-col p-4">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <span className="font-display text-lg font-bold text-white">AegisCampus</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="mt-4 space-y-1 flex-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium ${
                      activeTab === item.id ? 'bg-sky-500/20 text-sky-200' : 'text-slate-300'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb / Title — Clock — 1 Primary Action */}
        <header className="h-16 px-4 lg:px-6 border-b border-sky-500/20 bg-[#070d1d]/90 backdrop-blur-md flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-300 hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-base sm:text-lg font-semibold text-white truncate">
              {tabTitles[activeTab]}
            </h1>
          </div>

          <div className="hidden md:flex items-center gap-3 text-xs text-slate-300 font-mono tabular-nums whitespace-nowrap">
            <span>{nowClock.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</span>
            <span aria-hidden="true">·</span>
            <span className="text-sky-300 font-semibold">
              {nowClock.toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-xs text-slate-300 whitespace-nowrap">
                  {user.fullName} · {user.role === 'admin' ? 'Admin' : 'Teacher'}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                Staff Sign In
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1400px] w-full mx-auto">
          {activeTab === 'terminal' && (
            <GateTerminal
              kioskState={kioskState}
              onRefreshState={() => void loadKioskState()}
              wsConnected={wsConnected}
            />
          )}

          {activeTab === 'classroom' && user && (
            <ClassroomAttendance
              user={user}
              classes={classes}
              sections={sections}
              subjects={subjects}
            />
          )}

          {activeTab === 'directory' && user && (
            <StudentDirectory
              user={user}
              classes={classes}
              sections={sections}
              refreshKey={directoryRefreshKey}
            />
          )}

          {activeTab === 'register' && user?.role === 'admin' && (
            <StudentRegistration
              branches={branches}
              sessions={sessions}
              classes={classes}
              sections={sections}
              onRegistered={() => {
                setDirectoryRefreshKey((k) => k + 1);
                void loadKioskState();
              }}
            />
          )}

          {activeTab === 'reports' && user && (
            <ReportsCenter user={user} classes={classes} />
          )}

          {activeTab === 'admin' && user?.role === 'admin' && (
            <AdminConsole
              sessions={sessions}
              classes={classes}
              sections={sections}
              settings={settings}
              onBootstrapRefresh={() => void loadBootstrap()}
            />
          )}
        </main>
      </div>

      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={(loggedInUser) => {
          setUser(loggedInUser);
          if (activeTab === 'terminal') {
            setActiveTab(loggedInUser.role === 'admin' ? 'terminal' : 'classroom');
          }
        }}
      />
    </div>
  );
}
