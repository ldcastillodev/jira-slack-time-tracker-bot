# Jira Time Tracker Bot

Bot interactivo que gestiona la carga de horas diarias del equipo, integrando **Jira** y **Slack** sobre **Cloudflare Workers**.

## ¿Qué hace?

Todos los días de lunes a viernes a las **4:00 PM ET**, el bot:

1. Lee los worklogs de Jira de los boards configurados.
2. Calcula las horas cargadas por cada persona en el día.
3. Envía un mensaje directo (DM) en Slack a cada usuario configurado con:

| Escenario | Comportamiento |
|-----------|---------------|
| **< 8h cargadas** | Muestra el desglose + **3 ranuras interactivas** para cargar horas en múltiples tickets a la vez (intervalos de 0.5h). Valida duplicados, datos parciales, límite diario y datos obsoletos contra Jira en tiempo real. |
| **= 8h cargadas** | Muestra solo el desglose de horas como confirmación. Sin opciones interactivas. |
| **Viernes** | Además del reporte diario, incluye un resumen semanal con el total vs. el objetivo de 40h y el desglose día por día. |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                  Cloudflare Worker                   │
│                                                     │
│  ┌──────────┐    ┌─────────────────────────────┐    │
│  │  Cron    │───▶│ Jira API: fetch worklogs    │    │
│  │ 4PM ET   │    │ Aggregate per user           │    │
│  │ Mon-Fri  │    │ Build Block Kit message      │    │
│  │          │    │ (3 ranuras + targetDate)     │    │
│  │          │───▶│ Slack API: send DM           │    │
│  └──────────┘    └─────────────────────────────┘    │
│                                                     │
│  ┌──────────┐    ┌─────────────────────────────┐    │
│  │  POST    │───▶│ Verify Slack signature       │    │
│  │ /slack/  │    │ Validate targetDate + week   │    │
│  │ interact │    │ Parse 3 slots, check dupes   │    │
│  │          │    │ Re-fetch Jira (stale guard)  │    │
│  │          │───▶│ POST worklogs, update msg    │    │
│  └──────────┘    └─────────────────────────────┘    │
│                                                     │
│  ┌──────────┐                                       │
│  │ Workers  │  Cache: Slack user IDs, Jira          │
│  │   KV     │  accountId→email mappings              │
│  └──────────┘                                       │
└─────────────────────────────────────────────────────┘
```

---

## Carga Múltiple de Horas (3 Ranuras)

### Interfaz

Cuando un usuario tiene menos de 8h cargadas, el mensaje de Slack renderiza **3 ranuras (slots)** pre-generadas. Cada ranura contiene:
- Un `static_select` para elegir un ticket (`ticket_block_0..2` / `select_ticket_0..2`)
- Un `static_select` para elegir horas (`hours_block_0..2` / `select_hours_0..2`)

Un único botón **"✅ Cargar horas"** al final envía las 3 ranuras juntas. El usuario puede usar 1, 2 o las 3 ranuras.

### Codificación de `targetDate`

El campo `value` del botón Submit contiene la fecha objetivo (ej: `2026-04-02`) para la que se generó la alerta. Esto permite:
- Cargar horas en **la fecha correcta** aunque el usuario haga clic un día después.
- **Rechazar** la carga si la fecha actual ya no pertenece a la misma semana calendario ISO (Lunes–Domingo).

### Reglas de Validación (Backend)

Al recibir el submit, el backend ejecuta esta cadena de validaciones en orden:

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
  _(actualizar después del deploy)_

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

Después del deploy, actualizar la **Request URL** de Interactivity en la Slack App con:
```
https://jira-time-tracker-bot.<tu-subdomain>.workers.dev/slack/interactions
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
│   │   ├── cron.ts                 # 4PM ET notification logic
│   │   └── slack-interaction.ts    # Slack webhook handler
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
