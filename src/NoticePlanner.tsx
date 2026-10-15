import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, ClipboardList, LockKeyhole, Sparkles, WandSparkles, X } from 'lucide-react';
import { parseNotice } from './lib/noticeParser';
import type { NoticeDraft } from './lib/noticeParser';
import { humanBytes } from './lib/rules';
import type { SubmissionRules } from './lib/rules';
import { ApiFailure, accountApiConfigured } from './lib/serverApi';
import type { AuthSession } from './lib/serverApi';
import { submissionApi } from './lib/submissionApi';
import './noticePlanner.css';

type Props = {
  session: AuthSession | null;
  onLoginClick: () => void;
  onSessionExpired: () => void;
  onSaved: () => void;
  onOpenSubmissions: () => void;
  onApplyRules: (rules: SubmissionRules) => void;
};

type PlannerError = { title: string; reason: string; advice: string };
const MB = 1024 * 1024;
const supportedFormats = new Set(['JPG', 'PNG', 'WEBP', 'PDF', 'DOCX', 'XLSX', 'PPTX', 'ZIP']);

function hasRules(rules: SubmissionRules): boolean {
  return rules.formats.length > 0 || Object.entries(rules).some(([key, value]) => key !== 'formats' && value !== null);
}

function mbText(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / MB).toFixed(2)));
}

function numberText(value: number | null): string {
  return value === null ? '' : String(value);
}

function checklistLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export default function NoticePlanner({ session, onLoginClick, onSessionExpired, onSaved, onOpenSubmissions, onApplyRules }: Props) {
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<NoticeDraft | null>(null);
  const [checklistText, setChecklistText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<PlannerError | null>(null);
  const [savedTitle, setSavedTitle] = useState('');
  const checklist = useMemo(() => checklistLines(checklistText), [checklistText]);
  const commonRules = draft ? hasRules(draft.rules) : false;

  function updateDraft(changes: Partial<NoticeDraft>) {
    setDraft((current) => current ? { ...current, ...changes } : current);
    setConfirmed(false);
    setError(null);
    setSavedTitle('');
  }

  function updateRule<K extends keyof SubmissionRules>(key: K, value: SubmissionRules[K]) {
    if (!draft) return;
    updateDraft({ rules: { ...draft.rules, [key]: value } });
  }

  function updatePositiveRule(key: Exclude<keyof SubmissionRules, 'formats'>, value: string, multiplier = 1) {
    const number = Number(value);
    updateRule(key, value.trim() && Number.isFinite(number) && number > 0 ? Math.round(number * multiplier) : null);
  }

  function analyze() {
    setError(null);
    setSavedTitle('');
    setConfirmed(false);
    if (!source.trim()) {
      setError({ title: '공고 분석 실패', reason: '공고문이 비어 있습니다.', advice: '제출 안내 문구를 붙여넣은 뒤 다시 눌러 주세요.' });
      return;
    }
    if (source.length > 20_000) {
      setError({ title: '공고 분석 실패', reason: '공고문이 20,000자를 넘습니다.', advice: '제출 서류와 마감 조건이 있는 부분만 붙여넣어 주세요.' });
      return;
    }
    try {
      const result = parseNotice(source);
      setDraft(result);
      setChecklistText(result.checklist.join('\n'));
    } catch (failure) {
      setError({ title: '공고 분석 실패', reason: failure instanceof Error ? failure.message : '문구를 읽는 중 문제가 생겼습니다.', advice: '공고 내용을 줄여 다시 시도하거나, 직접 제출 건을 작성해 주세요.' });
    }
  }

  function validate(): string | null {
    if (!draft) return '공고문을 먼저 분석해 주세요.';
    if (!draft.title.trim()) return '제출 건 이름을 입력해 주세요.';
    if (draft.title.trim().length > 120 || draft.destination.trim().length > 120) return '제출 건 이름과 제출처는 각각 120자 이하여야 합니다.';
    if (draft.fileNameRule.trim().length > 240) return '파일명 안내는 240자 이하여야 합니다.';
    if (checklist.length < 1) return '필요한 서류를 한 개 이상 입력해 주세요.';
    if (checklist.length > 30) return '필요한 서류는 최대 30개까지 저장할 수 있습니다.';
    if (checklist.some((label) => label.length > 120)) return '서류 이름은 각각 120자 이하여야 합니다.';
    if (new Set(checklist).size !== checklist.length) return '같은 이름의 서류가 중복되었습니다. 목록을 확인해 주세요.';
    if (draft.rules.formats.some((format) => !supportedFormats.has(format))) return '허용 형식은 JPG, PNG, WEBP, PDF, DOCX, XLSX, PPTX, ZIP 중에서 입력해 주세요.';
    if (draft.rules.minEachBytes !== null && draft.rules.maxEachBytes !== null && draft.rules.minEachBytes > draft.rules.maxEachBytes) return '파일당 최소 용량이 최대 용량보다 큽니다.';
    for (const [key, limit] of Object.entries({ minEachBytes: 100_000_000, maxEachBytes: 100_000_000, maxTotalBytes: 5_000_000_000, maxFiles: 50, maxPages: 200, width: 16000, height: 16000 })) {
      const value = draft.rules[key as Exclude<keyof SubmissionRules, 'formats'>];
      if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > limit)) return '공통 파일 검사 기준의 숫자를 허용 범위 안으로 수정해 주세요.';
    }
    if (!confirmed) return '원문과 추출 결과를 확인했다는 항목을 선택해 주세요.';
    return null;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = validate();
    if (issue) {
      setError({ title: '제출 계획 저장 실패', reason: issue, advice: '아래 초안을 수정한 뒤 다시 저장해 주세요.' });
      return;
    }
    if (!session) { onLoginClick(); return; }
    if (!accountApiConfigured) {
      setError({ title: '제출 계획 저장 실패', reason: '계정 서버가 설정되지 않았습니다.', advice: '서버 연결을 확인한 뒤 다시 시도해 주세요. 분석한 내용은 이 화면에 남아 있습니다.' });
      return;
    }
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const title = draft.title.trim();
      await submissionApi.createFromNotice(session.token, {
        submission: {
          title,
          destination: draft.destination.trim(),
          dueDate: draft.dueDate || null,
          status: 'preparing',
          checklist: checklist.map((label) => ({ id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`, label, done: false })),
        },
        fileNameRule: draft.fileNameRule.trim(),
        ruleSet: commonRules ? { title: `${title} · 공통 검사 기준`.slice(0, 120), rules: draft.rules } : null,
      });
      setSavedTitle(title);
      onSaved();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.status === 401) onSessionExpired();
      setError({
        title: '제출 계획 저장 실패',
        reason: failure instanceof Error ? failure.message : '서버 요청에 실패했습니다.',
        advice: failure instanceof ApiFailure && failure.status === 401
          ? '로그인이 만료되었습니다. 다시 로그인한 뒤 저장해 주세요. 초안은 이 화면에 남아 있습니다.'
          : '인터넷 연결과 입력값을 확인한 뒤 다시 시도해 주세요. 초안은 이 화면에 남아 있습니다.',
      });
    } finally { setSaving(false); }
  }

  return <section className="panel notice-planner" role="tabpanel" aria-label="공고문으로 제출 계획 만들기">
    <div className="notice-planner-heading"><div><span className="notice-planner-kicker"><Sparkles size={14} /> 공고에서 준비까지</span><h3 className="panel-title"><ClipboardList /> 공고문 자동 정리</h3><p>공고를 붙여넣고 추출 결과를 확인하면 제출 건과 체크리스트를 만들 수 있어요.</p></div><span className="notice-planner-privacy"><LockKeyhole size={13} /> 공고 원문은 내 기기에서만 분석</span></div>

    <div className="notice-planner-step"><span>01</span><strong>공고문 붙여넣기</strong></div>
    <label className="field"><span className="field-label">제출 안내 문구</span><textarea className="field-input notice-source" value={source} maxLength={20_000} onChange={(event) => { setSource(event.target.value); setDraft(null); setChecklistText(''); setConfirmed(false); setError(null); setSavedTitle(''); }} placeholder={'예: 2026년 신입 개발자 채용\n접수 마감: 2026. 11. 30.\n제출 서류: 이력서, 자기소개서, 포트폴리오\n모든 파일은 PDF, 파일당 5MB 이하'} /><small className="field-help">텍스트를 붙여넣어 주세요. 스캔 이미지와 PDF 파일 읽기는 아직 지원하지 않습니다. {source.length.toLocaleString()}/20,000자</small></label>
    <div className="notice-planner-actions"><button type="button" className="button button-primary" onClick={analyze}><WandSparkles size={17} /> 공고 분석하기</button>{source && <button type="button" className="text-button" onClick={() => { setSource(''); setDraft(null); setChecklistText(''); setConfirmed(false); setError(null); setSavedTitle(''); }}><X size={15} /> 내용 지우기</button>}</div>

    {draft && !savedTitle && <form onSubmit={(event) => void save(event)} className="notice-planner-draft">
      <div className="notice-planner-step"><span>02</span><strong>추출 결과 확인·수정</strong></div>
      <p className="notice-planner-explain">자동 추출은 일부 내용을 놓칠 수 있습니다. 공고 원문과 대조해 빠진 서류나 조건을 직접 고쳐 주세요.</p>
      {draft.warnings.length > 0 && <div className="notice-planner-warnings" role="status"><strong><CircleAlert size={17} /> 직접 확인할 내용</strong><ul>{draft.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}
      <div className="notice-planner-grid">
        <label className="field"><span className="field-label">제출 건 이름 *</span><input className="field-input" value={draft.title} maxLength={120} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="예: 신입 개발자 지원" required /></label>
        <label className="field"><span className="field-label">제출처</span><input className="field-input" value={draft.destination} maxLength={120} onChange={(event) => updateDraft({ destination: event.target.value })} placeholder="회사·학교·기관 이름" /></label>
        <label className="field"><span className="field-label">마감일</span><input className="field-input" type="date" value={draft.dueDate ?? ''} onChange={(event) => updateDraft({ dueDate: event.target.value || null })} /></label>
        <label className="field"><span className="field-label">파일명 안내</span><input className="field-input" value={draft.fileNameRule} maxLength={240} onChange={(event) => updateDraft({ fileNameRule: event.target.value })} placeholder="예: 이름_지원분야.pdf" /></label>
      </div>
      <label className="field notice-checklist-field"><span className="field-label">필요한 서류 * <span className="optional">{checklist.length}/30개</span></span><textarea className="field-input" rows={5} value={checklistText} onChange={(event) => { setChecklistText(event.target.value); setConfirmed(false); setError(null); setSavedTitle(''); }} placeholder={'이력서\n자기소개서\n포트폴리오'} /><small className="field-help">한 줄에 한 서류씩 입력하세요. 서류별 형식 조건은 공고 원문과 함께 확인해 주세요.</small></label>

      <div className="notice-planner-rules"><div className="notice-planner-rules-head"><div><strong>공통 파일 검사 기준</strong><small>입력한 기준은 제출 건과 연결된 검사 기준으로 함께 저장됩니다.</small></div>{commonRules && <button type="button" className="text-button" onClick={() => onApplyRules(draft.rules)}>지금 조건 점검에 적용 <ArrowRight size={14} /></button>}</div>
        <div className="notice-planner-grid">
          <label className="field"><span className="field-label">허용 형식</span><input className="field-input" value={draft.rules.formats.join(', ')} onChange={(event) => updateRule('formats', [...new Set(event.target.value.toUpperCase().split(/[\s,，/]+/).filter(Boolean).map((format) => format === 'JPEG' ? 'JPG' : format))])} placeholder="예: PDF, JPG" /></label>
          <label className="field"><span className="field-label">파일당 최대 용량 (MB)</span><input className="field-input" type="number" min="0.01" max="95.36" step="0.01" value={mbText(draft.rules.maxEachBytes)} onChange={(event) => updatePositiveRule('maxEachBytes', event.target.value, MB)} placeholder="예: 5" /></label>
          <label className="field"><span className="field-label">파일당 최소 용량 (MB)</span><input className="field-input" type="number" min="0.01" max="95.36" step="0.01" value={mbText(draft.rules.minEachBytes)} onChange={(event) => updatePositiveRule('minEachBytes', event.target.value, MB)} placeholder="선택 사항" /></label>
          <label className="field"><span className="field-label">전체 최대 용량 (MB)</span><input className="field-input" type="number" min="0.01" max="4768" step="0.01" value={mbText(draft.rules.maxTotalBytes)} onChange={(event) => updatePositiveRule('maxTotalBytes', event.target.value, MB)} placeholder="선택 사항" /></label>
          <label className="field"><span className="field-label">최대 파일 수</span><input className="field-input" type="number" min="1" max="50" step="1" value={numberText(draft.rules.maxFiles)} onChange={(event) => updatePositiveRule('maxFiles', event.target.value)} placeholder="선택 사항" /></label>
          <label className="field"><span className="field-label">최대 PDF 페이지</span><input className="field-input" type="number" min="1" max="200" step="1" value={numberText(draft.rules.maxPages)} onChange={(event) => updatePositiveRule('maxPages', event.target.value)} placeholder="선택 사항" /></label>
          <label className="field"><span className="field-label">사진 크기 (가로 × 세로 px)</span><span className="notice-planner-size"><input className="field-input" aria-label="사진 가로 픽셀" type="number" min="1" max="16000" value={numberText(draft.rules.width)} onChange={(event) => updatePositiveRule('width', event.target.value)} placeholder="가로" /><span>×</span><input className="field-input" aria-label="사진 세로 픽셀" type="number" min="1" max="16000" value={numberText(draft.rules.height)} onChange={(event) => updatePositiveRule('height', event.target.value)} placeholder="세로" /></span></label>
        </div>
        {draft.rules.minEachBytes !== null && <p className="field-help">파일당 최소 용량: {humanBytes(draft.rules.minEachBytes)}</p>}
        {!commonRules && <p className="field-help">확실한 공통 조건을 찾지 못했습니다. 필요하다면 위에서 직접 입력할 수 있어요.</p>}
      </div>

      <div className="notice-planner-step"><span>03</span><strong>확인하고 저장</strong></div>
      <label className="simple-check notice-planner-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setError(null); }} /> 공고 원문과 추출 결과를 대조했고, 저장할 내용을 확인했습니다.</label>
      <div className="notice-planner-actions"><button className="button button-primary" type="submit" disabled={saving || !draft.title.trim()}>{saving ? '저장 중…' : session ? '제출 계획 저장하기' : '로그인하고 저장하기'} <ArrowRight size={17} /></button>{!session && <span className="field-help">분석과 수정은 로그인 없이 사용할 수 있어요.</span>}</div>
    </form>}

    {error && <div className="notice-planner-error" role="alert"><strong><CircleAlert size={17} /> {error.title}</strong><span>{error.reason}</span><small>{error.advice}</small></div>}
    {savedTitle && <div className="notice-planner-success" role="status"><strong><Check size={17} /> 「{savedTitle}」 제출 계획을 저장했습니다.</strong><span>필요 서류와 마감일을 제출 건에서 확인할 수 있어요. 다른 계획을 만들려면 위 공고를 바꾸고 다시 분석해 주세요.</span><button className="button button-secondary" type="button" onClick={onOpenSubmissions}>제출 건 확인 <ArrowRight size={15} /></button></div>}
  </section>;
}
