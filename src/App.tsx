import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUp, Check, CheckCheck, ChevronDown, CircleAlert,
  Download, FileCheck2, FileImage, FilePlus2, FileText, Files, Image as ImageIcon,
  Info, LockKeyhole, RotateCw, ScanLine, Settings2, ShieldCheck, Sparkles,
  Trash2, UploadCloud, WandSparkles, X,
} from 'lucide-react';
import { inspectImage, transformImage } from './lib/imageTools';
import type { ImageFormat } from './lib/imageTools';
import { emptyRules, formatOf, humanBytes, parseRequirements, validateFile } from './lib/rules';
import type { FileDetails, SubmissionRules } from './lib/rules';
import AccountPanel from './AccountPanel';

type Tool = 'check' | 'image' | 'pdf';
type FileKind = 'image' | 'pdf' | 'unsupported';
type PdfAction = 'merge' | 'extract' | 'rotate' | 'imagesToPdf' | 'pdfToImages' | 'compress';
type LoadedFile = {
  id: string;
  file: File;
  kind: FileKind;
  status: 'loading' | 'ready' | 'error';
  details: FileDetails;
  preview?: string;
  error?: string;
};
type Result = {
  blob: Blob;
  name: string;
  title: string;
  sourceBytes?: number;
  dimensions?: string;
  warning?: string;
  preview?: string;
};
type OperationError = { task: string; reason: string; advice: string; retry?: 'select' | 'image' | 'pdf' | 'download' };

const MB = 1024 * 1024;
const KB = 1024;
const MAX_FILES = 50;
const MAX_IMAGE_BYTES = 80 * MB;
const MAX_PDF_BYTES = 100 * MB;
const EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const SCANNED_PDF_COMPRESSION_WARNING = '스캔 PDF 압축은 각 페이지를 이미지로 다시 만듭니다. 선택 가능한 텍스트, 검색 기능, 링크, 입력 양식 및 접근성 정보가 사라질 수 있습니다. 원본을 보관해 주세요.';

function fileKind(file: File): FileKind {
  if (/\.(jpe?g|png|webp)$/i.test(file.name)) return 'image';
  if (/\.pdf$/i.test(file.name)) return 'pdf';
  return 'unsupported';
}

function id() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function suffixName(name: string, suffix: string, extension: string) {
  const stem = name.replace(/\.[^.]+$/, '') || '파일';
  return `${stem}-${suffix}.${extension}`;
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numberValue(n: number | null) {
  return n === null ? '' : String(n);
}

function mbValue(n: number | null) {
  return n === null ? '' : String(Number((n / MB).toFixed(2)));
}

function kbValue(n: number | null) {
  return n === null ? '' : String(Number((n / KB).toFixed(2)));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function withTimeout<T>(work: Promise<T>, milliseconds: number, task: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { onTimeout?.(); reject(new Error(`${task} 시간이 초과되었습니다.`)); }, milliseconds);
    work.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}

function adviceFor(reason: string): string {
  if (/시간이 초과/.test(reason)) return '한 번에 처리하는 파일 수나 페이지 수를 줄여 다시 시도해 주세요. 원본은 변경되지 않았습니다.';
  if (/목표 용량|최소 화질/.test(reason)) return '가로·세로 크기를 조금 더 줄이거나, 목표 용량을 높여 다시 시도해 주세요.';
  if (/메모리|너무 큽니다|최대|이하만/.test(reason)) return '파일 크기나 한 번에 처리하는 페이지·파일 수를 줄여 다시 시도해 주세요.';
  if (/암호|손상|올바른|읽을 수 없|열 수 없/.test(reason)) return '원본 파일이 정상적으로 열리는지 확인하고, 암호를 해제한 파일로 다시 시도해 주세요.';
  if (/페이지 범위|페이지를 입력/.test(reason)) return 'PDF의 실제 페이지 수를 확인하고 1,3-5처럼 다시 입력해 주세요.';
  if (/지원하지 않|지원 불가|브라우저/.test(reason)) return 'JPG·PNG·WebP·PDF 형식을 확인하고 최신 브라우저에서 다시 시도해 주세요.';
  return '입력한 값과 원본 파일을 확인한 뒤 다시 시도해 주세요. 계속 실패하면 다른 파일로 확인해 주세요.';
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultPreviewRef = useRef<string | null>(null);
  const pendingRuleImageRef = useRef<string | null>(null);
  const filesRef = useRef<LoadedFile[]>([]);
  const [tool, setTool] = useState<Tool>('check');
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [operationError, setOperationError] = useState<OperationError | null>(null);
  const [requirementText, setRequirementText] = useState('');
  const [rules, setRules] = useState<SubmissionRules>({ ...emptyRules });
  const [checked, setChecked] = useState(false);
  const [imageWidth, setImageWidth] = useState('');
  const [imageHeight, setImageHeight] = useState('');
  const [lockRatio, setLockRatio] = useState(true);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [imageFormat, setImageFormat] = useState<ImageFormat>('jpeg');
  const [quality, setQuality] = useState(92);
  const [targetKB, setTargetKB] = useState('');
  const [minimumKB, setMinimumKB] = useState('');
  const [pdfAction, setPdfAction] = useState<PdfAction>('merge');
  const [pageRange, setPageRange] = useState('');
  const [rotation, setRotation] = useState(90);
  const [pdfImageFormat, setPdfImageFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [pdfQuality, setPdfQuality] = useState(80);

  filesRef.current = files;
  useEffect(() => () => {
    filesRef.current.forEach((item) => {
      if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    });
    if (resultPreviewRef.current) URL.revokeObjectURL(resultPreviewRef.current);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function unexpected(event: ErrorEvent) {
      if (!(event.error instanceof Error)) return;
      setOperationError({ task: '예상하지 못한 작업 실패', reason: event.error.message || '화면 처리 중 문제가 생겼습니다.', advice: '입력값과 파일을 확인하고 다시 시도해 주세요.' });
    }
    function rejected(event: PromiseRejectionEvent) {
      event.preventDefault();
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? '알 수 없는 오류');
      setOperationError({ task: '작업 실패', reason, advice: adviceFor(reason) });
    }
    window.addEventListener('error', unexpected);
    window.addEventListener('unhandledrejection', rejected);
    return () => { window.removeEventListener('error', unexpected); window.removeEventListener('unhandledrejection', rejected); };
  }, []);

  function reportFailure(task: string, error: unknown, retry?: OperationError['retry']) {
    const reason = error instanceof Error ? error.message : String(error ?? '알 수 없는 오류');
    setOperationError({ task: `${task} 실패`, reason, advice: adviceFor(reason), retry });
  }

  const readyImages = files.filter((item) => item.kind === 'image' && item.status === 'ready');
  const readyPdfs = files.filter((item) => item.kind === 'pdf' && item.status === 'ready');
  const activeImage = readyImages.find((item) => item.id === selectedId) ?? readyImages[0];
  const activePdf = readyPdfs.find((item) => item.id === selectedId) ?? readyPdfs[0];
  const selectedForTool = tool === 'image' ? activeImage : tool === 'pdf' ? activePdf : files.find((item) => item.id === selectedId);
  const ratioMismatch = Boolean(activeImage?.details.width && activeImage.details.height && Number(imageWidth) > 0 && Number(imageHeight) > 0
    && Math.abs(Number(imageWidth) / Number(imageHeight) - activeImage.details.width / activeImage.details.height) > 0.01);
  const totalBytes = files.reduce((total, item) => total + item.file.size, 0);
  const hasRules = rules.formats.length > 0 || Object.entries(rules).some(([key, value]) => key !== 'formats' && value !== null);
  const globalProblems = useMemo(() => {
    const problems: string[] = [];
    if (rules.minEachBytes !== null && rules.maxEachBytes !== null && rules.minEachBytes > rules.maxEachBytes) problems.push(`파일당 최소 ${humanBytes(rules.minEachBytes)}가 최대 ${humanBytes(rules.maxEachBytes)}보다 큽니다. 입력한 기준을 확인해 주세요.`);
    if (rules.maxFiles !== null && files.length > rules.maxFiles) problems.push(`파일 ${files.length}개 · 기준 ${rules.maxFiles}개`);
    if (rules.maxTotalBytes !== null && totalBytes > rules.maxTotalBytes) problems.push(`전체 용량 ${humanBytes(totalBytes)} · 기준 ${humanBytes(rules.maxTotalBytes)}`);
    return problems;
  }, [rules, files.length, totalBytes]);
  const fileProblems = useMemo(() => files.map((item) => ({
    id: item.id,
    errors: item.status === 'error' ? [item.error ?? '파일을 읽을 수 없습니다.'] : item.status === 'loading' ? ['분석 중'] : validateFile(item.file, item.details, rules),
  })), [files, rules]);
  const issueCount = fileProblems.filter((item) => item.errors.length > 0).length + globalProblems.length;

  useEffect(() => {
    if (!activeImage) return;
    setFitMode('contain');
    const fromCheck = pendingRuleImageRef.current === activeImage.id;
    pendingRuleImageRef.current = null;
    setImageWidth(String(fromCheck && rules.width !== null ? rules.width : activeImage.details.width ?? ''));
    setImageHeight(String(fromCheck && rules.height !== null ? rules.height : activeImage.details.height ?? ''));
    const f = formatOf(activeImage.file).toLowerCase();
    const allowed = fromCheck ? rules.formats.find((item) => ['JPG', 'PNG', 'WEBP'].includes(item)) : undefined;
    setImageFormat(allowed ? allowed === 'JPG' ? 'jpeg' : allowed.toLowerCase() as ImageFormat : f === 'jpg' ? 'jpeg' : f === 'png' || f === 'webp' ? f : 'jpeg');
    if (fromCheck) {
      setMinimumKB(kbValue(rules.minEachBytes));
      setTargetKB(rules.maxEachBytes !== null ? String(Math.floor(rules.maxEachBytes / KB)) : '');
    }
  }, [activeImage?.id]);

  function clearResult() {
    setResult(null);
    if (resultPreviewRef.current) {
      URL.revokeObjectURL(resultPreviewRef.current);
      resultPreviewRef.current = null;
    }
  }

  function publishResult(next: Omit<Result, 'preview'>) {
    if (resultPreviewRef.current) URL.revokeObjectURL(resultPreviewRef.current);
    const preview = next.blob.type.startsWith('image/') ? URL.createObjectURL(next.blob) : undefined;
    resultPreviewRef.current = preview ?? null;
    setResult({ ...next, preview });
  }

  async function addFiles(incoming: FileList | File[]) {
    const list = Array.from(incoming);
    if (!list.length) return;
    const slots = Math.max(0, MAX_FILES - filesRef.current.length);
    if (!slots) { setToast(`파일은 한 번에 최대 ${MAX_FILES}개까지 추가할 수 있습니다.`); return; }
    const picked = list.slice(0, slots);
    if (picked.length < list.length) setToast(`최대 ${MAX_FILES}개까지만 추가했습니다.`);
    const newItems: LoadedFile[] = picked.map((file) => ({
      id: id(), file, kind: fileKind(file), status: 'loading', details: {},
    }));
    setFiles((old) => [...old, ...newItems]);
    setSelectedId((old) => old ?? newItems[0]?.id ?? null);
    clearResult();
    setOperationError(null);
    await Promise.all(newItems.map(async (item) => {
      try {
        if (item.kind === 'unsupported') throw new Error('JPG, PNG, WebP, PDF 파일만 지원합니다.');
        if (item.file.size > (item.kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
          throw new Error(item.kind === 'pdf' ? 'PDF는 100MB 이하만 처리할 수 있습니다.' : '이미지는 80MB 이하만 처리할 수 있습니다.');
        }
        if (item.kind === 'image') {
          const info = await withTimeout(inspectImage(item.file), 15_000, '이미지 확인');
          const preview = URL.createObjectURL(item.file);
          setFiles((old) => old.map((candidate) => candidate.id === item.id
            ? { ...candidate, status: 'ready', details: { width: info.width, height: info.height, format: info.format === 'jpeg' ? 'JPG' : info.format.toUpperCase() }, preview } : candidate));
        } else {
          const { inspectPdf } = await import('./lib/pdfTools');
          const info = await withTimeout(inspectPdf(item.file), 40_000, 'PDF 확인');
          setFiles((old) => old.map((candidate) => candidate.id === item.id
            ? { ...candidate, status: 'ready', details: { pages: info.pageCount, format: 'PDF' }, preview: info.thumbnail } : candidate));
        }
      } catch (error) {
        reportFailure(`${item.file.name} 확인`, error, 'select');
        setFiles((old) => old.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: 'error', error: error instanceof Error ? error.message : '파일을 읽을 수 없습니다.' } : candidate));
      }
    }));
  }

  function removeFile(fileId: string) {
    const found = files.find((item) => item.id === fileId);
    if (found?.preview?.startsWith('blob:')) URL.revokeObjectURL(found.preview);
    setFiles((old) => old.filter((item) => item.id !== fileId));
    if (selectedId === fileId) setSelectedId(files.find((item) => item.id !== fileId)?.id ?? null);
    clearResult();
  }

  function clearFiles() {
    files.forEach((item) => { if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview); });
    setFiles([]);
    setSelectedId(null);
    setChecked(false);
    setOperationError(null);
    clearResult();
  }

  function moveFile(fileId: string, direction: -1 | 1) {
    setFiles((old) => {
      const copy = [...old];
      const index = copy.findIndex((item) => item.id === fileId);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= copy.length) return old;
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  function handleDropKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      inputRef.current?.click();
    }
  }

  function updateNumberRule(key: Exclude<keyof SubmissionRules, 'formats'>, value: string, multiplier = 1) {
    const parsed = numberOrNull(value);
    setRules((old) => ({ ...old, [key]: parsed === null ? null : Math.round(parsed * multiplier) }));
    setChecked(false);
  }

  function parseTextRules() {
    if (!requirementText.trim()) { setToast('제출 안내 문구를 먼저 입력해 주세요.'); return; }
    const next = parseRequirements(requirementText);
    setRules(next);
    setChecked(false);
    setToast('읽어낸 조건을 아래 입력칸에서 확인하고 필요하면 수정해 주세요.');
  }

  function applyImageRule(item: LoadedFile) {
    pendingRuleImageRef.current = item.id;
    setSelectedId(item.id);
    setTool('image');
    if (rules.width !== null) setImageWidth(String(rules.width));
    if (rules.height !== null) setImageHeight(String(rules.height));
    if (rules.maxEachBytes !== null) setTargetKB(String(Math.floor(rules.maxEachBytes / KB)));
    setMinimumKB(kbValue(rules.minEachBytes));
    setFitMode('contain');
    const allowed = rules.formats.find((f) => ['JPG', 'PNG', 'WEBP'].includes(f));
    if (allowed) setImageFormat(allowed === 'JPG' ? 'jpeg' : allowed.toLowerCase() as ImageFormat);
    clearResult();
  }

  function changeWidth(value: string) {
    setImageWidth(value);
    if (lockRatio && activeImage?.details.width && activeImage.details.height) {
      const n = Number(value);
      setImageHeight(Number.isFinite(n) && n > 0 ? String(Math.round(n * activeImage.details.height / activeImage.details.width)) : '');
    }
  }

  function changeHeight(value: string) {
    setImageHeight(value);
    if (lockRatio && activeImage?.details.width && activeImage.details.height) {
      const n = Number(value);
      setImageWidth(Number.isFinite(n) && n > 0 ? String(Math.round(n * activeImage.details.width / activeImage.details.height)) : '');
    }
  }

  async function processImage() {
    if (!activeImage) { reportFailure('사진 변환', new Error('이미지를 먼저 추가해 주세요.'), 'select'); return; }
    const width = Number(imageWidth);
    const height = Number(imageHeight);
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      reportFailure('사진 변환', new Error('가로와 세로 크기를 1px 이상으로 입력해 주세요.'), 'image'); return;
    }
    const target = targetKB.trim() ? Number(targetKB) : undefined;
    const minimum = minimumKB.trim() ? Number(minimumKB) : undefined;
    if (target !== undefined && (!Number.isFinite(target) || target < 1)) { reportFailure('사진 변환', new Error('최대 용량은 1KB 이상으로 입력해 주세요.'), 'image'); return; }
    if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 1)) { reportFailure('사진 변환', new Error('최소 용량은 1KB 이상으로 입력해 주세요.'), 'image'); return; }
    if (target !== undefined && minimum !== undefined && minimum > target) { reportFailure('사진 변환', new Error('최소 용량은 최대 용량보다 클 수 없습니다.'), 'image'); return; }
    setBusy(true); clearResult(); setOperationError(null);
    try {
      const controller = new AbortController();
      const converted = await withTimeout(transformImage(activeImage.file, {
        width, height, format: imageFormat, quality: quality / 100,
        fit: fitMode,
        minQuality: 0.72,
        targetBytes: target === undefined ? undefined : Math.round(target * KB),
        minBytes: minimum === undefined ? undefined : Math.round(minimum * KB),
        signal: controller.signal,
      }), 90_000, '사진 변환', () => controller.abort());
      if (converted.targetBytesMet === false) {
        const reason = `결과가 ${humanBytes(converted.blob.size)}여서 최대 ${humanBytes(Math.round(target! * KB))}를 넘었습니다.`;
        setOperationError({ task: '최대 용량 맞추기 실패', reason, advice: minimum === undefined ? '사진 크기를 조금 줄이거나 최대 용량을 높여 다시 시도해 주세요.' : '설정한 최소·최대 용량 범위를 넓히거나 사진 크기를 조정해 주세요.', retry: 'image' });
        return;
      }
      if (converted.minBytesMet === false) {
        const reason = `${imageFormat === 'png' ? 'PNG 저장 결과' : '화질을 높인 결과'}가 ${humanBytes(converted.blob.size)}여서 최소 ${humanBytes(Math.round(minimum! * KB))}에 도달하지 못했습니다.`;
        setOperationError({ task: '최소 용량 맞추기 실패', reason, advice: '최소 용량을 낮추거나 사진 크기를 키워 다시 시도해 주세요. 없는 화질을 만들어 내거나 무의미한 데이터를 붙이지는 않습니다.', retry: 'image' });
        return;
      }
      const warning = [
        converted.warning,
        converted.blob.size > activeImage.file.size
          && width * height <= (activeImage.details.width ?? width) * (activeImage.details.height ?? height)
          ? '출력 파일이 원본보다 큽니다. 저장 형식이나 화질을 바꾸면 더 작게 만들 수 있습니다.' : undefined,
      ].filter(Boolean).join(' ');
      publishResult({
        blob: converted.blob,
        name: suffixName(activeImage.file.name, 'filefit', EXT[converted.format]),
        title: '이미지 변환이 끝났어요',
        sourceBytes: activeImage.file.size,
        dimensions: `${converted.width} × ${converted.height}px`,
        warning,
      });
    } catch (error) { reportFailure('사진 변환', error, 'image'); }
    finally { setBusy(false); }
  }

  async function processPdf() {
    setBusy(true); clearResult(); setOperationError(null);
    try {
      const { compressScannedPdf, imagesToPdf, mergePdfs, pdfToImages, rotatePdf, splitPdf } = await import('./lib/pdfTools');
      let blob: Blob;
      let name: string;
      let title: string;
      let sourceBytes: number | undefined;
      let warning: string | undefined;
      if (pdfAction === 'merge') {
        if (readyPdfs.length < 2) throw new Error('PDF를 두 개 이상 추가해 주세요.');
        blob = await withTimeout(mergePdfs(readyPdfs.map((item) => item.file)), 120_000, 'PDF 병합');
        name = 'filefit-merged.pdf'; title = 'PDF를 합쳤어요';
        sourceBytes = readyPdfs.reduce((sum, item) => sum + item.file.size, 0);
      } else if (pdfAction === 'imagesToPdf') {
        if (!readyImages.length) throw new Error('이미지를 한 장 이상 추가해 주세요.');
        blob = await withTimeout(imagesToPdf(readyImages.map((item) => item.file)), 120_000, '사진을 PDF로 변환');
        name = 'filefit-images.pdf'; title = '이미지를 PDF로 만들었어요';
        sourceBytes = readyImages.reduce((sum, item) => sum + item.file.size, 0);
      } else {
        if (!activePdf) throw new Error('PDF 파일을 먼저 추가해 주세요.');
        sourceBytes = activePdf.file.size;
        if (pdfAction === 'extract') {
          if (!pageRange.trim()) throw new Error('추출할 페이지를 입력해 주세요. 예: 1,3-5');
          blob = await withTimeout(splitPdf(activePdf.file, pageRange), 120_000, 'PDF 페이지 추출');
          name = suffixName(activePdf.file.name, 'pages', 'pdf'); title = '선택한 페이지를 추출했어요';
        } else if (pdfAction === 'rotate') {
          blob = await withTimeout(rotatePdf(activePdf.file, rotation, pageRange), 120_000, 'PDF 페이지 회전');
          name = suffixName(activePdf.file.name, 'rotated', 'pdf'); title = 'PDF 페이지를 회전했어요';
        } else if (pdfAction === 'pdfToImages') {
          const images = await withTimeout(pdfToImages(activePdf.file, pageRange, { format: pdfImageFormat, quality: pdfQuality / 100 }), 120_000, 'PDF 이미지 변환');
          if (images.length === 1) {
            blob = images[0].blob; name = images[0].name;
          } else {
            const JSZip = (await import('jszip')).default;
            const zip = new JSZip();
            images.forEach((item) => zip.file(item.name, item.blob));
            blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            name = suffixName(activePdf.file.name, 'images', 'zip');
          }
          title = images.length === 1 ? 'PDF를 이미지로 만들었어요' : `${images.length}장의 이미지를 만들었어요`;
        } else {
          const compressed = await withTimeout(compressScannedPdf(activePdf.file, { quality: Math.min(95, pdfQuality) / 100 }), 120_000, '스캔 PDF 압축');
          blob = compressed.blob;
          name = suffixName(activePdf.file.name, 'scanned-small', 'pdf'); title = '스캔 PDF 처리가 끝났어요';
          warning = compressed.warning;
          if (blob.size >= activePdf.file.size) {
            setOperationError({ task: '스캔 PDF 압축 실패', reason: `처리 결과 ${humanBytes(blob.size)}가 원본 ${humanBytes(activePdf.file.size)}보다 작지 않습니다.`, advice: '화질을 낮춰 다시 시도하거나, 원본 PDF를 그대로 사용해 주세요. 원본은 변경되지 않았습니다.', retry: 'pdf' });
            return;
          }
        }
      }
      publishResult({ blob, name, title, sourceBytes, warning });
    } catch (error) { reportFailure('PDF 작업', error, 'pdf'); }
    finally { setBusy(false); }
  }

  function chooseTool(next: Tool) {
    setTool(next); clearResult(); setOperationError(null);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="파일핏 처음으로">파일핏<span className="brand-dot">.</span></a>
        <nav className="nav-tabs" aria-label="주요 기능">
          <button className="nav-tab" aria-current={tool === 'check' ? 'page' : undefined} onClick={() => chooseTool('check')}>조건 점검</button>
          <button className="nav-tab" aria-current={tool === 'image' ? 'page' : undefined} onClick={() => chooseTool('image')}>이미지</button>
          <button className="nav-tab" aria-current={tool === 'pdf' ? 'page' : undefined} onClick={() => chooseTool('pdf')}>PDF</button>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="eyebrow">제출 전 마지막 확인, 한곳에서</span>
            <h1 id="hero-title" className="hero-title">서류 제출 준비,<br /><strong>파일핏</strong>으로 가볍게.</h1>
            <p className="hero-sub">파일 형식과 용량을 확인하고, 사진·PDF를 필요한 크기로 정리하세요. 복잡한 설치 없이 브라우저에서 바로 시작할 수 있어요.</p>
            <div className="hero-points"><span><Check size={15} /> 가입 없이 사용</span><span><LockKeyhole size={15} /> 파일은 내 기기에서 처리</span></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-sheet hero-sheet-back"><span className="mini-icon"><FileImage size={25} /></span><i /><i /><i /></div>
            <div className="hero-sheet hero-sheet-front"><span className="mini-icon"><FileText size={27} /></span><i /><i /><i /><div className="hero-sheet-footer"><span>제출 준비 완료</span><span className="hero-progress" /></div></div>
          </div>
        </section>

        <div className="main-grid">
          <section className="workbench" id="workbench" aria-label="파일 작업 공간">
            <div className="section-head">
              <div><h2>무엇을 도와드릴까요?</h2><p>파일을 추가한 뒤 필요한 작업을 선택하세요.</p></div>
              <span className="status-pill"><ShieldCheck size={14} /> 브라우저 내 처리</span>
            </div>
            <div className="tool-tabs" role="tablist" aria-label="작업 선택">
              <button className="tool-tab" role="tab" aria-selected={tool === 'check'} onClick={() => chooseTool('check')}><FileCheck2 size={17} /> 제출 조건 점검</button>
              <button className="tool-tab" role="tab" aria-selected={tool === 'image'} onClick={() => chooseTool('image')}><ImageIcon size={17} /> 이미지 다듬기</button>
              <button className="tool-tab" role="tab" aria-selected={tool === 'pdf'} onClick={() => chooseTool('pdf')}><Files size={17} /> PDF 정리</button>
            </div>

            <div className={`dropzone ${dragging ? 'dropzone-active' : ''}`} onDrop={handleDrop} onDragOver={(event) => event.preventDefault()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onKeyDown={handleDropKey} role="button" tabIndex={0} aria-label="파일 선택 또는 여기로 끌어 놓기">
              <UploadCloud aria-hidden="true" />
              <strong>파일을 이곳에 놓거나 선택하세요</strong>
              <p>JPG, PNG, WebP, PDF · 이미지 최대 80MB · PDF 최대 100MB</p>
              <button className="button button-secondary drop-button" type="button" onClick={() => inputRef.current?.click()}><FilePlus2 size={16} /> 파일 선택</button>
              <input ref={inputRef} className="visually-hidden" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { void addFiles(event.target.files ?? []); event.target.value = ''; }} />
            </div>

            {files.length > 0 && <div className="files-heading"><strong>추가한 파일 <span>{files.length}</span></strong><button className="text-button" onClick={clearFiles}><Trash2 size={14} /> 모두 지우기</button></div>}
            {files.length > 0 && <div className="file-list" aria-live="polite">
              {files.map((item, index) => <div className={`file-row ${selectedForTool?.id === item.id && tool !== 'check' ? 'file-row-selected' : ''}`} key={item.id}>
                <span className={`file-icon ${item.kind === 'pdf' ? 'file-icon-pdf' : ''}`}>{item.kind === 'pdf' ? 'PDF' : item.kind === 'image' ? formatOf(item.file) : '?'}</span>
                <div className="file-meta"><strong title={item.file.name}>{item.file.name}</strong><small>{humanBytes(item.file.size)}{item.status === 'ready' && item.details.width ? ` · ${item.details.width} × ${item.details.height}px` : ''}{item.status === 'ready' && item.details.pages ? ` · ${item.details.pages}페이지` : ''}{item.status === 'loading' ? ' · 확인 중…' : ''}{item.status === 'error' ? ` · ${item.error}` : ''}</small></div>
                <div className="file-actions">
                  {tool === 'pdf' && (pdfAction === 'merge' || pdfAction === 'imagesToPdf') && <><button className="icon-button" aria-label={`${item.file.name} 위로`} title="위로" disabled={index === 0} onClick={() => moveFile(item.id, -1)}><ArrowUp size={15} /></button><button className="icon-button" aria-label={`${item.file.name} 아래로`} title="아래로" disabled={index === files.length - 1} onClick={() => moveFile(item.id, 1)}><ArrowDown size={15} /></button></>}
                  {tool !== 'check' && item.status === 'ready' && (tool === 'image' ? item.kind === 'image' : item.kind === 'pdf') && <button className="mini-select" aria-pressed={selectedForTool?.id === item.id} onClick={() => { setSelectedId(item.id); clearResult(); }}>{selectedForTool?.id === item.id ? '선택됨' : '선택'}</button>}
                  <button className="icon-button" aria-label={`${item.file.name} 삭제`} title="삭제" onClick={() => removeFile(item.id)}><X size={16} /></button>
                </div>
              </div>)}
            </div>}

            {operationError && <section className="operation-error" role="alert" aria-live="assertive">
              <div className="operation-error-header"><div><span className="status-pill error"><CircleAlert size={14} /> 작업 실패</span><h3>{operationError.task}</h3></div><button className="icon-button" aria-label="실패 안내 닫기" onClick={() => setOperationError(null)}><X size={17} /></button></div>
              <p className="operation-error-detail"><strong>실패한 이유</strong><br />{operationError.reason}</p>
              <p><strong>다음에 해볼 방법</strong><br />{operationError.advice}</p>
              <div className="operation-error-actions">{operationError.retry && <button className="button button-ghost" onClick={() => { const retry = operationError.retry; setOperationError(null); if (retry === 'image') void processImage(); else if (retry === 'pdf') void processPdf(); else if (retry === 'download' && result) { try { downloadBlob(result.blob, result.name); } catch (error) { reportFailure('파일 다운로드', error, 'download'); } } else inputRef.current?.click(); }}>{operationError.retry === 'select' ? '다른 파일 선택' : operationError.retry === 'download' ? '다시 다운로드' : '다시 시도'}</button>}<button className="text-button" onClick={() => setOperationError(null)}>안내 닫기</button></div>
            </section>}

            {tool === 'check' && <section className="panel" role="tabpanel" aria-label="제출 조건 점검">
              <h3 className="panel-title"><ScanLine /> 제출 안내 문구를 입력하세요</h3>
              <p className="field-help">공고의 파일 조건을 붙여 넣으면 형식·용량·크기 등 일부 조건을 자동으로 채워요. 읽어낸 값은 직접 확인해 주세요.</p>
              <textarea value={requirementText} onChange={(event) => setRequirementText(event.target.value)} placeholder="예: JPG 또는 PNG, 파일당 5MB 이하, 총 10MB 이하, 최대 3개, 가로 1200 × 세로 1600px" aria-label="제출 안내 문구" />
              <div className="action-row"><button className="button button-secondary" onClick={parseTextRules}><WandSparkles /> 문구에서 조건 읽기</button><button className="text-button" onClick={() => { setRequirementText('JPG 또는 PNG, 파일당 5MB 이하, 최대 3개, 가로 1200 × 세로 1600px'); setRules(parseRequirements('JPG 또는 PNG, 파일당 5MB 이하, 최대 3개, 가로 1200 × 세로 1600px')); setChecked(false); }}>예시 적용</button></div>
              <div className="section-divider" />
              <h3 className="panel-title"><Settings2 /> 제출 기준</h3>
              <div className="field-grid">
                <label className="field"><span className="field-label">허용 형식</span><input className="field-input" type="text" value={rules.formats.join(', ')} onChange={(event) => { setRules((old) => ({ ...old, formats: [...new Set(event.target.value.toUpperCase().split(/[\s,，/]+/).filter(Boolean).map((f) => f === 'JPEG' ? 'JPG' : f))] })); setChecked(false); }} placeholder="예: JPG, PNG, PDF" /></label>
                <label className="field"><span className="field-label">파일당 최대 용량 (MB)</span><input className="field-input" type="number" min="0.01" step="0.01" value={mbValue(rules.maxEachBytes)} onChange={(event) => updateNumberRule('maxEachBytes', event.target.value, MB)} placeholder="예: 5" /></label>
                <label className="field"><span className="field-label">파일당 최소 용량 (KB)</span><input className="field-input" type="number" min="1" step="1" value={kbValue(rules.minEachBytes)} onChange={(event) => updateNumberRule('minEachBytes', event.target.value, KB)} placeholder="선택 사항" /></label>
                <label className="field"><span className="field-label">전체 최대 용량 (MB)</span><input className="field-input" type="number" min="0.01" step="0.01" value={mbValue(rules.maxTotalBytes)} onChange={(event) => updateNumberRule('maxTotalBytes', event.target.value, MB)} placeholder="선택 사항" /></label>
                <label className="field"><span className="field-label">최대 파일 수 (개)</span><input className="field-input" type="number" min="1" step="1" value={numberValue(rules.maxFiles)} onChange={(event) => updateNumberRule('maxFiles', event.target.value)} placeholder="선택 사항" /></label>
                <label className="field"><span className="field-label">최대 PDF 페이지 (쪽)</span><input className="field-input" type="number" min="1" step="1" value={numberValue(rules.maxPages)} onChange={(event) => updateNumberRule('maxPages', event.target.value)} placeholder="선택 사항" /></label>
                <div className="dimension-fields"><label className="field"><span className="field-label">사진 가로 (px)</span><input className="field-input" type="number" min="1" value={numberValue(rules.width)} onChange={(event) => updateNumberRule('width', event.target.value)} placeholder="선택 사항" /></label><label className="field"><span className="field-label">사진 세로 (px)</span><input className="field-input" type="number" min="1" value={numberValue(rules.height)} onChange={(event) => updateNumberRule('height', event.target.value)} placeholder="선택 사항" /></label></div>
              </div>
              <div className="action-row action-row-end"><button className="button button-primary" disabled={!files.length || !hasRules || files.some((item) => item.status === 'loading')} onClick={() => setChecked(true)}><CheckCheck /> 파일 검사하기 <ArrowRight /></button></div>
              {!hasRules && <p className="field-help muted-note">제출 기준을 하나 이상 입력하면 검사를 시작할 수 있어요.</p>}
            </section>}

            {tool === 'check' && <AccountPanel rules={rules} onApply={(savedRules, title) => { setRules(savedRules); setChecked(false); setToast(`「${title}」 제출 기준을 적용했습니다.`); }} onFailure={(task, error, advice) => { setOperationError({ task: `${task} 실패`, reason: error instanceof Error ? error.message : String(error ?? '알 수 없는 오류'), advice }); window.requestAnimationFrame(() => document.querySelector('.operation-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }} />}

            {tool === 'check' && checked && <section className="result-card" aria-live="polite">
              <div className="result-header"><div><span className={`status-pill ${issueCount ? 'warning' : ''}`}>{issueCount ? <CircleAlert size={14} /> : <Check size={14} />}{issueCount ? `${issueCount}개 항목 확인 필요` : '조건에 맞아요'}</span><h3>{issueCount ? '제출 전 수정할 항목이 있어요' : '지금 설정한 기준을 통과했어요'}</h3></div></div>
              {globalProblems.map((problem) => <div className="check-item" key={problem}><span className="status-pill error">전체</span><span>{problem}</span></div>)}
              {files.map((item) => { const problems = fileProblems.find((row) => row.id === item.id)?.errors ?? []; return <div className="check-item" key={item.id}><span className={`status-pill ${problems.length ? 'error' : ''}`}>{problems.length ? '확인 필요' : '통과'}</span><div><strong>{item.file.name}</strong><small>{problems.length ? problems.join(' · ') : '입력한 기준에 맞습니다.'}</small></div>{problems.length > 0 && item.kind === 'image' && item.status === 'ready' && <button className="text-button" onClick={() => applyImageRule(item)}>이미지 수정 <ArrowRight size={14} /></button>}</div>; })}
              <p className="field-help muted-note">사이트에서 설정한 기준만 검사합니다. 제출처의 세부 안내와 최종 업로드 결과도 확인해 주세요.</p>
            </section>}

            {tool === 'image' && <section className="panel" role="tabpanel" aria-label="이미지 다듬기">
              <h3 className="panel-title"><ImageIcon /> 사진 크기와 용량 조절</h3>
              {!activeImage ? <div className="empty-state"><span>사진을 추가하면 크기 조절과 형식 변환을 시작할 수 있어요.</span></div> : <>
                <div className="image-workspace"><div className="source-preview"><img src={activeImage.preview} alt="원본 사진 미리보기" /><span>원본 · {humanBytes(activeImage.file.size)}</span></div><div className="source-stats"><span className="status-pill">선택한 사진</span><strong>{activeImage.file.name}</strong><small>{activeImage.details.width} × {activeImage.details.height}px · {formatOf(activeImage.file)}</small><p>비율을 유지하면 얼굴과 글자가 찌그러지지 않아요. 작은 사진을 크게 만들 때는 새 디테일이 생기지 않습니다.</p></div></div>
                <div className="section-divider" />
                <div className="field-grid"><label className="field"><span className="field-label">가로 (px)</span><input className="field-input" type="number" min="1" max="16000" value={imageWidth} onChange={(event) => changeWidth(event.target.value)} /></label><label className="field"><span className="field-label">세로 (px)</span><input className="field-input" type="number" min="1" max="16000" value={imageHeight} onChange={(event) => changeHeight(event.target.value)} /></label></div>
                <label className="simple-check"><input type="checkbox" checked={lockRatio} onChange={(event) => setLockRatio(event.target.checked)} /> 원본 비율 유지 <LockKeyhole size={14} /></label>
                {ratioMismatch && <><div className="notice"><Info /> 원본과 입력한 가로·세로 비율이 달라요. 사진을 늘여 찌그러뜨리지 않고 아래 방식으로 맞춥니다.</div><div className="field image-fit-field"><span className="field-label">사진 맞춤 방식</span><div className="segmented"><button className="segmented-button" aria-pressed={fitMode === 'contain'} onClick={() => setFitMode('contain')}>전체 보존 · 여백</button><button className="segmented-button" aria-pressed={fitMode === 'cover'} onClick={() => setFitMode('cover')}>화면 가득 · 가장자리 자름</button></div></div></>}
                <div className="field-grid"><label className="field"><span className="field-label">저장 형식</span><select className="select" value={imageFormat} onChange={(event) => setImageFormat(event.target.value as ImageFormat)}><option value="jpeg">JPG · 제출처 호환성 높음</option><option value="png">PNG · 투명 배경 유지</option><option value="webp">WebP · 더 작은 용량</option></select></label><label className="field"><span className="field-label">최대 용량 (KB) <span className="optional">선택</span></span><input className="field-input" type="number" min="1" step="1" value={targetKB} onChange={(event) => setTargetKB(event.target.value)} placeholder="예: 500" /></label></div>
                <label className="field"><span className="field-label">최소 용량 (KB) <span className="optional">선택 · 용량 늘리기</span></span><input className="field-input" type="number" min="1" step="1" value={minimumKB} onChange={(event) => setMinimumKB(event.target.value)} placeholder="예: 100" /></label>
                <div className="quality-row"><label htmlFor="quality">화질 우선값 <strong>{quality}%</strong></label><input id="quality" type="range" min="72" max="100" value={quality} disabled={imageFormat === 'png'} onChange={(event) => setQuality(Number(event.target.value))} /><div className="quality-labels"><span>용량 작게</span><span>화질 선명하게</span></div></div>
                <div className="notice"><Info /> {imageFormat === 'png' ? 'PNG는 화질 슬라이더로 용량을 조절할 수 없어 결과 용량을 검사합니다. 목표를 맞추려면 픽셀 크기나 형식을 바꿔 주세요.' : '사진은 고품질로 크기를 바꾸고, 최대·최소 용량을 입력하면 화질을 조정합니다. 범위를 맞출 수 없으면 이유를 알려드려요.'}</div>
                <div className="action-row action-row-end"><button className="button button-primary" disabled={busy} onClick={() => void processImage()}>{busy ? <span className="spinner" /> : <Sparkles />} {busy ? '처리 중…' : '사진 변환하기'} <ArrowRight /></button></div>
              </>}
            </section>}

            {tool === 'pdf' && <section className="panel" role="tabpanel" aria-label="PDF 정리">
              <h3 className="panel-title"><FileText /> PDF에 필요한 작업 선택</h3>
              <div className="pdf-actions">
                {([
                  ['merge', 'PDF 합치기', Files], ['extract', '페이지 추출', FileText], ['rotate', '페이지 회전', RotateCw],
                  ['imagesToPdf', '사진 → PDF', FileImage], ['pdfToImages', 'PDF → 사진', ImageIcon], ['compress', '스캔 PDF 압축', ScanLine],
                ] as const).map(([value, label, Icon]) => <button key={value} className={`pdf-action ${pdfAction === value ? 'active' : ''}`} aria-pressed={pdfAction === value} onClick={() => { setPdfAction(value); clearResult(); }}><Icon size={19} /><span>{label}</span></button>)}
              </div>
              <div className="section-divider" />
              {(pdfAction === 'merge' || pdfAction === 'imagesToPdf') ? <p className="field-help">위 파일 목록의 순서대로 {pdfAction === 'merge' ? 'PDF를 합칩니다. PDF 2개 이상이 필요해요.' : '사진을 한 장씩 A4 페이지에 넣습니다.'} 화살표로 순서를 바꿀 수 있어요.</p> : <>
                <label className="field"><span className="field-label">작업할 PDF</span><select className="select" value={activePdf?.id ?? ''} onChange={(event) => { setSelectedId(event.target.value); clearResult(); }}><option value="" disabled>PDF를 추가해 주세요</option>{readyPdfs.map((item) => <option key={item.id} value={item.id}>{item.file.name} · {item.details.pages}페이지</option>)}</select></label>
                {activePdf?.preview && <div className="pdf-selected"><img src={activePdf.preview} alt="선택한 PDF 첫 페이지 미리보기" /><div><strong>{activePdf.file.name}</strong><small>{activePdf.details.pages}페이지 · {humanBytes(activePdf.file.size)}</small></div></div>}
              </>}
              {['extract', 'rotate', 'pdfToImages'].includes(pdfAction) && <label className="field"><span className="field-label">페이지 범위 {pdfAction === 'extract' ? '' : <span className="optional">빈칸이면 전체</span>}</span><input className="field-input" value={pageRange} onChange={(event) => setPageRange(event.target.value)} placeholder="예: 1,3-5" /><small className="field-help">쉼표와 하이픈으로 지정해요. 1,3-5 → 1·3·4·5페이지</small></label>}
              {pdfAction === 'rotate' && <label className="field"><span className="field-label">시계 방향 회전</span><select className="select" value={rotation} onChange={(event) => setRotation(Number(event.target.value))}><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option></select></label>}
              {pdfAction === 'pdfToImages' && <div className="field-grid"><label className="field"><span className="field-label">이미지 형식</span><select className="select" value={pdfImageFormat} onChange={(event) => setPdfImageFormat(event.target.value as 'jpeg' | 'png')}><option value="jpeg">JPG</option><option value="png">PNG</option></select></label><label className="field"><span className="field-label">JPG 화질: {pdfQuality}%</span><input type="range" min="50" max="95" value={pdfQuality} disabled={pdfImageFormat === 'png'} onChange={(event) => setPdfQuality(Number(event.target.value))} /></label></div>}
              {pdfAction === 'compress' && <><div className="notice warning-notice"><CircleAlert /> {SCANNED_PDF_COMPRESSION_WARNING}</div><label className="field"><span className="field-label">압축 화질: {Math.min(95, pdfQuality)}%</span><input type="range" min="40" max="90" value={Math.min(90, pdfQuality)} onChange={(event) => setPdfQuality(Number(event.target.value))} /></label></>}
              <div className="action-row action-row-end"><button className="button button-primary" disabled={busy || (pdfAction === 'imagesToPdf' ? !readyImages.length : pdfAction === 'merge' ? readyPdfs.length < 2 : !activePdf)} onClick={() => void processPdf()}>{busy ? <span className="spinner" /> : <Sparkles />} {busy ? '처리 중…' : '작업 시작하기'} <ArrowRight /></button></div>
            </section>}

            {result && tool !== 'check' && <section className="result-card" aria-live="polite"><div className="result-header"><div><span className="status-pill"><Check size={14} /> 완료</span><h3>{result.title}</h3><p>결과를 확인하고 파일을 저장하세요.</p></div><button className="icon-button" aria-label="결과 닫기" onClick={clearResult}><X size={18} /></button></div>
              {result.preview && <div className="result-preview"><img src={result.preview} alt="변환 결과 미리보기" /></div>}
              <div className="stat-grid"><div className="stat"><small>원본 용량</small><strong>{result.sourceBytes === undefined ? '—' : humanBytes(result.sourceBytes)}</strong></div><div className="stat"><small>결과 용량</small><strong>{humanBytes(result.blob.size)}</strong></div>{result.dimensions && <div className="stat"><small>결과 크기</small><strong>{result.dimensions}</strong></div>}</div>
              {result.warning && <div className="notice warning-notice"><CircleAlert /> {result.warning}</div>}
              <div className="action-row action-row-end"><button className="button button-primary" onClick={() => { try { downloadBlob(result.blob, result.name); } catch (error) { reportFailure('파일 다운로드', error, 'download'); } }}><Download /> 결과 다운로드</button></div>
            </section>}
          </section>

          <aside className="side-panel" aria-label="서비스 안내">
            <div className="side-icon"><ShieldCheck size={24} /></div><h2>안심하고 준비하세요</h2><p>선택한 파일은 변환과 점검을 위해 브라우저 안에서 처리됩니다. 서버로 업로드하지 않아요.</p>
            <ul className="feature-list"><li>제출 조건과 파일 상태를 한눈에 확인</li><li>사진 크기·형식·용량을 필요한 만큼 조절</li><li>PDF 합치기·추출·회전·이미지 변환</li><li>회원가입이나 별도 프로그램 설치 없이 사용</li></ul>
            <div className="side-tip"><span><Sparkles size={16} /> 작은 팁</span><p>제출처가 JPG만 허용한다면 사진 변환에서 저장 형식을 JPG로 고르세요. 변환 후 다시 조건 점검을 해보면 좋아요.</p></div>
          </aside>
        </div>

        <section className="how-section" aria-label="이용 방법"><div className="section-head"><div><h2>세 단계면 준비 끝</h2><p>처음 사용해도 순서대로 따라오면 돼요.</p></div></div><div className="step-grid"><div><span>01</span><UploadCloud size={23} /><h3>파일 추가</h3><p>제출할 사진이나 PDF를 선택하세요.</p></div><div><span>02</span><ChevronDown size={23} /><h3>조건 선택</h3><p>안내 문구를 붙여 넣거나 직접 입력하세요.</p></div><div><span>03</span><Download size={23} /><h3>확인하고 저장</h3><p>필요한 부분을 고쳐 결과를 내려받으세요.</p></div></div></section>
      </main>
      <footer className="footer"><span>© {new Date().getFullYear()} 파일핏 · 서류 준비를 더 간단하게</span><span>파일은 브라우저에서만 처리 · PDF와 이미지 원본은 본인이 보관해 주세요</span></footer>
      {toast && <div className="toast" role="alert"><CircleAlert size={17} /> {toast}<button aria-label="알림 닫기" onClick={() => setToast('')}><X size={15} /></button></div>}
    </div>
  );
}

export default App;
