# Jira Time Tracker Bot

Bot interactivo que gestiona la carga de horas diarias del equipo, integrando **Jira** y **Slack** sobre **Cloudflare Workers**.

## ¿Qué hace?

Todos los días de lunes a viernes a las **4:00 PM ET**, el bot:

1. Lee los worklogs de Jira de los boards configurados.
2. Calcula las horas cargadas por cada persona en el día.
3. Envía un mensaje directo (DM) en Slack a cada usuario configurado con:

| Escenario | Comportamiento |
|-----------|---------------|
| **< 8h cargadas** | Muestra el desglose + **ranuras interactivas dinámicas** (3 por defecto, expandibles hasta 10 con botón "➕ Agregar ticket") para cargar horas en múltiples tickets a la vez (intervalos de 0.5h). Los tickets se buscan con typeahead (sin límite de 100). Valida duplicados, datos parciales, límite diario y datos obsoletos contra Jira en tiempo real. |
| **= 8h cargadas** | Muestra solo el desglose de horas como confirmación. Sin opciones interactivas. |
| **Viernes** | Además del reporte diario, incluye un resumen semanal con el total vs. el objetivo de 40h y el desglose día por día. |

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                       │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  Cron    │───▶│ Jira API: fetch worklogs         │    │
│  │ 4PM ET   │    │ Aggregate per user                │    │
│  │ Mon-Fri  │    │ Cache all tickets in KV            │    │
│  │          │    │ Build Block Kit (dynamic slots)    │    │
│  │          │───▶│ Slack API: send DM                │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature            │    │
│  │ /slack/  │    │ submit_hours: validate + post     │    │
│  │ interact │    │ add_slot: add slot + preserve      │    │
│  │          │───▶│ Re-fetch Jira (stale guard)       │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature            │    │
│  │ /slack/  │    │ Read ticket cache from KV         │    │
│  │ options  │    │ Filter by query (typeahead)       │    │
│  │          │───▶│ Return option_groups (max 100)    │    │
│  └──────────┘    └──────────────────────────────────┘    │
│                                                          │
│  ┌──────────┐                                            │
│  │ Workers  │  Cache: Slack user IDs, Jira accountId     │
│  │   KV     │  → email map, all_tickets (typeahead)      │
│  └──────────┘                                            │
└──────────────────────────────────────────────────────────┘
```

---

## Carga Múltiple de Horas (Ranuras Dinámicas)

### Interfaz

Cuando un usuario tiene menos de 8h cargadas, el mensaje de Slack renderiza **3 ranuras (slots) iniciales**, expandibles hasta **10** con el botón **"➕ Agregar ticket"**. Cada ranura contiene:
- Un `external_select` con búsqueda typeahead para elegir un ticket (sin límite de 100)
- Un `static_select` para elegir horas (intervalos de 0.5h)

Botones disponibles:
- **"✅ Cargar horas"** — Envía todas las ranuras completas
- **"➕ Agregar ticket"** — Agrega una ranura adicional preservando las selecciones existentes

### Búsqueda de Tickets (external_select)

Los selectores de ticket usan `external_select` con `min_query_length: 0`, lo que significa:
- Al hacer clic en el selector, se muestran los tickets más relevantes (genéricos + proyecto)
- Al escribir, se filtran dinámicamente por key o summary
- Sin límite de 100 tickets (la búsqueda filtra del cache completo)
- El endpoint `/slack/options` responde con `option_groups` separando "📌 Tickets Genéricos" y "📋 Tickets de Proyecto"

El cache de tickets se actualiza automáticamente en cada ejecución del cron (4PM ET) y se almacena en KV con key `all_tickets`.

### Codificación de `targetDate`

El campo `value` del botón Submit contiene la fecha objetivo (ej: `2026-04-02`) para la que se generó la alerta. Esto permite:
- Cargar horas en **la fecha correcta** aunque el usuario haga clic un día después.
- **Rechazar** la carga si la fecha actual ya no pertenece a la misma semana calendario ISO (Lunes–Domingo).

El botón "➕ Agregar ticket" codifica `{slotCount}:{targetDate}` en su `value` para preservar el contexto.

### Reglas de Validación (Backend)

Al recibir el submit, el backend detecta dinámicamente la cantidad de slots desde `state.values` y ejecuta esta cadena de validaciones en orden:

| # | Validación | Comportamiento si falla |
|---|-----------|------------------------|
| 1 | **Semana calendario** — `targetDate` debe estar en la misma semana ISO que la fecha actual (ET) | Reemplaza el mensaje con aviso de período expirado |
| 2 | **Datos parciales** — Cada ranura debe tener ambos campos (ticket + horas) o estar vacía | Error indicando qué ranura(s) están incompletas |
| 3 | **Al menos 1 ranura** — Debe haber mínimo una ranura completa | Error solicitando completar al menos una |
| 4 | **Tickets duplicados** — No se permite el mismo ticket en más de una ranura | Error indicando la duplicación |
| 5 | **Suma vs. límite** — El total enviado no debe exceder `dailyTarget` (8h) | Error con el total enviado |
| 6 | **Stale-data guard** — Se re-fetcha Jira para obtener las horas actuales reales. `horasActuales + totalEnviado ≤ dailyTarget` | Reemplaza mensaje con saldo real actualizado y nuevas ranuras interactivas |
| 7 | **POST worklogs** — Se envían los worklogs uno por uno | Si alguno falla, se reporta cuál y los exitosos se confirman |

---

## Prerrequisitos

- **Cloudflare account** (free tier es suficiente)
- **Node.js** >= 18
- **Wrangler CLI** (`npm install -g wrangler`)
- Acceso de administrador al **Slack workspace**
- **Jira Cloud** con permisos para crear API tokens

---

## Setup paso a paso

### 1. Crear Slack App

1. Ir a [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Nombre: `Jira Time Tracker` (o el que prefieras)
3. Seleccionar tu workspace

#### Bot Token Scopes (OAuth & Permissions)
Agregar estos scopes:
- `chat:write` — Enviar mensajes
- `users:read.email` — Buscar usuarios por email
- `im:write` — Abrir DMs con usuarios

#### Interactivity & Shortcuts
- **Activar Interactivity**
- **Request URL**: `https://jira-time-tracker-bot.<tu-account>.workers.dev/slack/interactions`
- **Options Load URL**: `https://jira-time-tracker-bot.<tu-account>.workers.dev/slack/options`
  _(actualizar ambas URLs después del deploy)_

#### Install to Workspace
- Instalar la app y copiar:
  - **Bot User OAuth Token** (`xoxb-...`) → será `SLACK_BOT_TOKEN`
  - **Signing Secret** (en Basic Information) → será `SLACK_SIGNING_SECRET`

### 2. Crear Jira API Token

1. Ir a [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. **Create API token** → copiar el valor → será `JIRA_API_TOKEN`
3. El email de la cuenta será `JIRA_USER_EMAIL`

> **Recomendación**: usa una cuenta de servicio (no personal) para producción.

### 3. Configurar el proyecto

```bash
cd jira-time-tracker-bot

# Instalar dependencias
npm install

# Copiar archivo de secrets para desarrollo local
cp .dev.vars.example .dev.vars
```

Editar `.dev.vars` con tus valores reales:
```env
JIRA_API_TOKEN=ATATT3xFfGF0...
JIRA_USER_EMAIL=tu.email@company.com
SLACK_BOT_TOKEN=xoxb-123456-789...
SLACK_SIGNING_SECRET=abc123def456...
```

### 4. Configurar boards, usuarios y tickets

Editar `config/tracker-config.json`:

```json
{
  "jira": {
    "boards": ["MP", "PROJ2"],
    "genericTickets": [
      { "key": "MP-100", "label": "Client requested meetings" },
      { "key": "MP-101", "label": "Others" }
    ]
  },
  "tracking": {
    "dailyTarget": 8,
    "weeklyTarget": 40,
    "timezone": "America/New_York",
    "cronHourET": 16
  },
  "users": [
    "john.doe@applydigital.com",
    "jane.smith@applydigital.com"
  ]
}
```

| Campo | Descripción |
|-------|-------------|
| `jira.boards` | Keys de los proyectos de Jira donde buscar worklogs |
| `jira.genericTickets` | Tickets predefinidos que siempre aparecen en el dropdown (deben existir en Jira) |
| `tracking.dailyTarget` | Horas objetivo por día (default: 8) |
| `tracking.weeklyTarget` | Horas objetivo por semana (default: 40) |
| `tracking.cronHourET` | Hora en ET para enviar notificaciones (default: 16 = 4PM) |
| `users` | Lista de emails de las personas que recibirán notificaciones |

### 5. Crear KV namespace

```bash
# Login a Cloudflare
wrangler login

# Crear namespace para producción
wrangler kv namespace create CACHE

# Crear namespace para preview/dev
wrangler kv namespace create CACHE --preview
```

Copiar los IDs generados y actualizar `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "CACHE"
id = "tu-id-de-produccion"
preview_id = "tu-id-de-preview"
```

### 6. Configurar secrets en Cloudflare

```bash
wrangler secret put JIRA_API_TOKEN
wrangler secret put JIRA_USER_EMAIL
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

### 7. Deploy

```bash
wrangler deploy
```

Después del deploy, actualizar las URLs en la Slack App:
- **Request URL** (Interactivity): `https://jira-time-tracker-bot.<tu-subdomain>.workers.dev/slack/interactions`
- **Options Load URL** (Interactivity): `https://jira-time-tracker-bot.<tu-subdomain>.workers.dev/slack/options`

---

## CI/CD con GitHub Actions

El proyecto incluye un workflow de GitHub Actions con dos etapas:
- `build`: corre en pushes y pull requests contra `master`, instala dependencias, ejecuta type-check y genera el bundle del Worker con `wrangler deploy --dry-run`
- `deploy`: corre solo en pushes a `master` y únicamente si el job de build pasó

### Configurar secretos en GitHub

En tu repositorio → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secreto | Descripción | Cómo obtenerlo |
|---------|------------|----------------|
| `CLOUDFLARE_API_TOKEN` | Token API con permisos `Workers Scripts:Edit` | [Cloudflare Dashboard → API Tokens → Create Token](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | ID de la cuenta Cloudflare | Cloudflare Dashboard → Overview (sidebar derecho) |

> **Nota**: Los secretos de Jira y Slack no se necesitan en GitHub — ya están configurados en Cloudflare vía `wrangler secret put`.

Variables y secretos recomendados:
- GitHub `Secrets`: solo credenciales de CI/CD, por ejemplo `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`
- Cloudflare Worker Secrets: `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `USERS`, `JIRA_CONFIG`
- `wrangler.toml`: valores no sensibles y estáticos, por ejemplo bindings, cron y `JIRA_BASE_URL` si no consideras ese dato sensible
- GitHub `Variables`: solo si más adelante necesitas parámetros no sensibles exclusivos del pipeline; hoy no hacen falta

### Flujo del workflow

```
push/pull_request master → checkout → setup-node@20 → npm ci → tsc --noEmit → wrangler deploy --dry-run
push master + build OK → wrangler deploy
```

---

## Desarrollo local

```bash
# Iniciar servidor de desarrollo
wrangler dev

# El worker estará en http://localhost:8787
```

### Probar el cron manualmente
```bash
# Usando el endpoint de test (ignora la validación de hora ET)
curl -X POST http://localhost:8787/trigger

# Usando el endpoint nativo de Cloudflare para cron
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

### Probar interacciones de Slack localmente

Para que Slack pueda enviar webhooks a tu máquina local:

```bash
# En otra terminal, exponer el servidor local
ngrok http 8787

# Copiar la URL generada (https://xxxx.ngrok.io)
# y actualizarla como Request URL en Slack App → Interactivity
```

### Health check
```bash
curl http://localhost:8787/health
# → OK
```

---

## Estructura de archivos

```
jira-time-tracker-bot/
├── src/
│   ├── index.ts                    # Entry: fetch + scheduled handlers
│   ├── config.ts                   # Config loader + validation
│   ├── types/
│   │   └── index.ts                # TypeScript interfaces
│   ├── handlers/
│   │   ├── cron.ts                 # 4PM ET notification logic + ticket cache
│   │   ├── slack-interaction.ts    # Slack webhook handler (submit + add_slot)
│   │   └── slack-options.ts        # external_select typeahead endpoint
│   ├── services/
│   │   ├── jira.ts                 # Jira REST API v3 client
│   │   ├── slack.ts                # Slack Web API + KV cache
│   │   └── aggregator.ts          # Hours aggregation
│   ├── builders/
│   │   └── message-builder.ts      # Block Kit construction
│   └── utils/
│       ├── date.ts                 # Date/timezone utilities
│       └── crypto.ts               # HMAC-SHA256 signature verification
├── config/
│   └── tracker-config.json         # Boards, users, tickets, thresholds
├── wrangler.toml                   # CF Worker config + cron
├── tsconfig.json
├── package.json
├── .dev.vars.example               # Secret template
├── .github/
│   └── workflows/
│       └── deploy.yml              # CI/CD: auto-deploy on push to main
├── .gitignore
└── README.md
```

---

## Troubleshooting

### El bot no envía mensajes
- Verificar que los emails en `config/tracker-config.json` coinciden exactamente con los emails de Slack y Jira
- Revisar logs: `wrangler tail`
- Verificar que la Slack App tiene los scopes necesarios y está instalada en el workspace

### Error 401 en interacciones de Slack
- Verificar que `SLACK_SIGNING_SECRET` es correcto (está en Basic Information de la Slack App, NO es el Bot Token)
- Verificar que la Request URL en Interactivity apunta al Worker correcto

### No se cargan horas en Jira
- Verificar que `JIRA_API_TOKEN` es válido y no ha expirado
- El email en `JIRA_USER_EMAIL` debe tener permisos de escritura en los proyectos configurados
- Los tickets genéricos (`genericTickets`) deben existir en Jira

### El cron no se ejecuta a las 4PM ET
- El Worker usa dos cron triggers UTC (20:00 y 21:00) para cubrir EDT y EST
- Solo uno ejecuta la lógica basándose en la hora ET real
- Verificar con `wrangler tail` que el cron se está disparando

### Límite de subrequests en free tier
- El free tier permite 50 subrequests por invocación
- Si el equipo tiene muchos usuarios o tickets, considerar upgrade a Paid ($5/month → 10K subrequests)

---

## Costos

| Componente | Free Tier | Cuándo pagar |
|-----------|-----------|-------------|
| Cloudflare Worker | 100K req/day | >100K req/day → $5/month |
| KV Reads | 100K/day | >100K/day |
| KV Writes | 1K/day | >1K/day |
| Cron Triggers | 5 (usamos 2) | >5 |
| CPU Time (cron) | 10ms | Si se excede → $5/month plan gives 30s |

Para un equipo de hasta ~20 personas, el free tier debería ser suficiente.
