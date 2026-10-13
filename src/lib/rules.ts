export type SubmissionRules = {
  formats: string[];
  minEachBytes: number | null;
  maxEachBytes: number | null;
  maxTotalBytes: number | null;
  maxFiles: number | null;
  maxPages: number | null;
  width: number | null;
  height: number | null;
};

export const emptyRules: SubmissionRules = {
  formats: [],
  minEachBytes: null,
  maxEachBytes: null,
  maxTotalBytes: null,
  maxFiles: null,
  maxPages: null,
  width: null,
  height: null,
};

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const extensionToFormat: Record<string, string> = {
  jpg: 'JPG', jpeg: 'JPG', png: 'PNG', webp: 'WEBP', pdf: 'PDF',
};

export function formatOf(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  return extensionToFormat[extension] || extension.toUpperCase() || '파일';
}

function canonicalFormat(value: string): string {
  const format = value.trim().toLowerCase();
  if (format === 'image/jpeg' || format === 'image/jpg') return 'JPG';
  if (format === 'image/png') return 'PNG';
  if (format === 'image/webp') return 'WEBP';
  if (format === 'application/pdf') return 'PDF';
  return extensionToFormat[format] || format.toUpperCase();
}

function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)/g, (number) => number.replace(/,/g, ''))
    .replace(/\s+\/\s+/g, ',');
}

function segmentAt(text: string, start: number, end: number): { before: string; after: string } {
  const separators = /[,;\n，。]/g;
  let segmentStart = 0;
  let segmentEnd = text.length;
  for (const match of text.matchAll(separators)) {
    const index = match.index;
    if (index < start) segmentStart = index + 1;
    else if (index >= end) { segmentEnd = index; break; }
  }
  return { before: text.slice(segmentStart, start), after: text.slice(end, segmentEnd) };
}

function isMinimum(before: string, after: string): boolean {
  return /(?:최소|적어도)/.test(before.slice(-14))
    || /^\s*(?:이상|초과|부터|보다\s*큰)/.test(after);
}

function isSuggestion(before: string, after: string): boolean {
  return /(?:권장|추천|예시|예를\s*들어)/.test(before.slice(-18))
    || /^\s*(?:권장|추천|예시)/.test(after);
}

function unambiguousLimit(values: number[]): number | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function sizeToBytes(value: number, unit: string): number {
  const normalized = unit.toUpperCase();
  const multiplier = /^(?:G|GB|GIB|기가바이트)$/.test(normalized) ? 1024 ** 3
    : /^(?:M|MB|MIB|메가바이트)$/.test(normalized) ? 1024 ** 2
      : 1024;
  return Math.round(value * multiplier);
}

function lastCue(text: string, expression: RegExp): number {
  let index = -1;
  for (const match of text.matchAll(expression)) index = match.index;
  return index;
}

function parseSizes(text: string): Pick<SubmissionRules, 'minEachBytes' | 'maxEachBytes' | 'maxTotalBytes'> {
  const minimumEach: number[] = [];
  const each: number[] = [];
  const total: number[] = [];
  const expression = /(\d+(?:\.\d+)?)\s*(GiB|MiB|KiB|GB|MB|KB|G|M|K|기가바이트|메가바이트|킬로바이트)(?![A-Za-z가-힣])/gi;
  let previousSizeEnd = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index;
    const context = segmentAt(text, index, index + match[0].length);
    const before = context.before.slice(Math.max(0, previousSizeEnd - (index - context.before.length)));
    const after = context.after;
    previousSizeEnd = index + match[0].length;
    if (isSuggestion(before, after)) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const isMinimumSize = isMinimum(before, after);
    const bytes = sizeToBytes(value, match[2]) + (isMinimumSize && /^\s*(?:초과|보다\s*큰)/.test(after) ? 1 : 0)
      - (!isMinimumSize && /^\s*미만/.test(after) ? 1 : 0);
    const totalCue = lastCue(before, /(?:총|전체|합계|합산|모두\s*합쳐|모든\s*파일|총량)/g);
    const eachCue = lastCue(before, /(?:파일\s*당|개\s*당|개별|각\s*파일|각각|1\s*개\s*당|한\s*파일\s*당)/g);
    const isTotal = totalCue > eachCue || (totalCue === -1 && /^(?:\s*\(?\s*)(?:총|전체|합계|합산)/.test(after));
    if (isMinimumSize) {
      if (!isTotal) minimumEach.push(bytes);
    } else if (isTotal) total.push(bytes);
    else each.push(bytes);
  }
  return {
    minEachBytes: unambiguousLimit(minimumEach),
    maxEachBytes: unambiguousLimit(each),
    maxTotalBytes: unambiguousLimit(total),
  };
}

function parseFormats(text: string): string[] {
  const formats: string[] = [];
  const expression = /(?<![A-Z0-9])(?:JPEG|JPG|PNG|WEBP|PDF)(?![A-Z0-9])/gi;
  for (const match of text.matchAll(expression)) {
    const context = segmentAt(text, match.index, match.index + match[0].length);
    const before = context.before.slice(-24);
    const after = context.after.slice(0, 24);
    // A named format in a prohibition is not an allowed format.
    if (/(?:불가|금지|제외|지원\s*안\s*함|허용\s*안\s*함)\s*(?:형식\s*[:：]?\s*)?$/.test(before)
      || /^\s*(?:(?:는|은|만)?\s*(?:형식|파일)?\s*(?:은|는)?\s*)?(?:불가|금지|제외|지원\s*(?:안\s*함|하지\s*않)|허용\s*안\s*함|제출하지\s*마)/.test(after)) continue;
    const format = extensionToFormat[match[0].toLowerCase()];
    if (!formats.includes(format)) formats.push(format);
  }
  return formats;
}

function parseCount(text: string): number | null {
  const values: number[] = [];
  const expression = /(\d+)\s*(개|건|파일|장)(?!\s*(?:당|씩))/g;
  for (const match of text.matchAll(expression)) {
    const count = Number(match[1]);
    if (!Number.isSafeInteger(count) || count < 1) continue;
    const context = segmentAt(text, match.index, match.index + match[0].length);
    const before = context.before.slice(-25);
    const after = context.after.slice(0, 25);
    if (isMinimum(before, after) || isSuggestion(before, after)) continue;
    const unit = match[2];
    const photoContext = /(?:이미지|사진|JPG|JPEG|PNG|WEBP)\s*$/i.test(before);
    const documentContext = /(?:A4|PDF|문서|서류|원고|이력서|자기소개서|보고서|과제)(?:\s*용지|\s*기준)?\s*$/i.test(before);
    if (unit === '장' && (!photoContext || documentContext)) continue;
    const fileContext = /(?:파일|첨부|이미지|사진|서류|문서|PDF|JPG|JPEG|PNG|WEBP)\s*$/i.test(before)
      || /^\s*(?:파일|이미지|사진|서류|문서)/.test(after);
    const explicitCap = /(?:최대|총|전체)\s*$/.test(before)
      || /^\s*(?:이하|이내|미만|까지|만|제한)/.test(after);
    if (fileContext || explicitCap || unit === '파일') values.push(count - (/^\s*미만/.test(after) ? 1 : 0));
  }
  return unambiguousLimit(values.filter((value) => value >= 1));
}

function parsePages(text: string): number | null {
  const values: number[] = [];
  const explicit = /(\d+)\s*(?:페이지|쪽|pages?)(?![A-Za-z가-힣])/gi;
  for (const match of text.matchAll(explicit)) {
    const context = segmentAt(text, match.index, match.index + match[0].length);
    if (isMinimum(context.before, context.after) || isSuggestion(context.before, context.after)) continue;
    const count = Number(match[1]) - (/^\s*미만/.test(context.after) ? 1 : 0);
    if (count >= 1 && Number.isSafeInteger(count)) values.push(count);
  }
  const sheets = /(?:A4|PDF|문서|서류|원고|이력서|자기소개서|보고서|과제)(?:\s*(?:용지|기준)){0,2}\s*(\d+)\s*장/gi;
  for (const match of text.matchAll(sheets)) {
    const context = segmentAt(text, match.index, match.index + match[0].length);
    if (isMinimum(context.before, context.after) || isSuggestion(context.before, context.after)) continue;
    const count = Number(match[1]) - (/^\s*미만/.test(context.after) ? 1 : 0);
    if (count >= 1 && Number.isSafeInteger(count)) values.push(count);
  }
  return unambiguousLimit(values);
}

function dimensionIsExact(before: string, after: string): boolean {
  if (isSuggestion(before, after) || isMinimum(before, after)) return false;
  return !/(?:최대|최소|~|-)\s*$/.test(before.slice(-10))
    && !/^\s*(?:이하|이내|이상|미만|초과|부터|까지|권장|추천|~|-)/.test(after);
}

function parseDimensions(text: string): Pick<SubmissionRules, 'width' | 'height'> {
  const pairs: Array<[number, number]> = [];
  const pairExpression = /(?:가로\s*)?(\d{2,5})\s*(?:px|픽셀)?\s*[x×*]\s*(?:세로\s*)?(\d{2,5})\s*(?:px|픽셀)?(?![A-Za-z가-힣])/gi;
  for (const match of text.matchAll(pairExpression)) {
    const context = segmentAt(text, match.index, match.index + match[0].length);
    if (dimensionIsExact(context.before, context.after)) pairs.push([Number(match[1]), Number(match[2])]);
  }
  if (pairs.length) {
    const unique = [...new Set(pairs.map(([width, height]) => `${width}x${height}`))];
    if (unique.length === 1) return { width: pairs[0][0], height: pairs[0][1] };
    return { width: null, height: null };
  }
  const axes: Record<'width' | 'height', number[]> = { width: [], height: [] };
  for (const [axis, expression] of [
    ['width', /가로\s*(\d{2,5})\s*(?:px|픽셀)(?![A-Za-z가-힣])/gi],
    ['height', /세로\s*(\d{2,5})\s*(?:px|픽셀)(?![A-Za-z가-힣])/gi],
  ] as const) {
    for (const match of text.matchAll(expression)) {
      const context = segmentAt(text, match.index, match.index + match[0].length);
      if (dimensionIsExact(context.before, context.after)) axes[axis].push(Number(match[1]));
    }
  }
  return { width: unambiguousLimit(axes.width), height: unambiguousLimit(axes.height) };
}

/** Returns a draft. The user should confirm it before treating it as a submission rule. */
export function parseRequirements(input: string): SubmissionRules {
  const text = normalizeText(input);
  return {
    formats: parseFormats(text),
    ...parseSizes(text),
    maxFiles: parseCount(text),
    maxPages: parsePages(text),
    ...parseDimensions(text),
  };
}

export type FileDetails = { width?: number; height?: number; pages?: number; format?: string };

export function validateFile(file: File, details: FileDetails, rules: SubmissionRules): string[] {
  const errors: string[] = [];
  const verifiedFormat = details.format ? canonicalFormat(details.format) : null;
  const format = verifiedFormat ?? formatOf(file);
  const allowed = rules.formats.map(canonicalFormat);
  if (allowed.length > 0 && !allowed.includes(format)) errors.push(`허용 형식: ${allowed.join(', ')}`);
  if (rules.minEachBytes !== null && file.size < rules.minEachBytes) errors.push(`용량 ${humanBytes(file.size)} · 최소 ${humanBytes(rules.minEachBytes)}`);
  if (rules.maxEachBytes !== null && file.size > rules.maxEachBytes) errors.push(`용량 ${humanBytes(file.size)} · 기준 ${humanBytes(rules.maxEachBytes)}`);
  if (rules.maxPages !== null && details.pages !== undefined && details.pages > rules.maxPages) errors.push(`${details.pages}페이지 · 기준 ${rules.maxPages}페이지`);
  const isImage = verifiedFormat !== null
    ? ['JPG', 'PNG', 'WEBP'].includes(verifiedFormat)
    : ['JPG', 'PNG', 'WEBP'].includes(format) || file.type.startsWith('image/');
  if (isImage) {
    if (rules.width !== null && details.width !== undefined && details.width !== rules.width) errors.push(`가로 ${details.width}px · 기준 ${rules.width}px`);
    if (rules.height !== null && details.height !== undefined && details.height !== rules.height) errors.push(`세로 ${details.height}px · 기준 ${rules.height}px`);
  }
  return errors;
}
