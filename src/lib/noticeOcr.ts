import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Worker as TesseractWorker } from 'tesseract.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const NOTICE_MAX_FILES = 6;
export const NOTICE_MAX_FILE_BYTES = 15 * 1024 * 1024;
export const NOTICE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const NOTICE_MAX_PDF_PAGES = 12;

const MAX_TOTAL_PDF_PAGES = 16;
const MAX_OCR_PAGES = 12;
const MAX_CANVAS_PIXELS = 12_000_000;
const MAX_SOURCE_PIXELS = 60_000_000;
const MAX_OUTPUT_CHARS = 60_000;
const PDF_TIMEOUT_MS = 20_000;
const OCR_START_TIMEOUT_MS = 90_000;
const OCR_PAGE_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 1_000;

export interface NoticeReadResult {
  text: string;
  warnings: string[];
}

type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;

function timeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function explain(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'PasswordException') return '암호가 걸린 PDF는 읽을 수 없습니다. 암호를 해제한 파일을 올려 주세요.';
    if (error.name === 'InvalidPDFException' || error.name === 'MissingPDFException') {
      return 'PDF가 손상되었거나 PDF 형식이 아닙니다.';
    }
    if (error.name === 'NotReadableError') return '브라우저가 파일에 접근하지 못했습니다. 파일을 다시 선택해 주세요.';
    if (error.message) return error.message.slice(0, 240);
  }
  return '파일을 읽을 수 없습니다. 파일 형식과 상태를 확인해 주세요.';
}

function kindOf(file: File): 'pdf' | 'image' | undefined {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || (!file.type && name.endsWith('.pdf'))) return 'pdf';
  if (
    ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    || (!file.type && /\.(png|jpe?g|webp)$/.test(name))
  ) return 'image';
  return undefined;
}

async function destroyPdf(task: PdfLoadingTask): Promise<void> {
  try {
    await timeout(task.destroy(), CLEANUP_TIMEOUT_MS, 'PDF 정리 시간이 초과되었습니다.');
  } catch {
    // The public destroy call can stall if a worker never finished starting.
    try {
      (task as unknown as { _worker?: { destroy(): void } })._worker?.destroy();
    } catch {
      // Cleanup must not hide a usable result or the original error.
    }
  }
}

let mainThreadPdfReady: Promise<void> | undefined;

function enableMainThreadPdf(): Promise<void> {
  mainThreadPdfReady ??= timeout(
    import(/* @vite-ignore */ workerUrl).then(() => {
      if (!(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker) {
        throw new Error('PDF 렌더러를 불러올 수 없습니다.');
      }
    }),
    PDF_TIMEOUT_MS,
    'PDF 렌더러를 불러오는 데 시간이 너무 오래 걸립니다.',
  );
  return mainThreadPdfReady;
}

async function openPdf(file: File): Promise<{ document: PDFDocumentProxy; task: PdfLoadingTask }> {
  const data = new Uint8Array(await timeout(file.arrayBuffer(), PDF_TIMEOUT_MS, 'PDF를 읽는 데 시간이 너무 오래 걸립니다.'));
  const attempt = async () => {
    // PDF.js transfers the input buffer to its worker; each attempt needs its own copy.
    const task = pdfjs.getDocument({ data: data.slice(), useSystemFonts: true });
    try {
      const document = await timeout(task.promise, PDF_TIMEOUT_MS, 'PDF 렌더러가 응답하지 않습니다.');
      return { document, task };
    } catch (error) {
      await destroyPdf(task);
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('PDF 렌더러가 응답하지 않습니다')) throw error;
    // Some embedded browsers block module workers. PDF.js can run its worker module inline.
    await enableMainThreadPdf();
    return attempt();
  }
}

function pdfText(items: Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items']): string {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (!('str' in item)) continue;
    line += item.str;
    if (item.hasEOL) {
      if (line.trim()) lines.push(line.trim());
      line = '';
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n').trim();
}

function textLength(value: string): number {
  return value.replace(/\s/g, '').length;
}

async function openImage(file: File): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await timeout(createImageBitmap(file), PDF_TIMEOUT_MS, '이미지를 여는 데 시간이 너무 오래 걸립니다.');
  } catch {
    throw new Error('이미지를 열 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.');
  }
  if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
    bitmap.close();
    throw new Error('이미지 크기가 너무 큽니다. 화면을 여러 장으로 나눠 캡처해 주세요.');
  }
  return bitmap;
}

function imageTileStarts(bitmap: ImageBitmap): { starts: number[]; sourceHeight: number; scale: number } {
  const scale = Math.min(1, 4_000 / bitmap.width);
  const targetHeight = Math.min(4_000, Math.floor(MAX_CANVAS_PIXELS / (bitmap.width * scale)));
  const sourceHeight = Math.max(1, Math.floor(targetHeight / scale));
  const overlap = Math.min(100, Math.floor(sourceHeight / 10));
  const starts: number[] = [];
  for (let start = 0; start < bitmap.height; start += sourceHeight - overlap) {
    starts.push(start);
    if (start + sourceHeight >= bitmap.height) break;
  }
  return { starts, sourceHeight, scale };
}

function canvasFromImageTile(bitmap: ImageBitmap, start: number, sourceHeight: number, scale: number): HTMLCanvasElement {
  const height = Math.min(sourceHeight, bitmap.height - start);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('브라우저에서 이미지 처리를 시작할 수 없습니다.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, start, bitmap.width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function joinImageTiles(pieces: string[]): string {
  let result = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (!result) {
      result = piece;
      continue;
    }
    const before = result.split('\n');
    const after = piece.split('\n');
    let repeated = 0;
    for (let count = Math.min(4, before.length, after.length); count > 0; count -= 1) {
      const tail = before.slice(-count).map((line) => line.trim()).join('\n');
      const head = after.slice(0, count).map((line) => line.trim()).join('\n');
      if (tail && tail === head) {
        repeated = count;
        break;
      }
    }
    result += `\n${after.slice(repeated).join('\n')}`;
  }
  return result.trim();
}

async function canvasFromPdfPage(page: PDFPageProxy): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('PDF 페이지 크기를 확인할 수 없습니다.');
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('브라우저에서 PDF 페이지를 그릴 수 없습니다.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const render = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
  try {
    await timeout(render.promise, PDF_TIMEOUT_MS, 'PDF 페이지를 그리는 데 시간이 너무 오래 걸립니다.');
    return canvas;
  } catch (error) {
    render.cancel();
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}

/** Reads selected files locally in the browser. No image or PDF bytes are sent to FileFit's API. */
export async function readNoticeFiles(
  files: File[],
  onProgress: (message: string) => void,
): Promise<NoticeReadResult> {
  if (!files.length) throw new Error('공고 이미지 또는 PDF를 먼저 선택해 주세요.');
  if (files.length > NOTICE_MAX_FILES) throw new Error(`한 번에 최대 ${NOTICE_MAX_FILES}개 파일을 읽을 수 있습니다.`);
  if (files.reduce((size, file) => size + file.size, 0) > NOTICE_MAX_TOTAL_BYTES) {
    throw new Error('선택한 파일의 합계가 30MB를 넘습니다. 파일을 나눠서 올려 주세요.');
  }

  const warnings: string[] = [];
  const parts: string[] = [];
  let totalPdfPages = 0;
  let totalOcrPages = 0;
  let ocrWorker: TesseractWorker | undefined;
  let ocrStartupFailure: string | undefined;
  let currentTarget = '';
  let lastProgress = -1;

  async function worker(): Promise<TesseractWorker> {
    if (ocrWorker) return ocrWorker;
    if (ocrStartupFailure) throw new Error(ocrStartupFailure);
    onProgress('한글·영어 문자 인식기를 준비하고 있습니다. 처음에는 언어 데이터를 내려받느라 시간이 걸릴 수 있습니다.');
    let startedTooLate = false;
    try {
      const { createWorker } = await import('tesseract.js');
      const starting = createWorker(['kor', 'eng'], undefined, {
        logger: (event) => {
          if (event.status !== 'recognizing text' || !currentTarget) return;
          const step = Math.floor(event.progress * 10);
          if (step === lastProgress) return;
          lastProgress = step;
          onProgress(`${currentTarget}: 글자 인식 중 ${Math.max(0, Math.min(100, Math.round(event.progress * 100)))}%`);
        },
      });
      // A late completion still owns a worker; dispose it after a start timeout.
      void starting.then((lateWorker) => {
        if (startedTooLate) void lateWorker.terminate().catch(() => undefined);
      }).catch(() => undefined);
      ocrWorker = await timeout(starting, OCR_START_TIMEOUT_MS, '문자 인식기를 시작하는 데 시간이 너무 오래 걸립니다. 인터넷 연결을 확인해 주세요.');
      return ocrWorker;
    } catch (error) {
      startedTooLate = true;
      ocrStartupFailure = `문자 인식기를 준비하지 못했습니다. ${explain(error)}`;
      throw new Error(ocrStartupFailure);
    }
  }

  async function recognize(image: File | HTMLCanvasElement, label: string): Promise<string> {
    currentTarget = label;
    lastProgress = -1;
    const engine = await worker();
    onProgress(`${label}: 글자 인식 중…`);
    try {
      const result = await timeout(
        engine.recognize(image),
        OCR_PAGE_TIMEOUT_MS,
        '글자 인식에 시간이 너무 오래 걸립니다. 더 작은 이미지로 다시 시도해 주세요.',
      );
      return result.data.text.trim();
    } catch (error) {
      try {
        await timeout(engine.terminate(), CLEANUP_TIMEOUT_MS, '문자 인식기를 종료하지 못했습니다.');
      } catch {
        // The next page will create a fresh worker.
      }
      ocrWorker = undefined;
      throw error;
    } finally {
      currentTarget = '';
    }
  }

  try {
    for (const [index, file] of files.entries()) {
      const label = file.name || `파일 ${index + 1}`;
      onProgress(`${label} 읽는 중 (${index + 1}/${files.length})`);
      if (file.size === 0) {
        warnings.push(`${label}: 빈 파일입니다.`);
        continue;
      }
      if (file.size > NOTICE_MAX_FILE_BYTES) {
        warnings.push(`${label}: 15MB를 넘어서 읽지 않았습니다. 더 작은 파일을 선택해 주세요.`);
        continue;
      }
      const kind = kindOf(file);
      if (!kind) {
        warnings.push(`${label}: PNG, JPG, WebP 이미지 또는 PDF만 읽을 수 있습니다.`);
        continue;
      }

      try {
        if (kind === 'image') {
          const bitmap = await openImage(file);
          try {
            const { starts, sourceHeight, scale } = imageTileStarts(bitmap);
            if (starts.length > MAX_OCR_PAGES - totalOcrPages) {
              warnings.push(`${label}: 긴 이미지를 읽으려면 ${starts.length}개 구간이 필요한데 이번 작업의 인식 한도는 ${MAX_OCR_PAGES}개입니다. 화면을 나눠 캡처해 주세요.`);
              continue;
            }
            const tileTexts: string[] = [];
            for (const [tileIndex, start] of starts.entries()) {
              const tileLabel = starts.length > 1 ? `${label} ${tileIndex + 1}/${starts.length}구간` : label;
              let input: File | HTMLCanvasElement = file;
              try {
                if (starts.length > 1 || bitmap.width * bitmap.height > MAX_CANVAS_PIXELS) {
                  input = canvasFromImageTile(bitmap, start, sourceHeight, scale);
                }
                totalOcrPages += 1;
                tileTexts.push(await recognize(input, tileLabel));
              } catch (error) {
                warnings.push(`${tileLabel}: ${explain(error)}`);
                if (ocrStartupFailure) break;
              } finally {
                if (input instanceof HTMLCanvasElement) {
                  input.width = 0;
                  input.height = 0;
                }
              }
            }
            const imageText = joinImageTiles(tileTexts);
            if (imageText) parts.push(imageText);
            else warnings.push(`${label}: 읽을 수 있는 글자가 없습니다. 더 선명한 화면을 캡처해 주세요.`);
          } finally {
            bitmap.close();
          }
          continue;
        }

        const { document: pdf, task } = await openPdf(file);
        try {
          if (pdf.numPages > NOTICE_MAX_PDF_PAGES) {
            warnings.push(`${label}: PDF가 ${pdf.numPages}페이지입니다. 한 파일은 최대 ${NOTICE_MAX_PDF_PAGES}페이지까지 읽을 수 있습니다. 필요한 페이지만 분리해 주세요.`);
            continue;
          }
          if (totalPdfPages + pdf.numPages > MAX_TOTAL_PDF_PAGES) {
            warnings.push(`${label}: 이번 작업의 PDF 페이지 합계가 ${MAX_TOTAL_PDF_PAGES}페이지를 넘습니다. 파일을 나눠서 시도해 주세요.`);
            continue;
          }
          totalPdfPages += pdf.numPages;
          const pageTexts: string[] = [];
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const pageLabel = `${label} ${pageNumber}/${pdf.numPages}페이지`;
            let page: PDFPageProxy | undefined;
            try {
              onProgress(`${pageLabel}: PDF 글자 확인 중…`);
              page = await timeout(pdf.getPage(pageNumber), PDF_TIMEOUT_MS, 'PDF 페이지를 여는 데 시간이 너무 오래 걸립니다.');
              const content = await timeout(page.getTextContent(), PDF_TIMEOUT_MS, 'PDF 글자를 읽는 데 시간이 너무 오래 걸립니다.');
              let value = pdfText(content.items);
              // A page with only headers/footers can still contain a scanned posting image.
              if (textLength(value) < 120) {
                if (totalOcrPages < MAX_OCR_PAGES) {
                  try {
                    const canvas = await canvasFromPdfPage(page);
                    try {
                      totalOcrPages += 1;
                      const scanned = await recognize(canvas, pageLabel);
                      if (textLength(scanned) > textLength(value)) value = scanned;
                    } finally {
                      canvas.width = 0;
                      canvas.height = 0;
                    }
                  } catch (error) {
                    warnings.push(`${pageLabel}: 이미지 속 글자를 읽지 못했습니다. ${explain(error)}`);
                  }
                } else {
                  warnings.push(`${pageLabel}: 이미지·스캔 페이지 ${MAX_OCR_PAGES}개 제한으로 이미지 속 글자를 읽지 못했습니다.`);
                }
              }
              if (value.trim()) pageTexts.push(value.trim());
              else warnings.push(`${pageLabel}: 읽을 수 있는 글자가 없습니다.`);
            } catch (error) {
              warnings.push(`${pageLabel}: ${explain(error)}`);
            } finally {
              try { page?.cleanup(); } catch { /* Best effort. */ }
            }
          }
          if (pageTexts.length) parts.push(pageTexts.join('\n\n'));
        } finally {
          await destroyPdf(task);
        }
      } catch (error) {
        warnings.push(`${label}: ${explain(error)}`);
      }
    }
  } finally {
    if (ocrWorker) {
      try {
        await timeout(ocrWorker.terminate(), CLEANUP_TIMEOUT_MS, '문자 인식기를 종료하지 못했습니다.');
      } catch {
        // Do not replace extraction results with a cleanup error.
      }
    }
  }

  let text = parts.join('\n\n').trim();
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS);
    warnings.push('읽은 글자가 너무 많아 처음 60,000자까지만 표시했습니다. 끝부분도 필요한지 확인해 주세요.');
  }
  if (!text) {
    throw new Error(warnings.length
      ? `글자를 가져오지 못했습니다. ${warnings.join(' ')}`
      : '읽을 수 있는 글자가 없습니다. 더 선명한 공고 화면을 캡처해 주세요.');
  }
  return { text, warnings };
}
