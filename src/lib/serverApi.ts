import type { SubmissionRules } from './rules';

export type Account = { id: string; username: string };
export type AuthSession = { token: string; user: Account };
export type SavedRuleSet = {
  id: string;
  title: string;
  rules: SubmissionRules;
  version: number;
  shareId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RuleSetPage = { items: SavedRuleSet[]; total: number; page: number; limit: number };
export type SharedRuleSet = { title: string; rules: SubmissionRules; updatedAt: string };

const configuredOrigin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';
export const accountApiConfigured = Boolean(configuredOrigin);
const SESSION_KEY = 'filefit.account.session';

export class ApiFailure extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'ApiFailure';
  }
}

export function storedSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const session = value as Partial<AuthSession>;
    return typeof session.token === 'string' && typeof session.user?.id === 'string' && typeof session.user.username === 'string'
      ? session as AuthSession : null;
  } catch { return null; }
}

export function rememberSession(session: AuthSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* Storage may be disabled. The in-memory session still works. */ }
}

async function request<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  if (!accountApiConfigured) throw new ApiFailure('계정 서버 주소가 설정되지 않았습니다.', 0, 'NOT_CONFIGURED', false);
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(`${configuredOrigin}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      cache: 'no-store',
      signal: abort.signal,
    });
  } catch (error) {
    throw new ApiFailure(error instanceof DOMException && error.name === 'AbortError'
      ? '서버 응답 시간이 초과되었습니다.' : '계정 서버에 연결할 수 없습니다. 인터넷 연결이나 서버 상태를 확인해 주세요.',
    0, 'NETWORK_ERROR', true);
  } finally {
    window.clearTimeout(timer);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiFailure('서버가 읽을 수 없는 응답을 보냈습니다.', response.status, 'INVALID_RESPONSE', response.status >= 500); }
  if (!response.ok) {
    const detail = data && typeof data === 'object' ? data as { code?: unknown; message?: unknown; retryable?: unknown } : {};
    throw new ApiFailure(typeof detail.message === 'string' ? detail.message : `요청을 처리하지 못했습니다. (${response.status})`,
      response.status, typeof detail.code === 'string' ? detail.code : 'REQUEST_FAILED', detail.retryable === true || response.status >= 500);
  }
  return data as T;
}

const pathId = (id: string) => encodeURIComponent(id);

export const accountApi = {
  register: (username: string, password: string) => request<AuthSession>('/api/auth/register', { method: 'POST', body: { username, password } }),
  login: (username: string, password: string) => request<AuthSession>('/api/auth/login', { method: 'POST', body: { username, password } }),
  me: (token: string) => request<Account>('/api/auth/me', { token }),
  logout: (token: string) => request<{ ok: true }>('/api/auth/logout', { method: 'POST', token }),
  list: (token: string, q = '', page = 1, limit = 6) => request<RuleSetPage>(`/api/rule-sets?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`, { token }),
  create: (token: string, title: string, rules: SubmissionRules) => request<SavedRuleSet>('/api/rule-sets', { method: 'POST', token, body: { title, rules } }),
  get: (token: string, id: string) => request<SavedRuleSet>(`/api/rule-sets/${pathId(id)}`, { token }),
  update: (token: string, id: string, title: string, rules: SubmissionRules, expectedVersion: number) => request<SavedRuleSet>(`/api/rule-sets/${pathId(id)}`, { method: 'PATCH', token, body: { title, rules, expectedVersion } }),
  remove: (token: string, id: string) => request<{ ok: true }>(`/api/rule-sets/${pathId(id)}`, { method: 'DELETE', token }),
  share: (token: string, id: string) => request<{ shareId: string }>(`/api/rule-sets/${pathId(id)}/share`, { method: 'POST', token }),
  unshare: (token: string, id: string) => request<{ ok: true }>(`/api/rule-sets/${pathId(id)}/share`, { method: 'DELETE', token }),
  shared: (id: string) => request<SharedRuleSet>(`/api/shared/${pathId(id)}`),
};
