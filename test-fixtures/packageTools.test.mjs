import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import {
  createPackageArchive, generatedPackageName, inspectPackageFile,
  parseAllowedFormats,
} from '../src/lib/packageTools.ts';

function file(bytes, name) {
  return new File([Array.isArray(bytes) ? new Uint8Array(bytes) : bytes], name);
}

async function officeFile(name, folder, document) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file(`${folder}/${document}`, '<document/>');
  return file(await zip.generateAsync({ type: 'uint8array' }), name);
}

test('detects true Office format from ZIP container entries', async () => {
  for (const [name, folder, document, expected] of [
    ['resume.docx', 'word', 'document.xml', 'DOCX'],
    ['sheet.xlsx', 'xl', 'workbook.xml', 'XLSX'],
    ['slides.pptx', 'ppt', 'presentation.xml', 'PPTX'],
  ]) {
    const result = await inspectPackageFile(await officeFile(name, folder, document));
    assert.equal(result.format, expected);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  }
});

test('rejects wrong extension, damaged ZIP, and truncated PDF with readable reasons', async () => {
  await assert.rejects(
    inspectPackageFile(await officeFile('resume.xlsx', 'word', 'document.xml')),
    /실제 내용은 DOCX/,
  );
  await assert.rejects(inspectPackageFile(file([0x50, 0x4b, 0x03, 0x04, 0, 1], 'bad.zip')), /압축 파일 구조/);
  await assert.rejects(inspectPackageFile(file('%PDF-1.7\ntruncated', 'bad.pdf')), /PDF 끝 표시/);
});

test('normalizes formats and generated names without changing extensions', () => {
  assert.deepEqual(parseAllowedFormats('jpeg, DOCX / PDF'), { formats: ['JPG', 'DOCX', 'PDF'], unknown: [] });
  assert.equal(generatedPackageName('김 철수', '이력서 / 최종', file('x', 'resume.docx')), '김_철수_이력서_최종.docx');
});

test('does not silently overwrite duplicate archive names', async () => {
  const original = file('%PDF-1.7\n%%EOF', 'a.pdf');
  const entry = { label: '이력서', file: original, name: '지원서류_이력서.pdf', format: 'PDF', sha256: 'x' };
  await assert.rejects(createPackageArchive('회사 지원', [entry, { ...entry, label: '중복' }]), /파일명.*겹칩니다/);
});

test('packages renamed files with checklist and manifest', async () => {
  const original = file('%PDF-1.7\n%%EOF', 'resume.pdf');
  const inspection = await inspectPackageFile(original);
  const archive = await createPackageArchive('회사 지원', [{ label: '이력서', file: original, name: '지원서류_이력서.pdf', ...inspection }]);
  const zip = await JSZip.loadAsync(archive);
  assert.ok(zip.file('지원서류_이력서.pdf'));
  assert.ok(zip.file('제출-체크리스트.txt'));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.files[0].name, '지원서류_이력서.pdf');
  assert.equal(manifest.files[0].sha256, inspection.sha256);
});
