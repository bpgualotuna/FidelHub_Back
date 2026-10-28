# Esquema de base de datos - ChatControl MVP

## Modelos

### Contact
Representa un número de WhatsApp externo (cliente). El campo `phone` está normalizado (solo dígitos) y es único. Cada contacto puede tener múltiples conversaciones a lo largo del tiempo. **Escalabilidad:** en el futuro se puede agregar `companyId` para multi-empresa sin romper relaciones existentes.

### Conversation
Representa una ventana de diálogo con un contacto. `lastUserMessageAt` guarda el timestamp del último mensaje entrante (IN) del contacto y es la base para la regla de ventana de 24 horas. Las conversaciones permiten reconstruir el historial completo de un chat. **Escalabilidad:** se puede agregar `companyId` y lógica de “cierre” de ventana (nueva conversación por periodo).

### Message
Representa cada mensaje entrante o saliente. `whatsappMessageId` (WAMID) es único y evita duplicados al reenviar webhooks. `whatsappTimestamp` conserva el tiempo original de WhatsApp. `direction` (IN/OUT), `type` (TEXT, TEMPLATE, IMAGE, VIDEO, AUDIO, DOCUMENT) y `status` permiten listar, filtrar y mostrar estados. Para **texto:** `body` contiene el texto; para **media:** `mediaUrl` guarda la URL (no binarios), `body` el caption opcional, `mimeType` y `fileName` opcionales para renderizar/descargar. **Escalabilidad:** soporta templates, media y estados; futuro multi-empresa puede usar bucket por tenant para las URLs.

## Enums

- **MessageDirection:** IN (entrante), OUT (saliente).
- **MessageType:** TEXT (mensaje libre), TEMPLATE (plantillas), IMAGE, VIDEO, AUDIO, DOCUMENT (media).
- **MessageStatus:** RECEIVED, SENT, DELIVERED, READ, FAILED.

## Índices

- `Contact.phone` único y indexado para búsqueda por número.
- `Conversation`: por `contactId` y por `(contactId, createdAt desc)` para listar conversaciones recientes.
- `Message`: por `conversationId`, por `(conversationId, whatsappTimestamp asc)` para ordenar mensajes del chat, y `whatsappMessageId` único.

## Soporte de media (imagen, video, audio, documento)

**Análisis del esquema anterior:** Solo existían `MessageType` TEXT y TEMPLATE, y el campo `body` (obligatorio) para el contenido. No había forma de distinguir mensajes de media ni de guardar URLs de archivos.

**Cambios realizados (solo en Message):**
1. **Enum MessageType:** se añadieron IMAGE, VIDEO, AUDIO, DOCUMENT. TEXT y TEMPLATE se mantienen → compatibilidad con mensajes de texto existentes.
2. **Campos opcionales en Message:** `mediaUrl` (URL pública o firmada del archivo), `mimeType` (para renderizar/descargar), `fileName` (nombre del archivo, útil en documentos). Todos opcionales → mensajes antiguos y de texto siguen igual; el frontend puede mostrar imágenes cuando `type` es IMAGE/VIDEO/AUDIO/DOCUMENT y `mediaUrl` está presente.
3. **body:** se sigue usando para el texto del mensaje o el caption en media (WhatsApp permite caption en imagen/video). No se eliminó ni se hizo opcional → sin migraciones destructivas.

**Por qué no se guardan binarios:** Se usan URLs (p. ej. de WhatsApp Cloud API o de un bucket tipo Supabase Storage). Escalable a multi-empresa con bucket por tenant en el futuro.

## Por qué el diseño escala a futuro

- No hay tablas de usuarios/empresas/roles en el MVP; se pueden añadir después sin tocar Contact/Conversation/Message.
- Contact y Conversation admiten un futuro `companyId` (nullable y luego obligatorio por tenant) sin migraciones destructivas.
- Message soporta texto y media mediante type + mediaUrl; en el futuro las URLs pueden apuntar a almacenamiento por empresa.
- Nombres en inglés y relaciones claras facilitan extender el modelo sin reescribir el esquema.
