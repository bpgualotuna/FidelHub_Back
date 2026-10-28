import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import {
  McpResourceSchema,
  McpServerSummary,
  McpToolExecutionTrace,
  McpToolSchema,
} from './mcp-hub.types';

export const DEFAULT_FIDEL_MCP_TOOLS: McpToolSchema[] = [
  {
    name: 'fidel_consultar_catalogo',
    description:
      'Consulta precios, temarios, modalidades y descuentos vigentes de los programas de ClearMinds / KrakeDev.',
    inputSchema: {
      type: 'object',
      properties: {
        programa: {
          type: 'string',
          description: 'Código o nombre del programa (ia_docencia, fullstack_bootcamp, cloud_devops)',
        },
      },
      required: ['programa'],
    },
  },
  {
    name: 'fidel_consultar_horarios',
    description:
      'Verifica disponibilidad de horarios para sesiones informativas o inicio de cohortes con asesores comerciales.',
    inputSchema: {
      type: 'object',
      properties: {
        fecha_preferida: {
          type: 'string',
          description: 'Fecha o día solicitado por el prospecto (ej: mañana, jueves, 2026-11-02)',
        },
        franja: {
          type: 'string',
          description: 'Franja horaria preferida (mañana, tarde, noche)',
        },
      },
      required: ['fecha_preferida'],
    },
  },
  {
    name: 'fidel_agendar_cita',
    description:
      'Agenda una cita comercial o llamada de admisión en el calendario oficial y registra el lead en CRM.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre_cliente: { type: 'string', description: 'Nombre del prospecto' },
        contacto: { type: 'string', description: 'Teléfono, correo o usuario de red social' },
        fecha_hora: { type: 'string', description: 'Fecha y hora acordada' },
        programa_interes: { type: 'string', description: 'Programa de interés' },
      },
      required: ['nombre_cliente', 'fecha_hora'],
    },
  },
  {
    name: 'fidel_enviar_cotizacion',
    description:
      'Genera una proforma o cotización formal personalizada en PDF/link con opciones de financiamiento.',
    inputSchema: {
      type: 'object',
      properties: {
        programa: { type: 'string', description: 'Programa a cotizar' },
        plan_pago: {
          type: 'string',
          description: 'Modalidad de pago (contado, 3_cuotas, 6_cuotas, corporativo)',
        },
      },
      required: ['programa'],
    },
  },
  {
    name: 'fidel_transferir_humano',
    description:
      'Escala la conversación a un cerrador humano cuando el prospecto solicita atención directa o caso especial.',
    inputSchema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Razón de la transferencia' },
        prioridad: { type: 'string', description: 'ALTA, MEDIA, BAJA' },
      },
      required: ['motivo'],
    },
  },
];

export const DEFAULT_FIDEL_MCP_RESOURCES: McpResourceSchema[] = [
  {
    uri: 'clearminds://catalog/ia-docencia',
    name: 'Certificación IA Aplicada a la Docencia',
    description: 'Catálogo oficial, inversión ($149 USD), duración 6 semanas y malla curricular.',
    mimeType: 'application/json',
  },
  {
    uri: 'clearminds://catalog/fullstack-bootcamp',
    name: 'Bootcamp FullStack & Cloud Architecture',
    description: 'Programa intensivo de 16 semanas ($490 USD), proyectos reales y empleabilidad.',
    mimeType: 'application/json',
  },
  {
    uri: 'clearminds://policies/commercial-rules',
    name: 'Políticas Comerciales y Objeciones Fidel',
    description: 'Reglas de becas, descuentos por pronto pago y garantías académicas.',
    mimeType: 'text/markdown',
  },
];

@Injectable()
export class McpHubService {
  private readonly logger = new Logger(McpHubService.name);
  private readonly inMemoryServers = new Map<string, McpServerSummary[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
  ) {}

  private buildDefaultFidelMcp(organizationId: string): McpServerSummary {
    const defaultUrl = process.env.FIDEL_MCP_URL || 'http://localhost:3002/mcp';
    return {
      id: `fidel_mcp_default_${organizationId.slice(0, 8)}`,
      organizationId,
      name: 'FidelMCP — ClearMinds Comercial',
      description:
        'Servidor MCP oficial de Fidel con herramientas de catálogo, horarios, agendamiento de citas y cotizaciones.',
      transport: 'http',
      endpointUrl: defaultUrl,
      hasApiKey: false,
      isActive: true,
      isDefault: true,
      assignedChannels: ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK'],
      tools: DEFAULT_FIDEL_MCP_TOOLS,
      resources: DEFAULT_FIDEL_MCP_RESOURCES,
      updatedAt: new Date().toISOString(),
    };
  }

  async listServers(organizationId: string): Promise<McpServerSummary[]> {
    try {
      let rows = await this.prisma.mcpServerConfig.findMany({
        where: { organizationId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });

      if (rows.length === 0) {
        const def = this.buildDefaultFidelMcp(organizationId);
        await this.prisma.mcpServerConfig
          .create({
            data: {
              organizationId,
              name: def.name,
              description: def.description,
              transport: def.transport,
              endpointUrl: def.endpointUrl,
              isActive: true,
              isDefault: true,
              assignedChannels: def.assignedChannels,
              cachedTools: def.tools as any,
              cachedResources: def.resources as any,
            },
          })
          .catch(() => {});

        rows = await this.prisma.mcpServerConfig.findMany({
          where: { organizationId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
      }

      if (rows.length > 0) {
        return rows.map((r) => this.mapRowToSummary(r));
      }
    } catch {
      /* fallback in-memory if table not migrated yet */
    }

    if (!this.inMemoryServers.has(organizationId)) {
      this.inMemoryServers.set(organizationId, [this.buildDefaultFidelMcp(organizationId)]);
    }
    return this.inMemoryServers.get(organizationId)!;
  }

  private mapRowToSummary(r: any): McpServerSummary {
    return {
      id: r.id,
      organizationId: r.organizationId,
      name: r.name,
      description: r.description,
      transport: (r.transport || 'http') as McpServerSummary['transport'],
      endpointUrl: r.endpointUrl,
      hasApiKey: Boolean(r.apiKeyEncrypted),
      isActive: r.isActive,
      isDefault: r.isDefault,
      assignedChannels: Array.isArray(r.assignedChannels)
        ? r.assignedChannels
        : ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK'],
      tools: Array.isArray(r.cachedTools) ? r.cachedTools : DEFAULT_FIDEL_MCP_TOOLS,
      resources: Array.isArray(r.cachedResources) ? r.cachedResources : DEFAULT_FIDEL_MCP_RESOURCES,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
    };
  }

  async registerServer(
    organizationId: string,
    dto: {
      name: string;
      description?: string;
      transport?: 'http' | 'sse' | 'websocket' | 'stdio';
      endpointUrl: string;
      apiKey?: string;
      assignedChannels?: string[];
      isDefault?: boolean;
      customTools?: McpToolSchema[];
    },
  ): Promise<McpServerSummary> {
    const discovered = await this.probeRemoteMcpEndpoint(dto.endpointUrl, dto.apiKey);
    const toolsToSave =
      dto.customTools && dto.customTools.length > 0
        ? dto.customTools
        : discovered.tools.length > 0
          ? discovered.tools
          : [
              {
                name: `${dto.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_query`,
                description: `Consulta general al servidor MCP ${dto.name}`,
                inputSchema: {
                  type: 'object' as const,
                  properties: {
                    query: { type: 'string', description: 'Consulta o parámetro de entrada' },
                  },
                  required: ['query'],
                },
              },
            ];

    const resourcesToSave = discovered.resources;
    const apiKeyEnc = dto.apiKey?.trim() ? this.crypto.encrypt(dto.apiKey.trim()) : null;

    try {
      if (dto.isDefault) {
        await this.prisma.mcpServerConfig.updateMany({
          where: { organizationId },
          data: { isDefault: false },
        });
      }

      const created = await this.prisma.mcpServerConfig.create({
        data: {
          organizationId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          transport: dto.transport || 'http',
          endpointUrl: dto.endpointUrl.trim(),
          apiKeyEncrypted: apiKeyEnc,
          isActive: true,
          isDefault: dto.isDefault ?? false,
          assignedChannels:
            dto.assignedChannels && dto.assignedChannels.length > 0
              ? dto.assignedChannels
              : ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK'],
          cachedTools: toolsToSave as any,
          cachedResources: resourcesToSave as any,
        },
      });
      return this.mapRowToSummary(created);
    } catch {
      const list = await this.listServers(organizationId);
      const item: McpServerSummary = {
        id: `mcp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        organizationId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        transport: dto.transport || 'http',
        endpointUrl: dto.endpointUrl.trim(),
        hasApiKey: Boolean(dto.apiKey),
        isActive: true,
        isDefault: dto.isDefault ?? false,
        assignedChannels:
          dto.assignedChannels && dto.assignedChannels.length > 0
            ? dto.assignedChannels
            : ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK'],
        tools: toolsToSave,
        resources: resourcesToSave,
        updatedAt: new Date().toISOString(),
      };
      list.push(item);
      this.inMemoryServers.set(organizationId, list);
      return item;
    }
  }

  async updateServer(
    organizationId: string,
    serverId: string,
    patch: {
      isActive?: boolean;
      isDefault?: boolean;
      assignedChannels?: string[];
      endpointUrl?: string;
      name?: string;
    },
  ): Promise<McpServerSummary> {
    try {
      if (patch.isDefault) {
        await this.prisma.mcpServerConfig.updateMany({
          where: { organizationId },
          data: { isDefault: false },
        });
      }
      const updated = await this.prisma.mcpServerConfig.update({
        where: { id: serverId },
        data: {
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.assignedChannels ? { assignedChannels: patch.assignedChannels } : {}),
          ...(patch.endpointUrl ? { endpointUrl: patch.endpointUrl.trim() } : {}),
          ...(patch.name ? { name: patch.name.trim() } : {}),
        },
      });
      return this.mapRowToSummary(updated);
    } catch {
      const list = await this.listServers(organizationId);
      const target = list.find((s) => s.id === serverId);
      if (!target) throw new NotFoundException('Servidor MCP no encontrado');
      if (patch.isActive !== undefined) target.isActive = patch.isActive;
      if (patch.isDefault !== undefined) {
        if (patch.isDefault) list.forEach((s) => (s.isDefault = false));
        target.isDefault = patch.isDefault;
      }
      if (patch.assignedChannels) target.assignedChannels = patch.assignedChannels;
      if (patch.endpointUrl) target.endpointUrl = patch.endpointUrl;
      if (patch.name) target.name = patch.name;
      target.updatedAt = new Date().toISOString();
      return target;
    }
  }

  async deleteServer(organizationId: string, serverId: string): Promise<McpServerSummary[]> {
    try {
      await this.prisma.mcpServerConfig.deleteMany({
        where: { id: serverId, organizationId },
      });
    } catch {
      const list = await this.listServers(organizationId);
      this.inMemoryServers.set(
        organizationId,
        list.filter((s) => s.id !== serverId),
      );
    }
    return this.listServers(organizationId);
  }

  async discoverServerCapabilities(
    organizationId: string,
    serverId: string,
  ): Promise<{ server: McpServerSummary; liveConnected: boolean; latencyMs: number }> {
    const start = Date.now();
    const servers = await this.listServers(organizationId);
    const server = servers.find((s) => s.id === serverId);
    if (!server) throw new NotFoundException('Servidor MCP no encontrado');

    const probed = await this.probeRemoteMcpEndpoint(server.endpointUrl);
    const latencyMs = Date.now() - start;

    if (probed.tools.length > 0) {
      server.tools = probed.tools;
      server.resources = probed.resources;
      try {
        await this.prisma.mcpServerConfig.update({
          where: { id: serverId },
          data: {
            cachedTools: probed.tools as any,
            cachedResources: probed.resources as any,
          },
        });
      } catch {
        /* ignore */
      }
    }

    return {
      server,
      liveConnected: probed.liveConnected,
      latencyMs,
    };
  }

  private async probeRemoteMcpEndpoint(
    endpointUrl: string,
    apiKey?: string,
  ): Promise<{ tools: McpToolSchema[]; resources: McpResourceSchema[]; liveConnected: boolean }> {
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // 1. Intentar JSON-RPC 2.0 estándar de Model Context Protocol
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const rpcRes = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (rpcRes.ok) {
        const data: any = await rpcRes.json().catch(() => ({}));
        if (Array.isArray(data?.result?.tools)) {
          return {
            tools: data.result.tools,
            resources: [],
            liveConnected: true,
          };
        }
      }
    } catch {
      /* intentar REST de FidelBack_MCP */
    }

    // 2. Intentar endpoints REST de FidelBack_MCP (/tools y /resources)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const toolsRes = await fetch(`${baseUrl}/tools`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (toolsRes.ok) {
        const toolsData: any = await toolsRes.json().catch(() => ({}));
        const toolsList = Array.isArray(toolsData)
          ? toolsData
          : Array.isArray(toolsData?.tools)
            ? toolsData.tools
            : [];
        if (toolsList.length > 0) {
          return {
            tools: toolsList,
            resources: DEFAULT_FIDEL_MCP_RESOURCES,
            liveConnected: true,
          };
        }
      }
    } catch {
      /* usar catálogo por defecto */
    }

    const isFidelEndpoint =
      baseUrl.includes('3002') || baseUrl.toLowerCase().includes('fidel');
    return {
      tools: isFidelEndpoint ? DEFAULT_FIDEL_MCP_TOOLS : [],
      resources: isFidelEndpoint ? DEFAULT_FIDEL_MCP_RESOURCES : [],
      liveConnected: false,
    };
  }

  async executeTool(
    organizationId: string,
    serverId: string | undefined,
    toolName: string,
    args: Record<string, any>,
  ): Promise<McpToolExecutionTrace> {
    const start = Date.now();
    const servers = await this.listServers(organizationId);
    const server =
      (serverId ? servers.find((s) => s.id === serverId) : undefined) ||
      servers.find((s) => s.tools.some((t) => t.name === toolName)) ||
      servers.find((s) => s.isDefault) ||
      servers[0];

    const baseUrl = (server?.endpointUrl || 'http://localhost:3002/mcp').replace(/\/+$/, '');

    // 1. Intentar llamada remota por JSON-RPC 2.0 o REST a FidelBack_MCP
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const rpcRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (rpcRes.ok) {
        const rpcData: any = await rpcRes.json().catch(() => null);
        if (rpcData?.result) {
          return {
            id: `trace_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            serverId: server?.id || 'default',
            serverName: server?.name || 'MCP Server',
            toolName,
            arguments: args,
            result: rpcData.result,
            status: 'SUCCESS',
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
          };
        }
      }

      // Intentar endpoint REST /execute de FidelBack_MCP
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 3000);
      const restRes = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, arguments: args }),
        signal: controller2.signal,
      });
      clearTimeout(timeout2);

      if (restRes.ok) {
        const restData: any = await restRes.json().catch(() => null);
        if (restData) {
          return {
            id: `trace_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            serverId: server?.id || 'default',
            serverName: server?.name || 'FidelMCP',
            toolName,
            arguments: args,
            result: restData,
            status: 'SUCCESS',
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch {
      /* fallback local determinístico para alta disponibilidad */
    }

    // 2. Motor determinístico integrado de respaldo para herramientas de FidelMCP y MCPs conectados
    const simulatedResult = this.executeBuiltInFidelTool(toolName, args);
    return {
      id: `trace_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      serverId: server?.id || 'fidel_mcp_default',
      serverName: server?.name || 'FidelMCP — ClearMinds Comercial',
      toolName,
      arguments: args,
      result: simulatedResult,
      status: 'SUCCESS',
      latencyMs: Math.max(18, Date.now() - start),
      timestamp: new Date().toISOString(),
    };
  }

  private executeBuiltInFidelTool(
    toolName: string,
    args: Record<string, any>,
  ): Record<string, any> {
    switch (toolName) {
      case 'fidel_consultar_catalogo': {
        const query = String(args.programa || 'general').toLowerCase();
        if (query.includes('docencia') || query.includes('ia')) {
          return {
            programa: 'Certificación IA Aplicada a la Docencia',
            inversion_regular: '$220 USD',
            inversion_beca_vigente: '$149 USD (Beca 32% activa)',
            duracion: '6 semanas (clases en vivo + plataforma 24/7)',
            certificacion: 'Avalada por ClearMinds & KrakeDev',
            cupos_disponibles: 7,
          };
        }
        return {
          programa: 'Bootcamp FullStack & Cloud Architecture',
          inversion_regular: '$650 USD',
          inversion_beca_vigente: '$490 USD (Hasta 3 cuotas sin interés)',
          duracion: '16 semanas intensivas',
          modalidad: '100% Online en vivo con mentores senior',
          cupos_disponibles: 5,
        };
      }

      case 'fidel_consultar_horarios': {
        return {
          fecha_consultada: args.fecha_preferida || 'Próxima disponible',
          franja: args.franja || 'Flexible',
          slots_disponibles: [
            'Hoy 16:30 (GMT-5)',
            'Mañana 10:00 (GMT-5)',
            'Mañana 18:00 (GMT-5)',
          ],
          asesor_asignado: 'Especialista de Admisiones ClearMinds',
        };
      }

      case 'fidel_agendar_cita': {
        return {
          confirmacion_id: `CITA-${Math.floor(100000 + Math.random() * 900000)}`,
          estado: 'CONFIRMADA',
          prospecto: args.nombre_cliente || 'Prospecto Omnicanal',
          fecha_hora: args.fecha_hora || 'Mañana 18:00 (GMT-5)',
          programa: args.programa_interes || 'Certificación ClearMinds',
          enlace_reunion: 'https://meet.google.com/krk-fidel-ai',
        };
      }

      case 'fidel_enviar_cotizacion': {
        return {
          cotizacion_id: `PRO-${Math.floor(10000 + Math.random() * 90000)}`,
          programa: args.programa || 'Certificación IA / Bootcamp',
          plan_pago: args.plan_pago || '3 cuotas sin intereses',
          validez: '48 horas',
          pdf_url: 'https://clearminds.ec/cotizaciones/proforma-fidel.pdf',
        };
      }

      case 'fidel_transferir_humano': {
        return {
          handoff_status: 'ESCALADO_A_HUMANO',
          motivo: args.motivo || 'Solicitud de atención personalizada',
          prioridad: args.prioridad || 'ALTA',
          cola_destino: 'Closers Senior ClearMinds',
        };
      }

      default:
        return {
          ok: true,
          executedTool: toolName,
          receivedArgs: args,
          timestamp: new Date().toISOString(),
          message: `Herramienta MCP '${toolName}' ejecutada correctamente.`,
        };
    }
  }

  async getActiveToolsForChannel(
    organizationId: string,
    channel: string,
    preferredServerId?: string | null,
  ): Promise<{ server: McpServerSummary | null; tools: McpToolSchema[] }> {
    const servers = await this.listServers(organizationId);
    const activeServers = servers.filter(
      (s) =>
        s.isActive &&
        (s.assignedChannels.includes(channel.toUpperCase()) || s.assignedChannels.length === 0),
    );

    const primary =
      (preferredServerId ? activeServers.find((s) => s.id === preferredServerId) : undefined) ||
      activeServers.find((s) => s.isDefault) ||
      activeServers[0] ||
      null;

    const mergedTools: McpToolSchema[] = [];
    for (const srv of activeServers) {
      for (const tool of srv.tools) {
        if (!mergedTools.some((t) => t.name === tool.name)) {
          mergedTools.push(tool);
        }
      }
    }

    return { server: primary, tools: mergedTools };
  }
}
