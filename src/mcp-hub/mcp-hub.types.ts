export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface McpResourceSchema {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpToolExecutionTrace {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, any>;
  result: Record<string, any>;
  status: 'SUCCESS' | 'ERROR';
  latencyMs: number;
  timestamp: string;
}

export interface McpServerSummary {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  transport: 'http' | 'sse' | 'websocket' | 'stdio';
  endpointUrl: string;
  hasApiKey: boolean;
  isActive: boolean;
  isDefault: boolean;
  assignedChannels: string[];
  tools: McpToolSchema[];
  resources: McpResourceSchema[];
  updatedAt: string;
}
