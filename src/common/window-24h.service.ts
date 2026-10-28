import { Injectable } from '@nestjs/common';

/** Ventana de 24 horas de WhatsApp: solo se pueden enviar mensajes libres si el usuario escribió en las últimas 24h */
const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class Window24hService {
  /**
   * Indica si se puede enviar mensaje libre (texto) al usuario.
   * @param lastUserMessageAt timestamp del último mensaje ENVIADO POR EL USUARIO (no por nosotros)
   */
  canSendFreeMessage(lastUserMessageAt: Date | number | null | undefined): boolean {
    if (lastUserMessageAt == null) return false;
    const ts = typeof lastUserMessageAt === 'number' ? lastUserMessageAt : lastUserMessageAt.getTime();
    return Date.now() - ts < WINDOW_MS;
  }

  /** Segundos restantes dentro de la ventana (0 si ya expiró) */
  getSecondsRemaining(lastUserMessageAt: Date | number | null | undefined): number {
    if (lastUserMessageAt == null) return 0;
    const ts = typeof lastUserMessageAt === 'number' ? lastUserMessageAt : lastUserMessageAt.getTime();
    const elapsed = Date.now() - ts;
    if (elapsed >= WINDOW_MS) return 0;
    return Math.floor((WINDOW_MS - elapsed) / 1000);
  }
}
