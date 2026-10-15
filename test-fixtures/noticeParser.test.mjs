import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNotice } from '../src/lib/noticeParser.ts';

test('공고에서 확인 가능한 제출 계획 초안을 만든다', () => {
  const result = parseNotice(`공고명: 2026 신입 개발자 채용
회사명: 예시 회사
접수 마감: 2026. 11. 30. 18:00
제출 서류: 이력서, 자기소개서, 포트폴리오
모든 파일은 PDF, 파일당 5MB 이하
파일명: 지원자명_서류명.pdf`);
  assert.equal(result.title, '2026 신입 개발자 채용');
  assert.equal(result.destination, '예시 회사');
  assert.equal(result.dueDate, '2026-11-30');
  assert.deepEqual(result.checklist, ['이력서', '자기소개서', '포트폴리오']);
  assert.deepEqual(result.rules.formats, ['PDF']);
  assert.equal(result.rules.maxEachBytes, 5 * 1024 * 1024);
  assert.match(result.fileNameRule, /지원자명_서류명/);
  assert.ok(result.warnings.some((warning) => warning.includes('마감 시간')));
  assert.ok(!result.warnings.some((warning) => warning.includes('서류별 파일 조건')));
});

test('서류별 형식과 용량을 공통 파일 규칙으로 합치지 않는다', () => {
  const result = parseNotice(`제목: 제출 테스트
제출 서류:
- 이력서 PDF, 파일당 5MB 이하
- 증명사진 JPG, 파일당 1MB 이하`);
  assert.deepEqual(result.rules.formats, []);
  assert.equal(result.rules.maxEachBytes, null);
  assert.ok(result.warnings.some((warning) => warning.includes('서류별')));
});

test('연도가 없거나 마감일 후보가 여러 개면 날짜를 확정하지 않는다', () => {
  const yearless = parseNotice('제목: 테스트\n접수 마감: 11월 30일');
  assert.equal(yearless.dueDate, null);
  assert.ok(yearless.warnings.some((warning) => warning.includes('연도가 없는')));
  const ambiguous = parseNotice('제목: 테스트\n1차 마감: 2026-11-30\n2차 마감: 2026-12-10');
  assert.equal(ambiguous.dueDate, null);
  assert.ok(ambiguous.warnings.some((warning) => warning.includes('여러 개')));
});

test('접수 기간은 마지막 날짜를 사용하고 존재하지 않는 날짜는 사용하지 않는다', () => {
  assert.equal(parseNotice('제목: 테스트\n접수 기간: 2026-11-01~2026-11-30').dueDate, '2026-11-30');
  const invalid = parseNotice('제목: 테스트\n접수 마감: 2026-02-30');
  assert.equal(invalid.dueDate, null);
  assert.ok(invalid.warnings.some((warning) => warning.includes('존재하지 않는')));
});

test('선택 서류는 필수 체크리스트에 넣지 않는다', () => {
  const result = parseNotice(`공고명: 테스트 모집
제출 서류:
- 이력서
- 포트폴리오
선택 서류: 자격증 사본`);
  assert.deepEqual(result.checklist, ['이력서', '포트폴리오']);
});

test('빈 문구도 오류 화면 없이 수정 가능한 초안을 만든다', () => {
  const result = parseNotice('  ');
  assert.equal(result.title, '');
  assert.equal(result.dueDate, null);
  assert.deepEqual(result.checklist, []);
  assert.ok(result.warnings.length > 0);
});
