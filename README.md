# ⚙️ ChatControl — Backend (NestJS)

El núcleo operativo de **ChatControl**, un servicio backend robusto y modular desarrollado sobre **NestJS** y **TypeScript**. Administra la autenticación, la persistencia en base de datos PostgreSQL mediante **Prisma ORM**, la integración oficial de **WhatsApp Cloud API**, y la automatización inteligente a través de **Google Gemini**.

---

## ✨ Características Clave

- **🧩 Arquitectura NestJS**: Modular, altamente escalable y limpia.
- **🗄️ Persistencia de Datos (Prisma)**: Modelado y consultas ultrarrápidas sobre **PostgreSQL** para manejar contactos, conversaciones e historiales de mensajes.
- **💬 Integración de WhatsApp Cloud API (Oficial)**:
  - Recepción de mensajes en tiempo real mediante **Webhooks**.
  - Envío de mensajes y validación rigurosa de ventana de 24 horas.
  - Soporte de modo Sandbox (pruebas de números autorizados).
- **🤖 Motor de IA (Google Gemini)**: 
  - Generación de respuestas sugeridas y automatizadas contextuales según el historial de la conversación.
- **🔒 Autenticación y Seguridad**: Rutas protegidas mediante estrategias **Passport JWT**.
- **🐳 Contenerización Completa**: Configuración lista de desarrollo y despliegue usando Docker y Docker Compose con `pnpm`.

---

## 🛠️ Stack Tecnológico

- **Core**: [NestJS 10](https://nestjs.com/)
- **ORM**: [Prisma ORM](https://www.prisma.io/)
- **Base de Datos**: PostgreSQL (ej. Supabase)
- **IA**: [Google Gemini SDK](https://aistudio.google.com/)
- **Gestor de Paquetes**: `pnpm` (Migrado desde npm para mayor velocidad y consistencia)

---

## 🚀 Requisitos e Instalación

### 1. Requisitos Previos
Asegúrate de tener instalado [Node.js 18+](https://nodejs.org/) y el gestor de paquetes `pnpm`:
```bash
npm install -g pnpm
```

### 2. Configurar Variables de Entorno
Copia el archivo de variables de entorno y edítalo con tus credenciales:
```bash
cp .env.example .env
```

Variables clave en tu archivo `.env`:
- `DATABASE_URL`: URI de conexión a PostgreSQL.
- `JWT_SECRET` / `APP_LOGIN_PASSWORD`: Parámetros de seguridad.
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`: Credenciales de Meta Developer Portal.
- `GEMINI_API_KEY`: API Key de Google AI Studio.
- `WHATSAPP_SANDBOX`: `true` para activar validación de contactos autorizados.

### 3. Instalar Dependencias
```bash
pnpm install
```

### 4. Generar Cliente de Prisma y Aplicar Migraciones
```bash
pnpm run prisma:generate
pnpm run prisma:migrate
```

### 5. Iniciar en Desarrollo
```bash
pnpm run start:dev
```

El servidor backend se levantará en [http://localhost:3001](http://localhost:3001).

## Integración con el CRM de ventas

El código de Nextline sigue llamando `ChatControl` a algunas rutas y pantallas. El backend CRM corre localmente en `http://localhost:3003`; su frontend corre en `http://localhost:4200`.

Variables adicionales en `.env` para la integración:

| Variable | Uso |
| --- | --- |
| `CRM_HMAC_SECRET` | Misma clave que `CRM_HMAC_SECRET` del backend CRM; no se expone al frontend. |
| `ENCRYPTION_MASTER_KEY` | Cifra la API key que Nextline conserva al vincularse. Debe mantenerse estable si ya existe una conexión. |
| `CRM_BASE_URL` | URL alternativa del backend CRM, sin `/api`; por ejemplo `http://localhost:3003`. La URL guardada al vincular tiene prioridad. |

1. Aplica las migraciones Prisma de este backend en la base de Nextline (`pnpm run prisma:migrate` en desarrollo; usa el flujo de migraciones de tu despliegue en producción). El modelo `CrmIntegration` guarda el código y la conexión por organización.
2. Habilita CRM para la organización y, con una cuenta `ORG_ADMIN`, abre **Configuración → Integración CRM** en Nextline (`/settings/crm-integration`). Copia el código de vinculación.
3. En el frontend del CRM abre **Administrador → Integraciones** (`/admin/integraciones`). Pega el código y la URL pública de este backend Nextline, sin `/api` (localmente `http://localhost:3001`). El CRM verifica el código y ambos backends guardan la conexión. El código se regenera al usarlo.
4. En el CRM asocia los agentes de Nextline con vendedores antes del primer envío. Después, en **Nextline → Informes**, filtra y selecciona contactos y pulsa **Enviar a CRM**. Se envían la etiqueta, el agente y la fecha de registro en lotes de hasta 30. El resultado indica creados, actualizados, duplicados y rechazados. El Excel sigue disponible.

La URL que recibe Nextline para enviar informes proviene de `CRM_PUBLIC_URL` en el backend CRM. En producción debe ser el origen público del **backend** CRM, sin `/api`; si cambia después de vincular, vuelve a vincular para actualizarla. Reenviar un contacto existente actualiza sus datos de Nextline en el CRM y conserva su vendedor.

### Respuestas del diplomado

La plantilla de Meta `Diplomado Iapara Docentes` clasifica el contacto como **Interesado** o **No interesado** cuando responde con los botones “Quiero más información” o “No deseo recibir más información”. Se identifica la plantilla del mensaje original al que responde; otros mensajes con el mismo texto no cambian el estado. Una respuesta positiva asigna por turno a un agente activo si el chat aún no tiene agente. Una respuesta negativa deja sin asignar un chat nuevo y conserva cualquier asignación anterior. La respuesta más reciente determina el estado. Los contactos sin respuesta mantienen el estado vacío.

El filtro está disponible en Contactos, Masivos e Informes y no excluye automáticamente de masivos a los no interesados. Este estado permanece en Nextline y no se envía al CRM. Para activar la función, aplica la migración Prisma `20261005000000_contact_interest_status` **antes** de desplegar el backend y el frontend. Los mensajes de plantilla enviados antes de este cambio no tienen el identificador de plantilla necesario para clasificar sus respuestas.

---

## 🌐 Pruebas Locales de Webhooks (WhatsApp/Meta) con Ngrok

Dado que la API de Meta requiere una URL pública segura (HTTPS) para enviarnos los mensajes entrantes (webhooks) en desarrollo local, debes exponer tu servidor local usando un túnel como **Ngrok**.

### 1. Iniciar el túnel
Abre una nueva terminal en tu computadora y arranca el túnel apuntando al puerto del backend (`3001`):
```bash
npx ngrok http 3001
```

### 2. Configurar la URL en Meta Developers
1. Ve al panel de **Meta Developers > WhatsApp > Configuración**.
2. En la sección de Webhooks, haz clic en **Editar**.
3. Configura la **URL de devolución de llamada** usando tu dirección HTTPS de Ngrok, incluyendo el prefijo global `/api` que utiliza el backend:
   ```text
   https://<TU-SUBDOMINIO>.ngrok-free.app/api/whatsapp/webhook
   ```
4. En **Token de verificación**, escribe el token configurado en tu `.env` (por defecto `definir-token-de-verificacion`).
5. Haz clic en **Verificar y guardar**.

### 3. Suscribirse al evento de mensajes (Crítico)
En la lista de campos de Webhooks de Meta, busca el campo **`messages`** y haz clic en **Suscribirse** (el switch debe decir **"Suscrito"**). Sin esta suscripción activa, Meta no reenviará los chats ni los archivos multimedia a tu servidor local.

---

## 🐳 Uso con Docker

Si prefieres levantar todo el ecosistema (PostgreSQL + Backend) usando contenedores:

```bash
docker-compose up --build
```
*El contenedor de desarrollo está configurado por defecto para utilizar `pnpm` y recargar en caliente en el puerto `3001`.*

---

## 📁 Estructura del Directorio

```
ChatControl-Back/
├── prisma/               # Esquema de Prisma, migraciones y seeders de base de datos
├── src/
│   ├── ai/               # Integración con el SDK de Google Gemini
│   ├── auth/             # Módulo de autenticación y estrategias JWT
│   ├── chat/             # Controladores y servicios para gestión de conversaciones y mensajes
│   ├── common/           # Servicios transversales y utilidades (ej. validador de ventana 24h)
│   ├── prisma/           # Inicialización y servicio cliente de base de datos
│   ├── whatsapp/         # Controladores de Webhooks y cliente HTTP oficial para WhatsApp Cloud API
│   └── main.ts           # Punto de entrada de la aplicación
├── Dockerfile            # Configuración de Docker optimizada con pnpm
├── docker-compose.yml    # Configuración de Docker Compose para entorno local
├── package.json          # Definición de scripts y dependencias del proyecto
└── tsconfig.json         # Configuración del compilador TypeScript
```
