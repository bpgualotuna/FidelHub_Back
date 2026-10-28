import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type WhatsappTier = 'new' | 'level1' | 'level2' | 'level3' | 'excellent';

const TIER_DAILY_LIMITS: Record<WhatsappTier, number> = {
  new: 250,
  level1: 1_000,
  level2: 10_000,
  level3: 100_000,
  excellent: Number.MAX_SAFE_INTEGER,
};

const DEFAULT_FALLBACK_GEMINI_MODEL = 'gemini-3.5-flash';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async getGlobal(key: string): Promise<string | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  private async setGlobal(key: string, value: string): Promise<void> {
    await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  private async getOrgSetting(organizationId: string, key: string): Promise<string | null> {
    const row = await this.prisma.organizationSetting.findUnique({
      where: {
        organizationId_key: { organizationId, key },
      },
    });
    return row?.value ?? null;
  }

  private async setOrgSetting(organizationId: string, key: string, value: string): Promise<void> {
    await this.prisma.organizationSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value },
      update: { value },
    });
  }

  async getWhatsappTier(organizationId: string): Promise<WhatsappTier> {
    const v = await this.getOrgSetting(organizationId, 'whatsapp_tier');
    if (v && (v === 'new' || v === 'level1' || v === 'level2' || v === 'level3' || v === 'excellent'))
      return v as WhatsappTier;
    const legacy = await this.getGlobal('whatsapp_tier');
    if (
      legacy &&
      (legacy === 'new' ||
        legacy === 'level1' ||
        legacy === 'level2' ||
        legacy === 'level3' ||
        legacy === 'excellent')
    )
      return legacy as WhatsappTier;
    return 'new';
  }

  async setWhatsappTier(organizationId: string, tier: WhatsappTier): Promise<void> {
    await this.setOrgSetting(organizationId, 'whatsapp_tier', tier);
  }

  async getDailyLimit(organizationId: string): Promise<number> {
    const tier = await this.getWhatsappTier(organizationId);
    return TIER_DAILY_LIMITS[tier];
  }

  async getDailyConversationCount(organizationId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        direction: MessageDirection.OUT,
        whatsappTimestamp: { gte: since },
        conversation: { contact: { organizationId } },
      },
      _count: { conversationId: true },
    });
    return result.length;
  }

  /**
   * Momento en que el contador de cupo diario va a bajar por primera vez: el mensaje más reciente
   * de la conversación que menos falta le queda para cumplir 24h (cada conversación cuenta hasta que
   * SU último mensaje saliente cumple 24h, no todas a la vez). Null si no hay nada contando ahora mismo.
   */
  async getNextCapacityFreeAt(organizationId: string): Promise<Date | null> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        direction: MessageDirection.OUT,
        whatsappTimestamp: { gte: since },
        conversation: { contact: { organizationId } },
      },
      _max: { whatsappTimestamp: true },
    });
    if (!grouped.length) return null;

    let earliest: Date | null = null;
    for (const g of grouped) {
      const t = g._max.whatsappTimestamp;
      if (t && (!earliest || t < earliest)) earliest = t;
    }
    if (!earliest) return null;

    return new Date(earliest.getTime() + 24 * 60 * 60 * 1000);
  }

  async checkDailyLimitOrThrow(conversationId: string, organizationId: string): Promise<void> {
    const limit = await this.getDailyLimit(organizationId);
    if (limit === Number.MAX_SAFE_INTEGER) return;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const alreadySentToThis = await this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: MessageDirection.OUT,
        whatsappTimestamp: { gte: since },
      },
    });
    if (alreadySentToThis) return;

    const count = await this.getDailyConversationCount(organizationId);
    if (count >= limit) {
      throw new ForbiddenException(
        'No puedes agregar más conversaciones, has superado el límite diario de tu tier.',
      );
    }
  }

  async getGeminiModel(organizationId: string): Promise<string> {
    const v = await this.getOrgSetting(organizationId, 'gemini_model');
    if (v?.trim()) return v.trim();
    const legacy = await this.getGlobal('gemini_model');
    if (legacy?.trim()) return legacy.trim();
    const envModel = this.config.get<string>('GEMINI_MODEL')?.trim();
    return envModel || DEFAULT_FALLBACK_GEMINI_MODEL;
  }

  async setGeminiModel(organizationId: string, model: string): Promise<void> {
    await this.setOrgSetting(organizationId, 'gemini_model', model.trim());
    await this.setOrgSetting(organizationId, 'gemini_model_in_use', model.trim());
  }

  async getGeminiModelInUse(organizationId: string): Promise<string> {
    const v = await this.getOrgSetting(organizationId, 'gemini_model_in_use');
    if (v?.trim()) return v.trim();
    return this.getGeminiModel(organizationId);
  }

  async setGeminiModelInUse(organizationId: string, model: string): Promise<void> {
    await this.setOrgSetting(organizationId, 'gemini_model_in_use', model);
  }

  getFallbackGeminiModel(): string {
    const envModel = this.config.get<string>('GEMINI_MODEL')?.trim();
    return envModel || DEFAULT_FALLBACK_GEMINI_MODEL;
  }
}
