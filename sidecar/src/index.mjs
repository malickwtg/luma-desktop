// LUMA Desktop sidecar — hosts the Claude Agent SDK and bridges it to LUMA's MCP.
//
// Spawned by the Rust core (src-tauri/src/commands/agent.rs). Reads user messages
// as JSON lines on stdin ({ "type": "user", "text": "..." }), drives the Agent
// SDK against LUMA's MCP over Streamable HTTP, and writes every SDK message as a
// JSON line to stdout (the Rust core forwards them to the WebView).
//
// Security:
//   - MCP token comes from env (LUMA_MCP_TOKEN), injected by Rust from the OS
//     keychain. It is never logged.
//   - canUseTool denies EVERY tool that is not a LUMA MCP tool, so the agent
//     cannot run local Bash/Edit/Write/Read on the user's machine. Combined with
//     the read-only MCP token, the agent can only READ LUMA data.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const MCP_URL = process.env.LUMA_MCP_URL;
const MCP_TOKEN = process.env.LUMA_MCP_TOKEN;
// Path to the bundled `claude` binary (set by Rust in the packaged app). In dev
// it's unset and the SDK resolves its own binary from node_modules.
const CLAUDE_PATH = process.env.LUMA_CLAUDE_PATH;
// Model slug chosen in the UI (Haiku/Sonnet/Opus). Bound at session start; the
// UI restarts the session when the user picks a different one.
const MODEL = process.env.LUMA_MODEL;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (!MCP_URL || !MCP_TOKEN) {
  send({ type: "fatal", message: "Faltan LUMA_MCP_URL / LUMA_MCP_TOKEN" });
  process.exit(1);
}

const SYSTEM_PROMPT = `Eres el asistente de LUMA ERP para la Dirección de ARCESS (Aragonesa de Climatización Energía y Servicios S.L.U.), empresa de instalaciones HVAC y renovables.
Tienes acceso a las herramientas del MCP de LUMA (prefijo mcp__luma__) para CONSULTAR el ERP: facturación, cobros, clientes, presupuestos, pedidos, albaranes, partes de trabajo (ABT), incidencias, contratos de mantenimiento, almacén/stock, RRHH y KPIs.

Reglas:
- Responde siempre en español, conciso y directo. El usuario es Dirección/Administración, no experto en IA. Nada de preámbulos.
- Usa SIEMPRE los tools del MCP para obtener cifras — nunca inventes ni estimes datos. Si una herramienta falla o no devuelve nada, di exactamente qué buscaste y con qué filtros.
- Puedes CONSULTAR y también REALIZAR ESCRITURAS (crear/editar/borrar clientes, presupuestos, pedidos, incidencias/avisos; facturar; cobrar; remesas; etc.) con los tools del MCP de LUMA. CLAVE: cada escritura PIDE CONFIRMACIÓN al usuario en un diálogo del sistema ANTES de ejecutarse — tú solo solicitas la herramienta, el usuario aprueba o cancela. NO afirmes que algo se ha hecho hasta que el resultado del tool lo confirme. Si el usuario cancela recibirás un error de cancelación: reconócelo con naturalidad y NO reintentes a ciegas.
- Antes de una escritura con efecto importante (facturar, cobrar, remesa, borrar, dar de alta), resume en UNA frase qué vas a hacer (entidad, importe, cliente) para que el usuario sepa exactamente qué confirma. Para crear cosas, reúne primero los datos mínimos necesarios; si falta algo imprescindible, pregúntalo antes de llamar al tool.
- Formatea listas y cifras con tablas markdown. Importes en euros con dos decimales; alinea los números a la derecha con la sintaxis \`---:\`.
- Para KPIs o comparativas de pocos números (p.ej. Facturado/Cobrado/Pendiente del mes), en vez de una tabla usa un bloque \`\`\`luma:cards\`\`\` con un array JSON [{"label","value","delta"}] (value ya formateado con € y miles; delta opcional tipo "+12%" o "−4%"). Para series o rankings (p.ej. facturación por mes, top clientes) usa \`\`\`luma:chart\`\`\` con {"data":[{"label","value"}],"unit":"€"} (value numérico, sin formatear). Úsalos cuando aporten; para datos largos o detalle, sigue con tabla.

Informes compuestos (encadena varios tools en un solo turno y fúndelos en UN informe con tablas):
- "Parte del día" / briefing: usa get_daily_briefing si existe; si no, combina KPIs del mes, facturas vencidas con importe, incidencias abiertas, presupuestos que expiran en 7 días y stock bajo mínimo.
- "Cierre del mes" / "¿cómo vamos?": KPIs de facturación y cobro + facturas vencidas (aging) + presupuestos por expirar.
- "Estado de cobros": pagos vencidos por antigüedad + total pendiente + top clientes deudores.
- "Cliente X 360": usa get_customer_360 si existe (facturación, presupuestos, incidencias, mantenimiento, proyectos del cliente).
Para preguntas simples, una sola herramienta basta — no sobre-consultes.`;

// ── Streaming user-message input (multi-turn) ────────────────────────────────
const pending = [];
let wake = null;
let closed = false;
// Pending write-confirmations, keyed by id. Resolved when the WebView sends a
// {type:"confirm-response", id, allow} line back (via the respond_confirm command).
const pendingConfirms = new Map();

async function* userMessages() {
  while (true) {
    while (pending.length) yield pending.shift();
    if (closed) return;
    await new Promise((resolve) => {
      wake = resolve;
    });
  }
}

function pushUser(text) {
  pending.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });
  if (wake) {
    const w = wake;
    wake = null;
    w();
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.type === "user" && typeof msg.text === "string") pushUser(msg.text);
    else if (msg.type === "confirm-response" && typeof msg.id === "string") {
      const cb = pendingConfirms.get(msg.id);
      if (cb) cb(!!msg.allow);
    }
  } catch {
    // ignore non-JSON control lines
  }
});
rl.on("close", () => {
  closed = true;
  if (wake) {
    const w = wake;
    wake = null;
    w();
  }
});

// ── Local "propose" tool: lets the agent PROPOSE a write (e.g. facturar un ABT)
// WITHOUT being able to execute it. The handler only emits a {type:"propose"}
// event to the WebView; the human confirms in a native dialog and the WebView
// (same-origin, logged in) performs the actual write via /api/desktop/abt/[id]/invoice.
// The agent itself has NO write capability — canUseTool below is the boundary.
const desktopServer = createSdkMcpServer({
  name: "desktop",
  version: "1.0.0",
  tools: [
    tool(
      "propose_action",
      "Propone una acción de ESCRITURA (p.ej. facturar un ABT) para que el usuario la confirme en pantalla. NO ejecuta nada: solo muestra la propuesta. Tras llamarla, DETENTE y espera la confirmación del usuario.",
      {
        action: z.string().describe("Identificador de la acción, p.ej. 'invoice_abt'"),
        entityId: z.string().describe("UUID de la entidad afectada (p.ej. el ABT)"),
        humanSummary: z
          .string()
          .describe("Frase clara para el usuario: qué se hará, importe y cliente"),
        amount: z.number().optional().describe("Importe total con IVA, si aplica"),
        customer: z.string().optional().describe("Nombre del cliente, si aplica"),
      },
      async (args) => {
        send({
          type: "propose",
          proposalId: randomUUID(),
          action: args.action,
          entityId: args.entityId,
          humanSummary: args.humanSummary,
          amount: typeof args.amount === "number" ? args.amount : null,
          customer: args.customer ?? null,
        });
        return {
          content: [
            {
              type: "text",
              text: "Propuesta enviada al usuario para que la confirme en pantalla. Detente aquí y espera; NO asumas que se ha ejecutado.",
            },
          ],
        };
      },
    ),
  ],
});

// ── Tool gate. Read MCP tools pass silently. EVERY write tool is blocked until the
// human confirms it in a native dialog: the sidecar emits confirm-request → the
// WebView shows confirm_action → respond_confirm sends the decision back → this
// promise resolves. DEFAULT-TO-CONFIRM: anything not clearly a read needs approval,
// so a write can NEVER execute unattended. Bash/Edit/Write/etc. stay fully denied.
const READ_PREFIX = /^(get_|query_|list_|search_)/;
const READ_EXACT = new Set(["global_search", "payment_inbox", "monthly_closing_report"]);
function isLumaRead(toolName) {
  const t = toolName.replace(/^mcp__luma__/, "");
  return READ_PREFIX.test(t) || READ_EXACT.has(t);
}
const CONFIRM_TIMEOUT_MS = 180000;

const canUseTool = async (toolName, input) => {
  if (toolName === "mcp__desktop__propose_action") {
    return { behavior: "allow", updatedInput: input };
  }
  if (toolName.startsWith("mcp__luma__")) {
    if (isLumaRead(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    // WRITE → require explicit human confirmation. Never auto-allow.
    const id = randomUUID();
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (decision) => {
        if (settled) return;
        settled = true;
        pendingConfirms.delete(id);
        resolve(decision);
      };
      pendingConfirms.set(id, (allow) =>
        settle(
          allow
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "El usuario canceló la acción." },
        ),
      );
      send({
        type: "confirm-request",
        id,
        toolName: toolName.replace(/^mcp__luma__/, ""),
        input,
      });
      setTimeout(
        () => settle({ behavior: "deny", message: "Confirmación expirada; no se ejecutó nada." }),
        CONFIRM_TIMEOUT_MS,
      );
    });
  }
  return { behavior: "deny", message: "Herramienta no permitida en el asistente de LUMA." };
};

// Best-effort: detect an expired/revoked MCP token mid-session so the UI can tell
// the user to reconnect instead of the model saying "no encuentro datos".
let authNotified = false;
function looksAuthError(message) {
  try {
    const c = message && message.message && message.message.content;
    if (!Array.isArray(c)) return false;
    return c.some(
      (b) =>
        b &&
        b.type === "tool_result" &&
        b.is_error &&
        /unauthorized|invalid.?token|forbidden|\b401\b|\b403\b|expired|api key/i.test(
          typeof b.content === "string" ? b.content : JSON.stringify(b.content || "")
        )
    );
  } catch {
    return false;
  }
}

send({ type: "ready" });

try {
  const response = query({
    prompt: userMessages(),
    options: {
      systemPrompt: SYSTEM_PROMPT,
      ...(CLAUDE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_PATH } : {}),
      ...(MODEL ? { model: MODEL } : {}),
      mcpServers: {
        luma: {
          type: "http",
          url: MCP_URL,
          headers: { Authorization: `Bearer ${MCP_TOKEN}` },
        },
        desktop: desktopServer,
      },
      canUseTool,
      // Strip the local agent tools from context entirely (defense in depth).
      disallowedTools: [
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "NotebookEdit",
        "Task",
        "KillShell",
      ],
    },
  });

  for await (const message of response) {
    if (!authNotified && looksAuthError(message)) {
      authNotified = true;
      send({ type: "auth-expired" });
    }
    send(message);
  }
} catch (e) {
  send({ type: "fatal", message: e?.message ?? String(e) });
  process.exit(1);
}
process.exit(0);
