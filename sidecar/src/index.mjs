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

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";

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

const SYSTEM_PROMPT = `Eres el asistente de LUMA ERP para el equipo de ARCESS (Aragonesa de Climatización Energía y Servicios S.L.U.).
Tienes acceso a las herramientas del MCP de LUMA para CONSULTAR facturas, presupuestos, clientes, albaranes, partes de trabajo y más.

Reglas:
- Responde siempre en español, conciso y directo. Los usuarios son personal de administración y dirección, no expertos en IA.
- Cuando el usuario pida datos, usa los tools del MCP de LUMA — nunca inventes cifras ni datos.
- Esta sesión es de SOLO LECTURA: no puedes crear, editar ni borrar nada. Si te lo piden, explica que esa acción se hace desde la web de LUMA.
- Cuando muestres listas de facturas o presupuestos, formatea con tabla markdown.
- Si no encuentras algo, di exactamente qué buscaste.`;

// ── Streaming user-message input (multi-turn) ────────────────────────────────
const pending = [];
let wake = null;
let closed = false;

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

// ── Tool gate: ONLY LUMA MCP tools. Deny local Bash/Edit/Write/etc. ──────────
const canUseTool = async (toolName, input) => {
  if (toolName.startsWith("mcp__luma__")) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message:
      "Sesión de solo lectura sobre LUMA: solo se permiten consultas al MCP de LUMA.",
  };
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
