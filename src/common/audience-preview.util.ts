import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';

export interface AudiencePreviewResult {
  total: number;
  unique: number;
  duplicates: number;
  invalid: number;
  blocked: number;
  conversationIds: string[];
}

/**
 * Dado un listado de contactos (puede tener contactId repetido, ej. un mismo contacto
 * en varias listas seleccionadas), calcula la vista previa de audiencia: dedupe, valida
 * teléfonos, asegura que exista una Conversation para cada contacto y cruza contra la
 * ventana de 24h/sandbox para marcar bloqueados.
 */
export async function computeAudiencePreview(
  prisma: PrismaService,
  chat: ChatService,
  organizationId: string,
  contacts: Array<{ contactId: string; phone: string }>,
  userId?: string,
  userRole?: string,
): Promise<AudiencePreviewResult> {
  const uniqueContactIds = [...new Set(contacts.map((c) => c.contactId))];
  const duplicates = contacts.length - uniqueContactIds.length;

  const windowMap = new Map<string, { canSend: boolean; isSandboxAuthorized: boolean }>();
  const conversations = await chat.getConversationsWithWindowStatus(organizationId, userId, userRole);
  for (const conv of conversations) {
    windowMap.set(conv.id, {
      canSend: conv.canSend,
      isSandboxAuthorized: conv.isSandboxAuthorized ?? false,
    });
  }

  const conversationIds: string[] = [];
  let invalid = 0;
  let blocked = 0;

  for (const contactId of uniqueContactIds) {
    const entry = contacts.find((c) => c.contactId === contactId);
    const phone = entry?.phone || '';
    if (!phone || phone.replace(/\D/g, '').length < 7) {
      invalid += 1;
      continue;
    }

    let conv = await prisma.conversation.findFirst({ where: { contactId } });
    if (!conv) {
      conv = await prisma.conversation.create({ data: { contactId } });
    }

    const status = windowMap.get(conv.id);
    if (status && !status.canSend && !status.isSandboxAuthorized) {
      blocked += 1;
    }
    conversationIds.push(conv.id);
  }

  return {
    total: contacts.length,
    unique: uniqueContactIds.length,
    duplicates,
    invalid,
    blocked,
    conversationIds,
  };
}
