import JSZip from 'jszip';

export const PACKAGE_FORMATS = ['JPG', 'PNG', 'WEBP', 'PDF', 'DOCX', 'XLSX', 'PPTX', 'ZIP'] as const;
export type PackageFormat = typeof PACKAGE_FORMATS[number];
export const MAX_PACKAGE_FILES = 30;
export const MAX_PACKAGE_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 100 * 1024 * 1024;

export type InspectedPackageFile = { format: PackageFormat; sha256: string };
export type PackageArchiveEntry = {
  label: string;
  file: File;
  name: string;
  format: PackageFormat;
  sha256: string;
};

const extensions: Record<PackageFormat, string[]> = {
  JPG: ['jpg', 'jpeg'], PNG: ['png'], WEBP: ['webp'], PDF: ['pdf'],
  DOCX: ['docx'], XLSX: ['xlsx'], PPTX: ['pptx'], ZIP: ['zip'],
};

export function formatFromExtension(name: string): PackageFormat | null {
  const extension = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return PACKAGE_FORMATS.find((format) => extensions[format].includes(extension ?? '')) ?? null;
}

export function parseAllowedFormats(value: string): { formats: PackageFormat[]; unknown: string[] } {
  const tokens = value.toUpperCase().split(/[\s,，/]+/).filter(Boolean);
  const formats: PackageFormat[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    const canonical = token === 'JPEG' ? 'JPG' : token;
    if (PACKAGE_FORMATS.includes(canonical as PackageFormat)) {
      if (!formats.includes(canonical as PackageFormat)) formats.push(canonical as PackageFormat);
    } else if (!unknown.includes(token)) unknown.push(token);
  }
  return { formats, unknown };
}

function startsWith(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

function asText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function outerKind(head: Uint8Array): PackageFormat | 'ZIP_FAMILY' | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'JPG';
  if (startsWith(head, [137, 80, 78, 71, 13, 10, 26, 10])) return 'PNG';
  if (asText(head.slice(0, 4)) === 'RIFF' && asText(head.slice(8, 12)) === 'WEBP') return 'WEBP';
  if (asText(head).slice(0, 1024).includes('%PDF-')) return 'PDF';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'ZIP_FAMILY';
  return null;
}

function officeKind(zip: JSZip): PackageFormat {
  const names = Object.keys(zip.files);
  if (names.length > 2000) throw new Error('압축 파일 안의 항목이 2,000개를 넘어 검사할 수 없습니다.');
  const has = (name: string) => Boolean(zip.file(name));
  if (has('[Content_Types].xml') && has('_rels/.rels')) {
    if (has('word/document.xml')) return 'DOCX';
    if (has('xl/workbook.xml')) return 'XLSX';
    if (has('ppt/presentation.xml')) return 'PPTX';
  }
  return 'ZIP';
}

/** Checks the file's signature and, for ZIP-based Office files, required package entries. */
export async function inspectPackageFile(file: File): Promise<InspectedPackageFile> {
  if (file.size === 0) throw new Error('빈 파일은 제출할 수 없습니다.');
  if (file.size > MAX_PACKAGE_FILE_BYTES) throw new Error('파일 하나는 30MB 이하여야 합니다.');
  const namedFormat = formatFromExtension(file.name);
  if (!namedFormat) throw new Error('지원하지 않는 파일 확장자입니다. JPG, PNG, WebP, PDF, DOCX, XLSX, PPTX, ZIP 중에서 선택해 주세요.');

  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const kind = outerKind(head);
  if (!kind) throw new Error('파일 내용에서 지원하는 형식의 시작 표시를 찾지 못했습니다. 파일이 손상되었거나 확장자가 잘못되었을 수 있습니다.');

  let actualFormat: PackageFormat;
  if (kind === 'ZIP_FAMILY') {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      throw new Error('압축 파일 구조를 열 수 없습니다. 파일이 손상되었거나 암호화되었을 수 있습니다.');
    }
    actualFormat = officeKind(zip);
  } else {
    actualFormat = kind;
  }

  if (actualFormat === 'PDF') {
    const tail = asText(new Uint8Array(await file.slice(Math.max(0, file.size - 2048)).arrayBuffer()));
    if (!tail.includes('%%EOF')) throw new Error('PDF 끝 표시를 찾지 못했습니다. 파일이 잘렸거나 손상되었을 수 있습니다.');
  }
  if (actualFormat !== namedFormat) {
    throw new Error(`파일명은 ${namedFormat} 형식이지만 실제 내용은 ${actualFormat} 형식입니다. 원본 파일과 확장자를 확인해 주세요.`);
  }

  if (!globalThis.crypto?.subtle) throw new Error('이 브라우저에서 파일 중복 확인을 사용할 수 없습니다. 최신 브라우저나 HTTPS 주소에서 다시 시도해 주세요.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { format: actualFormat, sha256 };
}

export function safeNamePart(value: string, fallback = '서류'): string {
  const clean = value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '_').replace(/[. ]+$/g, '').replace(/^[_ .]+/g, '').slice(0, 48);
  return clean || fallback;
}

export function generatedPackageName(prefix: string, label: string, file: File): string {
  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? 'bin';
  return `${safeNamePart(prefix, '제출서류')}_${safeNamePart(label)}.${extension}`;
}

export async function createPackageArchive(title: string, entries: PackageArchiveEntry[], destination = ''): Promise<Blob> {
  if (!entries.length || entries.length > MAX_PACKAGE_FILES) throw new Error('ZIP으로 묶을 파일 수를 확인해 주세요.');
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.name || /[\\/\x00-\x1f]/.test(entry.name) || entry.name === '.' || entry.name === '..') {
      throw new Error('ZIP에 넣을 파일명에 사용할 수 없는 문자가 있습니다.');
    }
    const key = entry.name.normalize('NFKC').toLocaleLowerCase();
    if (names.has(key)) throw new Error(`정리한 파일명 「${entry.name}」이 겹칩니다. 서류 이름을 바꿔 주세요.`);
    names.add(key);
  }
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  if (total > MAX_PACKAGE_TOTAL_BYTES) throw new Error('전체 파일이 100MB를 넘어 ZIP으로 묶을 수 없습니다.');
  const zip = new JSZip();
  const createdAt = new Date().toISOString();
  const manifest = {
    version: 1, title: title.trim(), destination: destination.trim(), createdAt,
    note: '파일핏은 파일 형식과 설정한 제출 기준을 확인했습니다. 악성코드 검사나 제출처 접수 확인은 포함되지 않습니다.',
    files: entries.map((entry) => ({ slot: entry.label, name: entry.name, format: entry.format, bytes: entry.file.size, sha256: entry.sha256 })),
  };
  const checklist = [
    `제출 패키지: ${title.trim() || '제출 서류'}`,
    ...(destination.trim() ? [`제출처: ${destination.trim()}`] : []),
    `준비 시각: ${createdAt}`,
    '',
    ...entries.map((entry, index) => `${index + 1}. [완료] ${entry.label} — ${entry.name}`),
    '',
    '파일명과 제출처의 최신 안내를 마지막으로 확인해 주세요.',
  ].join('\n');
  zip.file('제출-체크리스트.txt', checklist);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  for (const entry of entries) zip.file(entry.name, entry.file, { binary: true, compression: 'STORE' });
  return zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
}
