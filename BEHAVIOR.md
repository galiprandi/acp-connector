# BEHAVIOR.md
> Generado por context-organizer. No editar a mano.

Reglas de negocio verificadas por los tests en `test/`, expresadas en prosa con
DEBE / NO DEBE, agrupadas por módulo. Cada regla está respaldada por al menos un
`it(...)` + `expect(...)` en los archivos de test listados.

## Módulo: BridgeBot (Telegram)

- DEBE registrar handlers para `message` y `callback_query` al iniciar (`start()`).
- DEBE rechazar mensajes de chats no autorizados (no incluidos en `allowedChatIds`).
- DEBE responder con el chat ID cuando la allowlist está vacía (modo setup), incluyendo instrucciones para `allowedChatIds`.
- NO DEBE responder con contenido del agente a chats no autorizados.
- NO DEBE reenviar mensajes vacíos (texto vacío o solo espacios) al agente.
- DEBE responder `Media no soportado` cuando llega un mensaje no textual (photo, voice, sticker, document) y no hay `mediaHandler` configurado.
- DEBE encolar prompts y procesarlos de a uno (cola serializada FIFO).
- DEBE reenviar el texto del mensaje a `acp.prompt()` cuando el chat está autorizado.
- DEBE delegar los comandos bridge (`/cron`, `/routine`, `/run`, `/stop`, `/start`, `/help`) a `onCommand` / comandos builtin antes de reenviar al agente.
- DEBE reenviar al agente un `/command` desconocido cuando `onCommand` devuelve `false`.
- DEBE responder con ayuda (`acp-connector`) ante `/start` y `/help`, incluso desde `enqueuePrompt` (path HTTP/cron).
- DEBE hacer streaming con batching (800 ms) editando un único mensaje de Telegram.
- DEBE enviar el primer chunk con `parse_mode: 'Markdown'`.
- DEBE hacer fallback a texto plano (sin `parse_mode`) cuando Telegram rechaza por error de parseo de entidades.
- DEBE partir la salida en múltiples mensajes cuando supera los 4096 caracteres (overflow chunks).
- DEBE enviar `[<stopReason>]` cuando el agente termina sin output y el stop reason no es `end_turn`.
- NO DEBE enviar mensaje de stop cuando el stop reason es `end_turn` y no hubo output.
- DEBE enviar `Error: <mensaje>` al chat cuando `acp.prompt()` o `acp.nextUpdate()` fallan.
- DEBE ignorar los `agent_thought` / `agent_thought_chunk` cuando `showThoughts=false`.
- DEBE reenviar los `agent_thought` / `agent_thought_chunk` al buffer de streaming cuando `showThoughts=true`.
- DEBE auto-aprobar permisos cuando `agentCmd` contiene `dangerous`, `bypass` o `yolo`.
- DEBE enviar botones inline (`Permiso requerido`) cuando no hay flag de auto-aprobación y hay `currentChatId` activo.
- DEBE auto-aprobar (seleccionar la opción `allow`) cuando no hay `currentChatId` seteado.
- DEBE cancelar el permiso cuando no hay opciones disponibles.
- NO DEBE resolver el permiso pendiente ante un `callback_query` con data inválida.
- NO DEBE crashear ante un `callback_query` sin permiso pendiente.
- DEBE responder `Nothing to stop.` ante `/stop` cuando está idle.
- DEBE cancelar el agente (`acp.cancel()`) y responder `⏹ Stopped.` ante `/stop` cuando está busy.
- DEBE vaciar la cola ante `/stop` cuando está busy.
- DEBE responder `Stop failed: <error>` cuando `acp.cancel()` falla.
- DEBE crear una sesión nueva con `/new` cuando está idle (responde `🆕 New session started`).
- DEBE rechazar `/new` cuando está busy (responde `Cannot start new session while busy. Use /stop first.`).
- DEBE listar sesiones con `/sessions` (responde `*Sessions:*` con la lista).
- DEBE responder `Cannot list sessions: <error>` cuando el agente no soporta `session/list`.
- DEBE cambiar de sesión con `/session <id>` (responde `🔄 Switched to session`).
- DEBE responder `Usage: /session <id>` cuando `/session` no tiene argumentos.
- DEBE rechazar `/session <id>` cuando está busy (responde `Cannot switch session while busy. Use /stop first.`).
- DEBE responder `Failed to create session: <error>` cuando `newSession()` falla.
- DEBE detener el polling con `stop()`.
- NO DEBE crashear al llamar `stop()` dos veces (double stop seguro).

## Módulo: DiscordBot

- DEBE hacer login con el token y registrar handlers `messageCreate` e `interactionCreate` al iniciar.
- DEBE rechazar mensajes de canales no autorizados (no en `allowedChannelIds`).
- DEBE responder con el channel ID en modo setup (allowlist vacía).
- DEBE ignorar mensajes provenientes de otros bots (`author.bot === true`).
- NO DEBE reenviar texto vacío al agente.
- DEBE reenviar mensajes autorizados a `acp.prompt()`.
- DEBE responder con ayuda (`acp-connector`) ante `/start` y `/help`.
- DEBE encolar prompts desde fuentes externas vía `enqueuePrompt()`.
- DEBE hacer streaming con batching (800 ms) editando un único mensaje de Discord.
- DEBE enviar el texto plano (sin parse_mode) en la edición del mensaje.
- DEBE partir la salida en múltiples mensajes cuando supera los 2000 caracteres.
- DEBE enviar `Error: <mensaje>` al canal cuando `acp.prompt()` falla (sync o async).
- DEBE enviar `[<stopReason>]` cuando el agente termina sin output y el stop reason no es `end_turn`.
- DEBE auto-aprobar permisos cuando `agentCmd` contiene `dangerous`.
- DEBE cancelar el permiso cuando no hay opciones.
- DEBE auto-aprobar (seleccionar `allow`) cuando no hay `currentChannelId` activo.
- DEBE enviar botones (`Permiso requerido`) cuando hay canal activo.
- DEBE ignorar `agent_thought_chunk` cuando `showThoughts=false`.
- DEBE reenviar `agent_thought_chunk` cuando `showThoughts=true`.
- DEBE responder `Nothing to stop.` ante `/stop` idle.
- DEBE cancelar el agente y responder `⏹ Stopped.` ante `/stop` busy.
- DEBE vaciar la cola ante `/stop` busy.
- DEBE destruir el client con `stop()`.
- DEBE delegar comandos a `onCommand` y no reenviar al agente cuando devuelve `true`.
- DEBE enviar mensajes al canal vía `sendMessage()`.

## Módulo: AcpClient

- DEBE crear una sesión nueva (`buildSession`) cuando no se provee `sessionId`.
- DEBE llamar `session/load` cuando se provee `sessionId` y el agente soporta `loadSession`.
- DEBE llamar `session/resume` cuando el agente expone `sessionCapabilities.resume`.
- DEBE lanzar error `does not support session/resume or session/load` cuando se provee `sessionId` pero el agente no soporta load ni resume.
- DEBE rechazar `start()` cuando el proceso hijo emite error (spawn ENOENT).
- DEBE rechazar `start()` cuando `session/load` falla.
- DEBE rechazar `start()` cuando `session/resume` falla.
- DEBE auto-aprobar permisos (seleccionar la primera opción `allow`) cuando no hay callback `onPermission`.
- DEBE delegar permisos al callback `onPermission` cuando está configurado.
- DEBE cancelar el permiso cuando no hay opciones ni handler.
- DEBE cancelar el permiso cuando hay opciones pero ninguna es `allow` y no hay handler.
- DEBE disponer la sesión y matar el proceso con `kill()`.
- DEBE delegar `prompt()` a `session.prompt`.
- DEBE delegar `nextUpdate()` a `session.nextUpdate`.
- DEBE cargar config de sesión desde `sessionConfigPath` (JSONC) e incluir `cwd` y `mcpServers` en `session/load`.
- NO DEBE colgar ni crashear al llamar `nextUpdate()` después de `kill()`.
- NO DEBE spawnear un segundo proceso en un segundo `start()` (debe reutilizar).
- NO DEBE lanzar en un segundo `kill()` (idempotente, `dispose` solo una vez).
- DEBE lanzar un error claro al llamar `prompt()` antes de `start()`.
- DEBE reenviar texto vacío y texto muy largo (1.000.000 chars) a `session.prompt` sin truncar.
- NO DEBE crashear cuando el agente cierra stdin / termina inesperadamente.
- DEBE almacenar `agentCapabilities` del init response.
- DEBE crear una sesión nueva con `newSession()` (dispose + buildSession + start).
- DEBE retornar el nuevo `sessionId` desde `newSession()`.
- DEBE listar sesiones con `listSessions()` cuando el agente soporta `sessionCapabilities.list`.
- DEBE lanzar `does not support session/list` cuando el agente no soporta `session/list`.
- DEBE cargar sesión con `loadSession(id)` usando `session/resume` cuando está disponible.
- DEBE cargar sesión con `loadSession(id)` usando `session/load` cuando solo `loadSession` está disponible.
- DEBE lanzar `does not support session/resume or session/load` cuando ninguna capability está disponible.
- DEBE disponer la sesión anterior antes de cargar una nueva con `loadSession()`.
- DEBE lanzar `ACP context not available` al llamar `newSession()`, `listSessions()` o `loadSession()` antes de `start()`.

## Módulo: bridge (orquestación)

- DEBE salir con código 1 cuando no se encuentra config.
- DEBE iniciar AcpClient, bot, CronManager y HttpServer al correr `run()`.
- DEBE salir con código 1 cuando ACP falla al iniciar.
- DEBE cablear `onCommand` del bot al `RoutineManager.handleCommand`.
- DEBE cablear `onPermission` del AcpClient a un router que despacha al bot con prompt activo.
- DEBE enrutar el permiso al bot con `hasActivePrompt() === true` (ej. Discord), no al primero.
- DEBE preservar Snowflake IDs (strings) de Discord en `allowedChatIds` del CronManager.

## Módulo: config (loader)

- DEBE retornar `null` cuando no existe el archivo de config.
- DEBE retornar `null` cuando el archivo está vacío (0 bytes).
- DEBE retornar `null` cuando el archivo solo tiene comentarios o whitespace.
- DEBE lanzar un error claro cuando el JSON es inválido (sintaxis).
- DEBE lanzar error de validación cuando falta `agentCmd`.
- DEBE lanzar error de validación cuando faltan `platforms.telegram` y `telegramToken`.
- DEBE defaultear `platforms.telegram.allowedChatIds` a `[]` cuando no está presente.
- DEBE preservar campos desconocidos sin romper.
- DEBE migrar `telegramToken` legacy a `platforms.telegram` (con `allowedChatIds`).
- DEBE aceptar comentarios de línea (`//`), de bloque (`/* */`) y comas trailing (JSONC).
- NO DEBE stripear `//` dentro de strings.
- DEBE lanzar cuando `saveConfig` recibe `null` / `undefined`.
- DEBE hacer round-trip `saveConfig` → `loadConfig` para config válida.
- DEBE resolver `defaultConfigPath` a `cwd/acp-connector.jsonc`.

## Módulo: CronManager

- DEBE iniciar todos los jobs válidos al `start()`.
- DEBE saltar jobs con `enabled: false` (log `disabled`).
- DEBE saltar jobs con schedule inválido (log `invalid schedule`).
- DEBE saltar jobs con prompt vacío (log `empty prompt`).
- DEBE saltar jobs sin `chatId` cuando `allowedChatIds` está vacío (log `no chatId`).
- DEBE disparar el job y encolar el prompt con el chatId correspondiente.
- DEBE usar el `chatId` del job cuando se provee, si no el primero de `allowedChatIds`.
- DEBE iniciar un job nuevo con `add()` y loguearlo.
- DEBE rechazar `add()` con nombres duplicados (retorna `null`, no agrega segundo job).
- DEBE detener y remover el job con `remove()`, retornando `true`.
- DEBE retornar `false` en `remove()` para jobs inexistentes.
- DEBE toggle pausar/activar y retornar el nuevo estado.
- DEBE retornar `false` en `toggle()` para jobs inexistentes.
- DEBE ejecutar el job inmediatamente con `run()` y encolar.
- DEBE retornar `false` en `run()` para jobs inexistentes.
- DEBE listar todos los jobs con `list()`.
- DEBE detener todas las tasks con `stop()`.
- NO DEBE crashear `stop()` sin jobs (no-op).
- DEBE soportar múltiples jobs con el mismo schedule.
- DEBE iniciar jobs agregados con `add()` después de `stop()`.

## Módulo: RoutineManager

- DEBE retornar `false` para texto que no es comando.
- DEBE retornar `false` para comandos desconocidos.
- DEBE ejecutar la routine por nombre con `/run <name>` y encolar el prompt.
- DEBE responder `not found` cuando `/run` referencia una routine inexistente.
- DEBE mostrar `Usage` cuando `/run` no tiene argumentos.
- DEBE listar todas las routines con `/routine list`.
- DEBE mostrar `No routines` cuando no hay routines.
- DEBE crear y persistir routine con `/routine add <name> <prompt>` (responde `✅`).
- DEBE rechazar `/routine add` con nombre duplicado (`already exists`).
- DEBE mostrar `Usage` cuando `/routine add` no tiene nombre o prompt.
- DEBE eliminar y persistir routine con `/routine remove <name>` (responde `✅`).
- DEBE responder `not found` cuando `/routine remove` referencia una routine inexistente.
- DEBE mostrar `Usage` cuando `/routine remove` no tiene nombre.
- DEBE listar jobs con `/cron list`.
- DEBE crear job y persistir con `/cron add <schedule> <prompt>` (responde `✅`).
- DEBE rechazar `/cron add` con schedule de menos de 5 tokens (muestra `Usage`).
- DEBE rechazar `/cron add` sin prompt (solo 5 tokens) (muestra `Usage`).
- DEBE rechazar `/cron add` sin schedule (muestra `Usage`).
- DEBE aceptar `/cron add` con prompt multi-palabra.
- DEBE detener job y persistir con `/cron remove <name>` (responde `✅`).
- DEBE toggle y persistir con `/cron toggle <name>` (responde `activated`/`paused`).
- DEBE ejecutar job inmediatamente con `/cron run <name>` (responde `Running`).
- DEBE mostrar `Usage` cuando `/cron remove`, `/cron toggle` o `/cron run` no tienen nombre.
- DEBE mostrar ayuda `Cron commands` cuando `/cron` no tiene subcomando.
- DEBE mostrar ayuda `Routine commands` cuando `/routine` no tiene subcomando.
- NO DEBE persistir cuando `loadConfig()` retorna `null`.

## Módulo: HttpServer

- NO DEBE iniciar el server cuando `enabled=false`.
- DEBE responder 200 con health info en `GET /health`.
- DEBE encolar un prompt en `POST /prompt` con `{ text, chatId }`.
- DEBE usar el body crudo como prompt cuando el JSON no tiene campo `text`.
- DEBE responder 400 cuando `POST /prompt` no tiene body.
- DEBE responder 400 cuando `text` está vacío o es solo whitespace.
- DEBE encolar con `chatId=undefined` cuando no se provee `chatId`.
- DEBE responder 404 para rutas desconocidas (GET y POST).
- DEBE responder 404 para `/prompt` con método no soportado (GET, PUT, DELETE).
- DEBE responder 404 para `/prompt/extra` y path traversal (`/prompt/../../../etc/passwd`).
- NO DEBE crashear con double `stop()` (idempotente).
- DEBE aceptar bodies >10KB (sin exceder `maxBodySize`).
- DEBE ignorar campos extra del body y encolar solo `text`.
- DEBE usar body crudo cuando `text` no es string.
- NO DEBE llamar `enqueue` en `GET /health`.
- DEBE anteponer contexto de query params al prompt (`[k=v, ...] text`).
- DEBE no modificar el prompt cuando no hay query params.
- DEBE anteponer contexto de query params también con body crudo.
- DEBE responder 401 cuando hay `authToken` configurado y no se envía token.
- DEBE responder 401 con bearer token incorrecto.
- DEBE encolar con bearer token correcto.
- DEBE requerir auth también en `GET /health` cuando `authToken` está seteado.
- NO DEBE forwardear el header `Authorization` al agente (nunca, incluso con `forwardHeaders`).
- DEBE forwardear headers custom al prompt solo cuando `forwardHeaders=true`.
- DEBE responder 429 al exceder el rate limit.
- DEBE contar todas las requests (incluida `/health`) para el rate limit.
- DEBE resetear el rate limit al expirar las entradas (>60s).
- DEBE contar requests no autorizadas para el rate limit.
- DEBE responder 413 cuando el body excede `maxBodySize`.
- DEBE rechazar esquema `bearer` (minúsculas) y `Basic`.
- DEBE rechazar bearer token vacío o con espacios extra.
- DEBE aceptar tokens con caracteres especiales.
- DEBE rechazar tokens muy largos (DoS) con 401 o 431.
- DEBE decodificar query params URL-encoded.
- DEBE aceptar bodies con unicode, newlines, JSON array/string/number/null.
- DEBE aceptar `Content-Type: text/plain` y sin content type.
- DEBE responder siempre JSON con `content-type: application/json`.
- DEBE incluir campo `error` en respuestas de error.
- DEBE construir `ImageContent` para files con mimeType `image/*`.
- DEBE construir `ResourceLink` para files no-imagen.
- DEBE crear múltiples blocks para múltiples files.
- DEBE encolar con files aunque `text` esté vacío (solo blocks).
- DEBE ignorar files sin `data` (fallback a texto).
- DEBE mantener backward compat sin campo `files`.
- DEBE aceptar `callback_url` (snake_case) o `callbackUrl` (camelCase) en el body de `POST /prompt`.
- DEBE pasar un callback `onComplete` a `enqueue` cuando se provee `callback_url`.
- NO DEBE pasar `onComplete` cuando no se provee `callback_url`.
- DEBE invocar `onComplete` con `(response, undefined)` cuando el agente termina exitosamente.
- DEBE invocar `onComplete` con `('', error)` cuando el agente falla.

## Módulo: MediaHandler

- DEBE guardar el archivo a disco en `uploadsDir` y retornar path, mimeType y data base64.
- DEBE crear `ImageContent` cuando el agente soporta imagen y el MIME es `image/*`.
- DEBE crear `ResourceLink` cuando el agente no soporta imagen.
- DEBE crear `ResourceLink` para archivos no-imagen (ej. PDF).
- DEBE agregar el caption como bloque de texto al final.
- DEBE descargar, guardar y convertir en un solo paso con `processMedia()`.
- DEBE crear el directorio de uploads si no existe.
- DEBE procesar photos de Telegram (image block + caption text).
- DEBE procesar documents de Telegram (resource_link).
- DEBE hacer fallback a `ResourceLink` cuando el agente no soporta imagen.
- DEBE enviar `Error downloading media: <msg>` al chat cuando la descarga falla.
- NO DEBE reenviar al agente cuando la descarga falla.
- DEBE responder `Media no soportado` cuando llega media sin `mediaHandler`.
- DEBE procesar stickers como imagen (webp).
