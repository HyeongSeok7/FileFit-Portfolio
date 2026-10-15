import { emptyRules, parseRequirements } from './rules.ts';
import type { SubmissionRules } from './rules.ts';

export type NoticeDraft = {
  title: string;
  destination: string;
  dueDate: string | null;
  checklist: string[];
  rules: SubmissionRules;
  fileNameRule: string;
  warnings: string[];
};

export const MAX_NOTICE_CHARS = 20_000;

const datePattern = /(?<!\d)(20\d{2})\s*(?:년\s*|[.\/-]\s*)(\d{1,2})\s*(?:월\s*|[.\/-]\s*)(\d{1,2})\s*일?(?!\d)/g;
const yearlessDatePattern = /(?<!\d)\d{1,2}\s*월\s*\d{1,2}\s*일|(?<!\d)\d{1,2}\s*[.\/-]\s*\d{1,2}(?!\d)/;
const deadlineCue = /마감|기한|접수\s*기간|지원\s*기간|신청\s*기간|제출\s*기간|접수\s*일정|(?:접수|제출)\s*[:：]|종료\s*일|까지/;
const documentName = /이력서|자기소개서|자소서|포트폴리오|경력기술서|경력증명서|재직증명서|졸업증명서|재학증명서|성적증명서|자격증(?:\s*사본)?|증명사진|추천서|사업계획서|연구계획서|학업계획서|제안서|지원서|신청서|동의서|주민등록등본|등본|초본|신분증(?:\s*사본)?|통장(?:\s*사본)?|작품집|과제물|산출물|첨부서식/;
const fileCondition = /\b(?:PDF|JPG|JPEG|PNG|WEBP|DOCX|XLSX|PPTX|ZIP|MB|KB|GB|px)\b|메가바이트|킬로바이트|파일\s*(?:형식|용량|크기|개수|수)|\d+\s*(?:개|파일|페이지|쪽)\s*(?:이하|이내|미만|까지)/i;
const globalCue = /공통|모든\s*(?:파일|서류|첨부)|전체\s*(?:파일|서류|첨부)|각\s*(?:파일|서류|첨부)|파일\s*당|파일별|^\s*(?:제출\s*)?(?:파일|첨부\s*파일)\s*(?:형식|포맷|용량|크기|개수|수|규격|제한)|^\s*(?:허용\s*형식|업로드\s*(?:형식|조건|용량|제한))|^\s*(?:총|전체)\s*\d+(?:\.\d+)?\s*(?:MB|KB|GB|개)/i;
const optionalCue = /선택\s*(?:서류|사항|제출)?|우대|해당자(?:에)?\s*한함|해당자만|필요\s*시|가능하면|미제출|제출\s*불필요|제외/;
const sectionHeader = /^(?:필수\s*)?(?:제출|구비|필요|첨부)\s*서류(?:\s*목록)?\s*[:：]?\s*(.*)$/;
const otherHeader = /^(?:모집|지원|접수|제출|신청|전형|일정|자격|우대|기타|문의|유의|파일|작성)\s*(?:방법|기간|일정|대상|조건|사항|형식|용량|규칙|안내|처|기한|마감|정보)?\s*[:：]/;

function cleanLine(value: string): string {
  return value.replace(/\u200b|\ufeff/g, '').replace(/\s+/g, ' ').trim();
}

function uniqueValue(values: string[]): string {
  const unique = [...new Set(values.map((value) => cleanLine(value).slice(0, 120)).filter(Boolean))];
  return unique.length === 1 ? unique[0] : '';
}

function labelValue(line: string, labels: RegExp): string | null {
  const match = line.match(labels);
  return match ? cleanLine(match[1]) : null;
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function deadlineFrom(lines: string[], warnings: string[]): string | null {
  const candidates: string[] = [];
  let sawYearless = false;
  let sawInvalid = false;
  let sawTime = false;
  for (const line of lines) {
    if (!deadlineCue.test(line) || /(?:접수|지원|신청)\s*시작|공고\s*게시/.test(line) && !/마감|종료|까지/.test(line)) continue;
    const matches = [...line.matchAll(datePattern)];
    if (!matches.length) {
      if (yearlessDatePattern.test(line)) sawYearless = true;
      continue;
    }
    const parsed = matches.map((match) => validDate(Number(match[1]), Number(match[2]), Number(match[3])));
    if (parsed.some((date) => date === null)) { sawInvalid = true; continue; }
    if (/\d{1,2}\s*:\s*\d{2}/.test(line)) sawTime = true;
    if (parsed.length === 1) candidates.push(parsed[0]!);
    else if (/[~～]|부터.+까지|\s-\s/.test(line)) candidates.push(parsed.at(-1)!);
    else warnings.push('한 줄에 마감 관련 날짜가 여러 개 있어 마감일을 자동으로 선택하지 않았습니다.');
  }
  if (sawInvalid) warnings.push('공고의 마감 날짜 중 존재하지 않는 날짜가 있습니다. 원문을 확인해 주세요.');
  if (sawYearless) warnings.push('연도가 없는 마감일은 자동 입력하지 않았습니다. 연도를 확인해 직접 입력해 주세요.');
  if (sawTime) warnings.push('마감 시간이 적혀 있습니다. 저장되는 마감일은 날짜만 포함하므로 시간은 원문에서 확인해 주세요.');
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    warnings.push('마감일로 보이는 날짜가 여러 개입니다. 올바른 날짜를 직접 선택해 주세요.');
    return null;
  }
  return unique[0] ?? null;
}

function splitDocuments(value: string): string[] {
  // A comma inside "(PDF, DOCX)" lists allowed formats, not separate documents.
  const chunks: string[] = [];
  let depth = 0;
  let chunk = '';
  for (const char of value) {
    if (char === '(' || char === '（') depth++;
    if (char === ')' || char === '）') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,，、;；]/.test(char)) {
      chunks.push(chunk);
      chunk = '';
    } else chunk += char;
  }
  chunks.push(chunk);
  return chunks.flatMap((entry) => entry.split(/\s+및\s+/));
}

function documentLabel(value: string): string | null {
  const label = cleanLine(value)
    .replace(/^(?:[-*•·]|\d+[.)])\s*/, '')
    .replace(/^(?:필수|제출|첨부)\s*[:：-]?\s*/, '')
    .replace(/\s*(?:필수\s*제출|제출\s*필수|필수)\s*$/, '')
    .replace(/[.。]\s*$/, '')
    .trim();
  if (!label || label.length > 120 || optionalCue.test(label)) return null;
  if (/^(?:없음|없습니다|해당\s*없음|별도\s*안내|참고|문의)/.test(label)) return null;
  if (fileCondition.test(label) && !documentName.test(label)) return null;
  if (/^(?:파일명|마감|접수|제출\s*방법|업로드|작성\s*방법)/.test(label)) return null;
  return label;
}

function checklistFrom(lines: string[], warnings: string[]): string[] {
  const labels: string[] = [];
  let inRequiredSection = false;
  for (const line of lines) {
    const header = line.match(sectionHeader);
    if (header) {
      inRequiredSection = !optionalCue.test(line);
      if (inRequiredSection && header[1]) {
        for (const part of splitDocuments(header[1])) {
          const label = documentLabel(part);
          if (label) labels.push(label);
        }
      }
      continue;
    }
    if (!line) { inRequiredSection = false; continue; }
    if (otherHeader.test(line) || /^(?:선택|우대)\s*(?:제출\s*)?서류/.test(line)) inRequiredSection = false;
    if (inRequiredSection) {
      if (!/^(?:[-*•·]|\d+[.)])\s*/.test(line) && !documentName.test(line)) continue;
      for (const part of splitDocuments(line)) {
        const label = documentLabel(part);
        if (label) labels.push(label);
      }
    } else if (documentName.test(line) && /\b필수\b|제출\s*필수|반드시\s*제출/.test(line) && !optionalCue.test(line)) {
      const label = documentLabel(line);
      if (label) labels.push(label);
    }
  }
  const unique = [...new Map(labels.map((label) => [label.toLocaleLowerCase('ko-KR'), label])).values()];
  if (unique.length > 30) {
    warnings.push('필수 서류가 30개를 넘어 앞의 30개만 초안에 넣었습니다. 나머지는 직접 확인해 주세요.');
    return unique.slice(0, 30);
  }
  if (!unique.length) warnings.push('필수 제출 서류를 확실하게 찾지 못했습니다. 체크리스트를 직접 입력해 주세요.');
  return unique;
}

function globalRulesFrom(lines: string[], warnings: string[]): SubmissionRules {
  const globalLines: string[] = [];
  let skippedPerDocument = false;
  let inDocumentSection = false;
  for (const line of lines) {
    if (sectionHeader.test(line)) inDocumentSection = true;
    else if (!line || otherHeader.test(line)) inDocumentSection = false;
    if (/파일\s*명|저장\s*이름|이름\s*형식/.test(line)) continue;
    if (!fileCondition.test(line)) continue;
    const namedDocument = documentName.test(line);
    const clearlyGlobal = globalCue.test(line);
    if (namedDocument || inDocumentSection && !clearlyGlobal) {
      skippedPerDocument = true;
      continue;
    }
    if (clearlyGlobal) globalLines.push(line);
  }
  if (skippedPerDocument) warnings.push('서류별 파일 조건은 공통 규칙으로 합치지 않았습니다. 각 서류의 형식과 용량을 따로 확인해 주세요.');
  if (!globalLines.length) return { ...emptyRules, formats: [] };
  const rules = parseRequirements(globalLines.join('\n'));
  if (!rules.formats.length && Object.entries(rules).every(([key, value]) => key === 'formats' || value === null)) {
    warnings.push('공통 파일 조건을 읽어내지 못했습니다. 조건 점검에서 직접 입력해 주세요.');
  }
  return rules;
}

/** Generates a reviewable draft. No extraction result should be saved without user confirmation. */
export function parseNotice(text: string): NoticeDraft {
  const warnings: string[] = [];
  const source = typeof text === 'string' ? text : '';
  if (source.length > MAX_NOTICE_CHARS) warnings.push('공고가 20,000자를 넘어 앞부분만 분석했습니다. 잘린 내용은 원문에서 확인해 주세요.');
  const lines = source.slice(0, MAX_NOTICE_CHARS).normalize('NFKC').replace(/\r/g, '').split('\n').map(cleanLine);
  if (!lines.some(Boolean)) warnings.push('공고 내용을 붙여 넣으면 제출 계획 초안을 만들 수 있습니다.');

  const titles = lines.map((line) => labelValue(line, /^(?:공고명|제목|모집명|채용명|사업명|신청명)\s*[:：]\s*(.+)$/)).filter((value): value is string => Boolean(value));
  const destinations = lines.map((line) => labelValue(line, /^(?:제출처|지원처|기관명|회사명|단체명|접수처)\s*[:：]\s*(.+)$/)).filter((value): value is string => Boolean(value));
  if (titles.length && !uniqueValue(titles)) warnings.push('공고 제목 후보가 여러 개입니다. 제목을 직접 확인해 주세요.');
  if (destinations.length && !uniqueValue(destinations)) warnings.push('제출처 후보가 여러 개입니다. 제출처를 직접 확인해 주세요.');
  const firstLine = lines.find(Boolean) ?? '';
  const inferredTitle = !titles.length && firstLine.length <= 120 && /채용|모집|공모|지원사업|신청\s*공고/.test(firstLine)
    && !/^(?:제출|접수|마감|파일|필수|문의)/.test(firstLine) ? firstLine : '';
  const title = uniqueValue(titles) || inferredTitle;
  const destination = uniqueValue(destinations);
  if (!title) warnings.push('공고 제목을 확실하게 찾지 못했습니다. 제출 건 이름을 직접 입력해 주세요.');

  const namingLines = lines.filter((line) => /파일\s*명|저장\s*이름|이름\s*형식/.test(line) && !/예시\s*파일\s*명/.test(line));
  const fileNameRule = namingLines.length === 1 ? namingLines[0].slice(0, 240) : '';
  if (namingLines.length === 1 && namingLines[0].length > 240) warnings.push('파일명 안내가 길어 앞의 240자만 초안에 넣었습니다. 원문을 확인해 주세요.');
  if (namingLines.length > 1) warnings.push('파일명 안내가 여러 군데 있어 자동으로 선택하지 않았습니다. 원문을 확인해 주세요.');

  return {
    title,
    destination,
    dueDate: deadlineFrom(lines, warnings),
    checklist: checklistFrom(lines, warnings),
    rules: globalRulesFrom(lines, warnings),
    fileNameRule,
    warnings,
  };
}
