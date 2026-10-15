import { useMemo, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Check, CircleAlert, Download, FileArchive, FileCheck2, FilePlus2, LockKeyhole, Trash2, UploadCloud, X } from 'lucide-react';
import {
  createPackageArchive, generatedPackageName, inspectPackageFile, MAX_PACKAGE_FILES,
  MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_TOTAL_BYTES, parseAllowedFormats, safeNamePart,
} from './lib/packageTools';
import type { InspectedPackageFile, PackageArchiveEntry } from './lib/packageTools';
import { humanBytes } from './lib/rules';
import './package.css';

export type PackageChecklistItem = { id: string; label: string; done: boolean };
export type SubmissionPackageProps = {
  onFailure?: (task: string, error: unknown, advice: string) => void;
  onSaveCase?: (title: string, checklist: PackageChecklistItem[], destination: string) => Promise<void>;
  onLoginClick?: () => void;
};

type Slot = {
  id: string;
  label: string;
  allowed: string;
  maxMB: string;
  file: File | null;
  status: 'empty' | 'checking' | 'ready' | 'error';
  inspection?: InspectedPackageFile;
  error?: string;
};

type LocalFailure = { task: string; reason: string; advice: string };

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newSlot(index: number): Slot {
  return { id: newId(), label: `제출 서류 ${index}`, allowed: '', maxMB: '', file: null, status: 'empty' };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '알 수 없는 오류가 발생했습니다.');
}

function slotBaseIssues(slot: Slot): string[] {
  const issues: string[] = [];
  if (!slot.label.trim()) issues.push('서류 이름을 입력해 주세요.');
  const { formats, unknown } = parseAllowedFormats(slot.allowed);
  if (unknown.length) issues.push(`알 수 없는 허용 형식: ${unknown.join(', ')}`);
  const limit = slot.maxMB.trim() ? Number(slot.maxMB) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0 || limit > 30)) issues.push('최대 용량은 0보다 크고 30MB 이하여야 합니다.');
  if (!slot.file) issues.push('필수 서류를 추가해 주세요.');
  else if (slot.status === 'checking') issues.push('파일 형식과 중복 여부를 확인 중입니다.');
  else if (slot.status === 'error') issues.push(slot.error ?? '파일을 읽을 수 없습니다.');
  else if (slot.status === 'ready' && slot.inspection) {
    if (formats.length && !formats.includes(slot.inspection.format)) issues.push(`허용 형식: ${formats.join(', ')} · 현재 ${slot.inspection.format}`);
    if (limit !== null && Number.isFinite(limit) && limit > 0 && slot.file.size > limit * 1024 * 1024) issues.push(`용량 ${humanBytes(slot.file.size)} · 기준 ${limit}MB`);
  }
  return issues;
}

function evaluateSlots(slots: Slot[], prefix: string): Record<string, string[]> {
  const issues: Record<string, string[]> = Object.fromEntries(slots.map((slot) => [slot.id, slotBaseIssues(slot)]));
  const digests = new Map<string, string>();
  const generatedNames = new Map<string, string>();
  for (const slot of slots) {
    if (!slot.file || slot.status !== 'ready' || !slot.inspection) continue;
    const duplicate = digests.get(slot.inspection.sha256);
    if (duplicate) {
      issues[slot.id].push('다른 칸과 내용이 같은 파일입니다.');
      issues[duplicate].push('다른 칸과 내용이 같은 파일입니다.');
    } else digests.set(slot.inspection.sha256, slot.id);

    const filename = generatedPackageName(prefix, slot.label, slot.file).toLocaleLowerCase();
    const collision = generatedNames.get(filename);
    if (collision) {
      issues[slot.id].push('정리한 파일명이 다른 칸과 겹칩니다. 서류 이름을 바꿔 주세요.');
      issues[collision].push('정리한 파일명이 다른 칸과 겹칩니다. 서류 이름을 바꿔 주세요.');
    } else generatedNames.set(filename, slot.id);
  }
  return issues;
}

export default function SubmissionPackage({ onFailure, onSaveCase, onLoginClick }: SubmissionPackageProps) {
  const [title, setTitle] = useState('');
  const [destination, setDestination] = useState('');
  const [prefix, setPrefix] = useState('제출서류');
  const [slots, setSlots] = useState<Slot[]>(() => [newSlot(1)]);
  const [failure, setFailure] = useState<LocalFailure | null>(null);
  const [notice, setNotice] = useState('');
  const [busyZip, setBusyZip] = useState(false);
  const [busySave, setBusySave] = useState(false);

  const issuesBySlot = useMemo(() => evaluateSlots(slots, prefix), [slots, prefix]);
  const totalBytes = slots.reduce((sum, slot) => sum + (slot.file?.size ?? 0), 0);
  const globalIssues = [
    ...(!title.trim() ? ['패키지 이름을 입력해 주세요.'] : []),
    ...(totalBytes > MAX_PACKAGE_TOTAL_BYTES ? [`전체 파일은 100MB 이하여야 합니다. 현재 ${humanBytes(totalBytes)}입니다.`] : []),
  ];
  const completeCount = slots.filter((slot) => issuesBySlot[slot.id].length === 0).length;
  const canExport = !busyZip && !busySave && globalIssues.length === 0 && completeCount === slots.length;

  function reportFailure(task: string, error: unknown, advice: string): void {
    setFailure({ task: `${task} 실패`, reason: reasonFor(error), advice });
    setNotice('');
    try { onFailure?.(task, error, advice); } catch { /* Local failure stays visible even if the caller fails. */ }
  }

  function editSlot(id: string, patch: Partial<Pick<Slot, 'label' | 'allowed' | 'maxMB'>>): void {
    setSlots((current) => current.map((slot) => slot.id === id ? { ...slot, ...patch } : slot));
    setNotice('');
  }

  async function inspectAssigned(id: string, file: File): Promise<void> {
    try {
      const inspection = await inspectPackageFile(file);
      setSlots((current) => current.map((slot) => slot.id === id && slot.file === file
        ? { ...slot, status: 'ready', inspection, error: undefined } : slot));
    } catch (error) {
      setSlots((current) => current.map((slot) => slot.id === id && slot.file === file
        ? { ...slot, status: 'error', inspection: undefined, error: reasonFor(error) } : slot));
      reportFailure(`「${file.name}」 확인`, error, '원본 파일이 정상적으로 열리는지 확인하고, 해당 칸에 다른 파일을 선택해 주세요.');
    }
  }

  function assignFile(id: string, file?: File): void {
    if (!file) return;
    if (file.size > MAX_PACKAGE_FILE_BYTES) {
      reportFailure('파일 추가', new Error('파일 하나는 30MB 이하여야 합니다.'), '더 작은 원본을 선택하거나 앞의 이미지·PDF 도구에서 크기를 조절해 주세요.');
      return;
    }
    const nextTotal = slots.reduce((sum, slot) => sum + (slot.id === id ? 0 : slot.file?.size ?? 0), file.size);
    if (nextTotal > MAX_PACKAGE_TOTAL_BYTES) {
      reportFailure('파일 추가', new Error('선택한 파일을 더하면 전체 용량이 100MB를 넘습니다.'), '불필요한 파일을 제거하거나 작은 파일을 선택해 주세요.');
      return;
    }
    setSlots((current) => current.map((slot) => slot.id === id
      ? { ...slot, file, status: 'checking', inspection: undefined, error: undefined } : slot));
    setFailure(null);
    setNotice('');
    void inspectAssigned(id, file);
  }

  function addMultiple(files: FileList | null): void {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;
    const empty = slots.filter((slot) => !slot.file);
    const needed = Math.max(0, incoming.length - empty.length);
    if (slots.length + needed > MAX_PACKAGE_FILES) {
      reportFailure('여러 파일 추가', new Error('제출 칸은 최대 30개까지 만들 수 있습니다.'), '파일 수를 줄이거나 필요 없는 제출 칸을 지워 주세요.');
      return;
    }
    if (incoming.some((file) => file.size > MAX_PACKAGE_FILE_BYTES)) {
      reportFailure('여러 파일 추가', new Error('30MB를 넘는 파일이 포함되어 있습니다.'), '큰 파일을 제외하고 다시 선택해 주세요.');
      return;
    }
    if (totalBytes + incoming.reduce((sum, file) => sum + file.size, 0) > MAX_PACKAGE_TOTAL_BYTES) {
      reportFailure('여러 파일 추가', new Error('선택한 파일을 더하면 전체 용량이 100MB를 넘습니다.'), '파일 수나 용량을 줄여 다시 선택해 주세요.');
      return;
    }
    const next = [...slots];
    const assignments: Array<{ id: string; file: File }> = [];
    for (const [index, file] of incoming.entries()) {
      const target = empty[index] ?? newSlot(next.length + 1);
      if (!empty[index]) next.push(target);
      const position = next.findIndex((slot) => slot.id === target.id);
      next[position] = { ...target, file, status: 'checking', inspection: undefined, error: undefined };
      assignments.push({ id: target.id, file });
    }
    setSlots(next);
    setFailure(null);
    setNotice('파일을 각 제출 칸에 넣었습니다. 서류 이름과 조건을 확인해 주세요.');
    for (const assignment of assignments) void inspectAssigned(assignment.id, assignment.file);
  }

  function removeFile(id: string): void {
    setSlots((current) => current.map((slot) => slot.id === id
      ? { ...slot, file: null, status: 'empty', inspection: undefined, error: undefined } : slot));
    setNotice('');
  }

  function downloadOne(slot: Slot): void {
    if (!slot.file || issuesBySlot[slot.id].length) {
      reportFailure('개별 파일 다운로드', new Error('이 서류의 확인 항목이 남아 있습니다.'), '서류 칸의 안내를 수정한 뒤 다시 시도해 주세요.');
      return;
    }
    try {
      downloadBlob(slot.file, generatedPackageName(prefix, slot.label, slot.file));
      setFailure(null);
      setNotice('파일 내용을 바꾸지 않고 정리한 이름으로 다운로드를 시작했습니다.');
    } catch (error) {
      reportFailure('개별 파일 다운로드', error, '브라우저의 다운로드 설정을 확인하고 다시 시도해 주세요.');
    }
  }

  async function downloadZip(): Promise<void> {
    if (!canExport) {
      reportFailure('ZIP 다운로드', new Error([...globalIssues, ...slots.flatMap((slot) => issuesBySlot[slot.id])][0] ?? '확인할 항목이 남아 있습니다.'), '아래 제출 칸의 안내를 확인해 주세요.');
      return;
    }
    setBusyZip(true);
    setFailure(null);
    setNotice('ZIP 파일을 만드는 중입니다. 이 화면을 열어 두세요.');
    try {
      const entries: PackageArchiveEntry[] = slots.map((slot) => ({
        label: slot.label.trim(), file: slot.file!, name: generatedPackageName(prefix, slot.label, slot.file!),
        format: slot.inspection!.format, sha256: slot.inspection!.sha256,
      }));
      const archive = await createPackageArchive(title, entries, destination);
      downloadBlob(archive, `${safeNamePart(title, '제출서류')}_제출패키지.zip`);
      setNotice('서류와 체크리스트, manifest.json이 들어 있는 ZIP 다운로드를 시작했습니다.');
    } catch (error) {
      reportFailure('ZIP 다운로드', error, '파일 수나 용량을 줄이고 다시 시도해 주세요. 원본은 변경되지 않았습니다.');
    } finally {
      setBusyZip(false);
    }
  }

  async function saveCase(): Promise<void> {
    if (!onSaveCase) return;
    if (!title.trim()) {
      reportFailure('제출 건 저장', new Error('패키지 이름을 입력해 주세요.'), '이름을 입력하면 미완료 서류도 체크리스트로 저장할 수 있습니다.');
      return;
    }
    if (slots.some((slot) => !slot.label.trim())) {
      reportFailure('제출 건 저장', new Error('이름이 비어 있는 제출 칸이 있습니다.'), '각 제출 칸의 서류 이름을 입력해 주세요.');
      return;
    }
    setBusySave(true);
    setFailure(null);
    try {
      await onSaveCase(title.trim(), slots.map((slot) => ({ id: slot.id, label: slot.label.trim(), done: issuesBySlot[slot.id].length === 0 })), destination.trim());
      setNotice('제출 건과 체크리스트를 저장했습니다. 파일 자체는 서버로 보내지 않았습니다.');
    } catch (error) {
      reportFailure('제출 건 저장', error, '로그인 상태와 네트워크 연결을 확인하고 다시 시도해 주세요. 파일은 브라우저에 그대로 있습니다.');
    } finally {
      setBusySave(false);
    }
  }

  return <section className="panel submission-package" role="tabpanel" aria-label="제출 패키지 만들기">
    <div className="package-head">
      <div><h3 className="panel-title"><FileArchive /> 제출 패키지 만들기</h3><p className="field-help">필수 서류를 칸별로 정리하고 실제 파일 형식·용량·중복을 확인하세요. 준비가 끝나면 이름을 정리한 파일이나 ZIP을 내려받을 수 있습니다.</p></div>
      <span className={`status-pill ${completeCount === slots.length && !globalIssues.length ? '' : 'warning'}`}><FileCheck2 size={14} /> {completeCount}/{slots.length} 준비 완료</span>
    </div>

    <div className="package-settings field-grid">
      <label className="field"><span className="field-label">패키지 이름 <span className="optional">필수</span></span><input className="field-input" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="예: 신입 개발자 지원 서류" /></label>
      <label className="field"><span className="field-label">제출처 <span className="optional">선택</span></span><input className="field-input" value={destination} maxLength={120} onChange={(event) => setDestination(event.target.value)} placeholder="예: OO회사 인사팀" /></label>
      <label className="field"><span className="field-label">정리할 파일명 앞부분</span><input className="field-input" value={prefix} maxLength={48} onChange={(event) => setPrefix(event.target.value)} placeholder="예: 홍길동_지원서류" /></label>
    </div>
    <p className="package-hint"><LockKeyhole size={15} /> 파일은 이 브라우저에서만 확인하고 ZIP으로 만듭니다. 계정에 제출 건을 저장해도 파일 내용과 파일명은 전송하지 않습니다.</p>

    <div className="package-list-head"><div><strong>필수 서류 목록</strong><small>최대 30개 · 파일당 30MB · 전체 100MB</small></div><div className="package-add-actions">
      <label className="button button-ghost package-upload-button"><UploadCloud size={15} /> 여러 파일 넣기<input className="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.pdf,.docx,.xlsx,.pptx,.zip" onChange={(event: ChangeEvent<HTMLInputElement>) => { addMultiple(event.target.files); event.target.value = ''; }} /></label>
      <button className="button button-secondary" type="button" disabled={slots.length >= MAX_PACKAGE_FILES} onClick={() => setSlots((current) => [...current, newSlot(current.length + 1)])}><FilePlus2 size={15} /> 서류 칸 추가</button>
    </div></div>

    <div className="package-slots" aria-live="polite">
      {slots.map((slot, index) => {
        const issues = issuesBySlot[slot.id];
        const ready = slot.file && slot.status === 'ready' && issues.length === 0;
        return <div className={`package-slot ${issues.length ? 'package-slot-warning' : 'package-slot-ready'}`} key={slot.id}
          onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
          onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); if (event.dataTransfer.files.length !== 1) reportFailure('파일 넣기', new Error('한 제출 칸에는 파일 한 개만 넣을 수 있습니다.'), '여러 파일을 넣으려면 위의 여러 파일 넣기를 사용해 주세요.'); else assignFile(slot.id, event.dataTransfer.files[0]); }}>
          <div className="package-slot-top"><span className="package-slot-number">{String(index + 1).padStart(2, '0')}</span><strong>{slot.label.trim() || '서류 이름 없음'}</strong><span className={`status-pill ${issues.length ? 'warning' : ''}`}>{slot.status === 'checking' ? '검사 중' : ready ? <><Check size={13} /> 준비됨</> : '확인 필요'}</span><button type="button" className="icon-button package-remove-slot" aria-label={`${slot.label} 제출 칸 삭제`} disabled={slots.length === 1} onClick={() => setSlots((current) => current.filter((item) => item.id !== slot.id))}><Trash2 size={16} /></button></div>
          <div className="package-slot-fields">
            <label className="field"><span className="field-label">필수 서류 이름</span><input className="field-input" value={slot.label} maxLength={60} onChange={(event) => editSlot(slot.id, { label: event.target.value })} placeholder="예: 이력서" /></label>
            <label className="field"><span className="field-label">허용 형식 <span className="optional">비우면 모두 허용</span></span><input className="field-input" value={slot.allowed} onChange={(event) => editSlot(slot.id, { allowed: event.target.value })} placeholder="예: PDF, DOCX" /></label>
            <label className="field"><span className="field-label">최대 용량 (MB) <span className="optional">선택</span></span><input className="field-input" type="number" min="0.01" max="30" step="0.01" value={slot.maxMB} onChange={(event) => editSlot(slot.id, { maxMB: event.target.value })} placeholder="예: 5" /></label>
          </div>
          <div className="package-file-row"><label className="button button-secondary package-upload-button"><FilePlus2 size={15} /> {slot.file ? '파일 바꾸기' : '파일 선택'}<input className="visually-hidden" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.docx,.xlsx,.pptx,.zip" aria-label={`${slot.label} 파일 선택`} onChange={(event: ChangeEvent<HTMLInputElement>) => { assignFile(slot.id, event.target.files?.[0]); event.target.value = ''; }} /></label>
            {slot.file && <><div className="package-file-meta"><strong title={slot.file.name}>{slot.file.name}</strong><small>{humanBytes(slot.file.size)}{slot.inspection ? ` · 실제 ${slot.inspection.format}` : ''}</small></div><button type="button" className="icon-button" aria-label={`${slot.label} 파일 제거`} onClick={() => removeFile(slot.id)}><X size={15} /></button></>}
            {ready && <button type="button" className="button button-ghost package-single-download" onClick={() => downloadOne(slot)}><Download size={15} /> 개별 저장</button>}
          </div>
          {ready && <p className="package-renamed">저장 이름 <strong>{generatedPackageName(prefix, slot.label, slot.file!)}</strong></p>}
          {issues.length > 0 && <ul className="package-issues">{[...new Set(issues)].map((issue) => <li key={issue}><CircleAlert size={14} /> {issue}</li>)}</ul>}
        </div>;
      })}
    </div>

    {globalIssues.length > 0 && <ul className="package-global-issues">{globalIssues.map((issue) => <li key={issue}><CircleAlert size={15} /> {issue}</li>)}</ul>}
    {failure && <div className="operation-error package-error" role="alert"><div className="operation-error-header"><div><span className="status-pill error"><CircleAlert size={14} /> 작업 실패</span><h3>{failure.task}</h3></div><button type="button" className="icon-button" aria-label="실패 안내 닫기" onClick={() => setFailure(null)}><X size={16} /></button></div><p className="operation-error-detail"><strong>실패한 이유</strong><br />{failure.reason}</p><p><strong>다음에 해볼 방법</strong><br />{failure.advice}</p></div>}
    {notice && <p className="account-notice package-notice" role="status">{notice}</p>}
    <div className="package-footer"><p className="field-help">ZIP에는 서류, 제출-체크리스트.txt, manifest.json이 들어갑니다. 실제 파일 형식과 설정한 조건을 확인하며 악성코드 검사나 제출처 접수 확인은 포함되지 않습니다.</p><div className="package-footer-actions">{onSaveCase && <button type="button" className="button button-secondary" disabled={busySave || busyZip} onClick={() => void saveCase()}><FileCheck2 size={17} /> {busySave ? '저장 중…' : '제출 건에 저장'}</button>}{!onSaveCase && onLoginClick && <button type="button" className="button button-ghost" onClick={onLoginClick}><FileCheck2 size={17} /> 로그인하고 제출 건 저장</button>}<button type="button" className="button button-primary" disabled={!canExport} onClick={() => void downloadZip()}><FileArchive size={17} /> {busyZip ? 'ZIP 만드는 중…' : 'ZIP 다운로드'}</button></div></div>
  </section>;
}
