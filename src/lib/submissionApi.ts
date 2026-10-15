import { accountApiConfigured, ApiFailure } from './serverApi';

export type SubmissionStatus = 'preparing' | 'ready' | 'submitted';
export type ChecklistItem = { id: string; label: string; done: boolean };
export type SubmissionCase = {
  id: string;
  title: string;
  destination: string;
  dueDate: string | null;
  status: SubmissionStatus;
  checklist: ChecklistItem[];
  ruleSetId: string | null;
  fileNameRule: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type SubmissionPage = { items: SubmissionCase[]; total: number; page: number; limit: number };
export type SubmissionChanges = Pick<SubmissionCase, 'title' | 'destination' | 'dueDate' | 'status' | 'checklist'> & { fileNameRule?: string };
export type NoticePlanInput = {
  submission: SubmissionChanges;
  ruleSet: { title: string; rules: import('./rules').SubmissionRules } | null;
  fileNameRule: string;
};
export type NoticePlanResult = {
  submission: SubmissionCase;
  ruleSet: import('./serverApi').SavedRuleSet | null;
};

const apiOrigin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';

async function request<T>(path: string, token: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!accountApiConfigured || !apiOrigin) throw new ApiFailure('계정 서버 주소가 설정되지 않았습니다.', 0, 'NOT_CONFIGURED', false);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiFailure(error instanceof DOMException && error.name === 'AbortError'
      ? '서버 응답 시간이 초과되었습니다.'
      : '서버에 연결할 수 없습니다. 인터넷 연결이나 서버 상태를 확인해 주세요.', 0, 'NETWORK_ERROR', true);
  } finally {
    window.clearTimeout(timer);
  }

  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiFailure('서버가 읽을 수 없는 응답을 보냈습니다.', response.status, 'INVALID_RESPONSE', response.status >= 500); }

  if (!response.ok) {
    const detail = data && typeof data === 'object' ? data as { code?: unknown; message?: unknown; retryable?: unknown } : {};
    const reason = typeof detail.message === 'string' ? detail.message
      : Array.isArray(detail.message) ? detail.message.filter((item): item is string => typeof item === 'string').join(' ') : '';
    throw new ApiFailure(reason || `요청을 처리하지 못했습니다. (${response.status})`, response.status,
      typeof detail.code === 'string' ? detail.code : 'REQUEST_FAILED', detail.retryable === true || response.status >= 500);
  }
  return data as T;
}

const encodedId = (id: string) => encodeURIComponent(id);

export const submissionApi = {
  list: (token: string, q = '', page = 1, limit = 6) => request<SubmissionPage>(`/api/submissions?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`, token),
  get: (token: string, id: string) => request<SubmissionCase>(`/api/submissions/${encodedId(id)}`, token),
  create: (token: string, values: SubmissionChanges) => request<SubmissionCase>('/api/submissions', token, { method: 'POST', body: values }),
  createFromNotice: (token: string, values: NoticePlanInput) => request<NoticePlanResult>('/api/notice-plans', token, { method: 'POST', body: values }),
  update: (token: string, id: string, values: SubmissionChanges, expectedVersion: number) => request<SubmissionCase>(`/api/submissions/${encodedId(id)}`, token, { method: 'PATCH', body: { ...values, expectedVersion } }),
  remove: (token: string, id: string) => request<{ ok: true }>(`/api/submissions/${encodedId(id)}`, token, { method: 'DELETE' }),
};
