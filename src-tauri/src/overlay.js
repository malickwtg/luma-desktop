// LUMA Desktop — assistant sidebar injected over the remote LUMA web.
//
// Runs as a Tauri initialization_script (before page scripts, not subject to the
// page CSP). Implements the "LUMA - Sidebar Asistente IA" design: a right-docked
// sidebar (sharp borders, Hedvig Letters + JetBrains Mono, role-aware empty state,
// topic chips, real model selector) wired to the Rust bridge:
//   - provisions a read-only MCP token via /api/desktop/provision-token (the
//     WebView is already logged into LUMA), hands it to Rust (store_luma_token),
//   - gates on `claude login` (check_claude_auth) before starting the agent,
//   - starts the Agent SDK sidecar with the chosen model, streams its output,
//   - surfaces failures instead of hanging (watchdog, result subtypes, auth-expiry).
//
// The whole UI lives in a Shadow DOM so styles never bleed into LUMA (and LUMA's
// CSS never bleeds into the chat). Light/dark follows the OS. Self-contained.
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

  // Map the 3 UI tiers to real Agent SDK model slugs (verified against claude-api).
  const MODEL_SLUG = { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-6", quality: "claude-opus-4-8" };

  // Anthropic burst logo (from the design).
  const BURST_PATH =
    "M14.854 2.698a9.148 9.148 0 0 1 0 5.786l-.542 1.623 2.012-1.783a7.378 7.378 0 0 0 2.333-4.04l.57-2.786 1.733.354-.57 2.787a9.149 9.149 0 0 1-2.892 5.01l-1.283 1.137 2.635-.538a7.379 7.379 0 0 0 4.04-2.333l1.888-2.129 1.324 1.174-1.887 2.129a9.148 9.148 0 0 1-5.01 2.892l-1.68.344 2.551.85a7.379 7.379 0 0 0 4.666 0l2.698-.9.56 1.68-2.698.9a9.148 9.148 0 0 1-5.785 0l-1.625-.543 1.784 2.012a7.375 7.375 0 0 0 4.04 2.331l2.787.572-.355 1.733-2.787-.57a9.148 9.148 0 0 1-5.01-2.892l-1.136-1.281.539 2.633a7.376 7.376 0 0 0 2.331 4.04l2.129 1.887L21.04 26.1l-2.129-1.887a9.146 9.146 0 0 1-2.892-5.01l-.343-1.677-.85 2.55a7.379 7.379 0 0 0 0 4.665l.9 2.698-1.68.56-.9-2.698a9.148 9.148 0 0 1 0-5.785l.541-1.627-2.01 1.785a7.38 7.38 0 0 0-2.334 4.04l-.57 2.788-1.733-.357.57-2.785a9.148 9.148 0 0 1 2.892-5.01l1.281-1.138-2.633.54a7.377 7.377 0 0 0-4.04 2.332l-1.887 2.129L1.9 21.04l1.887-2.129a9.146 9.146 0 0 1 5.01-2.892l1.678-.345-2.55-.849a7.379 7.379 0 0 0-4.666 0l-2.698.9-.56-1.68 2.698-.9a9.148 9.148 0 0 1 5.786 0l1.623.542-1.783-2.01a7.377 7.377 0 0 0-4.04-2.334l-2.786-.57.354-1.733 2.787.57a9.148 9.148 0 0 1 5.01 2.892l1.135 1.28-.538-2.632a7.376 7.376 0 0 0-2.331-4.04L5.786 3.223 6.96 1.898 9.09 3.785a9.148 9.148 0 0 1 2.892 5.01l.344 1.68.85-2.551a7.379 7.379 0 0 0 0-4.666l-.9-2.698 1.68-.56.9 2.698ZM14 11.234A2.767 2.767 0 0 0 11.234 14l.015.283a2.766 2.766 0 0 0 5.502 0l.014-.283-.014-.283a2.766 2.766 0 0 0-2.468-2.468L14 11.234Z";
  const burst = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="currentColor"><path d="${BURST_PATH}"></path></svg>`;
  const stroke = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ICON = {
    close: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    newChat: stroke('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    send: stroke('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    stop: stroke('<rect width="11" height="11" x="6.5" y="6.5" rx="1.5"/>'),
    chevron: stroke('<path d="m6 9 6 6 6-6"/>'),
    bot: stroke('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
    loader: stroke('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
    receipt: stroke('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'),
    chart: stroke('<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>'),
    file: stroke('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>'),
    alert: stroke('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    users: stroke('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    package: stroke('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  };

  // v1 desktop assistant is Dirección-only (SUPERADMIN/DIRECTIVO). Suggestions
  // target that audience.
  const ROLE = {
    desc: "Pregunta sobre KPIs, facturación, cobros y clientes.",
    suggestions: [
      "¿Cómo vamos de facturación este mes?",
      "Top 10 clientes por facturación",
      "Facturas pendientes de cobro",
      "KPIs del trimestre",
    ],
  };
  const CHIPS = [
    { label: "Facturación", icon: ICON.receipt, prompt: "¿Cómo vamos de facturación este mes?" },
    { label: "KPIs", icon: ICON.chart, prompt: "Enséñame los KPIs del trimestre" },
    { label: "Presupuestos", icon: ICON.file, prompt: "¿Qué presupuestos están pendientes de respuesta?" },
    { label: "Incidencias", icon: ICON.alert, prompt: "¿Hay incidencias abiertas?" },
    { label: "Clientes", icon: ICON.users, prompt: "Top 10 clientes por facturación" },
    { label: "Inventario", icon: ICON.package, prompt: "¿Cómo está el stock de almacén?" },
  ];
  const MODELS = [
    { id: "fast", label: "Rápido", desc: "Haiku · respuestas instantáneas" },
    { id: "balanced", label: "Equilibrado", desc: "Sonnet · mejor calidad" },
    { id: "quality", label: "Calidad", desc: "Opus · máxima precisión" },
  ];

  const BRIEFING_PROMPT =
    "Dame el parte del día de hoy: facturación del mes, facturas vencidas con importe, incidencias abiertas, presupuestos que expiran esta semana y stock bajo mínimo. Formatea en tablas.";

  ready(function () {
    if (!window.__TAURI__) return; // not running inside the desktop app

    if (!document.getElementById("luma-desktop-fonts")) {
      const pc1 = document.createElement("link");
      pc1.rel = "preconnect"; pc1.href = "https://fonts.googleapis.com";
      const pc2 = document.createElement("link");
      pc2.rel = "preconnect"; pc2.href = "https://fonts.gstatic.com"; pc2.crossOrigin = "anonymous";
      const f = document.createElement("link");
      f.id = "luma-desktop-fonts"; f.rel = "stylesheet";
      f.href = "https://fonts.googleapis.com/css2?family=Hedvig+Letters+Sans&family=Hedvig+Letters+Serif&family=JetBrains+Mono:wght@400;500;600&display=swap";
      document.head.appendChild(pc1);
      document.head.appendChild(pc2);
      document.head.appendChild(f);
    }

    const CSS = `
      :host {
        --bg:#ffffff; --fg:#121212; --card:#f7f6f1; --secondary:#e6e4dd; --accent:#f1efea;
        --border:#dcdbd7; --primary:#18181b; --primary-fg:#fafafa; --muted-fg:#616161;
        --tag-bg:#f2f1ef; --tag-fg:#878787; --destructive:#ef4444; --pos:#16794c;
        --sans:"Hedvig Letters Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
        --serif:"Hedvig Letters Serif", Georgia, "Times New Roman", serif;
        --mono:"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg:#0c0c0c; --fg:#fafafa; --card:#121212; --secondary:#121212; --accent:#1c1c1c;
          --border:#1c1c1c; --primary:#fafafa; --primary-fg:#18181b; --muted-fg:#878787;
          --tag-bg:#1d1d1d; --tag-fg:#878787; --destructive:#ff3b3b; --pos:#3fb950;
        }
      }
      * { box-sizing: border-box; }
      @keyframes luma-spin { to { transform: rotate(360deg); } }

      .launcher {
        position: fixed; right: 22px; bottom: 22px; width: 50px; height: 50px;
        background: var(--primary); color: var(--primary-fg); border: none; cursor: pointer;
        display: grid; place-items: center; box-shadow: 0 6px 22px rgba(0,0,0,.20);
        transition: transform .15s ease, box-shadow .15s;
      }
      .launcher:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(0,0,0,.26); }
      .launcher svg { width: 24px; height: 24px; }

      .sidebar {
        position: fixed; top: 0; right: 0; height: 100vh; width: 404px; max-width: 100vw;
        background: var(--bg); color: var(--fg); border-left: 1px solid var(--border);
        font-family: var(--sans); display: flex; flex-direction: column; min-height: 0;
        transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1);
        box-shadow: -10px 0 44px rgba(0,0,0,.14);
      }
      .sidebar.open { transform: none; }

      .head { height: 52px; flex: none; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 14px; gap: 9px; }
      .head .brand { color: var(--fg); display: flex; }
      .head .title { font-size: 14px; font-weight: 500; }
      .head .tag { font-size: 10px; color: var(--tag-fg); background: var(--tag-bg); padding: 2px 7px; }
      .head .sp { flex: 1; }
      .head .ico { width: 30px; height: 30px; border: none; background: none; cursor: pointer; display: grid; place-items: center; color: var(--muted-fg); transition: color .12s, background .12s; }
      .head .ico:hover { color: var(--fg); background: var(--accent); }
      .head .ico svg { width: 17px; height: 17px; }

      .body { flex: 1; overflow: auto; min-height: 0; }
      .body::-webkit-scrollbar { width: 10px; }
      .body::-webkit-scrollbar-thumb { background: var(--border); border: 3px solid var(--bg); }

      .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 46px 24px 22px; }
      .empty .glyph { color: var(--muted-fg); opacity: .45; display: flex; margin-bottom: 14px; }
      .empty .etitle { font-family: var(--serif); font-size: 21px; line-height: 1.15; }
      .empty .edesc { font-size: 13px; color: var(--muted-fg); margin-top: 8px; max-width: 280px; line-height: 1.5; }
      .sugg { padding: 0 16px; display: flex; flex-direction: column; }
      .sugg button { display: block; width: 100%; text-align: left; padding: 11px 12px; background: none; border: none; cursor: pointer; font-size: 13px; color: var(--muted-fg); font-family: inherit; transition: background .1s, color .1s; }
      .sugg button:hover { background: var(--accent); color: var(--fg); }
      .sugg button b { color: var(--fg); font-weight: 500; }

      .conv { padding: 18px 16px; display: flex; flex-direction: column; gap: 16px; }
      .row-user { display: flex; justify-content: flex-end; }
      .row-user > div { background: var(--accent); padding: 9px 12px; max-width: 82%; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
      .bot { font-size: 13.5px; line-height: 1.55; word-break: break-word; }
      .bot > :first-child { margin-top: 0; } .bot > :last-child { margin-bottom: 0; }
      .bot p { margin: 0 0 10px; } .bot p.h { font-weight: 500; }
      .bot ul, .bot ol { margin: 0 0 10px; padding-left: 20px; } .bot li { margin: 3px 0; }
      .bot strong { font-weight: 600; }
      .bot code { font-family: var(--mono); font-size: 12px; background: var(--card); border: 1px solid var(--border); padding: 1px 5px; }
      .bot pre { background: var(--card); border: 1px solid var(--border); padding: 11px 13px; margin: 0 0 10px; overflow-x: auto; }
      .bot pre code { background: none; border: none; padding: 0; font-size: 12px; line-height: 1.5; }
      .bot table { border: 1px solid var(--border); border-collapse: collapse; width: 100%; margin: 0 0 10px; }
      .bot th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 10px; color: var(--muted-fg); text-transform: uppercase; letter-spacing: .04em; font-weight: 400; }
      .bot td { padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
      .bot tr:last-child td { border-bottom: none; }
      .bot td.num, .bot th.num { text-align: right; font-family: var(--mono); }

      .status { display: none; align-items: center; gap: 8px; font-size: 12px; color: var(--muted-fg); }
      .status.show { display: flex; }
      .status svg { width: 14px; height: 14px; animation: luma-spin 1s linear infinite; }
      .sys { align-self: center; text-align: center; font-size: 12px; color: var(--tag-fg); max-width: 90%; line-height: 1.5; }
      .sys.err { color: var(--destructive); }
      .meta { align-self: flex-start; font-size: 10.5px; color: var(--tag-fg); font-family: var(--mono); margin-top: -6px; }

      .chips { flex: none; display: flex; gap: 7px; padding: 8px 14px 0; overflow-x: auto; }
      .chips::-webkit-scrollbar { display: none; }
      .chip { display: flex; align-items: center; gap: 5px; padding: 6px 10px; font-size: 12px; color: var(--muted-fg); background: var(--card); white-space: nowrap; flex: none; border: none; cursor: pointer; font-family: inherit; transition: color .1s; }
      .chip:hover { color: var(--fg); }
      .chip svg { width: 14px; height: 14px; }

      .foot { flex: none; padding: 12px 14px 14px; }
      .inputcard { border: 1px solid var(--border); background: var(--card); padding: 10px 12px; }
      .inputrow { display: flex; align-items: flex-end; gap: 8px; }
      textarea { flex: 1; background: none; border: none; outline: none; resize: none; color: var(--fg); font-family: var(--sans); font-size: 13.5px; line-height: 1.5; max-height: 130px; min-height: 22px; padding: 1px 0; }
      textarea::placeholder { color: var(--muted-fg); }
      .send { flex: none; width: 32px; height: 32px; background: var(--primary); color: var(--primary-fg); border: none; cursor: pointer; display: grid; place-items: center; transition: opacity .12s; }
      .send svg { width: 17px; height: 17px; }
      .send:disabled { opacity: .4; cursor: default; }
      .toolbar { display: flex; align-items: center; gap: 4px; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--border); position: relative; }
      .tbtn { display: flex; align-items: center; gap: 5px; padding: 4px 7px; background: none; border: none; cursor: pointer; font-size: 12px; color: var(--muted-fg); font-family: inherit; }
      .tbtn svg { width: 14px; height: 14px; }
      .hint { font-size: 10px; color: var(--tag-fg); }
      .modelmenu { position: absolute; bottom: 100%; left: 0; margin-bottom: 6px; background: var(--card); border: 1px solid var(--border); box-shadow: 0 4px 12px -2px rgba(0,0,0,.10); padding: 4px; min-width: 220px; z-index: 10; display: none; }
      .modelmenu.open { display: block; }
      .modelmenu button { display: block; width: 100%; text-align: left; padding: 7px 10px; background: none; border: none; cursor: pointer; font-family: inherit; }
      .modelmenu button:hover, .modelmenu button.sel { background: var(--accent); }
      .modelmenu .ml { font-size: 12px; font-weight: 500; color: var(--fg); }
      .modelmenu .md { font-size: 10px; color: var(--muted-fg); margin-top: 1px; }
    `;

    const host = document.createElement("div");
    host.id = "luma-desktop-root";
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="launcher" title="Asistente LUMA" aria-label="Asistente LUMA">${burst(24)}</button>
      <aside class="sidebar" role="dialog" aria-label="Asistente LUMA">
        <header class="head">
          <span class="brand">${burst(18)}</span>
          <span class="title">Asistente LUMA</span>
          <span class="tag">Solo lectura</span>
          <span class="sp"></span>
          <button class="ico new" title="Nueva conversación">${ICON.newChat}</button>
          <button class="ico close" title="Cerrar">${ICON.close}</button>
        </header>
        <div class="body">
          <div class="empty">
            <span class="glyph">${burst(40)}</span>
            <div class="etitle">Asistente LUMA</div>
            <div class="edesc">${ROLE.desc}</div>
          </div>
          <div class="sugg"></div>
          <div class="conv" style="display:none" aria-live="polite"></div>
        </div>
        <div class="chips"></div>
        <footer class="foot">
          <div class="inputcard">
            <div class="inputrow">
              <textarea rows="1" placeholder="Pregunta lo que necesites…"></textarea>
              <button class="send" title="Enviar" disabled>${ICON.send}</button>
            </div>
            <div class="toolbar">
              <button class="tbtn model">${ICON.bot}<span class="mlabel">Equilibrado</span>${ICON.chevron}</button>
              <span class="sp" style="flex:1"></span>
              <span class="hint">Enter para enviar</span>
              <div class="modelmenu"></div>
            </div>
          </div>
        </footer>
      </aside>
    `;
    document.body.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const launcher = $(".launcher");
    const sidebar = $(".sidebar");
    const empty = $(".empty");
    const sugg = $(".sugg");
    const chips = $(".chips");
    const conv = $(".conv");
    const input = $("textarea");
    const send = $(".send");
    const modelBtn = $(".tbtn.model");
    const modelMenu = $(".modelmenu");

    const status = el("div", { class: "status" });
    status.innerHTML = ICON.loader + '<span class="slabel">Pensando…</span>';
    const statusLabel = status.querySelector(".slabel");
    conv.appendChild(status);

    let started = false;
    let starting = false;
    let view = "empty";
    let model = "balanced";
    let inFlight = false;
    let turnHadText = false;
    let watchdog = null;
    let stderrBuf = [];

    ROLE.suggestions.forEach((text) => {
      const w = text.split(" ");
      const b = el("button");
      b.innerHTML = "<b>" + escapeHtml(w.slice(0, 2).join(" ")) + "</b> " + escapeHtml(w.slice(2).join(" "));
      b.addEventListener("click", () => sendText(text));
      sugg.appendChild(b);
    });
    CHIPS.forEach((c) => {
      const b = el("button", { class: "chip" });
      b.innerHTML = c.icon + escapeHtml(c.label);
      b.addEventListener("click", () => { input.value = c.prompt; autosize(); send.disabled = false; input.focus(); });
      chips.appendChild(b);
    });
    MODELS.forEach((m) => {
      const b = el("button");
      if (m.id === model) b.className = "sel";
      b.innerHTML = '<div class="ml">' + escapeHtml(m.label) + '</div><div class="md">' + escapeHtml(m.desc) + "</div>";
      b.addEventListener("click", () => onModelChange(m));
      modelMenu.appendChild(b);
    });

    function setView(v) {
      view = v;
      const isEmpty = v === "empty";
      empty.style.display = isEmpty ? "" : "none";
      sugg.style.display = isEmpty ? "" : "none";
      chips.style.display = isEmpty ? "" : "none";
      conv.style.display = isEmpty ? "none" : "";
    }
    setView("empty");

    launcher.addEventListener("click", openSidebar);
    $(".close").addEventListener("click", () => sidebar.classList.remove("open"));
    $(".new").addEventListener("click", newConversation);
    send.addEventListener("click", () => (inFlight ? stopTurn() : submit()));
    modelBtn.addEventListener("click", (e) => { e.stopPropagation(); modelMenu.classList.toggle("open"); });
    root.addEventListener("click", (e) => { if (!modelBtn.contains(e.target) && !modelMenu.contains(e.target)) modelMenu.classList.remove("open"); });
    input.addEventListener("input", () => { autosize(); if (!inFlight) send.disabled = !input.value.trim(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!inFlight) submit(); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebar.classList.contains("open")) sidebar.classList.remove("open"); });

    function onModelChange(m) {
      model = m.id;
      modelBtn.querySelector(".mlabel").textContent = m.label;
      modelMenu.querySelectorAll("button").forEach((x, i) => x.classList.toggle("sel", MODELS[i].id === model));
      modelMenu.classList.remove("open");
      // Model is bound at session start; restart so the next question uses it.
      if (started) {
        invoke("stop_agent_session").catch(() => {});
        started = false;
        sys("Modelo: " + m.label + ". Se aplica en tu próxima pregunta.");
      }
    }

    function openSidebar() {
      sidebar.classList.add("open");
      ensureStarted();
      setTimeout(() => input.focus(), 200);
      // C2: morning briefing, auto once per calendar day.
      try {
        const today = new Date().toISOString().slice(0, 10);
        if (localStorage.getItem("luma-desktop-briefing") !== today) {
          localStorage.setItem("luma-desktop-briefing", today);
          setTimeout(() => { if (view !== "chat" && !inFlight) sendText(BRIEFING_PROMPT); }, 450);
        }
      } catch (_) {}
    }
    function newConversation() {
      conv.querySelectorAll(".row-user, .bot, .sys, .meta").forEach((n) => n.remove());
      botBuf = null;
      setTyping(false);
      setInFlight(false);
      setView("empty");
    }
    function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 130) + "px"; }

    listen("agent-event", (e) => handleAgentLine(e.payload));
    // H: buffer stderr per turn; surface it only if a turn fails silently (no text).
    // Kills boot-time noise from the claude binary AND keeps the real errors the old
    // keyword regex used to drop (it's shown verbatim on an empty/failed turn).
    listen("agent-stderr", (e) => {
      const line = String(e.payload || "").trim();
      if (line) { stderrBuf.push(line); if (stderrBuf.length > 30) stderrBuf.shift(); }
    });

    async function ensureStarted() {
      if (started || starting) return;
      starting = true;
      try {
        const hasToken = await invoke("has_luma_token");
        if (!hasToken) {
          const resp = await fetch("/api/desktop/provision-token", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceLabel: "LUMA Desktop" }),
          });
          if (resp.status === 404) { sys("Esta versión de LUMA aún no soporta el asistente de escritorio. Actualiza LUMA e inténtalo de nuevo."); starting = false; return; }
          if (resp.status === 403) { sys("El asistente de escritorio está disponible solo para Dirección en esta versión."); starting = false; return; }
          if (resp.status === 401) { sys("Inicia sesión en LUMA primero (la pestaña debe estar logueada).", true); starting = false; return; }
          if (!resp.ok) { sys("No se pudo conectar el asistente (" + resp.status + ")."); starting = false; return; }
          const { token } = await resp.json();
          await invoke("store_luma_token", { token });
        }
        // D1: gate on `claude login` (subscription). check_claude_auth already exists.
        let authed = true;
        try { authed = await invoke("check_claude_auth"); } catch (_) { authed = true; }
        if (!authed) {
          sys("El asistente necesita que inicies sesión en Claude (tu suscripción). Abre la app Terminal y ejecuta:  claude login  — luego reabre este chat.", true);
          starting = false;
          return;
        }
        await invoke("start_agent_session", { model: MODEL_SLUG[model] });
        started = true;
      } catch (err) {
        setTyping(false); setInFlight(false);
        sys("Error al iniciar el asistente: " + errMsg(err), true);
      } finally {
        starting = false;
      }
    }

    function submit() {
      const text = input.value.trim();
      if (!text || inFlight) return;
      input.value = "";
      autosize();
      sendText(text);
    }
    async function sendText(text) {
      if (inFlight) return;
      if (view !== "chat") setView("chat");
      msg("user", text);
      turnHadText = false;
      stderrBuf = [];
      setTyping(true, "Pensando…");
      setInFlight(true);
      await ensureStarted();
      if (!started) { setTyping(false); setInFlight(false); return; }
      try {
        await invoke("send_message", { message: text });
        armWatchdog();
      } catch (err) {
        setTyping(false); setInFlight(false);
        sys("No se pudo enviar: " + errMsg(err), true);
      }
    }
    async function stopTurn() {
      clearWatchdog();
      try { await invoke("stop_agent_session"); } catch (_) {}
      started = false; botBuf = null;
      setTyping(false); setInFlight(false);
      sys("Detenido.");
    }

    let botBuf = null;
    function handleAgentLine(line) {
      clearWatchdog();
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text) { setTyping(false); turnHadText = true; appendBot(text); }
        const usedTool = m.message.content.some((b) => b.type === "tool_use");
        if (usedTool && !text) setTyping(true, "Consultando datos…");
      } else if (m.type === "result") {
        botBuf = null; setTyping(false); setInFlight(false);
        if (m.subtype && m.subtype !== "success") sys("El asistente no pudo completar la respuesta (" + m.subtype + ")." + stderrTail(), true);
        else if (!turnHadText) sys("No obtuve respuesta. Inténtalo de nuevo." + stderrTail(), true);
        else renderMeta(m); // C4
      } else if (m.type === "auth-expired") {
        started = false; setTyping(false); setInFlight(false);
        sys("Tu sesión con LUMA caducó. Cierra y reabre la app para reconectar.", true);
      } else if (m.type === "fatal" || m.type === "error") {
        setTyping(false); setInFlight(false);
        sys("Error del asistente: " + (m.message || "desconocido"), true);
      } else if (m.type === "sidecar-exit") {
        started = false; setTyping(false); setInFlight(false);
        sys("El asistente se cerró." + (stderrTail() || " Reábrelo para continuar."), true);
      }
      if (inFlight) armWatchdog();
    }

    function renderMeta(m) {
      const u = m.usage || {};
      const toks = (u.input_tokens || 0) + (u.output_tokens || 0);
      const parts = [];
      if (m.num_turns) parts.push(m.num_turns + " turno" + (m.num_turns > 1 ? "s" : ""));
      if (toks) parts.push("~" + Math.round(toks / 100) / 10 + "k tokens");
      if (typeof m.total_cost_usd === "number" && m.total_cost_usd > 0) parts.push(m.total_cost_usd.toFixed(3) + " $");
      if (parts.length) conv.insertBefore(el("div", { class: "meta" }, parts.join(" · ")), status);
    }
    function appendBot(text) {
      if (!botBuf) { const node = el("div", { class: "bot" }); conv.insertBefore(node, status); botBuf = { node, raw: "" }; }
      botBuf.raw += text;
      botBuf.node.innerHTML = renderMarkdown(botBuf.raw);
      scrollDown();
    }
    function msg(kind, text) {
      botBuf = null;
      let node;
      if (kind === "user") { node = el("div", { class: "row-user" }); node.appendChild(el("div", null, text)); }
      else node = el("div", { class: kind }, text);
      conv.insertBefore(node, status);
      scrollDown();
    }
    function sys(text, isErr) {
      botBuf = null;
      if (view !== "chat") setView("chat");
      conv.insertBefore(el("div", { class: "sys" + (isErr ? " err" : "") }, text), status);
      scrollDown();
    }
    function setTyping(on, label) {
      if (label) statusLabel.textContent = label;
      status.classList.toggle("show", !!on);
      if (on) { conv.appendChild(status); scrollDown(); }
    }
    function setInFlight(on) {
      inFlight = on;
      if (on) { send.disabled = false; send.innerHTML = ICON.stop; send.title = "Detener"; }
      else { send.innerHTML = ICON.send; send.title = "Enviar"; send.disabled = !input.value.trim(); }
    }
    // H: watchdog so a stuck turn (offline / blocked endpoint) surfaces instead of spinning forever.
    function armWatchdog() {
      clearWatchdog();
      watchdog = setTimeout(() => {
        if (inFlight) { setTyping(false); setInFlight(false); sys("Sin respuesta. Comprueba tu conexión a internet e inténtalo de nuevo." + stderrTail(), true); }
      }, 45000);
    }
    function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }
    function stderrTail() {
      const errs = stderrBuf.filter((l) =>
        /error|fail|denied|unauthor|invalid|enoent|cannot|no such|spawn|timeout|timed out|econnrefused|etimedout|getaddrinfo|enotfound|429|overloaded|rate.?limit|quota|network|offline|certificate|tls|credential|login/i.test(l)
      );
      const tail = (errs.length ? errs : stderrBuf).slice(-2).join(" · ");
      return tail ? " Detalle: " + tail.slice(0, 200) : "";
    }
    function scrollDown() { const b = $(".body"); b.scrollTop = b.scrollHeight; }
    function errMsg(err) { return err && err.message ? err.message : String(err); }
    function el(tag, attrs, text) {
      const n = document.createElement(tag);
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text != null) n.textContent = text;
      return n;
    }

    // --- Minimal, safe markdown renderer (escape-first; GFM tables; no links). ---
    function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function fmtInline(s) {
      s = escapeHtml(s);
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }
    function splitRow(line) {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map((c) => c.trim());
    }
    function isSep(line) {
      if (line.indexOf("|") === -1) return false;
      const cells = splitRow(line);
      return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
    }
    function renderSegment(text) {
      const lines = text.split("\n");
      let out = "", inUl = false, inOl = false, para = [];
      const flushPara = () => { if (para.length) { out += "<p>" + para.join("<br>") + "</p>"; para = []; } };
      const closeLists = () => { if (inUl) { out += "</ul>"; inUl = false; } if (inOl) { out += "</ol>"; inOl = false; } };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("|") !== -1 && i + 1 < lines.length && isSep(lines[i + 1])) {
          flushPara(); closeLists();
          const headers = splitRow(line);
          const aligns = splitRow(lines[i + 1]).map((c) => (c.endsWith(":") ? "num" : ""));
          i++;
          const rows = [];
          while (i + 1 < lines.length && lines[i + 1].indexOf("|") !== -1 && lines[i + 1].trim() !== "" && !isSep(lines[i + 1])) { i++; rows.push(splitRow(lines[i])); }
          out += "<table><thead><tr>";
          headers.forEach((h, c) => { out += '<th class="' + (aligns[c] || "") + '">' + fmtInline(h) + "</th>"; });
          out += "</tr></thead><tbody>";
          rows.forEach((r) => { out += "<tr>"; headers.forEach((_, c) => { out += '<td class="' + (aligns[c] || "") + '">' + fmtInline(r[c] || "") + "</td>"; }); out += "</tr>"; });
          out += "</tbody></table>";
          continue;
        }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        const h = line.match(/^\s*(#{1,3})\s+(.*)$/);
        if (ul) { flushPara(); if (inOl) { out += "</ol>"; inOl = false; } if (!inUl) { out += "<ul>"; inUl = true; } out += "<li>" + fmtInline(ul[1]) + "</li>"; continue; }
        if (ol) { flushPara(); if (inUl) { out += "</ul>"; inUl = false; } if (!inOl) { out += "<ol>"; inOl = true; } out += "<li>" + fmtInline(ol[1]) + "</li>"; continue; }
        if (h) { flushPara(); closeLists(); out += '<p class="h">' + fmtInline(h[2]) + "</p>"; continue; }
        if (line.trim() === "") { flushPara(); closeLists(); continue; }
        para.push(fmtInline(line));
      }
      flushPara(); closeLists();
      return out;
    }
    function renderMarkdown(src) {
      const parts = src.split("```");
      let html = "";
      parts.forEach((part, i) => {
        if (i % 2 === 1) { const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, ""); html += "<pre><code>" + escapeHtml(body) + "</code></pre>"; }
        else html += renderSegment(part);
      });
      return html;
    }
  });
})();
