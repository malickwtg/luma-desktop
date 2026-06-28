// LUMA Desktop — chat overlay injected over the remote LUMA web.
//
// Runs as a Tauri initialization_script (before page scripts, not subject to the
// page CSP). Renders a floating assistant panel wired to the Rust bridge:
//   - provisions a read-only MCP token via /api/desktop/provision-token (the
//     WebView is already logged into LUMA), hands it to Rust (store_luma_token),
//   - starts the Agent SDK sidecar, streams its output here, sends user messages.
//
// UI: Midday/shadcn visual language reproduced with native CSS. The whole UI lives
// inside a Shadow DOM so styles never bleed into LUMA (and LUMA's CSS never bleeds
// into the chat). Light/dark follows the OS. Self-contained: no Next.js patch on
// the remote web is required.
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

  // Lucide-style icons (inline SVG).
  const ICON_SPARKLES = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

  ready(function () {
    if (!window.__TAURI__) return; // not running inside the desktop app

    const CSS = `
      :host {
        --bg: #0a0a0a;
        --panel: #0c0c0c;
        --elev: #161616;
        --border: rgba(255,255,255,.08);
        --border-strong: rgba(255,255,255,.14);
        --fg: #fafafa;
        --muted: #a1a1aa;
        --muted-2: #71717a;
        --primary: #fafafa;
        --primary-fg: #0a0a0a;
        --user-bubble: #1c1c1f;
        --danger: #f87171;
        --radius: 16px;
        --font: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
      }
      @media (prefers-color-scheme: light) {
        :host {
          --bg: #ffffff;
          --panel: #ffffff;
          --elev: #f4f4f5;
          --border: rgba(0,0,0,.08);
          --border-strong: rgba(0,0,0,.14);
          --fg: #09090b;
          --muted: #52525b;
          --muted-2: #71717a;
          --primary: #18181b;
          --primary-fg: #fafafa;
          --user-bubble: #f4f4f5;
          --danger: #dc2626;
        }
      }

      * { box-sizing: border-box; }

      .fab {
        position: fixed; right: 24px; bottom: 24px;
        width: 48px; height: 48px; border-radius: 14px;
        background: var(--primary); color: var(--primary-fg);
        border: none; cursor: pointer;
        display: grid; place-items: center;
        box-shadow: 0 8px 28px rgba(0,0,0,.20), 0 1px 2px rgba(0,0,0,.10);
        transition: transform .16s cubic-bezier(.2,.8,.2,1), box-shadow .16s;
        -webkit-app-region: no-drag;
      }
      .fab:hover { transform: translateY(-2px); box-shadow: 0 12px 34px rgba(0,0,0,.26); }
      .fab:active { transform: translateY(0); }
      .fab svg { width: 22px; height: 22px; }

      .panel {
        position: fixed; right: 24px; bottom: 88px;
        width: 408px; max-width: calc(100vw - 48px);
        height: 628px; max-height: calc(100vh - 128px);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        display: flex; flex-direction: column;
        overflow: hidden;
        box-shadow: 0 24px 70px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.12);
        font-family: var(--font);
        color: var(--fg);
        opacity: 0; transform: translateY(10px) scale(.985); transform-origin: bottom right;
        pointer-events: none;
        transition: opacity .18s ease, transform .18s cubic-bezier(.2,.8,.2,1);
      }
      .panel.open { opacity: 1; transform: none; pointer-events: auto; }

      .head {
        display: flex; align-items: center; gap: 11px;
        padding: 13px 14px 13px 16px;
        border-bottom: 1px solid var(--border);
      }
      .head .avatar {
        width: 30px; height: 30px; border-radius: 9px; flex: none;
        background: var(--elev); border: 1px solid var(--border);
        display: grid; place-items: center; color: var(--fg);
      }
      .head .avatar svg { width: 16px; height: 16px; }
      .head .meta { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
      .head .title { font-size: 13.5px; font-weight: 600; letter-spacing: -.01em; line-height: 1.2; }
      .head .sub { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; line-height: 1.2; }
      .head .dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); }
      .head .x {
        width: 30px; height: 30px; border-radius: 8px; flex: none;
        background: none; border: none; color: var(--muted); cursor: pointer;
        display: grid; place-items: center; transition: background .12s, color .12s;
      }
      .head .x:hover { background: var(--elev); color: var(--fg); }
      .head .x svg { width: 16px; height: 16px; }

      .log {
        flex: 1; overflow-y: auto; overflow-x: hidden;
        padding: 18px 16px;
        display: flex; flex-direction: column; gap: 14px;
        scroll-behavior: smooth;
      }
      .log::-webkit-scrollbar { width: 10px; }
      .log::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; border: 3px solid var(--panel); }
      .log::-webkit-scrollbar-track { background: transparent; }

      .msg { max-width: 100%; font-size: 14px; line-height: 1.6; }
      .msg.user {
        align-self: flex-end; max-width: 85%;
        background: var(--user-bubble); color: var(--fg);
        padding: 9px 13px; border-radius: 14px 14px 4px 14px;
        white-space: pre-wrap; word-break: break-word;
      }
      .msg.bot { align-self: stretch; color: var(--fg); word-break: break-word; }
      .msg.bot > :first-child { margin-top: 0; }
      .msg.bot > :last-child { margin-bottom: 0; }
      .msg.bot p { margin: 0 0 8px; }
      .msg.bot p.h { font-weight: 600; letter-spacing: -.01em; }
      .msg.bot ul, .msg.bot ol { margin: 0 0 8px; padding-left: 20px; }
      .msg.bot li { margin: 2px 0; }
      .msg.bot code {
        font-family: var(--mono); font-size: 12.5px;
        background: var(--elev); border: 1px solid var(--border);
        padding: 1px 5px; border-radius: 5px;
      }
      .msg.bot pre {
        background: var(--elev); border: 1px solid var(--border);
        border-radius: 10px; padding: 11px 13px; margin: 0 0 8px;
        overflow-x: auto;
      }
      .msg.bot pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
      .msg.bot strong { font-weight: 600; }

      .sys {
        align-self: center; text-align: center;
        font-size: 12px; color: var(--muted-2);
        max-width: 90%; line-height: 1.5;
      }
      .sys.err { color: var(--danger); }

      .typing {
        align-self: flex-start;
        display: none; align-items: center; gap: 9px;
        color: var(--muted); font-size: 12.5px;
      }
      .typing.show { display: flex; }
      .typing .dots { display: inline-flex; gap: 3px; }
      .typing .dots i {
        width: 5px; height: 5px; border-radius: 50%; background: var(--muted);
        animation: luma-blink 1.2s infinite ease-in-out both;
      }
      .typing .dots i:nth-child(2) { animation-delay: .18s; }
      .typing .dots i:nth-child(3) { animation-delay: .36s; }
      @keyframes luma-blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

      .foot { padding: 12px; border-top: 1px solid var(--border); }
      .inputwrap {
        display: flex; align-items: flex-end; gap: 8px;
        background: var(--elev); border: 1px solid var(--border);
        border-radius: 13px; padding: 7px 7px 7px 13px;
        transition: border-color .14s, box-shadow .14s;
      }
      .inputwrap:focus-within { border-color: var(--border-strong); box-shadow: 0 0 0 3px rgba(127,127,127,.08); }
      textarea {
        flex: 1; background: none; border: none; outline: none; resize: none;
        color: var(--fg); font: inherit; font-size: 14px; line-height: 1.5;
        max-height: 132px; padding: 5px 0; min-height: 22px;
      }
      textarea::placeholder { color: var(--muted-2); }
      .send {
        width: 30px; height: 30px; border-radius: 9px; flex: none;
        background: var(--primary); color: var(--primary-fg);
        border: none; cursor: pointer; display: grid; place-items: center;
        transition: opacity .14s, transform .14s;
      }
      .send svg { width: 16px; height: 16px; }
      .send:disabled { opacity: .35; cursor: default; }
      .send:not(:disabled):hover { transform: translateY(-1px); }
      .hint { padding: 7px 4px 0; font-size: 10.5px; color: var(--muted-2); text-align: center; }
    `;

    // --- Build the UI inside a Shadow DOM so nothing leaks in or out. ---
    const host = document.createElement("div");
    host.id = "luma-desktop-root";
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="fab" title="Asistente LUMA" aria-label="Asistente LUMA">${ICON_SPARKLES}</button>
      <section class="panel" role="dialog" aria-label="Asistente LUMA">
        <header class="head">
          <div class="avatar">${ICON_SPARKLES}</div>
          <div class="meta">
            <div class="title">Asistente LUMA</div>
            <div class="sub"><span class="dot"></span>Solo lectura · Conectado</div>
          </div>
          <button class="x" title="Cerrar" aria-label="Cerrar">${ICON_CLOSE}</button>
        </header>
        <div class="log"></div>
        <footer class="foot">
          <div class="inputwrap">
            <textarea rows="1" placeholder="Pregunta sobre facturas, clientes, KPIs…"></textarea>
            <button class="send" title="Enviar" aria-label="Enviar" disabled>${ICON_SEND}</button>
          </div>
          <div class="hint">Enter para enviar · Shift+Enter salto de línea</div>
        </footer>
      </section>
    `;
    document.body.appendChild(host);

    const fab = root.querySelector(".fab");
    const panel = root.querySelector(".panel");
    const closeBtn = root.querySelector(".x");
    const log = root.querySelector(".log");
    const input = root.querySelector("textarea");
    const send = root.querySelector(".send");

    // Persistent typing indicator (reused; shown while waiting / consulting).
    const typing = el("div", { class: "typing" });
    typing.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="label">Pensando…</span>`;
    const typingLabel = typing.querySelector(".label");
    log.appendChild(typing);

    let started = false;
    let starting = false;

    fab.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      if (open) {
        ensureStarted();
        setTimeout(() => input.focus(), 180);
      }
    });
    closeBtn.addEventListener("click", () => panel.classList.remove("open"));
    send.addEventListener("click", submit);
    input.addEventListener("input", () => {
      autosize();
      send.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    function autosize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 132) + "px";
    }

    // Stream sidecar events.
    listen("agent-event", (e) => handleAgentLine(e.payload));
    // Surface error-like stderr from the sidecar/claude so failures are visible.
    listen("agent-stderr", (e) => {
      const line = String(e.payload || "");
      if (/error|fail|denied|unauthor|invalid|enoent|cannot|no such|spawn/i.test(line)) {
        sys("⚙︎ " + line.slice(0, 240), true);
      }
    });

    async function ensureStarted() {
      if (started || starting) return;
      starting = true;
      try {
        const hasToken = await invoke("has_luma_token");
        if (!hasToken) {
          setTyping(true, "Conectando con tus datos de LUMA…");
          const resp = await fetch("/api/desktop/provision-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceLabel: "LUMA Desktop" }),
          });
          setTyping(false);
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
        setTyping(false);
        sys("Error al iniciar el asistente: " + errMsg(err), true);
      } finally {
        starting = false;
      }
    }

    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      autosize();
      send.disabled = true;
      msg("user", text);
      setTyping(true, "Pensando…");
      await ensureStarted();
      if (!started) {
        setTyping(false);
        return;
      }
      try {
        await invoke("send_message", { message: text });
      } catch (err) {
        setTyping(false);
        sys("No se pudo enviar: " + errMsg(err), true);
      }
    }

    // Render the Agent SDK message JSON lines. Surface assistant text (streamed,
    // markdown-rendered) and a lightweight "consultando…" hint on tool use.
    let botBuf = null; // { node, raw }
    function handleAgentLine(line) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        const text = m.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          setTyping(false);
          appendBot(text);
        }
        const usedTool = m.message.content.some((b) => b.type === "tool_use");
        if (usedTool && !text) setTyping(true, "Consultando datos de LUMA…");
      } else if (m.type === "result") {
        botBuf = null; // end of turn
        setTyping(false);
      } else if (m.type === "fatal" || m.type === "error") {
        setTyping(false);
        sys("Error del asistente: " + (m.message || "desconocido"), true);
      } else if (m.type === "sidecar-exit") {
        started = false;
        setTyping(false);
        sys("El asistente se cerró. Reábrelo para continuar.");
      }
    }

    function appendBot(text) {
      if (!botBuf) {
        const node = el("div", { class: "msg bot" });
        log.insertBefore(node, typing);
        botBuf = { node, raw: "" };
      }
      botBuf.raw += text;
      botBuf.node.innerHTML = renderMarkdown(botBuf.raw);
      scrollDown();
    }

    function msg(kind, text) {
      botBuf = null;
      const node = el("div", { class: "msg " + kind }, text);
      log.insertBefore(node, typing);
      scrollDown();
    }

    function sys(text, isErr) {
      botBuf = null;
      const node = el("div", { class: "sys" + (isErr ? " err" : "") }, text);
      log.insertBefore(node, typing);
      scrollDown();
    }

    function setTyping(on, label) {
      if (label) typingLabel.textContent = label;
      typing.classList.toggle("show", !!on);
      if (on) {
        log.appendChild(typing); // keep it last
        scrollDown();
      }
    }

    function scrollDown() {
      log.scrollTop = log.scrollHeight;
    }

    function errMsg(err) {
      return err && err.message ? err.message : String(err);
    }

    function el(tag, attrs, text) {
      const n = document.createElement(tag);
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    }

    // --- Minimal, safe markdown renderer (escape-first; no link navigation). ---
    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function fmtInline(s) {
      s = escapeHtml(s);
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }
    function renderSegment(text) {
      const lines = text.split("\n");
      let out = "", inUl = false, inOl = false, para = [];
      const flushPara = () => { if (para.length) { out += "<p>" + para.join("<br>") + "</p>"; para = []; } };
      const closeLists = () => { if (inUl) { out += "</ul>"; inUl = false; } if (inOl) { out += "</ol>"; inOl = false; } };
      for (const line of lines) {
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        const h = line.match(/^\s*(#{1,3})\s+(.*)$/);
        if (ul) {
          flushPara(); if (inOl) { out += "</ol>"; inOl = false; }
          if (!inUl) { out += "<ul>"; inUl = true; }
          out += "<li>" + fmtInline(ul[1]) + "</li>"; continue;
        }
        if (ol) {
          flushPara(); if (inUl) { out += "</ul>"; inUl = false; }
          if (!inOl) { out += "<ol>"; inOl = true; }
          out += "<li>" + fmtInline(ol[1]) + "</li>"; continue;
        }
        if (h) { flushPara(); closeLists(); out += '<p class="h">' + fmtInline(h[2]) + "</p>"; continue; }
        if (line.trim() === "") { flushPara(); closeLists(); continue; }
        para.push(fmtInline(line));
      }
      flushPara(); closeLists();
      return out;
    }
    function renderMarkdown(src) {
      // Split on fenced code blocks (tolerant of an unterminated fence while streaming).
      const parts = src.split("```");
      let html = "";
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, "");
          html += "<pre><code>" + escapeHtml(body) + "</code></pre>";
        } else {
          html += renderSegment(part);
        }
      });
      return html;
    }
  });
})();
