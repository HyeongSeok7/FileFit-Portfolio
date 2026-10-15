import { ApiError, object } from './validation';

export type SubmissionStatus = 'preparing' | 'ready' | 'submitted';
export type ChecklistItem = { id: string; label: string; done: boolean };
export type SubmissionInput = {
  title: string;
  destination: string;
  dueDate: string | null;
  status: SubmissionStatus;
  checklist: ChecklistItem[];
};

function limitedText(value: unknown, field: string, required: boolean): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_SUBMISSION', `${field}을(를) 문자로 입력해 주세요.`);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > 120) throw new ApiError(400, 'INVALID_SUBMISSION', `${field}은(는) ${required ? '1~120' : '0~120'}자로 입력해 주세요.`);
  return trimmed;
}

function dueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, 'INVALID_DUE_DATE', '마감일은 YYYY-MM-DD 형식으로 입력해 주세요.');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (year < 1 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw new ApiError(400, 'INVALID_DUE_DATE', '존재하지 않는 날짜입니다.');
  return value;
}

function checklist(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value) || value.length > 30) throw new ApiError(400, 'INVALID_CHECKLIST', '체크리스트는 최대 30개까지 입력해 주세요.');
  const ids = new Set<string>();
  return value.map((item) => {
    const row = object(item);
    if (Object.keys(row).some((key) => !['id', 'label', 'done'].includes(key))) throw new ApiError(400, 'INVALID_CHECKLIST', '체크리스트 항목 형식이 올바르지 않습니다.');
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 100) throw new ApiError(400, 'INVALID_CHECKLIST', '체크리스트 항목 ID가 올바르지 않습니다.');
    const id = row.id.trim();
    if (ids.has(id)) throw new ApiError(400, 'INVALID_CHECKLIST', '체크리스트 항목 ID가 중복되었습니다.');
    ids.add(id);
    if (typeof row.done !== 'boolean') throw new ApiError(400, 'INVALID_CHECKLIST', '체크리스트 완료 여부가 올바르지 않습니다.');
    return { id, label: limitedText(row.label, '체크리스트 이름', true), done: row.done };
  });
}

export function submissionFields(value: unknown, partial: boolean): Partial<SubmissionInput> {
  const input = object(value);
  const allowed = partial ? ['title', 'destination', 'dueDate', 'status', 'checklist', 'expectedVersion'] : ['title', 'destination', 'dueDate', 'status', 'checklist'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ApiError(400, 'INVALID_SUBMISSION', '지원하지 않는 제출 건 항목이 포함되어 있습니다.');
  if (partial && !['title', 'destination', 'dueDate', 'status', 'checklist'].some((key) => key in input)) throw new ApiError(400, 'INVALID_SUBMISSION', '바꿀 내용을 입력해 주세요.');
  if (!partial && input.title === undefined) throw new ApiError(400, 'INVALID_SUBMISSION', '제출 건 이름을 입력해 주세요.');
  const result: Partial<SubmissionInput> = {};
  if (input.title !== undefined) result.title = limitedText(input.title, '제출 건 이름', true);
  if (input.destination !== undefined) result.destination = limitedText(input.destination, '제출처', false);
  if (input.dueDate !== undefined) result.dueDate = dueDate(input.dueDate);
  if (input.status !== undefined) {
    if (!['preparing', 'ready', 'submitted'].includes(input.status as string)) throw new ApiError(400, 'INVALID_STATUS', '진행 상태가 올바르지 않습니다.');
    result.status = input.status as SubmissionStatus;
  }
  if (input.checklist !== undefined) result.checklist = checklist(input.checklist);
  return result;
}

export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647) throw new ApiError(400, 'INVALID_VERSION', '제출 건의 버전이 올바르지 않습니다.');
  return value as number;
}
