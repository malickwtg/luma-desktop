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
    expand: stroke('<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>'),
    bot: stroke('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
    loader: stroke('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
    receipt: stroke('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'),
    chart: stroke('<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>'),
    file: stroke('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>'),
    alert: stroke('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    users: stroke('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    package: stroke('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    history: stroke('<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>'),
    mic: stroke('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
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

    // App version (for error telemetry — which release failed).
    let APP_VERSION = "";
    invoke("get_app_version").then((v) => { APP_VERSION = String(v || ""); }).catch(() => {});

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

    // Push the LUMA page aside (instead of covering it) while the panel is docked.
    // The page lives in THIS same WebView, so we can't resize a separate native
    // view — instead we narrow <body> to the remaining width and give it a
    // transform, which makes even LUMA's fixed navbar/sidebar reflow into that
    // width (a transform makes <body> the containing block for its fixed
    // descendants). The chat host hangs off <html> (sibling of <body>), so it is
    // NOT contained by that transform and stays pinned to the real viewport edge.
    if (!document.getElementById("luma-desktop-push-style")) {
      const ps = document.createElement("style");
      ps.id = "luma-desktop-push-style";
      ps.textContent = `
        html.luma-assistant-pushed { overflow-x: hidden; }
        html.luma-assistant-pushed > body {
          width: calc(100% - var(--luma-push, 0px)) !important;
          max-width: calc(100% - var(--luma-push, 0px)) !important;
          transform: translateZ(0);
          transition: width .24s cubic-bezier(.2,.8,.2,1), max-width .24s cubic-bezier(.2,.8,.2,1);
        }
        html.luma-resizing > body { transition: none !important; }
      `;
      document.head.appendChild(ps);
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

      /* Resize handle on the docked (left) edge. */
      .resizer { position: absolute; left: 0; top: 0; width: 6px; height: 100%; cursor: ew-resize; z-index: 6; }
      .resizer:hover { background: var(--border); }

      /* KPI cards (luma:cards directive). */
      .bot .kcards { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 10px; }
      .bot .kcard { flex: 1 1 30%; min-width: 92px; border: 1px solid var(--border); background: var(--card); padding: 10px 12px; }
      .bot .klabel { font-size: 11px; color: var(--muted-fg); }
      .bot .kvalue { font-family: var(--mono); font-size: 20px; font-weight: 500; letter-spacing: -.01em; margin-top: 4px; color: var(--fg); }
      .bot .kdelta { font-family: var(--mono); font-size: 11px; margin-top: 2px; }
      .bot .kdelta.pos { color: var(--pos); }
      .bot .kdelta.neg { color: var(--destructive); }

      /* Mini bar chart (luma:chart directive). */
      .bot .chart { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 10px; }
      .bot .crow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .bot .clabel { flex: none; width: 96px; color: var(--muted-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bot .cbar { flex: 1; height: 8px; background: var(--accent); }
      .bot .cbar i { display: block; height: 100%; background: var(--primary); }
      .bot .cval { flex: none; font-family: var(--mono); text-align: right; min-width: 72px; }

      .histview .hrow { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
      .histview .hrow:hover { background: var(--accent); }
      .histview .hmeta { flex: 1; min-width: 0; }
      .histview .htitle { font-size: 13px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .histview .hsub { font-size: 11px; color: var(--muted-fg); margin-top: 2px; }
      .histview .hdel { flex: none; width: 26px; height: 26px; border: none; background: none; color: var(--muted-fg); cursor: pointer; display: grid; place-items: center; }
      .histview .hdel svg { width: 14px; height: 14px; }
      .histview .hdel:hover { color: var(--destructive); }
      .histview .hempty { text-align: center; color: var(--muted-fg); font-size: 13px; padding: 44px 24px; line-height: 1.5; }

      .mic { flex: none; width: 32px; height: 32px; background: none; border: 1px solid var(--border); color: var(--muted-fg); cursor: pointer; display: grid; place-items: center; }
      .mic svg { width: 16px; height: 16px; }
      .mic.rec { color: var(--destructive); border-color: var(--destructive); }

      .proposal { align-self: stretch; border: 1px solid var(--border); background: var(--accent); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      .proposal.done { border-color: var(--pos); }
      .proposal.err { border-color: var(--destructive); }
      .proposal.cancelled { opacity: .65; }
      .proposal .pbody { font-size: 13.5px; line-height: 1.5; }
      .proposal .pactions { display: flex; align-items: center; gap: 12px; }
      .proposal .pconfirm { background: var(--primary); color: var(--primary-fg); border: none; padding: 8px 14px; cursor: pointer; font-family: inherit; font-size: 13px; }
      .proposal .pstate { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted-fg); }
      .proposal .pstate svg { width: 14px; height: 14px; animation: luma-spin 1s linear infinite; }
      .proposal .plink { color: var(--fg); text-decoration: underline; font-size: 13px; }
    `;

    const host = document.createElement("div");
    host.id = "luma-desktop-root";
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="launcher" title="Asistente LUMA" aria-label="Asistente LUMA">${burst(24)}</button>
      <aside class="sidebar" role="dialog" aria-label="Asistente LUMA">
        <div class="resizer" title="Arrastra para ajustar el ancho"></div>
        <header class="head">
          <span class="brand">${burst(18)}</span>
          <span class="title">Asistente LUMA</span>
          <span class="tag">Dirección</span>
          <span class="sp"></span>
          <button class="ico expand" title="Ancho">${ICON.expand}</button>
          <button class="ico hist" title="Historial">${ICON.history}</button>
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
          <div class="histview" style="display:none"></div>
        </div>
        <div class="chips"></div>
        <footer class="foot">
          <div class="inputcard">
            <div class="inputrow">
              <textarea rows="1" placeholder="Pregunta lo que necesites…"></textarea>
              <button class="mic" title="Dictar por voz" style="display:none">${ICON.mic}</button>
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
    // Append to <html> (sibling of <body>), NOT into <body>: the page-push below
    // puts a transform on <body>, which would otherwise capture this fixed host
    // and drag the panel off the real viewport edge.
    document.documentElement.appendChild(host);

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
    const histBtn = $(".hist");
    const histview = $(".histview");
    const micBtn = $(".mic");
    const resizer = $(".resizer");
    const expandBtn = $(".expand");

    const status = el("div", { class: "status" });
    status.innerHTML = ICON.loader + '<span class="slabel">Pensando…</span>';
    const statusLabel = status.querySelector(".slabel");
    conv.appendChild(status);

    // ── Resizable width (drag the left edge) + expand/compact toggle. Persisted. ──
    const MIN_W = 360;
    const maxW = () => Math.min(window.innerWidth - 80, 1000);
    // Below this remaining width LUMA gets unusable, so we stop pushing and let the
    // panel overlay (drawer-style) instead — keeps small windows sane.
    const MIN_ROOM = 640;
    // Push LUMA's <body> aside by the current panel width while the panel is open,
    // as long as there's room; otherwise fall back to overlay.
    function applyPush() {
      const docEl = document.documentElement;
      const open = sidebar.classList.contains("open");
      const w = sidebar.getBoundingClientRect().width || 404;
      if (open && window.innerWidth - w >= MIN_ROOM) {
        docEl.style.setProperty("--luma-push", Math.round(w) + "px");
        docEl.classList.add("luma-assistant-pushed");
      } else {
        docEl.classList.remove("luma-assistant-pushed");
        docEl.style.removeProperty("--luma-push");
      }
    }
    function setWidth(w, persist) {
      const clamped = Math.max(MIN_W, Math.min(maxW(), Math.round(w)));
      sidebar.style.width = clamped + "px";
      applyPush();
      if (persist) { try { localStorage.setItem("luma-desktop-width", String(clamped)); } catch (_) {} }
    }
    try {
      const saved = parseInt(localStorage.getItem("luma-desktop-width") || "", 10);
      if (saved) setWidth(saved, false);
    } catch (_) {}
    let resizing = false;
    resizer.addEventListener("pointerdown", (e) => {
      resizing = true;
      document.documentElement.classList.add("luma-resizing"); // no transition lag while dragging
      try { resizer.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    resizer.addEventListener("pointermove", (e) => { if (resizing) setWidth(window.innerWidth - e.clientX, false); });
    resizer.addEventListener("pointerup", () => {
      if (!resizing) return;
      resizing = false;
      document.documentElement.classList.remove("luma-resizing");
      setWidth(sidebar.getBoundingClientRect().width, true);
    });
    expandBtn.addEventListener("click", () => {
      const cur = sidebar.getBoundingClientRect().width;
      setWidth(cur < 560 ? 760 : 404, true);
    });
    // Window resized → re-clamp width to the new bounds and re-evaluate the push.
    window.addEventListener("resize", () => { setWidth(sidebar.getBoundingClientRect().width, false); });

    let started = false;
    let starting = false;
    let view = "empty";
    let model = "balanced";
    let inFlight = false;
    let turnHadText = false;
    let watchdog = null;
    let stderrBuf = [];
    let transcript = [];        // C5: current thread, persisted to disk
    let turnBotText = "";       // assistant text accumulated this turn
    let currentThreadId = null; // stable id so re-saves overwrite the same file
    let histOpen = false;

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
    $(".close").addEventListener("click", () => { saveCurrentThread(); sidebar.classList.remove("open"); applyPush(); });
    $(".new").addEventListener("click", newConversation);
    histBtn.addEventListener("click", () => (histOpen ? closeHistory() : openHistory()));
    send.addEventListener("click", () => (inFlight ? stopTurn() : submit()));
    modelBtn.addEventListener("click", (e) => { e.stopPropagation(); modelMenu.classList.toggle("open"); });
    root.addEventListener("click", (e) => { if (!modelBtn.contains(e.target) && !modelMenu.contains(e.target)) modelMenu.classList.remove("open"); });
    input.addEventListener("input", () => { autosize(); if (!inFlight) send.disabled = !input.value.trim(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!inFlight) submit(); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebar.classList.contains("open")) { sidebar.classList.remove("open"); applyPush(); } });

    // C6: voice dictation, ONLY if the WebView actually supports SpeechRecognition.
    // WKWebView on macOS usually does not → the mic button stays hidden (never a
    // dead control). Where supported, it fills the input; the OS handles the prompt.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      micBtn.style.display = "grid";
      let recog = null, recording = false;
      micBtn.addEventListener("click", () => {
        if (recording) { try { recog && recog.stop(); } catch (_) {} return; }
        try {
          recog = new SR();
          recog.lang = "es-ES";
          recog.interimResults = true;
          recog.continuous = false;
          recog.onresult = (ev) => {
            let txt = "";
            for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
            input.value = txt; autosize(); if (!inFlight) send.disabled = !input.value.trim();
          };
          recog.onerror = () => { recording = false; micBtn.classList.remove("rec"); };
          recog.onend = () => { recording = false; micBtn.classList.remove("rec"); input.focus(); };
          recording = true; micBtn.classList.add("rec");
          recog.start();
        } catch (_) { recording = false; micBtn.classList.remove("rec"); }
      });
    }

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
      applyPush();
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
      saveCurrentThread();
      conv.querySelectorAll(".row-user, .bot, .sys, .meta").forEach((n) => n.remove());
      botBuf = null; transcript = []; currentThreadId = null; turnBotText = "";
      histview.style.display = "none"; histOpen = false;
      setTyping(false);
      setInFlight(false);
      setView("empty");
    }

    // ── C5: conversation history (persisted via Rust, file-based) ──────────────
    function saveCurrentThread() {
      if (!transcript.length) return;
      const id = currentThreadId || String(Date.now());
      const first = transcript.find((m) => m.role === "user");
      const title = (first ? first.text : "Conversación").slice(0, 60);
      invoke("history_save", { thread: { id, title, createdAt: new Date().toISOString(), messages: transcript.slice() } }).catch(() => {});
    }
    async function openHistory() {
      histOpen = true;
      empty.style.display = "none"; sugg.style.display = "none"; chips.style.display = "none"; conv.style.display = "none";
      histview.style.display = "";
      histview.innerHTML = '<div class="hempty">Cargando…</div>';
      let metas = [];
      try { metas = await invoke("history_list"); } catch (_) {}
      if (!metas || !metas.length) { histview.innerHTML = '<div class="hempty">Sin conversaciones guardadas todavía.</div>'; return; }
      histview.innerHTML = "";
      metas.forEach((m) => {
        const row = el("div", { class: "hrow" });
        const meta = el("div", { class: "hmeta" });
        meta.appendChild(el("div", { class: "htitle" }, m.title || "Conversación"));
        meta.appendChild(el("div", { class: "hsub" }, fmtDate(m.createdAt) + " · " + m.count + " mensaje" + (m.count === 1 ? "" : "s")));
        const del = el("button", { class: "hdel", title: "Eliminar" }); del.innerHTML = ICON.close;
        row.appendChild(meta); row.appendChild(del);
        meta.addEventListener("click", () => loadThread(m.id));
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteThread(m.id, row); });
        histview.appendChild(row);
      });
    }
    function closeHistory() { histOpen = false; histview.style.display = "none"; setView(view); }
    async function loadThread(id) {
      let t;
      try { t = await invoke("history_load", { id }); } catch (_) { return; }
      histOpen = false; histview.style.display = "none";
      conv.querySelectorAll(".row-user, .bot, .sys, .meta").forEach((n) => n.remove());
      botBuf = null;
      setView("chat");
      const msgs = t.messages || [];
      transcript = msgs.slice();
      currentThreadId = t.id;
      msgs.forEach((mm) => {
        if (mm.role === "user") { const r = el("div", { class: "row-user" }); r.appendChild(el("div", null, mm.text)); conv.insertBefore(r, status); }
        else { const node = el("div", { class: "bot" }); node.innerHTML = renderMarkdown(mm.text); conv.insertBefore(node, status); }
      });
      scrollDown();
    }
    async function deleteThread(id, row) {
      try { await invoke("history_delete", { id }); } catch (_) {}
      row.remove();
      if (id === currentThreadId) currentThreadId = null;
      if (!histview.querySelector(".hrow")) histview.innerHTML = '<div class="hempty">Sin conversaciones guardadas todavía.</div>';
    }
    function fmtDate(iso) {
      try { return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
      catch (_) { return String(iso || "").slice(0, 10); }
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
          // Ensure the version is resolved before provisioning (it gates write access).
          if (!APP_VERSION) {
            try { APP_VERSION = String((await invoke("get_app_version")) || ""); } catch (_) {}
          }
          const resp = await fetch("/api/desktop/provision-token", {
            method: "POST", headers: { "Content-Type": "application/json" },
            // appVersion gates write access server-side: only this gated build
            // (with the native write-confirmation in canUseTool) gets a write token.
            body: JSON.stringify({ deviceLabel: "LUMA Desktop", appVersion: APP_VERSION }),
          });
          if (resp.status === 404) { sys("Esta versión de LUMA aún no soporta el asistente de escritorio. Actualiza LUMA e inténtalo de nuevo."); starting = false; return; }
          if (resp.status === 403) { sys("El asistente de escritorio está disponible solo para Dirección en esta versión."); starting = false; return; }
          if (resp.status === 401) { sys("Inicia sesión en LUMA primero (la pestaña debe estar logueada).", true); starting = false; return; }
          if (resp.status === 503) { sys("El asistente de escritorio está desactivado temporalmente."); starting = false; return; } // D4
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
        reportError("start-failed", errMsg(err));
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
      if (!currentThreadId) currentThreadId = String(Date.now());
      turnHadText = false;
      turnBotText = "";
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
      } else if (m.type === "propose") {
        setTyping(false);
        renderProposal(m);
      } else if (m.type === "confirm-request") {
        handleConfirmRequest(m);
      } else if (m.type === "result") {
        botBuf = null; setTyping(false); setInFlight(false);
        if (m.subtype && m.subtype !== "success") sys("El asistente no pudo completar la respuesta (" + m.subtype + ")." + stderrTail(), true);
        else if (!turnHadText) sys("No obtuve respuesta. Inténtalo de nuevo." + stderrTail(), true);
        else { renderMeta(m); transcript.push({ role: "assistant", text: turnBotText }); saveCurrentThread(); } // C4 + C5
      } else if (m.type === "auth-expired") {
        started = false; setTyping(false); setInFlight(false);
        sys("Tu sesión con LUMA caducó. Cierra y reabre la app para reconectar.", true);
        reportError("auth-expired", "");
      } else if (m.type === "fatal" || m.type === "error") {
        setTyping(false); setInFlight(false);
        sys("Error del asistente: " + (m.message || "desconocido"), true);
        reportError("agent-" + m.type, m.message);
      } else if (m.type === "sidecar-exit") {
        started = false; setTyping(false); setInFlight(false);
        sys("El asistente se cerró." + (stderrTail() || " Reábrelo para continuar."), true);
        reportError("sidecar-exit", stderrTail());
      }
      if (inFlight && m.type !== "confirm-request") armWatchdog();
    }

    // Goal: the agent can perform ANY MCP write, but each one is gated HERE by a
    // native confirmation (the sidecar's canUseTool blocks the tool until we answer).
    function prettyTool(t) {
      return String(t || "acción").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    }
    function humanizeWrite(toolName, input) {
      const lines = ["El asistente quiere ejecutar:", "", "  " + prettyTool(toolName), ""];
      try {
        const obj = input && typeof input === "object" ? input : {};
        for (const k of Object.keys(obj).slice(0, 12)) {
          let v = obj[k];
          if (v == null || v === "") continue;
          if (typeof v === "object") v = JSON.stringify(v);
          v = String(v);
          if (v.length > 80) v = v.slice(0, 80) + "…";
          lines.push("  " + k + ": " + v);
        }
      } catch (_) {}
      lines.push("", "¿Permitir esta acción?");
      return lines.join("\n");
    }
    async function handleConfirmRequest(m) {
      clearWatchdog();
      setTyping(false);
      let allow = false;
      try { allow = await invoke("confirm_action", { summary: humanizeWrite(m.toolName, m.input) }); }
      catch (_) { allow = false; }
      try { await invoke("respond_confirm", { id: m.id, allow }); } catch (_) {}
      sys((allow ? "✓ Permitido: " : "✕ Cancelado: ") + prettyTool(m.toolName));
      if (allow && inFlight) { setTyping(true, "Ejecutando…"); armWatchdog(); }
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

    // PR2: a proposed money write (the agent can only PROPOSE; the human confirms
    // in a NATIVE dialog and the WebView executes via the session cookie).
    function renderProposal(m) {
      botBuf = null;
      if (view !== "chat") setView("chat");
      const card = el("div", { class: "proposal" });
      const body = el("div", { class: "pbody" }, m.humanSummary || "Acción propuesta");
      const actions = el("div", { class: "pactions" });
      const confirm = el("button", { class: "pconfirm" }, "Revisar y confirmar");
      confirm.addEventListener("click", () => onConfirm(card, m, body, actions));
      actions.appendChild(confirm);
      card.appendChild(body);
      card.appendChild(actions);
      conv.insertBefore(card, status);
      scrollDown();
    }
    async function onConfirm(card, m, body, actions) {
      // The native dialog is the commit — not spoofable by the remote web.
      let ok = false;
      try { ok = await invoke("confirm_invoice", { summary: m.humanSummary || "¿Facturar este ABT?" }); }
      catch (_) { ok = false; }
      if (!ok) {
        actions.remove();
        card.classList.add("cancelled");
        body.textContent = "Cancelado — no se ha facturado.";
        reinject("[sistema] El usuario canceló la propuesta. No se ha facturado.");
        return;
      }
      await executeProposal(card, m, body, actions);
    }
    async function executeProposal(card, m, body, actions) {
      card.classList.remove("err");
      actions.innerHTML = "";
      const spin = el("div", { class: "pstate" });
      spin.innerHTML = ICON.loader + "<span>Facturando…</span>";
      actions.appendChild(spin);
      try {
        const resp = await fetch("/api/desktop/abt/" + encodeURIComponent(m.entityId) + "/invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Luma-Desktop": "1" },
          body: JSON.stringify({ confirmId: m.proposalId }),
        });
        const data = await resp.json().catch(() => ({}));
        actions.innerHTML = "";
        if (resp.ok) {
          card.classList.add("done");
          body.textContent = "✓ Factura borrador creada.";
          if (data.id) {
            actions.appendChild(el("a", { class: "plink", href: "/facturacion/" + data.id }, "Abrir en LUMA"));
          }
          reinject("[sistema] El usuario confirmó. Factura borrador creada correctamente.");
          return;
        }
        card.classList.add("err");
        const msg = resp.status === 409
          ? "Este ABT ya se facturó (quizá desde otra pantalla)."
          : (data && data.error) || ("No se pudo facturar (" + resp.status + ").");
        body.textContent = msg;
        reinject("[sistema] No se pudo facturar: " + msg);
      } catch (_) {
        // Network failure → safe retry: the same confirmId is idempotent (no doble factura).
        actions.innerHTML = "";
        body.textContent = "No se pudo completar. Comprueba tu conexión.";
        const retry = el("button", { class: "pconfirm" }, "Reintentar");
        retry.addEventListener("click", () => executeProposal(card, m, body, actions));
        actions.appendChild(retry);
      }
    }
    function reinject(text) {
      if (!started) return;
      invoke("send_message", { message: text }).catch(() => {});
    }
    function appendBot(text) {
      if (!botBuf) { const node = el("div", { class: "bot" }); conv.insertBefore(node, status); botBuf = { node, raw: "" }; }
      botBuf.raw += text;
      turnBotText += text;
      botBuf.node.innerHTML = renderMarkdown(botBuf.raw);
      scrollDown();
    }
    function msg(kind, text) {
      botBuf = null;
      let node;
      if (kind === "user") { transcript.push({ role: "user", text }); node = el("div", { class: "row-user" }); node.appendChild(el("div", null, text)); }
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
    // D3: best-effort error telemetry (error-only, no business data).
    function reportError(type, message) {
      try {
        fetch("/api/desktop/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, message: String(message || "").slice(0, 500), version: APP_VERSION }),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }
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
    // Dashboard directives the agent can emit inside fenced blocks:
    //   ```luma:cards [{"label":"Facturado","value":"128.940 €","delta":"+12%"}]```
    //   ```luma:chart {"data":[{"label":"Ene","value":12000}],"unit":"€"}```
    function renderCards(json) {
      let arr;
      try { arr = JSON.parse(json); } catch { return "<pre><code>" + escapeHtml(json) + "</code></pre>"; }
      if (!Array.isArray(arr) || !arr.length) return "";
      const card = (c) => {
        let delta = "";
        if (c && c.delta != null && String(c.delta) !== "") {
          const d = String(c.delta);
          const neg = /^\s*[-−]/.test(d) || /baj|menos|caíd/i.test(d);
          delta = '<div class="kdelta ' + (neg ? "neg" : "pos") + '">' + escapeHtml(d) + "</div>";
        }
        return (
          '<div class="kcard"><div class="klabel">' + escapeHtml(String((c && c.label) ?? "")) +
          '</div><div class="kvalue">' + escapeHtml(String((c && c.value) ?? "")) + "</div>" + delta + "</div>"
        );
      };
      return '<div class="kcards">' + arr.slice(0, 6).map(card).join("") + "</div>";
    }
    function renderChart(json) {
      let cfg;
      try { cfg = JSON.parse(json); } catch { return "<pre><code>" + escapeHtml(json) + "</code></pre>"; }
      const data = Array.isArray(cfg && cfg.data) ? cfg.data.slice(0, 12) : [];
      if (!data.length) return "";
      const max = Math.max(...data.map((d) => Math.abs(Number(d && d.value) || 0)), 1);
      const unit = cfg.unit ? " " + escapeHtml(String(cfg.unit)) : "";
      const rows = data.map((d) => {
        const pct = Math.round((Math.abs(Number(d && d.value) || 0) / max) * 100);
        return (
          '<div class="crow"><span class="clabel">' + escapeHtml(String((d && d.label) ?? "")) +
          '</span><span class="cbar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="cval">' + escapeHtml(String((d && d.value) ?? "")) + unit + "</span></div>"
        );
      });
      return '<div class="chart">' + rows.join("") + "</div>";
    }
    function renderMarkdown(src) {
      const parts = src.split("```");
      let html = "";
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          // Tolerate both ```lang\nbody``` and inline ```lang body``` forms.
          const mm = part.match(/^([a-zA-Z0-9_:+-]*)(?:[ \t]*\r?\n)?([\s\S]*)$/);
          const lang = mm ? mm[1] : "";
          const body = mm ? mm[2] : part;
          if (lang === "luma:cards") html += renderCards(body);
          else if (lang === "luma:chart") html += renderChart(body);
          else html += "<pre><code>" + escapeHtml(body) + "</code></pre>";
        } else html += renderSegment(part);
      });
      return html;
    }
  });
})();
