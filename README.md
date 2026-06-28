# LUMA Desktop

App de escritorio (Tauri 2.0) que carga la web de LUMA ERP (`luma.waytogrow.es`)
en una ventana y añade un asistente IA agéntico con el **Claude Agent SDK**
hablando con el **MCP de LUMA**.

> Estado: **paso 0 / hito 1** construido y compilando. La app carga la web; el
> sidecar del Agent SDK está cableado y validado. La UI de chat (parche Next.js)
> y el empaquetado firmado son follow-ups (ver más abajo). Plan completo y
> decisiones en el repo de LUMA: `.context/luma-desktop-plan.md`.

## Arquitectura

```
WebView (WKWebView/WebView2) → carga REMOTO https://luma.waytogrow.es
   │  tauri::invoke   (IPC habilitado SOLO para ese origen, vía capabilities/main.json)
   ▼
Rust core (src-tauri/) — launcher + OS keychain + ciclo de vida de procesos
   │  spawn (stdin/stdout)
   ▼
Node sidecar (sidecar/) — @anthropic-ai/claude-agent-sdk
   │  mcpServers { luma: { type:"http", url:.../api/mcp, headers:{ Authorization: Bearer <token> } } }
   ▼
MCP de LUMA (ya en producción)
```

## Modelo de seguridad (revisado con `/autoplan` + `/review`)

- **El token MCP nunca vuelve al WebView.** Se guarda en el Keychain del SO y Rust
  lo inyecta en el sidecar por variable de entorno. No existe ningún comando que
  devuelva el token a JS (`store_luma_token` lo recibe una vez; no hay getter).
- **IPC nativa solo para el origen remoto de LUMA.** `src-tauri/capabilities/main.json`
  limita el invoke a `windows: ["main"]` + `remote.urls: ["https://luma.waytogrow.es/*"]`.
  Un origen inyectado (about:blank, iframe de terceros, redirect secuestrado) no puede
  invocar comandos nativos.
- **El agente solo lee LUMA.** El sidecar deniega vía `canUseTool` cualquier tool que
  no sea `mcp__luma__*` (nada de Bash/Edit/Write locales) y el token MCP es **read-only**.
- **Sin procesos zombie.** Al cerrar la ventana o salir, Rust mata el sidecar (y el
  `claude` que este lanzó).
- **v1 = SOLO DIRECCIÓN, SOLO LECTURA.** El token lo acuña `/api/desktop/provision-token`
  (en el repo de LUMA) solo para SUPERADMIN/DIRECTIVO. El recorte por rol para el resto
  necesita autz per-usuario en el MCP (v2). El asistente no puede crear/editar/borrar.

## Prerrequisitos

| | macOS | Windows |
|---|---|---|
| Node 22 + pnpm 10 | ✓ | ✓ |
| Rust toolchain | `1.88.0` (lo fija `rust-toolchain.toml`) | idem |
| Toolchain del SO | Xcode Command Line Tools (`xcode-select --install`) | Visual Studio Build Tools + WebView2 Runtime |
| `claude` autenticado | `claude login` (o `ANTHROPIC_API_KEY`) | idem |

Instala Rust con: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
(el `rust-toolchain.toml` instala 1.88.0 + targets de macOS al primer build).

## Desarrollo

```bash
pnpm install                 # tauri CLI
pnpm --dir sidecar install   # Agent SDK + binario claude bundleado

# Hito 1: ventana que carga la web (sin chat aún)
pnpm dev                     # = tauri dev

# El sidecar se valida solo:
node --check sidecar/src/index.mjs
```

El sidecar se lanza desde Rust (`commands/agent.rs`). En dev resuelve
`sidecar/src/index.mjs` relativo al crate; override con `LUMA_SIDECAR_PATH`.

### Los DOS logins (no confundir)

1. **Claude** — el Agent SDK usa el binario `claude` (subscripción/OAuth o
   `ANTHROPIC_API_KEY`). `check_claude_installed` / `check_claude_auth` son pistas.
2. **Token MCP de LUMA** — distinto. El WebView (logueado en LUMA) llama a
   `POST /api/desktop/provision-token`, recibe el token read-only, e invoca
   `store_luma_token(token)` → Keychain. `start_agent_session` lo lee del Keychain.

## Comandos del bridge (Rust → WebView)

| Comando | Qué hace |
|---|---|
| `get_platform()` | "mac" \| "windows" \| "linux" |
| `check_claude_installed()` | `{ installed, version }` |
| `check_claude_auth()` | `bool` (best-effort) |
| `store_luma_token(token)` | guarda el token MCP en Keychain (entra, no sale) |
| `has_luma_token()` | `bool` |
| `clear_luma_token()` | borra el token |
| `start_agent_session()` | lanza el sidecar; emite `agent-event` / `agent-stderr` |
| `send_message(message)` | escribe en stdin del sidecar |
| `stop_agent_session()` | mata el sidecar |

## Estado por milestone

- [x] **Hito 1** — proyecto Tauri que carga `luma.waytogrow.es` (config + capabilities + íconos).
- [x] **Hito 1.5** — bridge Rust ↔ sidecar Node (spawn/stdin/stdout, kill-chain). *(cableado; `cargo check` verde)*
- [x] **Hito 2 (backend)** — sidecar con Agent SDK + MCP `http` + token desde Keychain, restringido a tools de LUMA. *(validado: importa el SDK, `query` ok, binario nativo bundleado)*
- [ ] **UI de chat** — parche Next.js en el repo LUMA. El review concluyó **reutilizar** `components/assistant/assistant-widget.tsx` (extraer un `<ChatPanel>` y variar solo el transporte: HTTP vs eventos Tauri). NO construir uno nuevo.
- [ ] **Empaquetado release** — bundlear el sidecar Node + binario `claude` como `externalBin`; firmar + notarizar los 3 binarios; `.dmg` Universal + `.exe`.
- [ ] **Auto-update** — `tauri-updater` apuntando a GitHub Releases.

## Packaging (follow-up)

El binario de release que produce hoy `.github/workflows/build.yml` (por tag) carga
la web (hito 1), pero **el chat necesita que el sidecar esté presente en runtime**.
Para entregarlo al usuario final:

1. Compilar el sidecar a un binario único (`bun build --compile sidecar/src/index.mjs`)
   en `src-tauri/binaries/luma-sidecar-<target-triple>`.
2. Añadir `bundle.externalBin: ["binaries/luma-sidecar"]` a `tauri.conf.json` y que
   `agent.rs` use el sidecar resuelto por Tauri en lugar de `node <path>`.
3. **Firmar + notarizar los 3 ejecutables** (shell Tauri + node embebido + `claude`)
   o Gatekeeper/SmartScreen los bloquea. Secrets de CI ya referenciados en `build.yml`.
4. Tamaño realista del `.dmg`: ~60-100 MB (no 10).

## Licencia / propiedad

Way To Grow — uso interno de Grupo Arcess.
