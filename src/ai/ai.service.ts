import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import { SettingsService } from '../settings/settings.service';

export interface AiGenerateResult {
  text: string;
  usedFallbackModel?: boolean;
}

export interface FidelTrainingRule {
  id: string;
  instruction: string;
  category: string;
  sourceFeedback?: string;
  createdByName?: string;
  isActive: boolean;
  createdAt: string;
}

export interface FidelTrainingTurnResult {
  text: string;
  mode: 'SETUP' | 'ROLEPLAY' | 'CORRECTION';
  learnedRule: FidelTrainingRule | null;
  usedFallbackModel?: boolean;
}

@Injectable()
export class AiService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
  ) {}

  private async getApiKeyForOrg(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { credentials: true },
    });
    if (org?.credentials?.geminiApiKeyEnc) {
      try {
        const k = this.crypto.decrypt(org.credentials.geminiApiKeyEnc);
        if (k.trim()) return k.trim();
      } catch {
        /* fall through */
      }
    }
    const envKey = this.config.get<string>('GEMINI_API_KEY', '')?.trim();
    return envKey || '';
  }

  private async getGenAI(organizationId: string): Promise<GoogleGenerativeAI | null> {
    const apiKey = await this.getApiKeyForOrg(organizationId);
    if (!apiKey) return null;
    return new GoogleGenerativeAI(apiKey);
  }

  async generateReply(organizationId: string, context: string): Promise<AiGenerateResult> {
    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      throw new Error('API key de Gemini no configurada (integraciones o GEMINI_API_KEY en .env)');
    }
    const modelId = await this.settings.getGeminiModel(organizationId);
    const prompt = `Eres un asistente de atención al cliente por WhatsApp. Responde de forma breve, profesional y útil. Solo texto, sin markdown ni emojis innecesarios.

Contexto de la conversación:
${context || '(Sin mensajes previos)'}

Responde como agente (una sola respuesta):`;

    const callWithModel = async (mId: string): Promise<string> => {
      const model = genAI.getGenerativeModel({ model: mId });
      const result = await model.generateContent(prompt);
      const text = result.response.text?.()?.trim() ?? '';
      return text || 'No pude generar una respuesta. Intenta de nuevo.';
    };

    try {
      const text = await callWithModel(modelId);
      return { text };
    } catch (err) {
      const fallback = this.settings.getFallbackGeminiModel();
      if (modelId === fallback) throw err;
      try {
        const text = await callWithModel(fallback);
        await this.settings.setGeminiModelInUse(organizationId, fallback);
        return { text, usedFallbackModel: true };
      } catch (fallbackErr) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || msg.includes('quota') || msg.includes('Too Many Requests');
        if (is429) {
          throw new Error(
            'Cuota de Gemini excedida. Espera unos minutos o revisa tu plan en https://ai.google.dev',
          );
        }
        throw err;
      }
    }
  }

  async generateFromInstruction(organizationId: string, instruction: string): Promise<AiGenerateResult> {
    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      throw new Error('API key de Gemini no configurada (integraciones o GEMINI_API_KEY en .env)');
    }
    const modelId = await this.settings.getGeminiModel(organizationId);
    const prompt = `Eres un redactor de mensajes para WhatsApp. Genera UN SOLO mensaje de texto que cumpla la instrucción del usuario.

Reglas:
- El mensaje debe ser COMPLETO: desarrolla la idea (saludos, bienvenidas, promociones, etc.), no respondas con una sola palabra como "Hola".
- Longitud: entre 2 y 5 oraciones, claro y profesional. Sin markdown ni emojis innecesarios.
- Solo texto plano, listo para copiar y enviar.

Instrucción del usuario: ${instruction?.trim() || 'Escribe un mensaje amigable y profesional.'}

Mensaje generado:`;

    const callWithModel = async (mId: string): Promise<string> => {
      const model = genAI.getGenerativeModel({ model: mId });
      const result = await model.generateContent(prompt);
      const text = result.response.text?.()?.trim() ?? '';
      return text || 'No pude generar el mensaje. Intenta con otra instrucción.';
    };

    try {
      const text = await callWithModel(modelId);
      return { text };
    } catch (err) {
      const fallback = this.settings.getFallbackGeminiModel();
      if (modelId === fallback) throw err;
      try {
        const text = await callWithModel(fallback);
        await this.settings.setGeminiModelInUse(organizationId, fallback);
        return { text, usedFallbackModel: true };
      } catch {
        throw err;
      }
    }
  }

  private getPromptFile(fileName: string): string {
    try {
      const candidates = [
        path.join(__dirname, 'prompts', fileName),
        path.join(process.cwd(), 'src', 'ai', 'prompts', fileName),
        path.join(process.cwd(), 'dist', 'ai', 'prompts', fileName),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return fs.readFileSync(p, 'utf-8');
        }
      }
    } catch {
      /* fall back */
    }
    return '';
  }

  async getFidelBehaviorPrompt(organizationId?: string): Promise<string> {
    if (organizationId) {
      try {
        const custom = await this.prisma.organizationSetting.findUnique({
          where: { organizationId_key: { organizationId, key: 'fidel_behavior' } },
        });
        if (custom?.value?.trim()) return custom.value.trim();
      } catch {
        /* fall back */
      }
    }
    return this.getPromptFile('fidel-behavior.md');
  }

  async getSalesKnowledgePrompt(organizationId?: string): Promise<string> {
    if (organizationId) {
      try {
        const custom = await this.prisma.organizationSetting.findUnique({
          where: { organizationId_key: { organizationId, key: 'sales_knowledge' } },
        });
        if (custom?.value?.trim()) return custom.value.trim();
      } catch {
        /* fall back */
      }
    }
    return this.getPromptFile('sales-knowledge.md');
  }

  async getFidelTrainingPrompt(organizationId?: string): Promise<string> {
    if (organizationId) {
      try {
        const custom = await this.prisma.organizationSetting.findUnique({
          where: { organizationId_key: { organizationId, key: 'fidel_training' } },
        });
        if (custom?.value?.trim()) return custom.value.trim();
      } catch {
        /* fall back */
      }
    }
    return this.getPromptFile('fidel-training.md');
  }

  async getFidelTrainingRules(organizationId: string): Promise<FidelTrainingRule[]> {
    try {
      const row = await this.prisma.organizationSetting.findUnique({
        where: { organizationId_key: { organizationId, key: 'fidel_training_rules' } },
      });
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveFidelTrainingRules(organizationId: string, rules: FidelTrainingRule[]): Promise<FidelTrainingRule[]> {
    const value = JSON.stringify(rules);
    await this.prisma.organizationSetting.upsert({
      where: { organizationId_key: { organizationId, key: 'fidel_training_rules' } },
      create: { organizationId, key: 'fidel_training_rules', value },
      update: { value },
    });
    return rules;
  }

  async addFidelTrainingRule(
    organizationId: string,
    params: { instruction: string; category?: string; sourceFeedback?: string; createdByName?: string },
  ): Promise<FidelTrainingRule> {
    const rules = await this.getFidelTrainingRules(organizationId);
    const newRule: FidelTrainingRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      instruction: params.instruction.trim(),
      category: (params.category || 'GENERAL').toUpperCase(),
      sourceFeedback: params.sourceFeedback?.trim(),
      createdByName: params.createdByName || 'Entrenador',
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    rules.unshift(newRule);
    await this.saveFidelTrainingRules(organizationId, rules);
    return newRule;
  }

  async toggleFidelTrainingRule(organizationId: string, ruleId: string, isActive: boolean): Promise<FidelTrainingRule[]> {
    const rules = await this.getFidelTrainingRules(organizationId);
    const updated = rules.map((r) => (r.id === ruleId ? { ...r, isActive } : r));
    return this.saveFidelTrainingRules(organizationId, updated);
  }

  async deleteFidelTrainingRule(organizationId: string, ruleId: string): Promise<FidelTrainingRule[]> {
    const rules = await this.getFidelTrainingRules(organizationId);
    const updated = rules.filter((r) => r.id !== ruleId);
    return this.saveFidelTrainingRules(organizationId, updated);
  }

  private async formatActiveRulesBlock(organizationId: string): Promise<string> {
    const rules = await this.getFidelTrainingRules(organizationId);
    const active = rules.filter((r) => r.isActive);
    if (active.length === 0) return '';
    const list = active.map((r, idx) => `${idx + 1}. [${r.category}] ${r.instruction}`).join('\n');
    return `\n---\nREGLAS Y CORRECCIONES APRENDIDAS EN ENTRENAMIENTO (PRIORIDAD MÁXIMA - DEBES CUMPLIRLAS OBLIGATORIAMENTE SOBRE CUALQUIER OTRA REGLA DE ESTILO O CONTENIDO):\n${list}\n---\n`;
  }

  async generateFidelReply(organizationId: string, context: string): Promise<AiGenerateResult> {
    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      throw new Error('API key de Gemini no configurada (integraciones o GEMINI_API_KEY en .env)');
    }
    const modelId = await this.settings.getGeminiModel(organizationId);

    const behavior = await this.getFidelBehaviorPrompt(organizationId);
    const knowledge = await this.getSalesKnowledgePrompt(organizationId);
    const learnedRulesBlock = await this.formatActiveRulesBlock(organizationId);

    const prompt = `${behavior}

---
BASE DE CONOCIMIENTO DE VENTAS:
${knowledge}
---
${learnedRulesBlock}
HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${context || '(Sin mensajes previos)'}

INSTRUCCIÓN: Responde al cliente como Fidel siguiendo todas las reglas de venta, estilo WhatsApp y las REGLAS Y CORRECCIONES APRENDIDAS EN ENTRENAMIENTO. Devuelve ÚNICAMENTE el texto que se le enviará al cliente:`;

    const callWithModel = async (mId: string): Promise<string> => {
      const model = genAI.getGenerativeModel({ model: mId });
      const result = await model.generateContent(prompt);
      const text = result.response.text?.()?.trim() ?? '';
      return text || 'No pude generar una respuesta. Intenta de nuevo.';
    };

    const candidateModels = [
      modelId,
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    let lastError: any = null;
    for (const mId of candidateModels) {
      try {
        const text = await callWithModel(mId);
        if (mId !== modelId) {
          await this.settings.setGeminiModelInUse(organizationId, mId).catch(() => {});
        }
        return { text, usedFallbackModel: mId !== modelId };
      } catch (err: any) {
        lastError = err;
        continue;
      }
    }
    throw lastError;
  }

  async processFidelTrainingTurn(
    organizationId: string,
    context: string,
    latestMessage: string,
    trainerName?: string,
  ): Promise<FidelTrainingTurnResult> {
    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      throw new Error('API key de Gemini no configurada (integraciones o GEMINI_API_KEY en .env)');
    }
    const modelId = await this.settings.getGeminiModel(organizationId);

    const behavior = await this.getFidelBehaviorPrompt(organizationId);
    const knowledge = await this.getSalesKnowledgePrompt(organizationId);
    const trainingPrompt = await this.getFidelTrainingPrompt(organizationId);
    const learnedRulesBlock = await this.formatActiveRulesBlock(organizationId);

    const prompt = `${trainingPrompt}

---
IDENTIDAD Y COMPORTAMIENTO BASE DE FIDEL:
${behavior}
---
BASE DE CONOCIMIENTO DE VENTAS:
${knowledge}
---
${learnedRulesBlock}
HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${context || '(Sin mensajes previos)'}

ÚLTIMO MENSAJE ENVIADO POR EL ENTRENADOR/USUARIO:
"${latestMessage}"

Devuelve ÚNICAMENTE el JSON solicitado:`;

    const callWithModel = async (mId: string): Promise<string> => {
      const model = genAI.getGenerativeModel({ model: mId });
      const result = await model.generateContent(prompt);
      return result.response.text?.()?.trim() ?? '';
    };

    const candidateModels = [
      modelId,
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    let rawOutput = '';
    let usedFallback = false;
    let lastError: any = null;

    for (const mId of candidateModels) {
      try {
        rawOutput = await callWithModel(mId);
        if (mId !== modelId) {
          usedFallback = true;
          await this.settings.setGeminiModelInUse(organizationId, mId).catch(() => {});
        }
        break;
      } catch (err: any) {
        lastError = err;
        continue;
      }
    }

    if (!rawOutput && lastError) throw lastError;

    let mode: 'SETUP' | 'ROLEPLAY' | 'CORRECTION' = 'ROLEPLAY';
    let reply = rawOutput;
    let savedRule: FidelTrainingRule | null = null;

    try {
      const cleaned = rawOutput
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

      if (parsed.mode === 'SETUP' || parsed.mode === 'CORRECTION' || parsed.mode === 'ROLEPLAY') {
        mode = parsed.mode;
      }
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
        reply = parsed.reply.trim();
      }
      if (mode === 'CORRECTION' && parsed.learnedRule?.instruction?.trim()) {
        savedRule = await this.addFidelTrainingRule(organizationId, {
          instruction: parsed.learnedRule.instruction.trim(),
          category: parsed.learnedRule.category || 'ESTILO',
          sourceFeedback: latestMessage,
          createdByName: trainerName || 'Entrenador',
        });
      }
    } catch {
      // Si el modelo devolvió texto plano en vez de JSON, usarlo directamente como respuesta
      reply = rawOutput || 'Entendido.';
    }

    return {
      text: reply,
      mode,
      learnedRule: savedRule,
      usedFallbackModel: usedFallback,
    };
  }
}

