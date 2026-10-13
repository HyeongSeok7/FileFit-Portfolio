import pica from 'pica';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface ImageInfo {
  width: number;
  height: number;
  size: number;
  format: ImageFormat;
  mimeType: string;
}

export interface ImageTransformOptions {
  width?: number;
  height?: number;
  format?: ImageFormat;
  /** Keep the original aspect ratio: pad to fit, or crop the center to fill. Defaults to contain. */
  fit?: 'contain' | 'cover';
  /** Encoder quality from 0 to 1. The highest quality tried for a max-only byte target. */
  quality?: number;
  /** Lowest quality allowed while trying to meet targetBytes. Defaults to 0.72. */
  minQuality?: number;
  /** A JPEG/WebP target; PNG is lossless and cannot use this quality search. */
  targetBytes?: number;
  /** Minimum JPEG/WebP output size, reached by raising encoder quality when possible. */
  minBytes?: number;
  /** Background used when transparent pixels are exported as JPEG. */
  background?: string;
  signal?: AbortSignal;
}

export interface ImageTransformResult {
  blob: Blob;
  width: number;
  height: number;
  format: ImageFormat;
  mimeType: string;
  /** Encoder quality requested, or null for PNG. */
  quality: number | null;
  /** Null when no target was requested. */
  targetBytesMet: boolean | null;
  /** Null when no minimum was requested. A miss never implies that bytes were padded. */
  minBytesMet: boolean | null;
  /** Large upscales cannot create detail absent from the original. */
  warning?: string;
}

const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_INPUT_PIXELS = 48_000_000;
const MAX_OUTPUT_PIXELS = 48_000_000;
const MAX_SIDE = 16_000;
const HEADER_BYTES = 2 * 1024 * 1024;

let sharedResizer: ReturnType<typeof pica> | undefined;

function resizer() {
  // Tiles and a small worker pool keep peak memory more predictable on phones.
  sharedResizer ??= pica({ tile: 1024, concurrency: 2 });
  return sharedResizer;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('작업이 취소되었습니다.', 'AbortError');
  }
}

function validateFile(file: File): void {
  if (!file || file.size === 0) {
    throw new Error('내용이 있는 이미지 파일을 선택해 주세요.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('이미지는 80MB 이하만 처리할 수 있습니다.');
  }
}

function imageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'webp';
  throw new Error('JPG, PNG, WebP 이미지 파일만 처리할 수 있습니다.');
}

function readPngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function readJpegSize(bytes: Uint8Array): [number, number] | null {
  let offset = 2;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (frameMarkers.has(marker) && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return [width, height];
    }
    offset += length;
  }
  return null;
}

function readWebpSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') {
    if (bytes[20] & 0x02) throw new Error('움직이는 WebP는 첫 장만 저장되므로 지원하지 않습니다.');
    return [
      1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
    ];
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return [
      1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    ];
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return [
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    ];
  }
  return null;
}

function dimensionsFromHeader(bytes: Uint8Array, format: ImageFormat): [number, number] | null {
  if (format === 'jpeg') return readJpegSize(bytes);
  if (format === 'png') return readPngSize(bytes);
  return readWebpSize(bytes);
}

function validateDimensions(width: number, height: number, maxPixels: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('이미지의 가로·세로 크기를 확인할 수 없습니다.');
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > maxPixels) {
    throw new Error('이미지가 너무 큽니다. 최대 4,800만 화소, 한 변 16,000px까지 처리할 수 있습니다.');
  }
}

async function openBitmap(file: File, signal?: AbortSignal): Promise<{ bitmap: ImageBitmap; format: ImageFormat }> {
  cancelled(signal);
  validateFile(file);
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, HEADER_BYTES)).arrayBuffer());
  const format = imageFormat(header);
  const headerSize = dimensionsFromHeader(header, format);
  if (!headerSize) throw new Error('이미지 헤더를 읽을 수 없습니다. 다른 파일로 다시 시도해 주세요.');
  validateDimensions(headerSize[0], headerSize[1], MAX_INPUT_PIXELS);
  cancelled(signal);

  if (typeof createImageBitmap !== 'function') {
    throw new Error('이 브라우저는 이미지 변환을 지원하지 않습니다. 최신 브라우저로 다시 시도해 주세요.');
  }
  let bitmap: ImageBitmap;
  try {
    // Apply EXIF orientation before reporting dimensions or resizing.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('이미지를 열 수 없습니다. 파일이 손상되었거나 브라우저에서 지원하지 않는 형식일 수 있습니다.');
  }
  try {
    cancelled(signal);
    validateDimensions(bitmap.width, bitmap.height, MAX_INPUT_PIXELS);
    return { bitmap, format };
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

/** Decode once to report the orientation-correct dimensions and verified file format. */
export async function inspectImage(file: File): Promise<ImageInfo> {
  const { bitmap, format } = await openBitmap(file);
  try {
    return {
      width: bitmap.width,
      height: bitmap.height,
      size: file.size,
      format,
      mimeType: MIME[format],
    };
  } finally {
    bitmap.close();
  }
}

function outputDimensions(sourceWidth: number, sourceHeight: number, options: ImageTransformOptions): [number, number] {
  const width = options.width;
  const height = options.height;
  if (width !== undefined && (!Number.isFinite(width) || width < 1)) throw new Error('가로 크기는 1px 이상이어야 합니다.');
  if (height !== undefined && (!Number.isFinite(height) || height < 1)) throw new Error('세로 크기는 1px 이상이어야 합니다.');
  const w = Math.round(width ?? (height === undefined ? sourceWidth : sourceWidth * height / sourceHeight));
  const h = Math.round(height ?? (width === undefined ? sourceHeight : sourceHeight * width / sourceWidth));
  validateDimensions(w, h, MAX_OUTPUT_PIXELS);
  return [w, h];
}

interface FitLayout {
  scaledWidth: number;
  scaledHeight: number;
  sourceX: number;
  sourceY: number;
  destinationX: number;
  destinationY: number;
  drawWidth: number;
  drawHeight: number;
  warning?: string;
}

function imageFitLayout(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: 'contain' | 'cover',
): FitLayout {
  if (fit === 'contain') {
    const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const scaledWidth = Math.min(targetWidth, Math.max(1, Math.round(sourceWidth * scale)));
    const scaledHeight = Math.min(targetHeight, Math.max(1, Math.round(sourceHeight * scale)));
    const horizontalSpace = targetWidth - scaledWidth;
    const verticalSpace = targetHeight - scaledHeight;
    return {
      scaledWidth,
      scaledHeight,
      sourceX: 0,
      sourceY: 0,
      destinationX: Math.floor(horizontalSpace / 2),
      destinationY: Math.floor(verticalSpace / 2),
      drawWidth: scaledWidth,
      drawHeight: scaledHeight,
      warning: horizontalSpace > 0
        ? '원본 비율을 유지하도록 사진 좌우에 여백을 추가했습니다.'
        : verticalSpace > 0
          ? '원본 비율을 유지하도록 사진 위아래에 여백을 추가했습니다.'
          : undefined,
    };
  }

  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const scaledWidth = Math.max(targetWidth, Math.ceil(sourceWidth * scale));
  const scaledHeight = Math.max(targetHeight, Math.ceil(sourceHeight * scale));
  // A huge aspect-ratio difference could otherwise create an unbounded canvas.
  validateDimensions(scaledWidth, scaledHeight, MAX_OUTPUT_PIXELS);
  const horizontalCrop = scaledWidth - targetWidth;
  const verticalCrop = scaledHeight - targetHeight;
  return {
    scaledWidth,
    scaledHeight,
    sourceX: Math.floor(horizontalCrop / 2),
    sourceY: Math.floor(verticalCrop / 2),
    destinationX: 0,
    destinationY: 0,
    drawWidth: targetWidth,
    drawHeight: targetHeight,
    warning: horizontalCrop > 0
      ? '원본 비율을 유지하도록 사진 좌우를 가운데 기준으로 잘랐습니다.'
      : verticalCrop > 0
        ? '원본 비율을 유지하도록 사진 위아래를 가운데 기준으로 잘랐습니다.'
        : undefined,
  };
}

function validQuality(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('화질은 0부터 1 사이로 지정해 주세요.');
  return value;
}

function validTarget(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1024) throw new Error('목표 용량은 1KB 이상으로 지정해 주세요.');
  return value;
}

function validMinimum(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1024) throw new Error('최소 용량은 1KB 이상으로 지정해 주세요.');
  return value;
}

async function encode(canvas: HTMLCanvasElement, mimeType: string, quality: number | null): Promise<Blob> {
  const blob = await resizer().toBlob(canvas, mimeType, quality ?? undefined);
  if (!blob || blob.size === 0 || blob.type !== mimeType) {
    throw new Error('이 브라우저에서 선택한 이미지 형식으로 저장할 수 없습니다. 다른 형식으로 시도해 주세요.');
  }
  return blob;
}

/** Resize/convert an image locally. No image data is sent to a server. */
export async function transformImage(file: File, options: ImageTransformOptions = {}): Promise<ImageTransformResult> {
  const signal = options.signal;
  const { bitmap, format: sourceFormat } = await openBitmap(file, signal);
  let canvas: HTMLCanvasElement | undefined;
  let scaledCanvas: HTMLCanvasElement | undefined;
  try {
    const format = options.format ?? sourceFormat;
    if (!(format in MIME)) throw new Error('JPG, PNG, WebP 중 저장 형식을 선택해 주세요.');
    const mimeType = MIME[format];
    const [width, height] = outputDimensions(bitmap.width, bitmap.height, options);
    const fit = options.fit ?? 'contain';
    if (fit !== 'contain' && fit !== 'cover') throw new Error('사진 맞춤 방식은 여백 또는 자르기 중에서 선택해 주세요.');
    const layout = imageFitLayout(bitmap.width, bitmap.height, width, height, fit);
    const targetBytes = validTarget(options.targetBytes);
    const minBytes = validMinimum(options.minBytes);
    if (minBytes !== undefined && targetBytes !== undefined && minBytes > targetBytes) {
      throw new Error('최소 용량은 최대 용량보다 작거나 같아야 합니다.');
    }
    const quality = validQuality(options.quality, 0.92);
    const minQuality = validQuality(options.minQuality, 0.72);
    if (targetBytes !== undefined && minQuality > quality) {
      throw new Error('최소 화질은 선택한 화질보다 낮아야 합니다.');
    }
    cancelled(signal);

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지 작업 공간을 만들 수 없습니다. 브라우저 메모리를 확인해 주세요.');

    try {
      if (layout.scaledWidth === width && layout.scaledHeight === height) {
        if (width === bitmap.width && height === bitmap.height) {
          context.drawImage(bitmap, 0, 0);
        } else {
          await resizer().resize(bitmap, canvas);
        }
      } else {
        scaledCanvas = document.createElement('canvas');
        scaledCanvas.width = layout.scaledWidth;
        scaledCanvas.height = layout.scaledHeight;
        if (layout.scaledWidth === bitmap.width && layout.scaledHeight === bitmap.height) {
          const scaledContext = scaledCanvas.getContext('2d');
          if (!scaledContext) throw new Error('이미지 작업 공간을 만들 수 없습니다.');
          scaledContext.drawImage(bitmap, 0, 0);
        } else {
          await resizer().resize(bitmap, scaledCanvas);
        }
        // drawImage copies the selected region 1:1. It does not stretch the
        // photo to the requested aspect ratio after Pica's single resize.
        context.drawImage(
          scaledCanvas,
          layout.sourceX,
          layout.sourceY,
          layout.drawWidth,
          layout.drawHeight,
          layout.destinationX,
          layout.destinationY,
          layout.drawWidth,
          layout.drawHeight,
        );
        scaledCanvas.width = 0;
        scaledCanvas.height = 0;
        scaledCanvas = undefined;
      }
    } catch (error) {
      cancelled(signal);
      throw new Error(`이미지 크기 변경에 실패했습니다. ${error instanceof Error ? error.message : '브라우저 메모리를 확인해 주세요.'}`);
    }
    cancelled(signal);

    if (format === 'jpeg' || options.background) {
      // Flatten alpha and fill contain padding in-place, without a second
      // full-size canvas. PNG/WebP remain transparent unless requested.
      context.save();
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = options.background ?? '#ffffff';
      context.fillRect(0, 0, width, height);
      context.restore();
    }

    let blob: Blob;
    let actualQuality: number | null = format === 'png' ? null : quality;
    if (format === 'png' || (targetBytes === undefined && minBytes === undefined)) {
      // PNG has no quality control. Encode it once and report each unmet bound.
      blob = await encode(canvas, mimeType, actualQuality);
    } else if (minBytes === undefined && targetBytes !== undefined) {
      // Browser encoders are not guaranteed to be perfectly monotonic. Keep the
      // best measured result under the limit, then report a miss if none fits.
      const highBlob = await encode(canvas, mimeType, quality);
      cancelled(signal);
      if (highBlob.size <= targetBytes) {
        blob = highBlob;
      } else {
        const lowBlob = await encode(canvas, mimeType, minQuality);
        cancelled(signal);
        if (lowBlob.size > targetBytes) {
          blob = lowBlob;
          actualQuality = minQuality;
        } else {
          let low = minQuality;
          let high = quality;
          blob = lowBlob;
          actualQuality = low;
          for (let step = 0; step < 7 && high - low > 0.005; step += 1) {
            cancelled(signal);
            const mid = (low + high) / 2;
            const candidate = await encode(canvas, mimeType, mid);
            if (candidate.size <= targetBytes) {
              low = mid;
              blob = candidate;
              actualQuality = mid;
            } else {
              high = mid;
            }
          }
        }
      }
    } else {
      if (minBytes === undefined) throw new Error('이미지 용량 조건을 확인해 주세요.');
      type Candidate = { blob: Blob; quality: number };
      const tried: Candidate[] = [];
      const encodingCanvas: HTMLCanvasElement = canvas;
      const tryQuality = async (candidateQuality: number): Promise<Candidate> => {
        const cached = tried.find((candidate) => candidate.quality === candidateQuality);
        if (cached) return cached;
        cancelled(signal);
        const candidate = { blob: await encode(encodingCanvas, mimeType, candidateQuality), quality: candidateQuality };
        cancelled(signal);
        tried.push(candidate);
        return candidate;
      };

      const initial = await tryQuality(quality);
      if (initial.blob.size < minBytes) {
        // A minimum asks for real encoder bytes: raise quality, never append
        // padding or claim that an upscaled image gained detail.
        const upper = await tryQuality(1);
        if (upper.blob.size >= minBytes) {
          let low = quality;
          let high = 1;
          for (let step = 0; step < 10 && high - low > 0.001; step += 1) {
            const mid = (low + high) / 2;
            const candidate = await tryQuality(mid);
            if (candidate.blob.size >= minBytes) high = mid;
            else low = mid;
          }
        }
      } else if (targetBytes !== undefined && initial.blob.size > targetBytes) {
        // Preserve the max-only search direction: find the highest measured
        // quality at or under the maximum, down to the chosen quality floor.
        const lower = await tryQuality(minQuality);
        if (lower.blob.size <= targetBytes) {
          let low = minQuality;
          let high = quality;
          for (let step = 0; step < 10 && high - low > 0.001; step += 1) {
            const mid = (low + high) / 2;
            const candidate = await tryQuality(mid);
            if (candidate.blob.size <= targetBytes) low = mid;
            else high = mid;
          }
        }
      }

      const inRange = tried.filter((candidate) =>
        candidate.blob.size >= minBytes && (targetBytes === undefined || candidate.blob.size <= targetBytes));
      let selected: Candidate;
      if (inRange.length) {
        selected = initial.blob.size < minBytes
          ? inRange.reduce((best, candidate) => candidate.blob.size < best.blob.size ? candidate : best)
          : inRange.reduce((best, candidate) => candidate.quality > best.quality ? candidate : best);
      } else {
        // Browser encoders can jump over a narrow range. Return the closest
        // actual encoding and let both result flags expose the miss.
        const distance = (candidate: Candidate): number => candidate.blob.size < minBytes
          ? minBytes - candidate.blob.size
          : targetBytes !== undefined && candidate.blob.size > targetBytes
            ? candidate.blob.size - targetBytes
            : 0;
        selected = tried.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best);
      }
      blob = selected.blob;
      actualQuality = selected.quality;
    }
    cancelled(signal);

    const upscale = Math.max(layout.scaledWidth / bitmap.width, layout.scaledHeight / bitmap.height);
    const warnings = [
      layout.warning,
      upscale > 1.5
        ? '사진을 크게 만들면 원본에 없던 세부 묘사는 복원되지 않아 확대해서 볼 때 부드럽게 보일 수 있습니다.'
        : undefined,
    ].filter(Boolean);
    return {
      blob,
      width,
      height,
      format,
      mimeType,
      quality: actualQuality,
      targetBytesMet: targetBytes === undefined ? null : blob.size <= targetBytes,
      minBytesMet: minBytes === undefined ? null : blob.size >= minBytes,
      warning: warnings.length ? warnings.join(' ') : undefined,
    };
  } finally {
    bitmap.close();
    if (canvas) {
      // Releasing dimensions lets the browser reclaim the backing pixel buffer.
      canvas.width = 0;
      canvas.height = 0;
    }
    if (scaledCanvas) {
      scaledCanvas.width = 0;
      scaledCanvas.height = 0;
    }
  }
}
