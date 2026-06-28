// LUMA Desktop — chat overlay injected over the remote LUMA web.
//
// Runs as a Tauri initialization_script (before page scripts, not subject to the
// page CSP). Renders a floating assistant panel wired to the Rust bridge:
//   - provisions a read-only MCP token via /api/desktop/provision-token (the
//     WebView is already logged into LUMA), hands it to Rust (store_luma_token),
//   - starts the Agent SDK sidecar, streams its output here, sends user messages.
// Self-contained: no Next.js patch on the remote web is required.
(function () {
  "use strict";
  if (window.__LUMA_DESKTOP_OVERLAY__) return;
  window.__LUMA_DESKTOP_OVERLAY__ = true;

  function ready(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  const T = () => window.__TAURI__;
  const invoke = (cmd, args) => T().core.invoke(cmd, args || {});
  const listen = (ev, cb) => T().event.listen(ev, cb);

  ready(function () {
    if (!window.__TAURI__) return; // not running inside the desktop app

    const css = `
      #luma-fab{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:52px;height:52px;border-radius:50%;
        background:#1f6feb;color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:22px}
      #luma-panel{position:fixed;right:20px;bottom:84px;z-index:2147483647;width:380px;max-width:calc(100vw - 40px);
        height:560px;max-height:calc(100vh - 120px);display:none;flex-direction:column;background:#0e0f12;color:#e7e7ea;
        border:1px solid #2a2c33;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.45);
        font:14px/1.5 -apple-system,system-ui,sans-serif}
      #luma-panel.open{display:flex}
      #luma-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2a2c33;font-weight:600}
      #luma-head .dot{width:8px;height:8px;border-radius:50%;background:#3fb950}
      #luma-head .sp{flex:1}
      #luma-head button{background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:15px}
      #luma-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
      .luma-msg{padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word;max-width:88%}
      .luma-msg.user{align-self:flex-end;background:#1f6feb;color:#fff}
      .luma-msg.bot{align-self:flex-start;background:#1a1c22;border:1px solid #2a2c33}
      .luma-msg.sys{align-self:center;color:#9aa0a6;font-size:12.5px;background:none;text-align:center}
      #luma-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #2a2c33}
      #luma-input{flex:1;background:#16181d;border:1px solid #2a2c33;border-radius:9px;color:#e7e7ea;padding:9px 11px;resize:none;font:inherit}
      #luma-send{background:#1f6feb;border:none;color:#fff;border-radius:9px;padding:0 14px;cursor:pointer;font-weight:600}
      #luma-send:disabled{opacity:.5;cursor:default}
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el("button", { id: "luma-fab", title: "Asistente LUMA" }, "💬");
    const panel = el("div", { id: "luma-panel" });
    panel.innerHTML = `
      <div id="luma-head"><span class="dot"></span><span>Asistente LUMA</span><span class="sp"></span>
        <button id="luma-min" title="Cerrar">✕</button></div>
      <div id="luma-log"></div>
      <div id="luma-foot">
        <textarea id="luma-input" rows="1" placeholder="Pregunta sobre facturas, clientes, KPIs…"></textarea>
        <button id="luma-send">Enviar</button>
      </div>`;
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const log = panel.querySelector("#luma-log");
    const input = panel.querySelector("#luma-input");
    const send = panel.querySelector("#luma-send");

    let started = false;
    let starting = false;

    fab.onclick = () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) ensureStarted();
    };
    panel.querySelector("#luma-min").onclick = () => panel.classList.remove("open");
    send.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    // Stream sidecar events.
    listen("agent-event", (e) => handleAgentLine(e.payload));
    // Surface error-like stderr from the sidecar/claude so failures are visible.
    listen("agent-stderr", (e) => {
      const line = String(e.payload || "");
      if (/error|fail|denied|unauthor|invalid|enoent|cannot|no such|spawn/i.test(line)) {
        sys("⚙︎ " + line.slice(0, 240));
      }
    });

    async function ensureStarted() {
      if (started || starting) return;
      starting = true;
      try {
        const hasToken = await invoke("has_luma_token");
        if (!hasToken) {
          sys("Conectando el asistente a tus datos de LUMA…");
          const resp = await fetch("/api/desktop/provision-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceLabel: "LUMA Desktop" }),
          });
          if (resp.status === 404) {
            sys("Esta versión de LUMA aún no soporta el asistente de escritorio. Actualiza LUMA e inténtalo de nuevo.");
            starting = false;
            return;
          }
          if (resp.status === 403) {
            sys("El asistente de escritorio está disponible solo para Dirección en esta versión.");
            starting = false;
            return;
          }
          if (!resp.ok) {
            sys("No se pudo conectar el asistente (" + resp.status + ").");
            starting = false;
            return;
          }
          const { token } = await resp.json();
          await invoke("store_luma_token", { token });
        }
        await invoke("start_agent_session");
        started = true;
        sys("Asistente listo. Es de solo lectura: puedo consultar, no modificar.");
      } catch (err) {
        sys("Error al iniciar el asistente: " + (err && err.message ? err.message : err));
      } finally {
        starting = false;
      }
    }

    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      msg("user", text);
      await ensureStarted();
      if (!started) return;
      try {
        await invoke("send_message", { message: text });
      } catch (err) {
        sys("No se pudo enviar: " + (err && err.message ? err.message : err));
      }
    }

    // Render the Agent SDK message JSON lines. We surface assistant text and a
    // lightweight "consultando…" hint on tool use.
    let botBuf = null;
    function handleAgentLine(line) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      // assistant text (SDKAssistantMessage shape: { type:"assistant", message:{ content:[...] } })
      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        const text = m.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) appendBot(text);
        const usedTool = m.message.content.some((b) => b.type === "tool_use");
        if (usedTool) sys("Consultando datos de LUMA…");
      } else if (m.type === "result") {
        botBuf = null; // end of turn
      } else if (m.type === "fatal" || m.type === "error") {
        sys("Error del asistente: " + (m.message || "desconocido"));
      } else if (m.type === "sidecar-exit") {
        started = false;
        sys("El asistente se cerró. Reábrelo para continuar.");
      }
    }

    function appendBot(text) {
      if (!botBuf) {
        botBuf = el("div", { class: "luma-msg bot" }, "");
        log.appendChild(botBuf);
      }
      botBuf.textContent += text;
      log.scrollTop = log.scrollHeight;
    }
    function msg(kind, text) {
      botBuf = null;
      log.appendChild(el("div", { class: "luma-msg " + kind }, text));
      log.scrollTop = log.scrollHeight;
    }
    function sys(text) {
      msg("sys", text);
    }
    function el(tag, attrs, text) {
      const n = document.createElement(tag);
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    }
  });
})();
