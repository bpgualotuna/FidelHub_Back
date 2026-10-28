import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import { SettingsService } from '../settings/settings.service';
import { McpHubService } from '../mcp-hub/mcp-hub.service';
import { McpToolExecutionTrace } from '../mcp-hub/mcp-hub.types';

export interface AiGenerateResult {
  text: string;
  usedFallbackModel?: boolean;
  mcpToolTraces?: McpToolExecutionTrace[];
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
  mcpToolTraces?: McpToolExecutionTrace[];
}

@Injectable()
export class AiService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
    private readonly mcpHub: McpHubService,
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
      return {
        text: '¡Hola! Con gusto te ayudo. ¿Te gustaría conocer los horarios o costos de nuestras certificaciones?',
      };
    }
    const modelId = await this.settings.getGeminiModel(organizationId);
    const prompt = `Eres un asistente de atención al cliente omnicanal. Responde de forma breve, profesional y útil. Solo texto, sin markdown ni emojis innecesarios.

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
      } catch {
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
    const prompt = `Eres un redactor de mensajes omnicanal. Genera UN SOLO mensaje de texto que cumpla la instrucción del usuario.

Reglas:
- El mensaje debe ser COMPLETO: desarrolla la idea (saludos, bienvenidas, promociones, etc.).
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

  /**
   * Detecta y ejecuta herramientas del servidor MCP activo según la intención del último mensaje del cliente
   */
  private async detectAndExecuteMcpTools(
    organizationId: string,
    context: string,
    channel = 'WHATSAPP',
    preferredServerId?: string | null,
  ): Promise<McpToolExecutionTrace[]> {
    const traces: McpToolExecutionTrace[] = [];
    const lines = context.split('\n').filter(Boolean);
    const lastLine = (lines[lines.length - 1] || '').toLowerCase();

    const { server, tools } = await this.mcpHub.getActiveToolsForChannel(
      organizationId,
      channel,
      preferredServerId,
    );
    if (!server || tools.length === 0) return traces;

    // 1. Intención de precio / catálogo / programas / becas
    if (
      /precio|costo|cuanto|cuánto|valor|beca|curso|programa|certificaci|bootcamp|info/i.test(
        lastLine,
      ) &&
      tools.some((t) => t.name === 'fidel_consultar_catalogo')
    ) {
      const prog = lastLine.includes('docencia') || lastLine.includes('ia')
        ? 'ia_docencia'
        : 'fullstack_bootcamp';
      const trace = await this.mcpHub.executeTool(
        organizationId,
        server.id,
        'fidel_consultar_catalogo',
        { programa: prog },
      );
      traces.push(trace);
    }

    // 2. Intención de horarios / disponibilidad
    if (
      /horario|disponib|cuando|cuándo|hora|agenda|reuni/i.test(lastLine) &&
      tools.some((t) => t.name === 'fidel_consultar_horarios')
    ) {
      const trace = await this.mcpHub.executeTool(
        organizationId,
        server.id,
        'fidel_consultar_horarios',
        { fecha_preferida: 'Próxima disponible', franja: 'tarde' },
      );
      traces.push(trace);
    }

    // 3. Intención de agendar cita explícita
    if (
      /agendar|reservar cita|llamada|mañana a las|jueves a las|confirmo cita/i.test(lastLine) &&
      tools.some((t) => t.name === 'fidel_agendar_cita')
    ) {
      const trace = await this.mcpHub.executeTool(
        organizationId,
        server.id,
        'fidel_agendar_cita',
        {
          nombre_cliente: 'Prospecto Omnicanal',
          fecha_hora: 'Mañana 18:00 (GMT-5)',
          programa_interes: 'Certificación ClearMinds',
        },
      );
      traces.push(trace);
    }

    // 4. Intención de cotización / proforma
    if (
      /cotizaci|proforma|cuotas|financiamiento|factura/i.test(lastLine) &&
      tools.some((t) => t.name === 'fidel_enviar_cotizacion')
    ) {
      const trace = await this.mcpHub.executeTool(
        organizationId,
        server.id,
        'fidel_enviar_cotizacion',
        { programa: 'Certificación ClearMinds', plan_pago: '3_cuotas' },
      );
      traces.push(trace);
    }

    // 5. Si el servidor MCP tiene herramientas personalizadas externas y hay coincidencia
    const customTools = tools.filter((t) => !t.name.startsWith('fidel_'));
    if (customTools.length > 0 && traces.length === 0) {
      const firstCustom = customTools[0];
      const trace = await this.mcpHub.executeTool(
        organizationId,
        server.id,
        firstCustom.name,
        { query: lastLine.replace(/^cliente:\s*/i, '') },
      );
      traces.push(trace);
    }

    return traces;
  }

  async generateFidelReply(
    organizationId: string,
    context: string,
    options?: { channel?: string; activeMcpServerId?: string | null },
  ): Promise<AiGenerateResult> {
    const channel = options?.channel || 'WHATSAPP';
    const mcpToolTraces = await this.detectAndExecuteMcpTools(
      organizationId,
      context,
      channel,
      options?.activeMcpServerId,
    );

    const mcpContextBlock =
      mcpToolTraces.length > 0
        ? `\n---\nRESULTADOS EN VIVO DE HERRAMIENTAS MCP EJECUTADAS (${mcpToolTraces.map((t) => `${t.serverName} -> ${t.toolName}`).join(', ')}):\n${JSON.stringify(
            mcpToolTraces.map((t) => ({ tool: t.toolName, output: t.result })),
            null,
            2,
          )}\nUsa obligatoriamente estos datos oficiales del MCP para responder al cliente con exactitud.\n---\n`
        : '';

    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      // Respuesta comercial inteligente basada en las trazas MCP cuando no hay API key de Gemini en local
      if (mcpToolTraces.length > 0) {
        const first = mcpToolTraces[0];
        if (first.toolName === 'fidel_consultar_catalogo') {
          const r = first.result;
          return {
            text: `¡Excelente elección! Para ${r.programa || 'nuestro programa'}, la inversión regular es de ${r.inversion_regular || '$220 USD'}, pero hoy cuentas con beca activa quedando en ${r.inversion_beca_vigente || '$149 USD'} (${r.duracion || '6 semanas'}). ¿Te gustaría conocer los horarios disponibles para iniciar?`,
            mcpToolTraces,
          };
        }
        if (first.toolName === 'fidel_consultar_horarios') {
          const slots = Array.isArray(first.result.slots_disponibles)
            ? first.result.slots_disponibles.join(', ')
            : 'Mañana 10:00 o 18:00';
          return {
            text: `Acabo de verificar la agenda en nuestro sistema MCP y tenemos disponibilidad en los siguientes horarios: ${slots}. ¿Cuál de estas opciones te queda mejor para agendar tu sesión?`,
            mcpToolTraces,
          };
        }
        if (first.toolName === 'fidel_agendar_cita') {
          return {
            text: `¡Listo! He agendado tu cita con código ${first.result.confirmacion_id} para ${first.result.fecha_hora}. Te esperamos en: ${first.result.enlace_reunion}. ¿Tienes alguna duda adicional antes de nuestra reunión?`,
            mcpToolTraces,
          };
        }
      }
      return {
        text: `¡Hola! Soy Fidel, asesor comercial de ClearMinds & KrakeDev (${channel}). ¿En qué programa estás interesado hoy para brindarte costos y becas vigentes?`,
        mcpToolTraces,
      };
    }

    const modelId = await this.settings.getGeminiModel(organizationId);
    const behavior = await this.getFidelBehaviorPrompt(organizationId);
    const knowledge = await this.getSalesKnowledgePrompt(organizationId);
    const learnedRulesBlock = await this.formatActiveRulesBlock(organizationId);

    const prompt = `${behavior}

CANAL DE ORIGEN ACTUAL: ${channel}

---
BASE DE CONOCIMIENTO DE VENTAS:
${knowledge}
---
${learnedRulesBlock}${mcpContextBlock}
HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${context || '(Sin mensajes previos)'}

INSTRUCCIÓN: Responde al cliente como Fidel siguiendo todas las reglas de venta, adaptando la brevedad al canal ${channel}, incorporando los datos del MCP si se ejecutaron herramientas y cumpliendo las REGLAS APRENDIDAS EN ENTRENAMIENTO. Devuelve ÚNICAMENTE el texto que se le enviará al cliente:`;

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
        return { text, usedFallbackModel: mId !== modelId, mcpToolTraces };
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
    const mcpToolTraces = await this.detectAndExecuteMcpTools(organizationId, latestMessage);
    const genAI = await this.getGenAI(organizationId);
    if (!genAI) {
      return {
        text: 'Modo entrenamiento local activo. Regla o turno registrado con FidelMCP.',
        mode: 'ROLEPLAY',
        learnedRule: null,
        mcpToolTraces,
      };
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
      reply = rawOutput || 'Entendido.';
    }

    return {
      text: reply,
      mode,
      learnedRule: savedRule,
      usedFallbackModel: usedFallback,
      mcpToolTraces,
    };
  }
}
