import { Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ffmpeg-static/ffprobe-static exponen el binario vía `module.exports =`, sin interop
// de default export en este tsconfig (esModuleInterop no está activo) — se usa require directo.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStatic: string | null = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffprobeStatic: { path: string } = require('ffprobe-static');

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const logger = new Logger('VideoTranscode');

/** Límite real que impone la API de envío de WhatsApp Cloud para video (no confundir con el
 * límite, más permisivo, que acepta la subida del archivo de ejemplo al aprobar una plantilla). */
export const WHATSAPP_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
// Margen para el overhead del contenedor MP4 y la imprecisión del bitrate en un solo paso de codificación.
const SIZE_SAFETY_MARGIN = 0.92;
const AUDIO_BITRATE_BPS = 128_000;
const MIN_VIDEO_BITRATE_BPS = 200_000;
// Cada intento corre un proceso ffmpeg completo; en instancias con poca RAM, encadenar varios
// intentos seguidos suma memoria/CPU. 2 alcanza en la práctica gracias al cap de resolución.
const MAX_BITRATE_ATTEMPTS = 2;
const BITRATE_BACKOFF = 0.85;

interface VideoProbeInfo {
  codec: string | null;
  durationSec: number | null;
}

function probeVideo(filePath: string): Promise<VideoProbeInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        logger.warn(`No se pudo analizar el video: ${err.message}`);
        resolve({ codec: null, durationSec: null });
        return;
      }
      const videoStream = data.streams?.find((s) => s.codec_type === 'video');
      const duration = Number(data.format?.duration);
      resolve({
        codec: videoStream?.codec_name ?? null,
        durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      });
    });
  });
}

/** Codifica `inputPath` a H.264 en `outputPath`, apuntando a `videoBitrateBps` (o a un CRF fijo
 * si no hay bitrate objetivo, ej. por no poder determinar la duración del video). */
function transcodeOnce(inputPath: string, outputPath: string, videoBitrateBps: number | null): Promise<void> {
  const TRANSCODE_TIMEOUT_MS = 120_000;
  return new Promise<void>((resolve, reject) => {
    const outputOptions = [
      '-preset veryfast',
      '-pix_fmt yuv420p',
      '-movflags +faststart',
      // Limita hilos y resolución para no disparar el uso de memoria/CPU de ffmpeg en instancias
      // con poca RAM (ej. Render Starter): un video 4K/1080p de un celular puede hacer que ffmpeg
      // por sí solo consuma varios cientos de MB al codificar, tirando abajo todo el proceso.
      '-threads 2',
      "-vf scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
    ];
    if (videoBitrateBps) {
      const kbps = Math.floor(videoBitrateBps / 1000);
      outputOptions.push(`-b:v ${kbps}k`, `-maxrate ${kbps}k`, `-bufsize ${kbps * 2}k`);
    } else {
      outputOptions.push('-crf 26');
    }

    const command = ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate(AUDIO_BITRATE_BPS / 1000)
      .outputOptions(outputOptions)
      .format('mp4')
      .on('error', reject)
      .on('end', () => resolve());

    const timer = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error(`Recodificación excedió ${TRANSCODE_TIMEOUT_MS / 1000}s`));
    }, TRANSCODE_TIMEOUT_MS);

    command.save(outputPath);
    command.on('end', () => clearTimeout(timer));
    command.on('error', () => clearTimeout(timer));
  });
}

/**
 * WhatsApp Cloud API solo procesa video H.264 (AVC) + audio AAC en MP4, hasta 16MB por archivo
 * al ENVIAR un mensaje (el límite es distinto y más permisivo al subir el ejemplo de una plantilla
 * para aprobación — que Meta haya aceptado un archivo ahí no garantiza que pase al enviarlo).
 * Los videos HEVC/H.265 (comunes en iPhone) son aceptados al subir pero rechazados después, de
 * forma asíncrona (error 131053). Si el video no viene en H.264, o si pesa más de lo permitido,
 * se recodifica antes de enviarlo, apuntando a un bitrate calculado según su duración para quedar
 * bajo el límite de tamaño.
 */
export async function ensureWhatsAppCompatibleVideo(
  buffer: Buffer,
  mimetype: string,
): Promise<{ buffer: Buffer; mimetype: string; transcoded: boolean }> {
  if (!mimetype.startsWith('video/')) {
    return { buffer, mimetype, transcoded: false };
  }

  const inputPath = join(tmpdir(), `${randomUUID()}_in`);
  const outputPath = join(tmpdir(), `${randomUUID()}_out.mp4`);

  try {
    await fs.writeFile(inputPath, buffer);
    const { codec, durationSec } = await probeVideo(inputPath);
    const needsCodecFix = codec !== 'h264';
    const needsSizeFix = buffer.length > WHATSAPP_VIDEO_MAX_BYTES;

    if (!needsCodecFix && !needsSizeFix) {
      return { buffer, mimetype, transcoded: false };
    }

    logger.log(
      `Recodificando video (códec="${codec ?? 'desconocido'}", ${(buffer.length / 1024 / 1024).toFixed(1)}MB) ` +
        `para compatibilidad/tamaño con WhatsApp`,
    );

    let targetVideoBitrateBps =
      durationSec != null
        ? Math.max(
            MIN_VIDEO_BITRATE_BPS,
            Math.floor((WHATSAPP_VIDEO_MAX_BYTES * SIZE_SAFETY_MARGIN * 8) / durationSec) - AUDIO_BITRATE_BPS,
          )
        : null;

    // Un solo paso de codificación con bitrate promedio puede pasarse del tamaño objetivo por
    // variación de contenido; si el resultado sigue superando el límite, se reintenta con un
    // bitrate menor hasta lograrlo o agotar los intentos.
    let transcodedBuffer: Buffer | null = null;
    for (let attempt = 1; attempt <= MAX_BITRATE_ATTEMPTS; attempt++) {
      await transcodeOnce(inputPath, outputPath, targetVideoBitrateBps);
      const result = await fs.readFile(outputPath);

      if (result.length <= WHATSAPP_VIDEO_MAX_BYTES || !targetVideoBitrateBps) {
        transcodedBuffer = result;
        break;
      }

      logger.warn(
        `Recodificación intento ${attempt} dio ${(result.length / 1024 / 1024).toFixed(1)}MB, ` +
          `por encima del límite; bajando bitrate y reintentando`,
      );
      targetVideoBitrateBps = Math.max(MIN_VIDEO_BITRATE_BPS, Math.floor(targetVideoBitrateBps * BITRATE_BACKOFF));
      transcodedBuffer = result;
    }

    return { buffer: transcodedBuffer!, mimetype: 'video/mp4', transcoded: true };
  } catch (err) {
    logger.error(`Fallo al recodificar el video, se enviará el original: ${err instanceof Error ? err.message : err}`);
    return { buffer, mimetype, transcoded: false };
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

/** Reemplaza la extensión de un nombre de archivo por .mp4, usado cuando el video fue recodificado. */
export function withMp4Extension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '') + '.mp4';
}
