# DESIGN.md

Documento de diseño de `acp-connector`. Adaptado al contexto de un CLI/bridge
(sin componentes de UI): documenta patrones de arquitectura, convenciones de
mensajes, máquinas de estado, límites de plataforma y seguridad HTTP.

## Patrones de arquitectura

- **Thin bridge**: sin loop de agente, sin model provider, sin tools. El bridge
  solo transporta prompts y updates entre una plataforma de mensajería y un
  agente ACP arbitrario.
- **Agent-agnostic**: `agentCmd` es un string arbitrario (ej. `acp-agent serve`,
  `claude acp`, `gemini acp`). No hay referencias hardcodeadas a agentes
  específicos en el código fuente.
- **Cola serializada**: un prompt a la vez por sesión. `session/prompt` es
  bloqueante, por lo que `BridgeBot`/`DiscordBot` mantienen una `queue: QueueItem[]`
  FIFO procesada por `_processQueue()`, que solo despacha el siguiente item si
  `busy === false`.
- **Config is truth**: todo el estado persistente vive en `acp-connector.jsonc`
  (JSONC con comentarios y trailing commas). `RoutineManager._persist()` recarga
  la config, la muta y la guarda completa.
- **PlatformBot interface**: interfaz compartida (`start`, `stop`, `enqueuePrompt`,
  `sendMessage`, `hasActivePrompt`) implementada por `BridgeBot` (Telegram) y
  `DiscordBot`. El bridge orquesta sobre `PlatformBot[]`, sin importar la
  plataforma concreta.
- **Inyección post-construcción**: `MediaHandler` se crea después de `acp.start()`
  (para conocer `promptCapabilities.image`) y se inyecta en los bots ya
  construidos.
- **Permission routing**: `acp.onPermission` recorre `bots` y despacha al bot con
  `hasActivePrompt() === true`; si ninguno tiene prompt activo, cancela.
- **Shutdown cooperativo**: `SIGINT`/`SIGTERM` detienen HTTP, cron, bots y ACP en
  orden, luego `process.exit(0)`. Un `setInterval` vacío mantiene el proceso vivo.

## Convenciones de mensajes

### Streaming
- Batching con `STREAM_BATCH_MS = 800` ms (constante compartida por TG y Discord).
- Se edita un **único** mensaje por prompt: el primer chunk se envía con
  `sendMessage`, los siguientes se actualizan con `editMessageText` (TG) /
  `message.edit` (Discord).
- `streamBuffer` acumula el texto; `streamDirty` indica si hay cambios sin flushear;
  `streamTimer` programa el flush.
- Al recibir `stop`, se flushea el stream restante y luego el overflow.

### Tipos de update ACP
| `sessionUpdate` | Acción |
|---|---|
| `agent_message_chunk` | Append al buffer (content.type === 'text') |
| `agent_message` | Reemplazo del buffer (content array o single) |
| `agent_thought_chunk` | Append solo si `showThoughts=true` |
| `agent_thought` | Append solo si `showThoughts=true` |
| `stop` | Fin del loop de updates |

### Parse mode y fallback
- **Telegram**: `parse_mode: 'Markdown'` en send y edit. Si Telegram rechaza con
  error de parseo (`parse` / `entity` en el mensaje), se reintenta **sin**
  `parse_mode` (texto plano). Aplica tanto al flush del stream como al overflow.
- **Discord**: texto plano, sin `parse_mode` en send ni edit. Los fallos de
  edición son no-fatales (silenciados).

### Overflow
- Cuando `streamBuffer.length > MAX_LEN`, los chunks excedentes se envían como
  mensajes nuevos (send), respetando el mismo límite y el mismo fallback de parse.

## Patrones de estado

Estados del bot (TG y Discord comparten la misma máquina):

- **Idle**: `busy=false`, `currentChatId`/`currentChannelId = null`, sin prompt activo.
  - Transición a **Processing** al despachar un item de la cola.
- **Processing**: `busy=true`, `currentChatId`/`currentChannelId` set,
  `currentMessageId`/`currentMessage` set tras primer flush.
  - Loop `for(;;)` consumiendo `acp.nextUpdate()` hasta `kind === 'stop'`.
  - Transición a **Idle** al finalizar (catch incluido).
- **Permission pending**: `permissionPending != null`, botones inline enviados
  (`Permiso requerido`). Se resuelve via `callback_query` (TG) / `interactionCreate`
  (Discord) con `perm_allow_*` / `perm_deny_*`.
- **Error**: cualquier excepción en `prompt()` o `nextUpdate()` envía
  `Error: <msg>` al chat/canal y vuelve a **Idle**.

Estados del AcpClient:

- **Not started**: `_started=false`, `session=null`. `prompt()` lanza.
- **Starting**: spawn + initialize + session load/resume/build en curso.
- **Ready**: `session` y `sessionId` set, `_sessionReady` resuelto.
- **Killed**: `_killed=true`, `session.dispose()` llamado, proceso killado.
  Idempotente: segundo `kill()` no-op.

## Límites de plataforma

| Plataforma | Max len | Parse mode | Edición |
|---|---|---|---|
| Telegram | 4096 (`TG_MAX_LEN`) | Markdown (fallback plain) | `editMessageText` |
| Discord | 2000 (`DISCORD_MAX_LEN`) | Plain (sin parse_mode) | `message.edit` |

## Comandos builtin

Comandos manejados antes de reenviar al agente (en `_handleBuiltinCommand`):

| Comando | Comportamiento |
|---|---|
| `/start`, `/help` | Mensaje de ayuda con lista de comandos |
| `/stop` | Si idle → `Nothing to stop.`; si busy → `acp.cancel()` + vaciar cola + `⏹ Stopped.` |

Comandos delegados a `RoutineManager` via `onCommand`:

| Comando | Subcomandos |
|---|---|
| `/cron` | `list`, `add <schedule> <prompt>`, `remove <name>`, `toggle <name>`, `run <name>` |
| `/routine` | `list`, `add <name> <prompt>`, `remove <name>` |
| `/run <name>` | Ejecuta routine por nombre |

## Permisos (ACP `session/request_permission`)

Flujo de `_handlePermission` (TG y Discord):

1. Si `agentCmd` contiene `dangerous`, `bypass` o `yolo` → auto-aprobar
   (seleccionar primera opción `allow`).
2. Si no hay opciones → cancelar.
3. Si no hay `currentChatId`/`currentChannelId` → auto-aprobar (fallback seguro).
4. Si hay canal activo → enviar botones inline `Permitir` / `Denegar` con
   `callback_data`/`customId` `perm_allow_<optionId>` / `perm_deny_<optionId>`,
   y quedar pendiente en un `Promise` resuelto por el handler de callback.
5. Si falla el envío de botones → auto-aprobar como fallback.

## Media (ContentBlocks)

`MediaHandler` convierte archivos descargados a ACP `ContentBlock`:

| Condición | Block type |
|---|---|
| `mimeType` starts with `image/` AND `supportsImage=true` | `image` (base64 data) |
| Cualquier otro caso | `resource_link` (`file://` URI, name, mimeType) |
| Caption presente | `text` block adicional al final |

- Archivos guardados en `uploadsDir` (default `/tmp/acp-connector-uploads`),
  creado con `mkdirSync({ recursive: true })`.
- `BridgeBot` soporta photo, document, sticker (webp→image), voice, audio, video.
- `DiscordBot` procesa `msg.attachments` (cualquier tipo).
- HTTP `/prompt` acepta `files: [{ data, mimeType, filename? }]`:
  - `image/*` → `ImageContent`; resto → `ResourceLink` con `data:` URI.
  - Files sin `data` se ignoran (fallback a texto).

## Seguridad HTTP

`HttpServer` (opcional, `http.enabled`):

| Aspecto | Default | Notas |
|---|---|---|
| Bind host | `127.0.0.1` | Loopback only por defecto |
| Port | `7780` | Configurable via `http.port` |
| Auth | opcional | Bearer token via `http.auth.token` |
| Body limit | 1 MB (`DEFAULT_MAX_BODY`) | `http.maxBodySize` |
| Rate limit | 60 req/min (`DEFAULT_RATE_LIMIT`) | `http.rateLimit` |
| Forward headers | `false` | `http.forwardHeaders` |

Reglas de seguridad verificadas:

- **Authorization nunca forwardeado**: incluso con `forwardHeaders=true`, se
  eliminan `authorization`, `content-length`, `content-type` y `host` antes de
  serializar headers al prompt.
- **Auth estricta**: solo `Bearer <token>` exacto (case-sensitive en esquema).
  Rechaza `bearer` minúscula, `Basic`, token vacío, espacios extra, tokens muy
  largos (DoS → 401/431).
- **Auth aplica a todas las rutas** incluida `/health`.
- **Rate limit cuenta todo**: incluye `/health` y requests no autorizadas.
  Ventana deslizante de 60s sobre `_requestTimes`.
- **Path traversal**: `/prompt/../../../etc/passwd` → 404 (no reach al FS).
- **Métodos no soportados**: GET/PUT/DELETE en `/prompt` → 404 (no 405).
- **Content-Type flexible**: acepta `application/json`, `text/plain` y sin
  content-type; usa body crudo como prompt si no es JSON con `text`.
- **Query params como contexto**: `[k=v, ...]` se antepone al prompt (URL-encoded
  decodificado).
- **Responses siempre JSON** con `content-type: application/json`; errores
  incluyen campo `error`.

## Config (JSONC)

`acp-connector.jsonc` soporta:

- Comentarios de línea `//` y de bloque `/* */` (striper propio `stripJsonc`).
- Trailing commas (striper con regex `/,(\s*[}\]])/`).
- Strings con `//` dentro no se stripean (state machine con `inString`).
- Migración legacy: `telegramToken` + `allowedChatIds` raíz → `platforms.telegram`.
- Validación: `agentCmd` requerido (string); requiere `platforms.telegram` o
  `telegramToken` legacy.
- `defaultConfigPath` = `cwd/acp-connector.jsonc`.

## Convenciones de logging

- Emojis prefijos en stdout: `👤` (prompt entrante), `🤖` (respuesta),
  `🚫` (chat no autorizado), `⏰` (cron), `🔐` (permiso), `⚡` (auto-approve),
  `📄` (file guardado), `🌐` (HTTP), `⏹` (stop), `👋` (help).
- `_sanitize(text, 80)` para logs: stripa control chars, newlines, trunca a 80.
- Errores del agente (stderr) filtrados por regex
  `/\bERROR\b|\bFATAL\b|\berror:\b|\bfatal:\b|Invalid params/` y logueados con `⚠️`.
