import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { accountApi, ApiFailure, accountApiConfigured } from './lib/serverApi';
import type { AuthSession } from './lib/serverApi';
import { submissionApi } from './lib/submissionApi';
import type { ChecklistItem, SubmissionCase, SubmissionChanges, SubmissionStatus } from './lib/submissionApi';
import type { SubmissionRules } from './lib/rules';
import './submissions.css';

type Props = {
  session: AuthSession | null;
  onFailure?: (task: string, error: unknown, advice: string) => void;
  onLoginClick?: () => void;
  refreshSignal?: number;
  onApplyRules?: (rules: SubmissionRules, title: string) => void;
};
type LocalError = { task: string; reason: string; advice: string };

const PAGE_SIZE = 6;
const statusLabels: Record<SubmissionStatus, string> = {
  preparing: '준비 중',
  ready: '제출 준비 완료',
  submitted: '제출 완료',
};

function newChecklistId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function draftOf(item: SubmissionCase): SubmissionChanges {
  return {
    title: item.title,
    destination: item.destination,
    dueDate: item.dueDate,
    status: item.status,
    checklist: item.checklist.map((entry) => ({ ...entry })),
    fileNameRule: item.fileNameRule ?? '',
  };
}

function formattedDate(value: string | null): string {
  if (!value) return '마감일 없음';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function completedCount(checklist: ChecklistItem[]) {
  return checklist.filter((item) => item.done).length;
}

export default function SubmissionCases({ session, onFailure, onLoginClick, refreshSignal, onApplyRules }: Props) {
  const [items, setItems] = useState<SubmissionCase[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [selected, setSelected] = useState<SubmissionCase | null>(null);
  const [draft, setDraft] = useState<SubmissionChanges | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDestination, setNewDestination] = useState('');
  const [newDueDate, setNewDueDate] = useState('');
  const [newChecklist, setNewChecklist] = useState('');
  const [nextChecklistLabel, setNextChecklistLabel] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<LocalError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [expired, setExpired] = useState(false);
  const previousRefreshSignal = useRef(refreshSignal);

  const token = session?.token;

  function report(task: string, failure: unknown, advice: string) {
    const reason = failure instanceof Error ? failure.message : String(failure ?? '알 수 없는 오류');
    if (failure instanceof ApiFailure && failure.status === 401) {
      setExpired(true);
      advice = '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    }
    if (failure instanceof ApiFailure && failure.status === 409) {
      setConflict(true);
      advice = '다른 탭에서 이 제출 건을 먼저 수정했습니다. 최신 내용을 불러와 확인한 뒤 다시 저장해 주세요.';
    }
    setError({ task, reason, advice });
    onFailure?.(task, failure, advice);
  }

  async function loadList(currentToken: string, query = activeSearch, nextPage = page) {
    const result = await submissionApi.list(currentToken, query, nextPage, PAGE_SIZE);
    setItems(result.items);
    setTotal(result.total);
    setPage(result.page);
  }

  async function refreshListAfterMutation(currentToken: string, query = activeSearch, nextPage = page) {
    try { await loadList(currentToken, query, nextPage); }
    catch (failure) { report('목록 새로고침', failure, '변경사항은 저장되었습니다. 서버 연결을 확인한 뒤 목록을 새로고침해 주세요.'); }
  }

  useEffect(() => {
    setItems([]);
    setTotal(0);
    setPage(1);
    setSelected(null);
    setDraft(null);
    setConflict(false);
    setExpired(false);
    setError(null);
    if (!token || !accountApiConfigured) return;
    let active = true;
    setLoading(true);
    void submissionApi.list(token, '', 1, PAGE_SIZE).then((result) => {
      if (!active) return;
      setItems(result.items);
      setTotal(result.total);
      setPage(result.page);
      setActiveSearch('');
      setSearch('');
    }).catch((failure: unknown) => {
      if (active) report('제출 건 목록 불러오기', failure, '서버 연결을 확인하고 새로고침을 눌러 주세요.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // The initial request must run only when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const changed = previousRefreshSignal.current !== refreshSignal;
    previousRefreshSignal.current = refreshSignal;
    if (!changed || !token || !accountApiConfigured || expired) return;
    let active = true;
    void submissionApi.list(token, '', 1, PAGE_SIZE).then((result) => {
      if (!active) return;
      setItems(result.items);
      setTotal(result.total);
      setPage(result.page);
      setActiveSearch('');
      setSearch('');
    }).catch((failure: unknown) => {
      if (active) report('제출 건 목록 갱신', failure, '새 제출 건이 목록에 보이지 않으면 잠시 후 목록 새로고침을 눌러 주세요.');
    });
    return () => { active = false; };
    // This signal is emitted by the package tool; keep the selected unsaved draft intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  async function run(task: string, action: () => Promise<void>, advice = '입력값과 서버 연결을 확인한 뒤 다시 시도해 주세요.') {
    setPending(task);
    setError(null);
    setNotice('');
    try { await action(); }
    catch (failure) { report(task, failure, advice); }
    finally { setPending(null); }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || expired) return;
    void run('제출 건 만들기', async () => {
      const labels = newChecklist.split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
      if (!newTitle.trim()) throw new Error('제출 건 이름을 입력해 주세요.');
      if (labels.length > 30) throw new Error('체크리스트는 최대 30개까지 만들 수 있습니다.');
      if (labels.some((label) => label.length > 120)) throw new Error('체크리스트 항목은 각각 120자 이하로 입력해 주세요.');
      const value = await submissionApi.create(token, {
        title: newTitle.trim(),
        destination: newDestination.trim(),
        dueDate: newDueDate || null,
        status: 'preparing',
        checklist: labels.map((label) => ({ id: newChecklistId(), label, done: false })),
      });
      setNewTitle('');
      setNewDestination('');
      setNewDueDate('');
      setNewChecklist('');
      setSelected(value);
      setDraft(draftOf(value));
      setActiveSearch('');
      setSearch('');
      setItems((current) => [value, ...current.filter((item) => item.id !== value.id)].slice(0, PAGE_SIZE));
      setTotal((current) => current + 1);
      setPage(1);
      await refreshListAfterMutation(token, '', 1);
      setNotice(`「${value.title}」 제출 건을 만들었습니다. 파일 내용은 서버에 전송하지 않았습니다.`);
    }, '이름과 체크리스트 내용을 확인한 뒤 다시 시도해 주세요.');
  }

  function open(item: SubmissionCase) {
    if (!token || expired) return;
    if (selected && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(selected))
      && !window.confirm('저장하지 않은 변경이 있습니다. 다른 제출 건을 열까요?')) return;
    void run('제출 건 열기', async () => {
      const value = await submissionApi.get(token, item.id);
      setSelected(value);
      setDraft(draftOf(value));
      setConflict(false);
    }, '목록을 새로고침한 뒤 다시 열어 주세요.');
  }

  function addChecklist() {
    const label = nextChecklistLabel.trim();
    if (!draft || !label) return;
    if (draft.checklist.length >= 30) {
      report('항목 추가 실패', new Error('체크리스트는 최대 30개까지 만들 수 있습니다.'), '기존 항목을 정리한 뒤 다시 추가해 주세요.');
      return;
    }
    setDraft({ ...draft, checklist: [...draft.checklist, { id: newChecklistId(), label, done: false }] });
    setNextChecklistLabel('');
    setError(null);
  }

  function changeChecklist(id: string, change: Partial<ChecklistItem>) {
    if (!draft) return;
    setDraft({ ...draft, checklist: draft.checklist.map((entry) => entry.id === id ? { ...entry, ...change } : entry) });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !selected || !draft || expired) return;
    void run('제출 건 저장', async () => {
      const title = draft.title.trim();
      const checklist = draft.checklist.map((entry) => ({ ...entry, label: entry.label.trim() }));
      if (!title) throw new Error('제출 건 이름을 입력해 주세요.');
      if (checklist.some((entry) => !entry.label)) throw new Error('빈 체크리스트 항목을 채우거나 삭제해 주세요.');
      if (new Set(checklist.map((entry) => entry.id)).size !== checklist.length) throw new Error('체크리스트 항목 ID가 중복되었습니다. 항목을 다시 추가해 주세요.');
      const value = await submissionApi.update(token, selected.id, {
        title,
        destination: draft.destination.trim(),
        dueDate: draft.dueDate || null,
        status: draft.status,
        checklist,
        fileNameRule: draft.fileNameRule?.trim() ?? '',
      }, selected.version);
      setSelected(value);
      setDraft(draftOf(value));
      setConflict(false);
      setItems((current) => current.map((item) => item.id === value.id ? value : item));
      await refreshListAfterMutation(token);
      setNotice('변경사항을 저장했습니다.');
    }, '입력값을 확인한 뒤 다시 시도해 주세요.');
  }

  function refreshSelected() {
    if (!token || !selected || expired) return;
    if (draft && JSON.stringify(draft) !== JSON.stringify(draftOf(selected))
      && !window.confirm('저장하지 않은 변경이 사라집니다. 서버의 최신 내용을 불러올까요?')) return;
    void run('최신 제출 건 불러오기', async () => {
      const value = await submissionApi.get(token, selected.id);
      setSelected(value);
      setDraft(draftOf(value));
      setConflict(false);
      setNotice('서버의 최신 내용을 불러왔습니다. 내용을 확인한 뒤 다시 수정해 주세요.');
    }, '목록을 새로고침한 뒤 다시 시도해 주세요.');
  }

  function removeSelected() {
    if (!token || !selected || expired || !window.confirm(`「${selected.title}」 제출 건을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    void run('제출 건 삭제', async () => {
      await submissionApi.remove(token, selected.id);
      setItems((current) => current.filter((item) => item.id !== selected.id));
      setTotal((current) => Math.max(0, current - 1));
      setSelected(null);
      setDraft(null);
      await refreshListAfterMutation(token, activeSearch, items.length === 1 && page > 1 ? page - 1 : page);
      setNotice('제출 건을 삭제했습니다.');
    }, '서버 연결을 확인한 뒤 다시 시도해 주세요.');
  }

  function searchCases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || expired) return;
    void run('제출 건 검색', async () => {
      await loadList(token, search.trim(), 1);
      setActiveSearch(search.trim());
    }, '검색어를 확인하고 다시 시도해 주세요.');
  }

  function applyLinkedRules() {
    if (!token || !selected?.ruleSetId || expired) return;
    void run('연결된 검사 기준 불러오기', async () => {
      const savedRules = await accountApi.get(token, selected.ruleSetId!);
      onApplyRules?.(savedRules.rules, savedRules.title);
    }, '검사 기준이 삭제되었을 수 있습니다. 조건 점검에서 직접 기준을 입력하거나 새로고침해 주세요.');
  }

  const disabled = Boolean(pending) || loading;
  const dirty = Boolean(selected && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(selected)));

  return <section className="submissions-panel panel" aria-label="제출 건 관리">
    <div className="submissions-heading">
      <div><span className="submissions-kicker">제출 관리</span><h3 className="panel-title">제출 건과 체크리스트</h3></div>
      <span className="submissions-privacy">파일은 서버에 저장되지 않아요</span>
    </div>
    <p className="submissions-intro">지원처마다 필요한 서류, 마감일, 준비 상태를 한곳에서 관리하세요. 이 화면에는 서류 이름과 진행 상황만 저장합니다.</p>
    {notice && <p className="submissions-notice" role="status">{notice}</p>}
    {error && <div className="submissions-error" role="alert"><strong>{error.task}</strong><p>{error.reason}</p><small>{error.advice}</small>{conflict && selected && <button className="button button-secondary" type="button" disabled={disabled} onClick={refreshSelected}>서버 최신 내용 불러오기</button>}</div>}
    {!accountApiConfigured ? <p className="submissions-empty">계정 서버 연결 전입니다. 이미지·PDF·파일 제출 조건 점검은 계속 사용할 수 있어요.</p>
      : !session || expired ? <div className="submissions-empty"><strong>{expired ? '로그인이 만료되었습니다.' : '로그인하면 제출 건을 저장할 수 있어요.'}</strong><p>체크리스트와 마감일을 계정에 저장하고 다른 기기에서도 이어서 확인할 수 있습니다.</p>{onLoginClick && <button className="button button-primary" type="button" onClick={onLoginClick}>로그인 화면으로 이동</button>}</div>
        : <div className="submissions-workspace">
          <form className="submissions-create" onSubmit={create}>
            <div className="submissions-section-heading"><div><span className="submissions-step">01</span><h4>새 제출 건 만들기</h4></div></div>
            <div className="submissions-form-grid">
              <label className="field"><span className="field-label">제출 건 이름 *</span><input className="field-input" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={120} required placeholder="예: 신입 개발자 지원" /></label>
              <label className="field"><span className="field-label">제출처</span><input className="field-input" value={newDestination} onChange={(event) => setNewDestination(event.target.value)} maxLength={120} placeholder="회사·학교·기관 이름" /></label>
              <label className="field"><span className="field-label">마감일</span><input className="field-input" type="date" value={newDueDate} onChange={(event) => setNewDueDate(event.target.value)} /></label>
            </div>
            <label className="field submissions-checklist-input"><span className="field-label">필요한 서류</span><textarea className="field-input" value={newChecklist} onChange={(event) => setNewChecklist(event.target.value)} rows={3} placeholder={'이력서\n자기소개서\n포트폴리오'} /><span className="field-help">한 줄에 하나씩 입력하세요. 최대 30개이며, 만든 뒤에도 수정할 수 있어요.</span></label>
            <button className="button button-primary" type="submit" disabled={disabled || !newTitle.trim()}>{pending === '제출 건 만들기' ? '만드는 중…' : '제출 건 만들기'}</button>
          </form>

          <div className="submissions-columns">
            <div className="submissions-list-section">
              <div className="submissions-section-heading"><div><span className="submissions-step">02</span><h4>내 제출 건</h4></div><span className="submissions-count">{total}개</span></div>
              <form className="submissions-search" onSubmit={searchCases}><input className="field-input" aria-label="제출 건 검색" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="이름·제출처 검색" /><button className="button button-secondary" type="submit" disabled={disabled}>검색</button></form>
              <button className="submissions-refresh" type="button" disabled={disabled} onClick={() => void run('제출 건 새로고침', () => loadList(token!), '서버 연결을 확인한 뒤 다시 시도해 주세요.')}>목록 새로고침</button>
              {loading ? <p className="submissions-list-empty">제출 건을 불러오는 중입니다…</p> : items.length === 0 ? <p className="submissions-list-empty">{activeSearch ? '검색 결과가 없습니다. 다른 검색어로 다시 찾아보세요.' : '아직 만든 제출 건이 없습니다. 위에서 첫 제출 건을 만들어 보세요.'}</p> : <div className="submissions-list">{items.map((item) => <button className={`submissions-card${selected?.id === item.id ? ' is-selected' : ''}`} type="button" disabled={disabled} onClick={() => open(item)} key={item.id} aria-pressed={selected?.id === item.id}>
                <span className="submissions-card-top"><strong>{item.title}</strong><span className={`submissions-status status-${item.status}`}>{statusLabels[item.status]}</span></span>
                <span className="submissions-card-meta">{item.destination || '제출처 미입력'} · {formattedDate(item.dueDate)}</span>
                <span className="submissions-card-progress">서류 {completedCount(item.checklist)}/{item.checklist.length}개 완료</span>
              </button>)}</div>}
              {total > PAGE_SIZE && <div className="submissions-pages"><button className="button button-secondary" type="button" disabled={disabled || page <= 1} onClick={() => void run('이전 제출 건', () => loadList(token!, activeSearch, page - 1))}>이전</button><span>{page} / {Math.ceil(total / PAGE_SIZE)}</span><button className="button button-secondary" type="button" disabled={disabled || page * PAGE_SIZE >= total} onClick={() => void run('다음 제출 건', () => loadList(token!, activeSearch, page + 1))}>다음</button></div>}
            </div>

            <div className="submissions-detail-section">
              <div className="submissions-section-heading"><div><span className="submissions-step">03</span><h4>진행 상황</h4></div>{selected && <span className="submissions-version">버전 {selected.version}</span>}</div>
              {!selected || !draft ? <div className="submissions-detail-empty">목록에서 제출 건을 선택하면 체크리스트와 진행 상태를 수정할 수 있어요.</div> : <form className="submissions-edit" onSubmit={save}>
                <div className="submissions-form-grid">
                  <label className="field"><span className="field-label">제출 건 이름 *</span><input className="field-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={120} required /></label>
                  <label className="field"><span className="field-label">제출처</span><input className="field-input" value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })} maxLength={120} /></label>
                  <label className="field"><span className="field-label">마감일</span><input className="field-input" type="date" value={draft.dueDate ?? ''} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null })} /></label>
                  <label className="field"><span className="field-label">진행 상태</span><select className="field-input" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as SubmissionStatus })}><option value="preparing">준비 중</option><option value="ready">제출 준비 완료</option><option value="submitted">제출 완료</option></select></label>
                </div>
                <label className="field submissions-filename-rule"><span className="field-label">파일명 안내</span><input className="field-input" value={draft.fileNameRule ?? ''} maxLength={240} onChange={(event) => setDraft({ ...draft, fileNameRule: event.target.value })} placeholder="예: 지원자명_서류명.pdf" /><small className="field-help">공고에 파일명 규칙이 있다면 보관해 두고 최종 제출 전에 확인하세요.</small></label>
                {selected.ruleSetId && <div className="submissions-linked-rule"><span>이 제출 건에 파일 검사 기준이 연결되어 있습니다.</span><button type="button" className="button button-secondary" disabled={disabled} onClick={applyLinkedRules}>조건 점검에 적용</button></div>}
                <div className="submissions-checklist-title"><strong>필요한 서류</strong><span>{completedCount(draft.checklist)}/{draft.checklist.length}개 완료</span></div>
                {draft.checklist.length === 0 ? <p className="submissions-list-empty">필요한 서류를 아래에서 추가해 주세요.</p> : <ul className="submissions-checklist">{draft.checklist.map((entry) => <li key={entry.id}><label className="submissions-checkbox"><input type="checkbox" checked={entry.done} onChange={(event) => changeChecklist(entry.id, { done: event.target.checked })} aria-label={`${entry.label || '이름 없는 서류'} 준비 완료`} /></label><input className="field-input" aria-label="서류 이름" value={entry.label} maxLength={120} required onChange={(event) => changeChecklist(entry.id, { label: event.target.value })} /><button className="submissions-remove-item" type="button" aria-label={`${entry.label || '서류'} 삭제`} onClick={() => setDraft({ ...draft, checklist: draft.checklist.filter((item) => item.id !== entry.id) })}>삭제</button></li>)}</ul>}
                <div className="submissions-add-checklist"><input className="field-input" aria-label="추가할 서류 이름" value={nextChecklistLabel} onChange={(event) => setNextChecklistLabel(event.target.value)} maxLength={120} placeholder="예: 자격증 사본" /><button className="button button-secondary" type="button" disabled={!nextChecklistLabel.trim() || draft.checklist.length >= 30} onClick={addChecklist}>항목 추가</button></div>
                {draft.status === 'submitted' && draft.checklist.some((entry) => !entry.done) && <p className="submissions-caution">완료하지 않은 서류가 있습니다. 제출 상태를 다시 확인해 주세요.</p>}
                <div className="submissions-edit-actions"><button className="button button-primary" type="submit" disabled={disabled || !dirty || !draft.title.trim()}>{pending === '제출 건 저장' ? '저장 중…' : '변경사항 저장'}</button><button className="button button-secondary" type="button" disabled={disabled} onClick={refreshSelected}>최신 내용 불러오기</button><button className="submissions-delete" type="button" disabled={disabled} onClick={removeSelected}>제출 건 삭제</button></div>
                {dirty && <p className="submissions-unsaved">저장하지 않은 변경이 있습니다.</p>}
                <p className="submissions-updated">마지막 저장: {new Date(selected.updatedAt).toLocaleString('ko-KR')}</p>
              </form>}
            </div>
          </div>
        </div>}
  </section>;
}
