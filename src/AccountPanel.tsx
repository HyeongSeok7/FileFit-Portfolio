import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SubmissionRules } from './lib/rules';
import { accountApi, accountApiConfigured, ApiFailure, rememberSession, storedSession } from './lib/serverApi';
import type { AuthSession, SavedRuleSet, SharedRuleSet } from './lib/serverApi';

type Props = {
  rules: SubmissionRules;
  onApply: (rules: SubmissionRules, title: string) => void;
  onFailure: (task: string, error: unknown, advice: string) => void;
};

const shareId = new URLSearchParams(window.location.search).get('share');

export default function AccountPanel({ rules, onApply, onFailure }: Props) {
  const hasRules = rules.formats.length > 0 || Object.entries(rules).some(([key, value]) => key !== 'formats' && value !== null);
  const [session, setSession] = useState<AuthSession | null>(() => storedSession());
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<SavedRuleSet[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [shared, setShared] = useState<SharedRuleSet | null>(null);
  const [sharedFailed, setSharedFailed] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [notice, setNotice] = useState('');

  function fail(task: string, error: unknown, advice = '잠시 후 다시 시도해 주세요. 파일 작업은 계속 사용할 수 있습니다.') {
    if (error instanceof ApiFailure && error.status === 401 && session) {
      rememberSession(null);
      setSession(null);
      setItems([]);
      advice = '로그인이 만료되었습니다. 다시 로그인해 주세요. 파일 작업은 계속 사용할 수 있습니다.';
    }
    onFailure(task, error, advice);
  }

  async function list(token: string, query = activeSearch, nextPage = page) {
    const result = await accountApi.list(token, query, nextPage, 6);
    setItems(result.items);
    setTotal(result.total);
    setPage(result.page);
  }

  useEffect(() => {
    if (!accountApiConfigured || !session) return;
    let active = true;
    void accountApi.me(session.token).then(() => accountApi.list(session.token, '', 1, 6)).then((result) => {
      if (!active) return;
      setItems(result.items); setTotal(result.total); setPage(1);
    }).catch((error) => { if (active) fail('저장한 조건 불러오기', error); });
    return () => { active = false; };
    // Session restoration runs once for each new token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  useEffect(() => {
    if (!shareId) return;
    if (!accountApiConfigured) { setSharedFailed(true); onFailure('공유 조건 불러오기', new Error('계정 서버 주소가 설정되지 않았습니다.'), '사이트 관리자에게 서버 연결을 확인해 달라고 요청해 주세요.'); return; }
    let active = true;
    void accountApi.shared(shareId).then((value) => { if (active) setShared(value); })
      .catch((error) => { if (active) { setSharedFailed(true); onFailure('공유 조건 불러오기', error, '공유 주소를 확인하거나 공유자에게 새 링크를 요청해 주세요.'); } });
    return () => { active = false; };
    // A share URL is loaded when the panel mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(task: string, action: () => Promise<void>, advice?: string) {
    setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { fail(task, error, advice); }
    finally { setBusy(false); }
  }

  function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(mode === 'register' ? '회원가입' : '로그인', async () => {
      const result = mode === 'register' ? await accountApi.register(name.trim(), secret) : await accountApi.login(name.trim(), secret);
      rememberSession(result);
      setSession(result);
      setSecret('');
      setNotice(`${result.user.username}님, 로그인되었습니다.`);
    }, '아이디와 비밀번호를 확인해 주세요. 서버 연결에 문제가 있다면 잠시 후 다시 시도해 주세요.');
  }

  function logout() {
    if (!session) return;
    const token = session.token;
    void run('로그아웃', async () => {
      await accountApi.logout(token);
      rememberSession(null); setSession(null); setItems([]); setNotice('로그아웃되었습니다.');
    }, '서버 연결을 확인한 뒤 다시 시도해 주세요.');
  }

  function create() {
    if (!session) return;
    void run('조건 저장', async () => {
      const value = await accountApi.create(session.token, title, rules);
      setTitle(''); setActiveSearch(''); setSearch('');
      await list(session.token, '', 1);
      setNotice(`「${value.title}」 조건을 저장했습니다. 파일은 서버에 저장하지 않았습니다.`);
    }, '조건 이름과 입력한 제출 기준을 확인해 주세요.');
  }

  function saveEdit(item: SavedRuleSet) {
    if (!session) return;
    void run('조건 수정', async () => {
      await accountApi.update(session.token, item.id, editTitle, rules, item.version);
      setEditingId(null);
      await list(session.token);
      setNotice('현재 화면의 제출 기준으로 수정했습니다.');
    }, '다른 탭에서 먼저 수정했다면 목록을 새로고침한 뒤 다시 시도해 주세요.');
  }

  function remove(item: SavedRuleSet) {
    if (!session || !window.confirm(`「${item.title}」 조건을 삭제할까요? 공유 링크도 사용할 수 없게 됩니다.`)) return;
    void run('조건 삭제', async () => {
      await accountApi.remove(session.token, item.id);
      await list(session.token, activeSearch, items.length === 1 && page > 1 ? page - 1 : page);
      setNotice('저장한 조건을 삭제했습니다.');
    });
  }

  function share(item: SavedRuleSet) {
    if (!session) return;
    void run('조건 공유', async () => {
      const { shareId: id } = await accountApi.share(session.token, item.id);
      const link = `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(id)}`;
      setShareLink(link);
      await list(session.token);
      try { await navigator.clipboard.writeText(link); setNotice('읽기 전용 공유 링크를 복사했습니다.'); }
      catch { fail('공유 링크 자동 복사', new Error('브라우저가 클립보드 접근을 허용하지 않았습니다.'), '아래 표시된 링크를 직접 선택해 복사해 주세요.'); }
    });
  }

  function unshare(item: SavedRuleSet) {
    if (!session || !window.confirm(`「${item.title}」의 공유 링크를 중지할까요?`)) return;
    void run('공유 중지', async () => {
      await accountApi.unshare(session.token, item.id);
      await list(session.token);
      setShareLink(''); setNotice('공유 링크를 중지했습니다.');
    });
  }

  return <section className="account-panel panel" aria-label="제출 기준 저장 및 공유">
    <div className="account-heading"><div><span className="account-kicker">선택 기능</span><h3 className="panel-title">제출 기준 저장 · 공유</h3></div><span className="status-pill">파일은 전송되지 않아요</span></div>
    <p className="field-help">자주 쓰는 형식·용량·크기 기준만 계정에 저장하세요. 사진과 PDF는 계속 이 브라우저에서 처리합니다.</p>
    {notice && <p className="account-notice" role="status">{notice}</p>}
    {shareId && <div className="shared-rule"><strong>공유받은 조건</strong>{shared ? <><span>{shared.title}</span><p>읽기 전용입니다. 적용하면 현재 입력한 기준이 바뀝니다.</p><button className="button button-secondary" type="button" onClick={() => onApply(shared.rules, shared.title)}>이 조건 적용</button></> : <p>{sharedFailed ? '공유 조건을 불러오지 못했습니다. 위의 실패 이유를 확인해 주세요.' : '공유 조건을 불러오는 중입니다…'}</p>}</div>}
    {!accountApiConfigured ? <p className="account-offline">계정 서버 연결 전입니다. 제출 조건 점검과 사진·PDF 작업은 바로 사용할 수 있어요.</p> : !session ? <div className="account-auth">
      <div className="account-switch"><button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>로그인</button><button type="button" aria-pressed={mode === 'register'} onClick={() => setMode('register')}>회원가입</button></div>
      <form className="account-form" onSubmit={submitAuth}><label className="field"><span className="field-label">아이디</span><input className="field-input" autoComplete="username" value={name} onChange={(event) => setName(event.target.value)} minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]+" required placeholder="영문·숫자·밑줄, 3~32자" /></label><label className="field"><span className="field-label">비밀번호</span><input className="field-input" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={secret} onChange={(event) => setSecret(event.target.value)} minLength={12} maxLength={128} required placeholder="12자 이상" /></label><button className="button button-primary" disabled={busy} type="submit">{busy ? '처리 중…' : mode === 'register' ? '가입하고 조건 저장하기' : '로그인'}</button></form>
    </div> : <div className="account-signed">
      <div className="account-user"><strong>{session.user.username}님의 저장 공간</strong><button className="text-button" type="button" disabled={busy} onClick={logout}>로그아웃</button></div>
      <div className="account-save"><label className="field"><span className="field-label">현재 기준 이름</span><input className="field-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="예: 입사 지원서 사진" /></label><button className="button button-primary" type="button" disabled={busy || !title.trim() || !hasRules} onClick={create}>현재 기준 저장</button></div>
      {!hasRules && <p className="field-help">위의 제출 기준을 하나 이상 입력하면 저장할 수 있어요.</p>}
      <form className="account-search" onSubmit={(event) => { event.preventDefault(); void run('조건 검색', async () => { setActiveSearch(search); await list(session.token, search, 1); }); }}><input className="field-input" aria-label="저장한 조건 검색" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="저장한 조건 검색" /><button className="button button-secondary" type="submit" disabled={busy}>검색</button></form>
      <div className="account-list-heading"><strong>저장한 조건</strong><span>{total}개</span><button className="text-button" type="button" disabled={busy} onClick={() => void run('목록 새로고침', () => list(session.token))}>새로고침</button></div>
      {items.length === 0 ? <p className="account-empty">저장한 조건이 없습니다. 위에서 이름을 입력하고 현재 기준을 저장해 보세요.</p> : <div className="account-list">{items.map((item) => <div className="account-item" key={item.id}><div className="account-item-head"><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString('ko-KR')} · 버전 {item.version}</small></div><div className="account-item-actions"><button className="text-button" type="button" disabled={busy} onClick={() => onApply(item.rules, item.title)}>적용</button><button className="text-button" type="button" disabled={busy} onClick={() => { setEditingId(item.id); setEditTitle(item.title); }}>수정</button><button className="text-button" type="button" disabled={busy} onClick={() => share(item)}>공유 링크</button>{item.shareId && <button className="text-button" type="button" disabled={busy} onClick={() => unshare(item)}>공유 중지</button>}<button className="text-button danger-text" type="button" disabled={busy} onClick={() => remove(item)}>삭제</button></div>{editingId === item.id && <div className="account-edit"><label className="field"><span className="field-label">수정할 이름</span><input className="field-input" value={editTitle} maxLength={120} onChange={(event) => setEditTitle(event.target.value)} /></label><p>현재 화면에 입력된 제출 기준으로 이 항목을 바꿉니다.</p><button className="button button-secondary" type="button" disabled={busy || !editTitle.trim() || !hasRules} onClick={() => saveEdit(item)}>현재 기준으로 수정</button><button className="text-button" type="button" onClick={() => setEditingId(null)}>취소</button></div>}</div>)}</div>}
      {total > 6 && <div className="account-pages"><button className="button button-secondary" type="button" disabled={busy || page <= 1} onClick={() => void run('이전 목록', () => list(session.token, activeSearch, page - 1))}>이전</button><span>{page} / {Math.ceil(total / 6)}</span><button className="button button-secondary" type="button" disabled={busy || page * 6 >= total} onClick={() => void run('다음 목록', () => list(session.token, activeSearch, page + 1))}>다음</button></div>}
      {shareLink && <label className="field account-share-link"><span className="field-label">공유 주소 · 직접 복사할 수 있어요</span><input className="field-input" readOnly value={shareLink} onFocus={(event) => event.target.select()} /></label>}
    </div>}
  </section>;
}
