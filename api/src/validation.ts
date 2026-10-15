export type Rules = {
  formats: string[];
  minEachBytes: number | null;
  maxEachBytes: number | null;
  maxTotalBytes: number | null;
  maxFiles: number | null;
  maxPages: number | null;
  width: number | null;
  height: number | null;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) { super(message); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_INPUT', '요청 형식이 올바르지 않습니다.');
  return value as Record<string, unknown>;
}
export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(value)) throw new ApiError(400, 'INVALID_USERNAME', '아이디는 영문, 숫자, 밑줄로 3~32자 입력해 주세요.');
  return value.toLowerCase();
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new ApiError(400, 'INVALID_PASSWORD', '비밀번호는 12~128자로 입력해 주세요.');
  return value;
}
export function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new ApiError(400, 'INVALID_TITLE', '조건 이름은 1~120자로 입력해 주세요.');
  return value.trim();
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'INVALID_ID', '요청한 조건의 주소가 올바르지 않습니다.');
  return value;
}
export function rules(value: unknown): Rules {
  const input = object(value);
  const keys = ['formats', 'minEachBytes', 'maxEachBytes', 'maxTotalBytes', 'maxFiles', 'maxPages', 'width', 'height'];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new ApiError(400, 'INVALID_RULES', '지원하지 않는 제출 기준이 포함되어 있습니다.');
  if (!Array.isArray(input.formats) || input.formats.length > 8 || input.formats.some((f) => typeof f !== 'string' || !['JPG', 'PNG', 'WEBP', 'PDF', 'DOCX', 'XLSX', 'PPTX', 'ZIP'].includes(f)) || new Set(input.formats).size !== input.formats.length) throw new ApiError(400, 'INVALID_RULES', '허용 형식은 JPG, PNG, WEBP, PDF, DOCX, XLSX, PPTX, ZIP 중에서 선택해 주세요.');
  const limits: Record<string, number> = { minEachBytes: 100_000_000, maxEachBytes: 100_000_000, maxTotalBytes: 5_000_000_000, maxFiles: 50, maxPages: 200, width: 16000, height: 16000 };
  for (const [key, max] of Object.entries(limits)) {
    const n = input[key];
    if (n !== null && (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max)) throw new ApiError(400, 'INVALID_RULES', `${key} 값이 허용 범위를 벗어났습니다.`);
  }
  if (keys.some((key) => !(key in input))) throw new ApiError(400, 'INVALID_RULES', '제출 기준 항목이 빠져 있습니다.');
  if (input.formats.length === 0 && keys.filter((key) => key !== 'formats').every((key) => input[key] === null)) throw new ApiError(400, 'EMPTY_RULES', '제출 기준을 하나 이상 입력해 주세요.');
  if (input.minEachBytes !== null && input.maxEachBytes !== null && (input.minEachBytes as number) > (input.maxEachBytes as number)) throw new ApiError(400, 'INVALID_RULES', '파일당 최소 용량이 최대 용량보다 큽니다.');
  return input as Rules;
}
export function positiveInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new ApiError(400, 'INVALID_QUERY', `1~${max} 사이의 숫자를 입력해 주세요.`);
  return number;
}
