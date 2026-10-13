import { degrees, PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_RASTER_PAGES = 60;
const MAX_IMAGES = 50;
const MAX_CANVAS_PIXELS = 16_000_000;
const PDF_LOAD_TIMEOUT_MS = 15_000;
const PDF_RENDER_TIMEOUT_MS = 20_000;
const PDF_CLEANUP_TIMEOUT_MS = 750;
const PDF_INSPECTION_TIMEOUT_MS = 35_000;

class PdfEngineTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfEngineTimeout';
  }
}

function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new PdfEngineTimeout(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;

async function disposeLoadingTask(task: PdfLoadingTask): Promise<void> {
  try {
    // In PDF.js 6, destroy() itself waits for worker setup and can hang when
    // the worker never announces readiness.
    await within(task.destroy(), PDF_CLEANUP_TIMEOUT_MS, 'PDF 워커를 종료할 수 없습니다.');
  } catch {
    // Best-effort emergency termination of PDF.js's internally owned worker.
    // This branch is only reached after its public destroy() stops responding.
    try {
      (task as unknown as { _worker?: { destroy(): void } })._worker?.destroy();
    } catch {
      // A failed cleanup should never keep the user interface waiting.
    }
  }
}

let fakeWorkerReady: Promise<void> | undefined;

function enableMainThreadPdfWorker(): Promise<void> {
  fakeWorkerReady ??= within(
    import(/* @vite-ignore */ workerUrl).then(() => {
      if (!(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker) {
        throw new Error('PDF 렌더러를 불러올 수 없습니다.');
      }
    }),
    PDF_LOAD_TIMEOUT_MS,
    'PDF 렌더러를 불러오는 데 시간이 너무 오래 걸립니다.',
  );
  return fakeWorkerReady;
}

export const SCANNED_PDF_COMPRESSION_WARNING =
  '스캔 PDF 압축은 각 페이지를 이미지로 다시 만듭니다. 선택 가능한 텍스트, 검색 기능, 링크, 입력 양식 및 접근성 정보가 사라질 수 있습니다. 원본을 보관해 주세요.';

export interface PdfInspection {
  pageCount: number;
  thumbnail: string;
  width: number;
  height: number;
}

export interface PdfImage {
  pageNumber: number;
  name: string;
  blob: Blob;
}

export interface PdfToImagesOptions {
  scale?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface ScannedPdfCompressionOptions {
  scale?: number;
  quality?: number;
}

export interface ScannedPdfCompressionResult {
  blob: Blob;
  originalBytes: number;
  outputBytes: number;
  warning: string;
}

function assertPdf(file: File): void {
  if (!file || file.size === 0) throw new Error('PDF 파일을 선택해 주세요.');
  if (file.size > MAX_PDF_BYTES) throw new Error('PDF 파일은 100MB 이하만 처리할 수 있습니다.');
}

async function readPdfBytes(file: File): Promise<Uint8Array> {
  assertPdf(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = String.fromCharCode(...bytes.subarray(0, 5));
  if (signature !== '%PDF-') throw new Error('올바른 PDF 파일이 아닙니다.');
  return bytes;
}

function checkedPageCount(count: number): void {
  if (count < 1) throw new Error('페이지가 없는 PDF는 처리할 수 없습니다.');
  if (count > MAX_PAGES) throw new Error(`PDF는 최대 ${MAX_PAGES}페이지까지 처리할 수 있습니다.`);
}

function checkedRasterCount(count: number): void {
  if (count > MAX_RASTER_PAGES) {
    throw new Error(`이미지 변환은 한 번에 최대 ${MAX_RASTER_PAGES}페이지까지 가능합니다.`);
  }
}

/** 1-based page numbers, in the order given. Empty range selects every page. */
export function parsePageRange(range: string | undefined, pageCount: number): number[] {
  checkedPageCount(pageCount);
  const input = (range ?? '').trim();
  if (!input || input.toLowerCase() === 'all' || input === '전체') {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const selected: number[] = [];
  const seen = new Set<number>();
  for (const token of input.split(',')) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('페이지 범위는 1,3-5처럼 입력해 주세요.');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new Error(`페이지 범위는 1부터 ${pageCount}까지 입력해 주세요.`);
    }
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) {
        seen.add(page);
        selected.push(page);
      }
    }
  }
  if (!selected.length) throw new Error('처리할 페이지를 선택해 주세요.');
  return selected;
}

function blobFromPdf(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
}

async function loadEditablePdf(file: File): Promise<PDFDocument> {
  const bytes = await readPdfBytes(file);
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes);
  } catch {
    throw new Error('PDF를 열 수 없습니다. 암호가 걸려 있거나 손상된 파일인지 확인해 주세요.');
  }
  checkedPageCount(document.getPageCount());
  return document;
}

async function tryLoadRenderedPdf(file: File) {
  const bytes = await readPdfBytes(file);
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  let document: PDFDocumentProxy;
  try {
    document = await within(
      loadingTask.promise,
      PDF_LOAD_TIMEOUT_MS,
      'PDF 렌더러가 응답하지 않습니다.',
    );
    checkedPageCount(document.numPages);
  } catch (error) {
    await disposeLoadingTask(loadingTask);
    throw error;
  }
  return { document, destroy: () => disposeLoadingTask(loadingTask) };
}

async function loadRenderedPdf(file: File) {
  try {
    return await tryLoadRenderedPdf(file);
  } catch (error) {
    if (error instanceof PdfEngineTimeout) {
      // A module worker can be blocked or silently fail in an embedded browser.
      // PDF.js also supports its worker module in the main thread as a fallback.
      try {
        await enableMainThreadPdfWorker();
        return await tryLoadRenderedPdf(file);
      } catch (fallbackError) {
        if (fallbackError instanceof PdfEngineTimeout) {
          throw new Error('PDF 렌더러가 응답하지 않습니다. 브라우저를 새로고침하거나 다른 브라우저에서 시도해 주세요.');
        }
        const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`PDF 렌더러를 시작할 수 없습니다: ${detail}`, { cause: fallbackError });
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF 렌더러에서 파일을 열지 못했습니다: ${detail}`, { cause: error });
  }
}

function safeScale(width: number, height: number, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || requested > 4) {
    throw new Error('이미지 배율은 0보다 크고 4 이하여야 합니다.');
  }
  return Math.min(requested, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
}

function canvasForPage(width: number, height: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  return canvas;
}

async function renderPage(
  page: PDFPageProxy,
  requestedScale: number,
): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = safeScale(base.width, base.height, requestedScale);
  const viewport = page.getViewport({ scale });
  const canvas = canvasForPage(base.width, base.height, scale);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('브라우저에서 이미지 작업을 시작할 수 없습니다.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
  try {
    await within(task.promise, PDF_RENDER_TIMEOUT_MS, 'PDF 페이지 렌더링이 응답하지 않습니다.');
    return canvas;
  } catch (error) {
    task.cancel();
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return within(new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('이미지 변환에 실패했습니다.'));
    }, type, quality);
  }), PDF_RENDER_TIMEOUT_MS, '이미지 저장이 응답하지 않습니다.');
}

function pdfPlaceholder(pageCount: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320"><rect width="240" height="320" rx="15" fill="#eef2f7"/><rect x="31" y="23" width="178" height="274" rx="9" fill="white" stroke="#d5deea"/><rect x="53" y="61" width="71" height="37" rx="5" fill="#e45d5d"/><text x="88" y="86" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="21" font-weight="700">PDF</text><path d="M53 129h133M53 151h133M53 173h103" stroke="#d2dbe7" stroke-width="8" stroke-linecap="round"/><text x="120" y="254" text-anchor="middle" fill="#58677c" font-family="Arial,sans-serif" font-size="15">${pageCount} pages</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function inspectPdf(file: File): Promise<PdfInspection> {
  // Keep metadata available even when the PDF.js worker or canvas stalls.
  let fallback: PdfInspection | undefined;
  try {
    const metadata = await loadEditablePdf(file);
    const page = metadata.getPage(0);
    const { width, height } = page.getSize();
    const quarterTurns = Math.abs(page.getRotation().angle / 90) % 2 === 1;
    fallback = {
      pageCount: metadata.getPageCount(),
      thumbnail: pdfPlaceholder(metadata.getPageCount()),
      width: Math.round(quarterTurns ? height : width),
      height: Math.round(quarterTurns ? width : height),
    };
  } catch {
    // PDF.js may still support a PDF that pdf-lib cannot parse.
  }

  const renderedInspection = async (): Promise<PdfInspection> => {
    const { document, destroy } = await loadRenderedPdf(file);
    try {
      const page = await within(document.getPage(1), PDF_LOAD_TIMEOUT_MS, 'PDF 첫 페이지를 읽지 못했습니다.');
      const viewport = page.getViewport({ scale: 1 });
      const thumbnailScale = Math.min(1, 480 / viewport.width, 620 / viewport.height);
      const canvas = await renderPage(page, thumbnailScale);
      try {
        return {
          pageCount: document.numPages,
          thumbnail: canvas.toDataURL('image/jpeg', 0.8),
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    } finally {
      await destroy();
    }
  };

  try {
    return await within(
      renderedInspection(),
      PDF_INSPECTION_TIMEOUT_MS,
      'PDF 미리보기가 응답하지 않습니다.',
    );
  } catch (error) {
    if (fallback) return fallback;
    throw error;
  }
}

export async function mergePdfs(files: File[]): Promise<Blob> {
  if (files.length < 2) throw new Error('병합할 PDF를 두 개 이상 선택해 주세요.');
  if (files.length > 30) throw new Error('한 번에 최대 30개 파일을 병합할 수 있습니다.');
  const merged = await PDFDocument.create();
  let pagesTotal = 0;
  for (const file of files) {
    const source = await loadEditablePdf(file);
    pagesTotal += source.getPageCount();
    checkedPageCount(pagesTotal);
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return blobFromPdf(await merged.save());
}

export async function splitPdf(file: File, range: string): Promise<Blob> {
  const source = await loadEditablePdf(file);
  const pages = parsePageRange(range, source.getPageCount());
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, pages.map((page) => page - 1));
  copied.forEach((page) => output.addPage(page));
  return blobFromPdf(await output.save());
}

export async function rotatePdf(file: File, angle: number, range?: string): Promise<Blob> {
  if (![90, 180, 270].includes(angle)) throw new Error('회전 각도는 90°, 180°, 270° 중에서 선택해 주세요.');
  const output = await loadEditablePdf(file);
  const pages = parsePageRange(range, output.getPageCount());
  for (const pageNumber of pages) {
    const page = output.getPage(pageNumber - 1);
    const rotation = ((page.getRotation().angle + angle) % 360 + 360) % 360;
    page.setRotation(degrees(rotation));
  }
  return blobFromPdf(await output.save());
}

async function imageToJpeg(file: File): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    throw new Error('이미지는 파일당 25MB 이하만 처리할 수 있습니다.');
  }
  if (!file.type.startsWith('image/')) throw new Error('이미지 파일만 선택해 주세요.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${file.name}: 이 브라우저에서 읽을 수 없는 이미지 형식입니다.`);
  }
  try {
    const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = canvasForPage(bitmap.width, bitmap.height, scale);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('브라우저에서 이미지 작업을 시작할 수 없습니다.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

export async function imagesToPdf(files: File[]): Promise<Blob> {
  if (!files.length) throw new Error('PDF로 만들 이미지를 선택해 주세요.');
  if (files.length > MAX_IMAGES) throw new Error(`한 번에 최대 ${MAX_IMAGES}장의 이미지를 선택할 수 있습니다.`);
  const output = await PDFDocument.create();
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 24;
  for (const file of files) {
    const { bytes, width, height } = await imageToJpeg(file);
    const embedded = await output.embedJpg(bytes);
    const fit = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height);
    const drawWidth = width * fit;
    const drawHeight = height * fit;
    const page = output.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }
  return blobFromPdf(await output.save());
}

export async function pdfToImages(
  file: File,
  range?: string,
  options: PdfToImagesOptions = {},
): Promise<PdfImage[]> {
  const { document, destroy } = await loadRenderedPdf(file);
  try {
    const pages = parsePageRange(range, document.numPages);
    checkedRasterCount(pages.length);
    const format = options.format ?? 'png';
    if (!['png', 'jpeg'].includes(format)) throw new Error('이미지 형식은 PNG 또는 JPG를 선택해 주세요.');
    const quality = options.quality ?? 0.88;
    if (!Number.isFinite(quality) || quality < 0.2 || quality > 1) throw new Error('이미지 품질은 0.2에서 1 사이여야 합니다.');
    const baseName = file.name.replace(/\.pdf$/i, '') || 'document';
    const output: PdfImage[] = [];
    for (const pageNumber of pages) {
      const page = await document.getPage(pageNumber);
      const canvas = await renderPage(page, options.scale ?? 1.5);
      const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await canvasToBlob(canvas, type, quality);
      output.push({ pageNumber, name: `${baseName}-${pageNumber}.${format === 'jpeg' ? 'jpg' : 'png'}`, blob });
      page.cleanup();
    }
    return output;
  } finally {
    await destroy();
  }
}

export async function compressScannedPdf(
  file: File,
  options: ScannedPdfCompressionOptions = {},
): Promise<ScannedPdfCompressionResult> {
  const { document, destroy } = await loadRenderedPdf(file);
  try {
    checkedRasterCount(document.numPages);
    const quality = options.quality ?? 0.68;
    if (!Number.isFinite(quality) || quality < 0.2 || quality > 0.95) {
      throw new Error('압축 품질은 0.2에서 0.95 사이여야 합니다.');
    }
    const output = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const originalViewport = page.getViewport({ scale: 1 });
      const canvas = await renderPage(page, options.scale ?? 1.25);
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
      const embedded = await output.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
      const outputPage = output.addPage([originalViewport.width, originalViewport.height]);
      outputPage.drawImage(embedded, {
        x: 0,
        y: 0,
        width: originalViewport.width,
        height: originalViewport.height,
      });
      page.cleanup();
    }
    const blob = blobFromPdf(await output.save());
    return {
      blob,
      originalBytes: file.size,
      outputBytes: blob.size,
      warning: SCANNED_PDF_COMPRESSION_WARNING,
    };
  } finally {
    await destroy();
  }
}
