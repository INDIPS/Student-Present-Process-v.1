import type { AuthUser, OfflineAttendanceEvent } from '../shared/types';

const TOKEN_STORAGE_KEY = 'aegiscampus_auth_token';
const OFFLINE_QUEUE_KEY = 'aegiscampus_offline_queue';

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const errJson = (await res.json()) as { error?: string };
      throw new Error(errJson.error || `Request failed (${res.status})`);
    }
    throw new Error(`Request failed with status ${res.status}`);
  }

  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export function getOfflineQueue(): OfflineAttendanceEvent[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineAttendanceEvent[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineEvent(event: OfflineAttendanceEvent): OfflineAttendanceEvent[] {
  const queue = getOfflineQueue();
  const next = [...queue, event];
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(next));
  return next;
}

export function clearOfflineQueue(): void {
  localStorage.removeItem(OFFLINE_QUEUE_KEY);
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  if (!getStoredToken()) return null;
  try {
    const data = await apiFetch<{ user: AuthUser }>('/api/auth/me');
    return data.user;
  } catch {
    setStoredToken(null);
    return null;
  }
}
