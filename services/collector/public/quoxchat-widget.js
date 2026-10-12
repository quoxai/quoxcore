/**
 * QuoxChat Visitor Widget (CW-13.1)
 *
 * Self-contained chat widget for embedding on any website. Zero runtime
 * dependencies. Shadow-DOM isolated from host-page styles. Served from
 * GET /quoxchat/widget.js.
 *
 * Embed:
 *   <script src="https://collector/quoxchat/widget.js"
 *           data-widget-id="wgt_abc"
 *           data-endpoint="https://collector"
 *           async></script>
 *
 * Reads data-* attributes from its own <script> tag, attaches a shadow-root
 * UI (bubble + panel) to document.body, and routes messages through
 * ${endpoint}/quoxchat/message.
 *
 * Glass surface (QCX-GLASS): data-surface="glass" renders the panel chrome
 * translucent with backdrop blur; messages stay solid. Browsers without
 * backdrop-filter keep the solid default.
 *
 * Header status glyph (QCX-LAUNCHER phase 2): data-status-icon takes a URL
 * template with a {status} slot (e.g. "/assets/chat-status-{status}.svg").
 * The widget renders it in the header and swaps the image per status
 * (idle/thinking/streaming/tool/error) — animated SVGs animate inside the
 * <img>. Absent attribute = no glyph, unchanged look.
 *
 * Custom launchers (QCX-LAUNCHER): data-launcher="custom" suppresses the
 * built-in bubble entirely; the host page opens the panel through
 * window.QuoxChat.toggle()/open(). The widget dispatches
 * CustomEvent('quoxchat:status', {detail:{status, open}}) on window at every
 * state change so a host-page launcher can animate with the conversation:
 * ready | open | closed | thinking (sent, awaiting reply) | streaming
 * (tokens arriving) | tool (server tool running) | error | idle (turn done).
 * window.QuoxChat.getStatus() returns the latest value.
 */

(function () {
  'use strict';

  // Web Component embed: <quox-chat widget-id="..." endpoint="..."></quox-chat>.
  // Attributes are read through the same getAttribute('data-*') calls the
  // script-tag embed uses, so both shapes boot the identical widget.
  function elementSource(el) {
    return {
      getAttribute: function (name) {
        var bare = String(name).replace(/^data-/, '');
        var v = el.getAttribute(bare);
        return v !== null ? v : el.getAttribute(name);
      },
    };
  }

  function boot(script) {
  if (window.__quoxchat_bootstrapped__) return;
  window.__quoxchat_bootstrapped__ = true;

  if (!script) {
    console.warn('[QuoxChat] script tag with data-widget-id not found');
    return;
  }

  var widgetId = script.getAttribute('data-widget-id');
  if (!widgetId) {
    console.warn('[QuoxChat] data-widget-id missing');
    return;
  }
  var endpoint = (script.getAttribute('data-endpoint') || '').replace(/\/+$/, '');
  // A data-endpoint already ending in /quoxchat would double up with every
  // request path below and produce bare 404s. Strip it and warn.
  if (/\/quoxchat$/.test(endpoint)) {
    console.warn('[QuoxChat] data-endpoint should not include the /quoxchat suffix — stripping the duplicate segment');
    endpoint = endpoint.replace(/\/quoxchat$/, '');
  }
  var theme = script.getAttribute('data-theme') || 'auto';
  var position = script.getAttribute('data-position') || 'bottom-right';
  var accentAttr = script.getAttribute('data-accent');
  var accentColor = accentAttr || '#a855f7';
  var greeting = script.getAttribute('data-greeting') || '';
  // White-label by default (owner ruling 2026-10-10): the badge is opt-in.
  var showBranding = script.getAttribute('data-show-branding') === 'true';
  // A host page that already knows its user can pass data-user-name /
  // data-user-email on the embed tag (or call QuoxChat.identify() later);
  // either path skips the pre-handoff "your name?" ask.
  var embedUserName = (script.getAttribute('data-user-name') || '').trim();
  var embedUserEmail = (script.getAttribute('data-user-email') || '').trim();
  // QCX-LAUNCHER: 'custom' hides the built-in bubble; host page drives
  // open/close via window.QuoxChat and animates on quoxchat:status events.
  var customLauncher = script.getAttribute('data-launcher') === 'custom';
  // WAVE5: thumbs up/down under completed AI answers; data-ratings="false" opts out.
  var ratingsEnabled = script.getAttribute('data-ratings') !== 'false';
  // QCX-GLASS: data-surface="glass" renders the panel chrome translucent
  // with backdrop blur (messages stay solid for contrast). Opt-in per embed;
  // browsers without backdrop-filter keep the solid default automatically.
  var surface = script.getAttribute('data-surface') === 'glass' ? 'glass' : 'solid';
  // QCX-LAUNCHER phase 2: header status glyph URL template ({status} slot).
  var statusIconTemplate = (script.getAttribute('data-status-icon') || '').trim() || null;
  if (statusIconTemplate && statusIconTemplate.indexOf('{status}') === -1) {
    console.warn('[QuoxChat] data-status-icon should contain a {status} placeholder');
  }
  // Visual statuses with their own artwork; everything else shows idle.
  var GLYPH_STATUSES = { thinking: 1, streaming: 1, tool: 1, error: 1 };

  // QCX-LAUNCHER status channel. Dispatch never throws into widget flow.
  var lastStatus = 'ready';
  function emitStatus(status) {
    lastStatus = status;
    // Header glyph tracks the same status machine (statusGlyph is created
    // during panel construction below; var hoisting makes this safe).
    try {
      if (statusGlyph) {
        var g = GLYPH_STATUSES[status] ? status : 'idle';
        var src = statusIconTemplate.replace('{status}', g);
        if (statusGlyph.getAttribute('src') !== src) statusGlyph.src = src;
      }
    } catch (_) { /* glyph is decorative */ }
    try {
      window.dispatchEvent(new CustomEvent('quoxchat:status', {
        detail: { status: status, open: typeof open === 'boolean' ? open : false },
      }));
    } catch (_) { /* host page listeners are optional */ }
  }

  // Unguessable visitor id: 128 bits from crypto.randomUUID() when
  // available, else crypto.getRandomValues, else a widened Math.random()
  // fallback for very old browsers. An already-stored id (any format) is
  // reused unchanged below; only new visitors get a strong id.
  function generateVisitorId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return 'v_' + window.crypto.randomUUID().replace(/-/g, '');
      }
    } catch (_) { /* ignore */ }
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        var hex = '';
        for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return 'v_' + hex;
      }
    } catch (_) { /* ignore */ }
    var weak = '';
    for (var j = 0; j < 4; j++) weak += Math.random().toString(36).slice(2, 10);
    return 'v_' + weak + Date.now().toString(36);
  }
  var visitorId = generateVisitorId();
  try {
    var stored = localStorage.getItem('qx_visitor_' + widgetId);
    if (stored) visitorId = stored;
    else localStorage.setItem('qx_visitor_' + widgetId, visitorId);
  } catch (_) { /* private mode */ }

  var conversationId = null;
  var history = [];
  // QUOXCHAT-PRO P2 — human handoff relay state. While the conversation is
  // handed off, the AI is silent server-side and operator replies arrive via
  // a lightweight 10s poll (only active during handoff, stopped on close).
  var handedOff = false;
  var pollTimer = null;
  var lastOperatorMsgId = null;
  var open = false;
  var sending = false;
  // Visitor name, remembered per widget so returning visitors are not
  // re-asked. nameAsked caps the in-chat ask at once per page load; Skip is
  // respected for the rest of the session.
  var visitorName = null;
  var visitorEmail = null;
  var nameAsked = false;
  try {
    visitorName = localStorage.getItem('qx_vname_' + widgetId) || null;
    visitorEmail = localStorage.getItem('qx_vemail_' + widgetId) || null;
  } catch (_) { /* private mode */ }

  function rememberVisitorIdentity(attrs) {
    if (!attrs || typeof attrs !== 'object') return;
    try {
      var n = (typeof attrs.name === 'string' && attrs.name.trim())
        || [attrs.first_name, attrs.last_name].filter(function (p) { return typeof p === 'string' && p.trim(); }).join(' ');
      if (n && n.trim()) {
        visitorName = n.trim().slice(0, 120);
        try { localStorage.setItem('qx_vname_' + widgetId, visitorName); } catch (_) {}
      }
      if (typeof attrs.email === 'string' && attrs.email.trim()) {
        visitorEmail = attrs.email.trim().slice(0, 254);
        try { localStorage.setItem('qx_vemail_' + widgetId, visitorEmail); } catch (_) {}
      }
    } catch (_) { /* non-fatal */ }
  }

  // ─── DOM ───────────────────────────────────────────────────────────────
  var host = document.createElement('div');
  host.id = 'quoxchat-host-' + widgetId;
  host.style.cssText = 'all:initial;position:fixed;' + (
    position === 'bottom-left' ? 'bottom:20px;left:20px;' :
    position === 'top-right' ? 'top:20px;right:20px;' :
    position === 'top-left' ? 'top:20px;left:20px;' :
    'bottom:20px;right:20px;'
  ) + 'z-index:2147483647;';
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  // QCX-4.2 motion pass + QCX-4.3 theming. Palette lives in CSS vars so
  // data-theme="light|dark|auto" can flip the whole widget. `auto` mode
  // follows prefers-color-scheme.
  var EASE = 'cubic-bezier(0.22,0.61,0.36,1)';
  var LIGHT_VARS =
    '--qx-bg:#ffffff;--qx-panel-bg:#ffffff;--qx-body-bg:#f8fafc;' +
    '--qx-text:#0f172a;--qx-text-muted:#64748b;' +
    '--qx-border:rgba(0,0,0,0.08);--qx-border-strong:rgba(0,0,0,0.14);' +
    '--qx-bot-bg:#ffffff;--qx-user-bg:' + accentColor + ';--qx-user-fg:#ffffff;' +
    '--qx-err-bg:#fef2f2;--qx-err-fg:#991b1b;--qx-err-border:#fca5a5;' +
    '--qx-code-bg:rgba(15,23,42,0.06);--qx-pre-bg:#0f172a;--qx-pre-fg:#e2e8f0;' +
    '--qx-chip-bg:rgba(0,0,0,0.04);--qx-chip-fg:#334155;' +
    '--qx-tool-bg:rgba(168,85,247,0.06);--qx-tool-fg:#6b21a8;--qx-tool-border:rgba(168,85,247,0.18);' +
    '--qx-conf-high-bg:#dcfce7;--qx-conf-high-fg:#166534;' +
    '--qx-conf-med-bg:#fef3c7;--qx-conf-med-fg:#92400e;' +
    '--qx-conf-low-bg:#fee2e2;--qx-conf-low-fg:#991b1b;';
  var DARK_VARS =
    '--qx-bg:#0b0f17;--qx-panel-bg:#121826;--qx-body-bg:#0f1524;' +
    '--qx-text:#e2e8f0;--qx-text-muted:#94a3b8;' +
    '--qx-border:rgba(255,255,255,0.08);--qx-border-strong:rgba(255,255,255,0.14);' +
    '--qx-bot-bg:#1a2234;--qx-user-bg:' + accentColor + ';--qx-user-fg:#ffffff;' +
    '--qx-err-bg:#3b0f14;--qx-err-fg:#fecaca;--qx-err-border:#7f1d1d;' +
    '--qx-code-bg:rgba(255,255,255,0.07);--qx-pre-bg:#020617;--qx-pre-fg:#e2e8f0;' +
    '--qx-chip-bg:rgba(255,255,255,0.06);--qx-chip-fg:#cbd5e1;' +
    '--qx-tool-bg:rgba(168,85,247,0.14);--qx-tool-fg:#ddd6fe;--qx-tool-border:rgba(168,85,247,0.32);' +
    '--qx-conf-high-bg:rgba(34,197,94,0.18);--qx-conf-high-fg:#86efac;' +
    '--qx-conf-med-bg:rgba(245,158,11,0.20);--qx-conf-med-fg:#fcd34d;' +
    '--qx-conf-low-bg:rgba(239,68,68,0.20);--qx-conf-low-fg:#fca5a5;';
  // QCX-GLASS dark chrome, reused verbatim for data-theme="dark" and (via a
  // selector swap) for data-theme="auto" under prefers-color-scheme:dark.
  var GLASS_DARK_RULES =
    ':host([data-surface="glass"][data-theme="dark"]) .panel{background:rgba(15,21,36,0.58);' +
    'border-color:rgba(255,255,255,0.16);' +
    'box-shadow:0 24px 64px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.09)}' +
    ':host([data-surface="glass"][data-theme="dark"]) .footer{background:rgba(15,21,36,0.35);border-top:1px solid rgba(255,255,255,0.10)}' +
    ':host([data-surface="glass"][data-theme="dark"]) .qx-disclosure{background:rgba(15,21,36,0.92);color:#cbd5e1;border-color:rgba(255,255,255,0.12)}' +
    ':host([data-surface="glass"][data-theme="dark"]) .brand{color:#cbd5e1}';
  style.textContent =
    // Token layering: :host is light by default. data-theme="dark" overrides.
    // data-theme="auto" picks dark via prefers-color-scheme.
    ':host{all:initial;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' + LIGHT_VARS + '}' +
    ':host([data-theme="dark"]){' + DARK_VARS + '}' +
    '@media(prefers-color-scheme:dark){:host([data-theme="auto"]){' + DARK_VARS + '}}' +
    '*{box-sizing:border-box;font-family:inherit}' +
    '@keyframes qxPanelIn{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}' +
    '@keyframes qxBubbleIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes qxDot{0%,60%,100%{transform:translateY(0);opacity:0.4}30%{transform:translateY(-3px);opacity:1}}' +
    '.bubble{width:56px;height:56px;border-radius:50%;background:' + accentColor + ';color:#fff;' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.18);transition:transform .15s ' + EASE + ',box-shadow .15s ' + EASE + ';border:none}' +
    '.bubble:hover{transform:scale(1.06);box-shadow:0 12px 32px rgba(0,0,0,0.22)}' +
    '.bubble svg{width:26px;height:26px}' +
    '.panel{display:none;position:relative;width:360px;height:520px;max-width:calc(100vw - 40px);max-height:calc(100vh - 80px);' +
    'background:var(--qx-panel-bg);color:var(--qx-text);border-radius:14px;overflow:hidden;' +
    'box-shadow:0 24px 64px rgba(0,0,0,0.28);border:1px solid var(--qx-border);flex-direction:column;' +
    'margin-bottom:12px;transform-origin:bottom right}' +
    '.panel.open{display:flex;animation:qxPanelIn 200ms ' + EASE + ' both}' +
    '.header{padding:12px 14px;background:' + accentColor + ';color:#fff;font-weight:600;font-size:14px;' +
    'display:flex;justify-content:space-between;align-items:center}' +
    '.qx-status-glyph{width:26px;height:26px;flex:none;margin-right:2px;display:block}' +
    '.close{background:transparent;border:none;color:#fff;cursor:pointer;font-size:18px;padding:0;' +
    'width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:4px}' +
    '.close:hover{background:rgba(255,255,255,0.15)}' +
    '.body{flex:1;padding:12px 10px;overflow-y:auto;background:var(--qx-body-bg)}' +
    '.msg{margin:6px 0;padding:8px 12px;border-radius:14px;font-size:13px;line-height:1.45;max-width:82%;word-wrap:break-word;' +
    'animation:qxBubbleIn 180ms ' + EASE + ' both}' +
    '.msg>p{margin:0 0 6px 0}.msg>p:last-child{margin-bottom:0}' +
    '.msg>h1,.msg>h2,.msg>h3{margin:8px 0 4px 0;font-weight:600;line-height:1.25}' +
    '.msg>h1{font-size:15px}.msg>h2{font-size:14px}.msg>h3{font-size:13px}' +
    '.msg>ul,.msg>ol{margin:4px 0;padding-left:20px}' +
    '.msg>ul>li,.msg>ol>li{margin:2px 0}' +
    '.msg code{background:var(--qx-code-bg);padding:1px 5px;border-radius:4px;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}' +
    '.msg pre{background:var(--qx-pre-bg);color:var(--qx-pre-fg);padding:10px 12px;border-radius:8px;overflow-x:auto;margin:6px 0}' +
    '.msg pre code{background:transparent;padding:0;color:inherit;font-size:12px;line-height:1.5}' +
    '.msg a{color:' + accentColor + ';text-decoration:underline}' +
    '.msg table{border-collapse:collapse;margin:6px 0;font-size:12px;width:100%}' +
    '.msg th,.msg td{border:1px solid var(--qx-border-strong);padding:4px 8px;text-align:left}' +
    '.msg th{background:var(--qx-chip-bg);font-weight:600}' +
    '.msg-user{background:var(--qx-user-bg);color:var(--qx-user-fg);margin-left:auto;border-bottom-right-radius:4px}' +
    '.msg-user a{color:var(--qx-user-fg)}' +
    '.msg-bot{background:var(--qx-bot-bg);color:var(--qx-text);border:1px solid var(--qx-border);margin-right:auto;border-bottom-left-radius:4px}' +
    '.msg-err{background:var(--qx-err-bg);color:var(--qx-err-fg);border:1px solid var(--qx-err-border)}' +
    // QCX-4.3: tool card — collapsed one-liner by default, shows name + state chip.
    '.msg-tool{max-width:100%;padding:0;background:transparent;border:none;animation:qxBubbleIn 180ms ' + EASE + ' both}' +
    '.qx-tool-card{display:inline-flex;flex-direction:column;gap:4px;padding:6px 10px;border-radius:10px;' +
    'background:var(--qx-tool-bg);border:1px solid var(--qx-tool-border);color:var(--qx-tool-fg);font-size:11px;max-width:82%}' +
    '.qx-tc-head{display:flex;align-items:center;gap:8px}' +
    '.qx-tc-name{font-family:"SF Mono",Menlo,Consolas,monospace;font-weight:600}' +
    '.qx-tc-status{opacity:0.8}' +
    '.qx-tc-input{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:10px;opacity:0.72;word-break:break-all}' +
    '.qx-tool-card[data-state="running"] .qx-tc-status::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;animation:qxDot 1.2s ' + EASE + ' infinite;margin-right:4px;vertical-align:middle}' +
    '.qx-tool-card[data-state="ok"] .qx-tc-status::before{content:"✓ ";opacity:0.9}' +
    '.qx-tool-card[data-state="error"]{background:var(--qx-err-bg);border-color:var(--qx-err-border);color:var(--qx-err-fg)}' +
    '.qx-tool-card[data-state="error"] .qx-tc-status::before{content:"✕ ";opacity:0.9}' +
    // QCX-4.3: citation chips + confidence badge row.
    '.qx-meta{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:2px 0 8px 8px;max-width:82%}' +
    '.qx-chips{display:flex;flex-wrap:wrap;gap:4px}' +
    '.qx-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;' +
    'font-size:10px;background:var(--qx-chip-bg);color:var(--qx-chip-fg);text-decoration:none;' +
    'border:1px solid var(--qx-border);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.qx-chip:hover{border-color:var(--qx-border-strong)}' +
    '.qx-chip[data-pinned="true"]::before{content:"★ ";color:' + accentColor + '}' +
    '.qx-chip-sec{opacity:0.7}.qx-chip-score{opacity:0.6;margin-left:4px}' +
    '.qx-confidence{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600}' +
    '.qx-rating{display:flex;align-items:center;gap:4px;margin:2px 0 8px 8px;font-size:11px;color:var(--qx-text-muted)}' +
    '.qx-rate{background:transparent;border:1px solid var(--qx-border);color:var(--qx-text-muted);cursor:pointer;border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;padding:0}' +
    '.qx-rate:hover:not(:disabled){color:var(--qx-text);border-color:var(--qx-border-strong)}' +
    '.qx-rate:focus-visible{outline:2px solid ' + accentColor + ';outline-offset:1px}' +
    '.qx-rate:disabled{opacity:.5;cursor:default}' +
    '.qx-confidence[data-tier="high"]{background:var(--qx-conf-high-bg);color:var(--qx-conf-high-fg)}' +
    '.qx-confidence[data-tier="med"]{background:var(--qx-conf-med-bg);color:var(--qx-conf-med-fg)}' +
    '.qx-confidence[data-tier="low"]{background:var(--qx-conf-low-bg);color:var(--qx-conf-low-fg)}' +
    '.typing-dots{display:inline-flex;gap:3px;align-items:center;padding:2px 2px;color:var(--qx-text-muted)}' +
    '.typing-dots span{width:5px;height:5px;border-radius:50%;background:currentColor;display:inline-block;animation:qxDot 1.2s ' + EASE + ' infinite}' +
    '.typing-dots span:nth-child(2){animation-delay:0.15s}' +
    '.typing-dots span:nth-child(3){animation-delay:0.3s}' +
    '.footer{padding:10px;border-top:1px solid var(--qx-border);background:var(--qx-panel-bg)}' +
    // PRO-3: quick-action chips above the composer, rendered from /config actions.
    '.qx-action-strip{display:none;flex-wrap:wrap;gap:5px;margin-bottom:8px}' +
    '.qx-action-strip.has-actions{display:flex}' +
    '.qx-action-chip{display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;' +
    'font-size:11px;font-family:inherit;cursor:pointer;background:var(--qx-chip-bg);color:var(--qx-chip-fg);' +
    'border:1px solid var(--qx-border);transition:border-color .15s ' + EASE + '}' +
    '.qx-action-chip:hover{border-color:' + accentColor + ';color:' + accentColor + '}' +
    // UX HOLES FIX: handed-off status strip above the composer + delivered
    // tick on visitor messages while a human owns the conversation.
    '.qx-handoff-strip{display:none;align-items:center;gap:6px;margin-bottom:8px;padding:5px 10px;border-radius:8px;' +
    'font-size:11px;background:var(--qx-chip-bg);color:var(--qx-chip-fg);border:1px solid var(--qx-border)}' +
    '.qx-handoff-strip.active{display:flex}' +
    '.qx-handoff-strip .qx-hs-dot{width:6px;height:6px;border-radius:50%;background:' + accentColor + ';flex:none}' +
    '.qx-delivered{display:block;font-size:9px;opacity:0.65;margin-top:2px;text-align:right}' +
    '.input-row{display:flex;gap:6px;align-items:flex-end}' +
    '.input{flex:1;padding:9px 12px;border:1px solid var(--qx-border);border-radius:20px;font-size:13px;' +
    'outline:none;resize:none;max-height:80px;font-family:inherit;background:var(--qx-bg);color:var(--qx-text)}' +
    '.input:focus{border-color:' + accentColor + '}' +
    '.send{background:' + accentColor + ';color:#fff;border:none;border-radius:50%;width:38px;height:38px;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s ' + EASE + '}' +
    '.send:not(:disabled):hover{transform:scale(1.06)}' +
    '.send:disabled{opacity:0.4;cursor:not-allowed}' +
    '.send svg{width:18px;height:18px}' +
    '.brand{font-size:10px;color:var(--qx-text-muted);text-align:center;margin-top:6px}' +
    '.brand a{color:inherit;text-decoration:none}' +
    // QCX-GLASS branding: on hover the QuoxChat product link becomes a small
    // blue->violet gradient pill with a soft glow — unmistakable even at
    // 10px (a clipped-text gradient proved too subtle at this size).
    '.brand a.qx-powered{padding:1px 6px;border-radius:7px;' +
    'transition:color .15s ' + EASE + ',box-shadow .15s ' + EASE + ',transform .15s ' + EASE + '}' +
    '.brand a.qx-powered:hover{color:#fff;' +
    'background-image:linear-gradient(100deg,#35B6FF,#8b5cf6,#a855f7,#35B6FF);' +
    'background-size:220% 100%;' +
    'box-shadow:0 2px 12px rgba(139,92,246,0.55);transform:translateY(-1px);' +
    'animation:qxBrandSweep 1.6s linear infinite}' +
    '@keyframes qxBrandSweep{from{background-position:0% 0}to{background-position:220% 0}}' +
    // QCX-6e: Art.52 transparency disclosure shown above the first greeting.
    '.qx-disclosure{padding:6px 10px;margin:4px 0 8px;font-size:10px;color:var(--qx-text-muted);' +
    'background:var(--qx-chip-bg);border:1px solid var(--qx-border);border-radius:8px;text-align:center}' +
    // QCX-4.4b: attachment strip (above input) + paperclip button + chip styling.
    // QCX-4.5: header avatar + title.
    '.qx-avatar{width:24px;height:24px;border-radius:50%;background-size:cover;background-position:center;background-color:rgba(255,255,255,0.2);flex-shrink:0}' +
    '.qx-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.qx-attach-strip{display:none;flex-wrap:wrap;gap:5px;padding:4px 2px 6px 2px}' +
    '.qx-attach-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 3px;border-radius:20px;' +
    'background:var(--qx-chip-bg);color:var(--qx-chip-fg);border:1px solid var(--qx-border);font-size:11px;max-width:180px}' +
    '.qx-att-thumb{width:22px;height:22px;border-radius:50%;background-size:cover;background-position:center;flex-shrink:0}' +
    '.qx-att-icon{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:13px}' +
    '.qx-att-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}' +
    '.qx-att-x{background:transparent;border:none;color:var(--qx-text-muted);cursor:pointer;font-size:14px;line-height:1;padding:0 4px}' +
    '.qx-att-x:hover{color:var(--qx-text)}' +
    '.attach{background:transparent;border:none;color:var(--qx-text-muted);cursor:pointer;width:38px;height:38px;' +
    'display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:50%;transition:color .15s ' + EASE + ',background .15s ' + EASE + '}' +
    '.attach:hover{color:' + accentColor + ';background:var(--qx-chip-bg)}' +
    '.attach svg{width:18px;height:18px}' +
    // P-V voice: mic + read-aloud toggles share the attach button look.
    '.qx-mic,.qx-speak{background:transparent;border:none;color:var(--qx-text-muted);cursor:pointer;width:38px;height:38px;' +
    'display:none;align-items:center;justify-content:center;flex-shrink:0;border-radius:50%;transition:color .15s ' + EASE + ',background .15s ' + EASE + '}' +
    '.qx-mic.avail,.qx-speak.avail{display:flex}' +
    '.qx-mic:hover,.qx-speak:hover{color:' + accentColor + ';background:var(--qx-chip-bg)}' +
    '.qx-mic.on,.qx-speak.on{color:#fff;background:' + accentColor + '}' +
    '.qx-mic svg,.qx-speak svg{width:18px;height:18px}' +
    // P-V proactive greeting card: sits above the launcher, never steals focus.
    '@keyframes qxProIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}' +
    '.qx-proactive{display:none;align-items:flex-start;gap:6px;max-width:260px;margin-bottom:10px;padding:10px 10px 10px 12px;' +
    'background:var(--qx-panel-bg);color:var(--qx-text);border:1px solid var(--qx-border);border-radius:14px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.18);font-size:13px;line-height:1.4}' +
    '.qx-proactive.show{display:flex;animation:qxProIn 200ms ' + EASE + ' both}' +
    '.qx-proactive-msg{flex:1;text-align:left;background:transparent;border:none;color:inherit;font:inherit;cursor:pointer;padding:0}' +
    '.qx-proactive-x{background:transparent;border:none;color:var(--qx-text-muted);cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:50%}' +
    '.qx-proactive-x:hover{color:var(--qx-text);background:var(--qx-chip-bg)}' +
    '.qx-proactive-x svg{width:12px;height:12px}' +
    // Enlarged mode: a centred two-column modal (header/messages/composer +
    // a 240px side rail for the visualiser/actions/links). Hidden on mobile.
    '.qx-expand{background:transparent;border:none;color:#fff;cursor:pointer;padding:0;width:28px;height:28px;' +
    'display:none;align-items:center;justify-content:center;border-radius:4px;margin-right:2px;flex-shrink:0}' +
    '.qx-expand:hover{background:rgba(255,255,255,0.15)}' +
    '.qx-expand svg{width:16px;height:16px}' +
    '@media(min-width:760px){.qx-expand{display:flex}}' +
    // "Start new chat" reset affordance — same button convention as
    // qx-expand/close, always visible (no media gate).
    '.qx-reset{background:transparent;border:none;color:#fff;cursor:pointer;padding:0;width:28px;height:28px;' +
    'display:flex;align-items:center;justify-content:center;border-radius:4px;margin-right:2px;flex-shrink:0}' +
    '.qx-reset:hover{background:rgba(255,255,255,0.15)}' +
    '.qx-reset svg{width:15px;height:15px}' +
    '.qx-scrim{display:none;position:fixed;inset:0;background:rgba(2,6,14,0.5)}' +
    '.qx-scrim.on{display:block}' +
    '.panel.open.qx-expanded{display:grid;animation:none;position:fixed;left:50%;top:50%;right:auto;bottom:auto;' +
    'transform:translate(-50%,-50%);width:min(1100px,92vw);height:min(760px,85vh);max-width:92vw;max-height:85vh;' +
    'grid-template-columns:minmax(0,1fr) 240px;grid-template-rows:auto minmax(0,1fr) auto;' +
    'grid-template-areas:"header header" "body side" "footer side";margin-bottom:0}' +
    '.panel.qx-expanded .header{grid-area:header}' +
    '.panel.qx-expanded .body{grid-area:body;padding:16px 18px;min-height:0}' +
    '.panel.qx-expanded .footer{grid-area:footer}' +
    '.panel.qx-expanded .msg{font-size:14px;max-width:72%}' +
    '.panel.qx-expanded .qx-meta{max-width:72%}' +
    // Enlarged mode moves the chips into the side rail; hide the footer strip.
    '.panel.qx-expanded .qx-action-strip{display:none}' +
    '.qx-side{display:none;grid-area:side;flex-direction:column;min-height:0;overflow-y:auto;' +
    'border-left:1px solid var(--qx-border);background:var(--qx-body-bg)}' +
    '.panel.qx-expanded .qx-side{display:flex}' +
    '.qx-side-viz{flex:none;min-height:170px;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:8px;padding:16px 10px;border-bottom:1px solid var(--qx-border)}' +
    '.qx-viz-fallback{display:flex;flex-direction:column;align-items:center;gap:8px}' +
    '.qx-viz-avatar{width:64px;height:64px;border-radius:50%;background-color:' + accentColor + ';background-size:cover;background-position:center;' +
    'display:flex;align-items:center;justify-content:center;color:#fff;overflow:hidden}' +
    '.qx-viz-avatar svg{width:30px;height:30px}' +
    '.qx-viz-name{font-size:12px;font-weight:600;color:var(--qx-text)}' +
    '.qx-side-actions{flex:1;display:flex;flex-direction:column;gap:6px;padding:12px 10px}' +
    '.qx-side-title{font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--qx-text-muted);margin:0 2px 2px}' +
    '.qx-side-action{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;font-size:12px;font-family:inherit;' +
    'text-align:left;cursor:pointer;background:var(--qx-chip-bg);color:var(--qx-chip-fg);border:1px solid var(--qx-border);transition:border-color .15s ' + EASE + '}' +
    '.qx-side-action:hover{border-color:' + accentColor + ';color:' + accentColor + '}' +
    '.qx-side-action svg{width:14px;height:14px;flex-shrink:0}' +
    '.qx-side-links{flex:none;display:flex;flex-direction:column;gap:5px;padding:10px;border-top:1px solid var(--qx-border);font-size:11px}' +
    '.qx-side-links a{color:var(--qx-text-muted);text-decoration:underline;cursor:pointer}' +
    '.qx-side-links a:hover{color:var(--qx-text)}' +
    // QCX-AGENT: persona line under the header title + label above first bubble.
    '.qx-subtitle{display:block;font-size:10px;font-weight:400;opacity:0.75;line-height:1.3}' +
    '.qx-agent-label{font-size:10px;font-weight:600;color:var(--qx-text-muted);margin:4px 0 0 8px}' +
    // QCX-PRIVACY: in-widget privacy panel (export / erase / transcript / links).
    '.qx-privacy{display:none;position:absolute;inset:0;z-index:6;background:var(--qx-panel-bg);color:var(--qx-text);flex-direction:column}' +
    '.qx-privacy.open{display:flex}' +
    '.qx-privacy-head{padding:12px 14px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:14px;' +
    'border-bottom:1px solid var(--qx-border);flex-shrink:0}' +
    '.qx-privacy-head .close{color:var(--qx-text-muted)}' +
    '.qx-privacy-head .close:hover{color:var(--qx-text);background:var(--qx-chip-bg)}' +
    '.qx-privacy-body{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}' +
    '.qx-privacy-btn{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;font-size:12px;font-family:inherit;' +
    'text-align:left;cursor:pointer;background:var(--qx-chip-bg);color:var(--qx-text);border:1px solid var(--qx-border)}' +
    '.qx-privacy-btn:hover{border-color:var(--qx-border-strong)}' +
    '.qx-privacy-btn svg{width:15px;height:15px;flex-shrink:0}' +
    '.qx-privacy-btn.qx-danger{color:var(--qx-err-fg);background:var(--qx-err-bg);border-color:var(--qx-err-border)}' +
    '.qx-privacy-note{font-size:10px;color:var(--qx-text-muted);line-height:1.5}' +
    '.qx-privacy-links{display:flex;gap:12px;font-size:11px}' +
    '.qx-privacy-links a{color:var(--qx-text-muted);text-decoration:underline}' +
    // QCX-4.3: mobile breakpoints 320/375/420/768. Small-phone compact; iPad+ grows.
    '@media(max-width:420px){.panel{width:calc(100vw - 24px);height:calc(100vh - 100px);max-height:calc(100vh - 100px)}' +
    '.msg{max-width:88%;font-size:14px}.qx-tool-card,.qx-meta{max-width:100%}}' +
    // QCX-MOBILE (owner feedback 2026-09-04: phone chat "lacked the same
    // attention"): on phones the panel becomes a full-screen sheet — no
    // floating 350px card with page bleed around it. dvh (not vh) tracks
    // the real visual viewport; the input is 16px so iOS does not zoom on
    // focus; the footer honours the home-indicator safe area.
    '@media(max-width:480px){' +
    '.panel{position:fixed;inset:0;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;' +
    'margin:0;border-radius:0;border:none;transform-origin:bottom center}' +
    '.panel.qx-expanded{position:fixed;inset:0;width:100vw;height:100dvh}' +
    '.header{padding-top:calc(12px + env(safe-area-inset-top,0px))}' +
    '.footer{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}' +
    '.input{font-size:16px}' +
    '.msg{font-size:14px;max-width:88%}' +
    '.bubble{width:50px;height:50px}.bubble svg{width:22px;height:22px}' +
    '}' +
    '@media(min-width:768px){.panel{width:400px;height:560px}}' +
    '@media(prefers-reduced-motion:reduce){.msg,.panel.open,.bubble,.send,.qx-tool-card,.qx-proactive.show{animation:none!important;transition:none!important}.typing-dots span,.qx-tool-card .qx-tc-status::before{animation:none!important;opacity:0.6!important}.brand a.qx-powered:hover{animation:none!important;transform:none!important;background-position:50% 0}}' +
    // ── QCX-GLASS: translucent panel chrome (opt-in via data-surface).
    // Guarded by @supports so browsers without backdrop-filter keep the
    // solid default. Message bubbles, input and chips stay SOLID for
    // contrast; only the containing chrome (panel, header, footer, body
    // ground) goes glass. Dark variants keep the same hue family.
    '@supports ((backdrop-filter:blur(4px)) or (-webkit-backdrop-filter:blur(4px))){' +
    ':host([data-surface="glass"]) .panel{background:rgba(255,255,255,0.60);' +
    '-webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5);' +
    'border:1px solid rgba(255,255,255,0.55);' +
    'box-shadow:0 24px 64px rgba(0,0,0,0.22),inset 0 1px 0 rgba(255,255,255,0.6)}' +
    ':host([data-surface="glass"]) .body{background:transparent}' +
    ':host([data-surface="glass"]) .footer{background:rgba(255,255,255,0.35);border-top:1px solid rgba(255,255,255,0.45)}' +
    ':host([data-surface="glass"]) .header{background:color-mix(in srgb,' + accentColor + ' 84%,transparent)}' +
    // Muted-on-translucent is unreadable (owner, 2026-09-04): informational
    // chrome goes SOLID on glass, like the message bubbles.
    ':host([data-surface="glass"]) .qx-disclosure{background:rgba(255,255,255,0.92);color:#334155;border-color:rgba(0,0,0,0.08)}' +
    ':host([data-surface="glass"]) .brand{color:#334155}' +
    GLASS_DARK_RULES +
    '@media(prefers-color-scheme:dark){' + GLASS_DARK_RULES.replace(/data-theme="dark"/g, 'data-theme="auto"') + '}' +
    '}';
  shadow.appendChild(style);
  // QCX-4.3: surface data-theme on the host so the selectors above work.
  // prefers-color-scheme listener re-applies when the user flips system theme.
  host.setAttribute('data-theme', ['light', 'dark', 'auto'].indexOf(theme) >= 0 ? theme : 'auto');
  host.setAttribute('data-surface', surface);

  var container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end';
  shadow.appendChild(container);

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('part', 'panel');
  container.appendChild(panel);

  var header = document.createElement('div');
  header.className = 'header';
  header.setAttribute('part', 'header');
  // QCX-4.5: header = optional avatar + title. Avatar hidden until /config
  // returns an avatar_url (or never, if unset).
  var headerLeft = document.createElement('div');
  headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
  var avatarEl = document.createElement('span');
  avatarEl.className = 'qx-avatar';
  avatarEl.style.display = 'none';
  var titleWrap = document.createElement('span');
  titleWrap.className = 'qx-title';
  var titleSpan = document.createElement('span');
  titleSpan.textContent = 'Chat with us';
  // QCX-AGENT: persona subtitle, shown once /config names the assistant.
  var subtitleSpan = document.createElement('span');
  subtitleSpan.className = 'qx-subtitle';
  subtitleSpan.style.display = 'none';
  subtitleSpan.textContent = 'AI assistant';
  titleWrap.appendChild(titleSpan);
  titleWrap.appendChild(subtitleSpan);
  headerLeft.appendChild(avatarEl);
  headerLeft.appendChild(titleWrap);
  // QCX-ENLARGE: enlarge toggle (desktop only, CSS-gated below 760px).
  var QX_ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  var QX_ICON_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M20 8V6a2 2 0 0 0-2-2h-2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/></svg>';
  var expandBtn = document.createElement('button');
  expandBtn.className = 'qx-expand';
  expandBtn.type = 'button';
  expandBtn.setAttribute('aria-label', 'Enlarge chat');
  expandBtn.innerHTML = QX_ICON_EXPAND;
  // "Start new chat" reset affordance — clears the local conversation/history
  // and re-greets, without touching the server-side conversation (still
  // available to operators in Logs/Live Support) or the visitor's identity.
  var resetBtn = document.createElement('button');
  resetBtn.className = 'qx-reset';
  resetBtn.type = 'button';
  resetBtn.setAttribute('aria-label', 'Start new chat');
  resetBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.setAttribute('aria-label', 'Close chat');
  closeBtn.textContent = '×';
  // QCX-LAUNCHER phase 2: optional live status glyph in the header. The
  // embed passes data-status-icon as a URL template containing {status};
  // the widget swaps the image per status (thinking/streaming/tool/error,
  // everything else maps to idle), so a brand can animate its own mark in
  // the header — animated SVGs animate inside <img>. Absent attribute =
  // nothing rendered, unchanged look.
  var statusGlyph = null;
  if (statusIconTemplate) {
    statusGlyph = document.createElement('img');
    statusGlyph.className = 'qx-status-glyph';
    statusGlyph.alt = '';
    statusGlyph.setAttribute('aria-hidden', 'true');
    statusGlyph.src = statusIconTemplate.replace('{status}', 'idle');
  }
  header.appendChild(headerLeft);
  if (statusGlyph) header.appendChild(statusGlyph);
  header.appendChild(resetBtn);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  var body = document.createElement('div');
  body.className = 'body';
  body.setAttribute('part', 'messages');
  panel.appendChild(body);

  var footer = document.createElement('div');
  footer.className = 'footer';

  // QCX-4.4b: attachment chip strip above the input row. Populated as the
  // visitor uploads files; each chip has a remove button.
  var attachStrip = document.createElement('div');
  attachStrip.className = 'qx-attach-strip';
  footer.appendChild(attachStrip);

  // Quick-action chip strip above the composer, populated from /config's
  // actions array. Clicking a chip sends the guided message WITH the action
  // kind, so the server executes the builtin deterministically.
  var actionStrip = document.createElement('div');
  actionStrip.className = 'qx-action-strip';
  footer.appendChild(actionStrip);

  // Persistent handed-off status strip above the composer, shown while
  // operator-reply polling is active.
  var HANDOFF_STRIP_DEFAULT = 'Connected to the team queue, a human will reply here';
  var handoffStrip = document.createElement('div');
  handoffStrip.className = 'qx-handoff-strip';
  var handoffStripDot = document.createElement('span');
  handoffStripDot.className = 'qx-hs-dot';
  var handoffStripText = document.createElement('span');
  handoffStripText.textContent = HANDOFF_STRIP_DEFAULT;
  handoffStrip.appendChild(handoffStripDot);
  handoffStrip.appendChild(handoffStripText);
  footer.appendChild(handoffStrip);

  // Icons for the side-rail action list, keyed by builtin kind with a
  // generic fallback; labels/prompts/kinds come from /config.
  var ACTION_ICONS = {
    book_appointment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    schedule_demo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    leave_message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>',
    human_handoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  };
  var ACTION_ICON_DEFAULT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
  // Synthetic message text for the required `message` field when submitting
  // a data-collection form directly (action_input path).
  var ACTION_PROMPTS = {
    book_appointment: "I'd like to book an appointment.",
    schedule_demo: "I'd like to schedule a demo.",
    leave_message: "I'd like to leave a message for the team.",
  };

  function renderActionChips(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    actionStrip.innerHTML = '';
    sideActions.innerHTML = '';
    var valid = actions.filter(function (a) {
      return a && typeof a.label === 'string' && typeof a.prompt === 'string';
    });
    function fire(a) {
      if (sending) return;
      // "Talk to a human" with no known name asks for it first (skippable),
      // then the handoff send proceeds automatically.
      if (a.kind === 'human_handoff' && !visitorName && !nameAsked) {
        askVisitorName('pre', function () {
          if (sending) return;
          input.value = a.prompt;
          send(a.kind);
        });
        return;
      }
      input.value = a.prompt;
      // CHIP DETERMINISM: pass the builtin kind so the server executes the
      // action directly instead of leaving tool invocation to LLM choice.
      send(a.kind);
    }
    // Compact mode: chip row above the composer, always rendered when the
    // config has actions (no scrolling needed to find them).
    valid.slice(0, 4).forEach(function (a) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'qx-action-chip';
      chip.textContent = a.label.slice(0, 40);
      chip.addEventListener('click', function () { fire(a); });
      actionStrip.appendChild(chip);
    });
    if (actionStrip.childNodes.length > 0) actionStrip.classList.add('has-actions');
    // Enlarged mode: the same actions as an icon + label list in the side rail.
    if (valid.length > 0) {
      var st = document.createElement('div');
      st.className = 'qx-side-title';
      st.textContent = 'Actions';
      sideActions.appendChild(st);
    }
    valid.slice(0, 6).forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qx-side-action';
      btn.innerHTML = (ACTION_ICONS[a.kind] || ACTION_ICON_DEFAULT) + '<span></span>';
      btn.querySelector('span').textContent = a.label.slice(0, 60);
      btn.addEventListener('click', function () { fire(a); });
      sideActions.appendChild(btn);
    });
  }

  var inputRow = document.createElement('div');
  inputRow.className = 'input-row';
  // QCX-4.4b: paperclip button opens a hidden file picker.
  var attachBtn = document.createElement('button');
  attachBtn.className = 'attach';
  attachBtn.setAttribute('aria-label', 'Attach file');
  attachBtn.type = 'button';
  attachBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv';
  fileInput.style.display = 'none';
  var input = document.createElement('textarea');
  input.className = 'input';
  input.setAttribute('part', 'input');
  input.rows = 1;
  input.placeholder = 'Type a message…';
  // B2 a11y fix: a placeholder alone is not a reliable accessible name for
  // screen readers (it disappears once typed and some readers skip it), so
  // the composer needs its own aria-label.
  input.setAttribute('aria-label', 'Type a message');
  var sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.setAttribute('part', 'send');
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  // P-V voice (Professional): dictation + read-aloud, both browser-native.
  // Hidden until /config says features.voice AND the browser supports it.
  var QX_ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>';
  var QX_ICON_SPEAK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  var micBtn = document.createElement('button');
  micBtn.className = 'qx-mic';
  micBtn.type = 'button';
  micBtn.setAttribute('aria-label', 'Dictate message');
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.innerHTML = QX_ICON_MIC;
  var speakBtn = document.createElement('button');
  speakBtn.className = 'qx-speak';
  speakBtn.type = 'button';
  speakBtn.setAttribute('aria-label', 'Read replies aloud');
  speakBtn.setAttribute('aria-pressed', 'false');
  speakBtn.innerHTML = QX_ICON_SPEAK;
  inputRow.appendChild(attachBtn);
  inputRow.appendChild(fileInput);
  inputRow.appendChild(micBtn);
  inputRow.appendChild(speakBtn);
  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);
  footer.appendChild(inputRow);
  if (showBranding) {
    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = 'Powered by <a class="qx-powered" href="https://quox.ai/solutions/quoxchat" target="_blank" rel="noopener">QuoxChat</a>';
    footer.appendChild(brand);
  }
  panel.appendChild(footer);

  // QCX-ENLARGE: right side rail, visible only in enlarged mode. Top slot
  // hosts the site enhance layer's visualiser when one is present; the
  // fallback shows the widget avatar (or a chat glyph) + the agent name.
  var sideCol = document.createElement('div');
  sideCol.className = 'qx-side';
  var sideViz = document.createElement('div');
  sideViz.className = 'qx-side-viz';
  var vizFallback = document.createElement('div');
  vizFallback.className = 'qx-viz-fallback';
  var vizAvatar = document.createElement('span');
  vizAvatar.className = 'qx-viz-avatar';
  vizAvatar.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
  var vizName = document.createElement('span');
  vizName.className = 'qx-viz-name';
  vizName.style.display = 'none';
  vizFallback.appendChild(vizAvatar);
  vizFallback.appendChild(vizName);
  sideViz.appendChild(vizFallback);
  var sideActions = document.createElement('div');
  sideActions.className = 'qx-side-actions';
  var sideLinks = document.createElement('div');
  sideLinks.className = 'qx-side-links';
  sideCol.appendChild(sideViz);
  sideCol.appendChild(sideActions);
  sideCol.appendChild(sideLinks);
  panel.appendChild(sideCol);

  // Scrim behind the enlarged modal (sibling before the panel so the panel
  // paints on top within the shadow stacking context).
  var scrim = document.createElement('div');
  scrim.className = 'qx-scrim';
  container.insertBefore(scrim, panel);

  var expanded = false;
  function setExpanded(v) {
    if (v && window.innerWidth < 760) return;
    expanded = !!v;
    panel.classList.toggle('qx-expanded', expanded);
    scrim.classList.toggle('on', expanded);
    expandBtn.innerHTML = expanded ? QX_ICON_COLLAPSE : QX_ICON_EXPAND;
    expandBtn.setAttribute('aria-label', expanded ? 'Shrink chat' : 'Enlarge chat');
    body.scrollTop = body.scrollHeight;
  }

  var bubble = document.createElement('button');
  bubble.className = 'bubble';
  bubble.setAttribute('part', 'launcher');
  bubble.setAttribute('aria-label', 'Open chat');
  // QCX-LAUNCHER: custom mode never shows the built-in bubble.
  if (customLauncher) bubble.style.display = 'none';
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
  container.appendChild(bubble);

  // ─── P-V proactive greeting card (Professional) ────────────────────────
  var proactiveCard = document.createElement('div');
  proactiveCard.className = 'qx-proactive';
  proactiveCard.setAttribute('role', 'status');
  proactiveCard.setAttribute('aria-live', 'polite');
  var proactiveMsg = document.createElement('button');
  proactiveMsg.type = 'button';
  proactiveMsg.className = 'qx-proactive-msg';
  proactiveMsg.setAttribute('aria-label', 'Open chat');
  var proactiveX = document.createElement('button');
  proactiveX.type = 'button';
  proactiveX.className = 'qx-proactive-x';
  proactiveX.setAttribute('aria-label', 'Dismiss greeting');
  proactiveX.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  proactiveCard.appendChild(proactiveMsg);
  proactiveCard.appendChild(proactiveX);
  container.insertBefore(proactiveCard, bubble);
  var proactiveTimers = [];
  function hideProactive() { proactiveCard.classList.remove('show'); }
  proactiveX.addEventListener('click', hideProactive);
  proactiveMsg.addEventListener('click', function () { hideProactive(); setOpen(true); });
  // Rule match: path glob ('*' wildcard) or '/regex/'. Invalid -> no match.
  function proactiveMatches(rule, path) {
    var m = String(rule.match || '');
    try {
      if (m.length > 2 && m.charAt(0) === '/' && m.charAt(m.length - 1) === '/') {
        return new RegExp(m.slice(1, -1)).test(path);
      }
      var re = '^' + m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      return new RegExp(re).test(path);
    } catch (_) { return false; }
  }
  // The "shown" count is a per-browser CACHE (localStorage): it only keeps a
  // greeting from repeating. Losing it re-shows one polite bubble, it is not
  // customer data. There is no server-side visitor field for it.
  function proactiveKey(rule) {
    var h = 0, src = rule.id + '|' + rule.match + '|' + rule.message;
    for (var i = 0; i < src.length; i++) h = ((h << 5) - h + src.charCodeAt(i)) | 0;
    return 'qx_pa_' + widgetId + '_' + rule.id + '_' + (h >>> 0).toString(36);
  }
  function scheduleProactive(rules) {
    proactiveTimers.forEach(clearTimeout);
    proactiveTimers = [];
    if (!Array.isArray(rules)) return;
    var path = location.pathname || '/';
    for (var i = 0; i < rules.length; i++) {
      (function (rule) {
        if (!rule || !proactiveMatches(rule, path)) return;
        var key = proactiveKey(rule), shown = 0;
        try { shown = parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch (_) {}
        if (shown >= (rule.max_per_visitor || 1)) return;
        proactiveTimers.push(setTimeout(function () {
          if (open || proactiveCard.classList.contains('show')) return;
          if (document.visibilityState === 'hidden') return;
          proactiveMsg.textContent = rule.message;
          proactiveCard.classList.add('show');
          try { localStorage.setItem(key, String(shown + 1)); } catch (_) {}
        }, Math.max(1, rule.delay_seconds || 8) * 1000));
      })(rules[i]);
    }
  }

  // ─── P-V voice (Professional): browser-native, no audio to our servers ─
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var canSpeak = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  var voiceEnabled = false;
  var recognizer = null;
  var listening = false;
  var readAloud = false;
  try { readAloud = localStorage.getItem('qx_readaloud_' + widgetId) === '1'; } catch (_) {}
  function setListening(v) {
    listening = v;
    micBtn.classList.toggle('on', v);
    micBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
    micBtn.setAttribute('aria-label', v ? 'Stop dictation' : 'Dictate message');
  }
  function toggleDictation() {
    if (!SpeechRec) return;
    if (listening && recognizer) { try { recognizer.stop(); } catch (_) {} return; }
    var base = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
    try {
      recognizer = new SpeechRec();
      recognizer.interimResults = true;
      recognizer.continuous = false;
      recognizer.lang = (document.documentElement.lang || navigator.language || 'en-US');
      recognizer.onresult = function (e) {
        var t = '';
        for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        input.value = base + t;
      };
      recognizer.onerror = function () { setListening(false); };
      recognizer.onend = function () { setListening(false); };
      recognizer.start();
      setListening(true);
    } catch (_) { setListening(false); }
  }
  function setReadAloud(v) {
    readAloud = !!v;
    speakBtn.classList.toggle('on', readAloud);
    speakBtn.setAttribute('aria-pressed', readAloud ? 'true' : 'false');
    try { localStorage.setItem('qx_readaloud_' + widgetId, readAloud ? '1' : '0'); } catch (_) {}
    if (!readAloud && canSpeak) { try { window.speechSynthesis.cancel(); } catch (_) {} }
  }
  function speakReply(text) {
    if (!voiceEnabled || !readAloud || !canSpeak || !text) return;
    try {
      window.speechSynthesis.cancel();
      var plain = String(text).replace(/[*_`#>\[\]]/g, '').replace(/\(https?:[^)]*\)/g, '');
      window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(plain));
    } catch (_) {}
  }
  function enableVoice() {
    voiceEnabled = true;
    if (SpeechRec) micBtn.classList.add('avail');
    if (canSpeak) { speakBtn.classList.add('avail'); setReadAloud(readAloud); }
  }
  micBtn.addEventListener('click', toggleDictation);
  speakBtn.addEventListener('click', function () { setReadAloud(!readAloud); });

  // Rendering: renderMarkdown is inlined by the /widget.js route from
  // lib/quoxchatMarkdown.js. The markers below are literal comments the
  // route substitutes with function DECLARATIONS; in source form these are
  // fallbacks so eslint/editor loading still work. The assignments MUST be
  // guarded: declarations hoist, so an unguarded `var renderX = fallback`
  // assignment runs after hoisting and silently overwrites the injected
  // implementation (night audit 2026-07-25: markdown, tool cards,
  // confidence badges and source chips were shipping as dead stubs).
  var renderMarkdown = (typeof renderMarkdown === 'function') ? renderMarkdown : function (s) {
    // Fallback if the route substitution fails: plain escaped text.
    return '<p>' + String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    }) + '</p>';
  };
  var renderToolCard = (typeof renderToolCard === 'function') ? renderToolCard : function () { return ''; };
  var renderConfidenceBadge = (typeof renderConfidenceBadge === 'function') ? renderConfidenceBadge : function () { return ''; };
  var renderSourceChips = (typeof renderSourceChips === 'function') ? renderSourceChips : function () { return ''; };
  /* __QUOXCHAT_MARKDOWN_INJECT__ */
  /* __QUOXCHAT_CARDS_INJECT__ */

  // Server sources are {title, score, pinned}. The chip renderer reads
  // .source, so map the human title onto it. Internal ids are never shown.
  function normalizeSources(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      var label = typeof x.title === 'string' ? x.title.trim() : '';
      if (!label && typeof x.source === 'string' && !/^[A-Za-z0-9_-]{16,}$/.test(x.source)) label = x.source;
      if (!label) return;
      out.push({ source: label, score: x.score, pinned: x.pinned, url: (typeof x.url === 'string' && /^https:\/\//i.test(x.url)) ? x.url : undefined });
    });
    return out;
  }

  function appendMessage(role, text, meta) {
    var m = document.createElement('div');
    m.className = 'msg msg-' + role;
    if (role === 'bot') m.innerHTML = renderMarkdown(text || '');
    else m.textContent = text;
    body.appendChild(m);
    if (meta && Array.isArray(meta.sources) && meta.sources.length > 0) {
      var s = document.createElement('div');
      s.className = 'sources';
      s.appendChild(document.createTextNode('Sources: '));
      meta.sources.slice(0, 3).forEach(function (x, i) {
        var label = x.title || x.source || '';
        if (!label) return;
        if (i > 0) s.appendChild(document.createTextNode(', '));
        if (typeof x.url === 'string' && /^https:\/\//i.test(x.url)) {
          var a = document.createElement('a');
          a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
          s.appendChild(a);
        } else {
          s.appendChild(document.createTextNode(label));
        }
      });
      body.appendChild(s);
    }
    body.scrollTop = body.scrollHeight;
    return m;
  }

  // Operator reply delivery: while handed off, poll GET
  // /quoxchat/poll/:conversationId every 10s and render operator messages.
  function appendOperatorMessage(name, text) {
    var m = document.createElement('div');
    m.className = 'msg msg-bot';
    var label = document.createElement('div');
    label.textContent = name || 'Operator';
    label.style.cssText = 'font-size:10px;font-weight:600;opacity:0.7;margin-bottom:3px';
    var content = document.createElement('div');
    content.textContent = text || '';
    m.appendChild(label);
    m.appendChild(content);
    body.appendChild(m);
    body.scrollTop = body.scrollHeight;
  }

  // Strip helpers + delivered tick: the persistent "a human owns this chat"
  // signal, and a small delivered state on visitor messages sent while
  // handed off.
  function showHandoffStrip(text) {
    if (typeof text === 'string' && text) handoffStripText.textContent = text;
    handoffStrip.classList.add('active');
  }
  function hideHandoffStrip() {
    handoffStrip.classList.remove('active');
    handoffStripText.textContent = HANDOFF_STRIP_DEFAULT;
  }
  function markDelivered(msgEl) {
    if (!msgEl || msgEl.querySelector('.qx-delivered')) return;
    var t = document.createElement('span');
    t.className = 'qx-delivered';
    t.textContent = 'Delivered';
    msgEl.appendChild(t);
  }

  function stopHandoffPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    hideHandoffStrip();
  }

  // Reusable inline form bubble: label(s) + input(s) + Continue + Skip, as
  // one bot bubble (data-qx-form="1"). fields: [{name, label, type, required,
  // placeholder}]. Skip is always available and never blocks the chat.
  function renderInlineForm(fields, prefill, onSubmit, onSkip, title) {
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      try { if (form.parentNode) form.parentNode.removeChild(form); } catch (_) {}
    };

    var form = document.createElement('div');
    form.setAttribute('data-qx-form', '1');
    form.className = 'msg msg-bot';
    form.style.cssText += ';max-width:85%';

    if (title) {
      var titleEl = document.createElement('div');
      titleEl.textContent = title;
      titleEl.style.cssText = 'margin-bottom:8px';
      form.appendChild(titleEl);
    }

    var inputEls = {};
    var firstEl = null;
    (fields || []).forEach(function (f) {
      if (!f || !f.name) return;
      if (f.label) {
        var lbl = document.createElement('div');
        lbl.textContent = f.label;
        lbl.style.cssText = 'font-size:11px;margin-bottom:3px;opacity:0.85';
        form.appendChild(lbl);
      }
      var el = f.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      if (f.type === 'textarea') el.rows = 2;
      else el.type = f.type === 'email' ? 'email' : 'text';
      el.placeholder = f.placeholder || '';
      // B2 a11y fix: the label above is a plain div, not a <label>, so it is
      // never programmatically tied to the field — an aria-label carries the
      // same text to screen readers even without that association.
      var accessibleName = f.label || f.placeholder;
      if (accessibleName) el.setAttribute('aria-label', accessibleName);
      var pref = prefill && typeof prefill[f.name] === 'string' ? prefill[f.name] : '';
      if (pref) el.value = pref;
      el.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:6px;' +
        'border:1px solid var(--qx-border);border-radius:6px;font-size:11px;font-family:inherit;' +
        'background:var(--qx-bg);color:var(--qx-text);outline:none;resize:vertical';
      form.appendChild(el);
      inputEls[f.name] = el;
      if (!firstEl) firstEl = el;
    });

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'Continue';
    // B2 touch-target fix: 5px/11px padding measured under 24px tall on a
    // real device — below the minimum comfortable tap target. Bumped
    // padding + font-size without changing the visual style.
    okBtn.style.cssText = 'background:' + accentColor + ';color:#fff;border:0;padding:9px 16px;' +
      'border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit';
    var skip = document.createElement('a');
    skip.href = '#';
    skip.textContent = 'Skip';
    skip.style.cssText = 'font-size:11px;color:var(--qx-text);opacity:0.6;text-decoration:underline;' +
      'cursor:pointer;padding:8px 4px;display:inline-block';
    row.appendChild(okBtn);
    row.appendChild(skip);
    form.appendChild(row);

    var submit = function () {
      var values = {};
      var hasError = false;
      (fields || []).forEach(function (f) {
        if (!f || !f.name) return;
        var el = inputEls[f.name];
        var v = (el.value || '').trim();
        if (f.required && !v) { el.style.borderColor = '#ef4444'; hasError = true; return; }
        if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { el.style.borderColor = '#ef4444'; hasError = true; return; }
        el.style.borderColor = '';
        values[f.name] = v;
      });
      if (hasError) return;
      finish();
      try { onSubmit(values); } catch (_) {}
    };
    okBtn.addEventListener('click', submit);
    skip.addEventListener('click', function (e) {
      e.preventDefault();
      finish();
      try { if (onSkip) onSkip(); } catch (_) {}
    });
    (fields || []).forEach(function (f) {
      if (!f || !f.name || f.type === 'textarea') return;
      inputEls[f.name].addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    });

    body.appendChild(form);
    body.scrollTop = body.scrollHeight;
    try { if (firstEl) firstEl.focus(); } catch (_) {}
    return form;
  }

  // Visitor name ask: a compact form bubble shown at most once per page
  // load, only when no name is known. mode 'pre' runs before a "Talk to a
  // human" chip send; 'post' runs after a handoff the LLM/server already
  // triggered. Always skippable, never blocks the handoff.
  function askVisitorName(mode, done) {
    if (visitorName || nameAsked) { try { done(); } catch (_) {} return; }
    // The ask must survive page reloads, or a visitor stuck in a handed-off
    // conversation gets re-asked on every page load.
    var askedKey = conversationId ? 'qx_nameasked_' + widgetId + '_' + conversationId : null;
    try { if (askedKey && localStorage.getItem(askedKey)) { nameAsked = true; done(); return; } } catch (_) {}
    nameAsked = true;
    try { if (askedKey) localStorage.setItem(askedKey, '1'); } catch (_) {}
    var title = mode === 'post'
      ? 'So the team knows who they are talking to: your name?'
      : 'Before I connect you: your name?';
    renderInlineForm(
      [
        { name: 'name', type: 'text', placeholder: 'Your name', required: false },
        { name: 'email', type: 'email', placeholder: 'Email (optional)', required: false },
      ],
      { email: visitorEmail || '' },
      function (values) {
        var name = values.name || '';
        var email = values.email || '';
        if (!name && !email) { try { done(); } catch (_) {} return; }
        var attrs = {};
        if (name) attrs.name = name;
        if (email) attrs.email = email;
        rememberVisitorIdentity(attrs);
        var finished = false;
        var finish = function () { if (finished) return; finished = true; try { done(); } catch (_) {} };
        // identify() resolves after auth persisted the attrs, so the handoff
        // that follows sees the name. Bounded: never stall the handoff on a
        // slow network.
        var p = identify(attrs);
        var t = setTimeout(finish, 1500);
        if (p && typeof p.then === 'function') {
          p.then(function () { clearTimeout(t); finish(); }, function () { clearTimeout(t); finish(); });
        }
      },
      function () { try { done(); } catch (_) {} },
      title
    );
  }

  // Data-collection needs_input form (leave_message / book_appointment /
  // schedule_demo / lead_capture): the server returns `needs_input` when a
  // required field is missing; submit executes the tool directly.
  function renderDataCollectionForm(needsInput) {
    if (!needsInput || !Array.isArray(needsInput.fields) || needsInput.fields.length === 0) return;
    renderInlineForm(needsInput.fields, needsInput.prefill || {}, function (values) {
      submitActionInput(needsInput.kind, values);
    }, function () { /* Skip — non-blocking, the visitor can keep chatting */ });
  }

  // Lean direct execution (no LLM, no SSE) — mirrors the widget's existing
  // quick-action chip send, but with form-collected action_input.
  async function submitActionInput(kind, values) {
    if (sending) return;
    sending = true;
    sendBtn.disabled = true;
    var thinking = appendMessage('bot', '');
    thinking.classList.add('typing');
    thinking.innerHTML = '<span class="typing-dots" aria-label="Assistant is typing"><span></span><span></span><span></span></span>';
    try {
      var resp = await fetch(endpoint + '/quoxchat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widget_id: widgetId,
          visitor_id: visitorId,
          conversation_id: conversationId,
          // A real message is required server-side; reuse the same guided
          // prompt the quick-action chip would have sent for this kind.
          message: (ACTION_PROMPTS[kind] || 'Continuing with the details you provided.'),
          page_url: window.location.pathname,
          action: kind,
          action_input: values,
        }),
      });
      var data = await resp.json().catch(function () { return {}; });
      thinking.remove();
      if (!resp.ok) {
        appendMessage('err', (data && data.response) || 'The assistant hit a temporary problem answering that. Please try again in a moment.');
        return;
      }
      if (data.conversation_id) { conversationId = data.conversation_id; try { localStorage.setItem('qx_conv_' + widgetId, conversationId); } catch (_) { /* private mode */ } }
      var text = (typeof data.response === 'string' && data.response.trim()) || 'Done.';
      appendMessage('bot', text);
      history.push({ role: 'assistant', content: text });
      if (data.needs_input && Array.isArray(data.needs_input.fields) && data.needs_input.fields.length > 0) {
        renderDataCollectionForm(data.needs_input);
      }
    } catch (err) {
      thinking.remove();
      appendMessage('err', 'Network error. Please try again.');
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  // ── Small inline Confirm/Cancel bubble (same styling as renderInlineForm) ──
  function renderConfirmBubble(message, onConfirm, onCancel, confirmLabel, cancelLabel) {
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      try { if (box.parentNode) box.parentNode.removeChild(box); } catch (_) {}
    };
    var box = document.createElement('div');
    box.setAttribute('data-qx-form', '1');
    box.className = 'msg msg-bot';
    box.style.cssText += ';max-width:85%';
    var label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'margin-bottom:8px';
    box.appendChild(label);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = confirmLabel || 'Confirm';
    // B2 touch-target fix: same padding bump as the inline form's Continue
    // button — the old 5px/11px combo measured under 24px tall on device.
    okBtn.style.cssText = 'background:' + accentColor + ';color:#fff;border:0;padding:9px 16px;' +
      'border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit';
    var cancel = document.createElement('a');
    cancel.href = '#';
    cancel.textContent = cancelLabel || 'Cancel';
    cancel.style.cssText = 'font-size:11px;color:var(--qx-text);opacity:0.6;text-decoration:underline;' +
      'cursor:pointer;padding:8px 4px;display:inline-block';
    row.appendChild(okBtn);
    row.appendChild(cancel);
    box.appendChild(row);
    okBtn.addEventListener('click', function () { finish(); try { onConfirm(); } catch (_) {} });
    cancel.addEventListener('click', function (e) { e.preventDefault(); finish(); try { if (onCancel) onCancel(); } catch (_) {} });
    body.appendChild(box);
    body.scrollTop = body.scrollHeight;
    return box;
  }

  // "Start new chat" reset: clears local conversation id, history, and any
  // handoff state, then re-renders the greeting. Visitor identity is kept;
  // the old conversation is not deleted, staying visible to operators.
  function startNewChat() {
    renderConfirmBubble(
      'Start a new chat? The current conversation stays available to our team.',
      function () {
        // The handed-off gate is keyed by (widget, visitor), so also ask the
        // server to close the conversation (fire-and-forget).
        if (conversationId) {
          try {
            fetch(endpoint + '/quoxchat/conversation/close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ widget_id: widgetId, visitor_id: visitorId, conversation_id: conversationId }),
            }).catch(function () {});
          } catch (_) {}
        }
        conversationId = null;
        history = [];
        lastOperatorMsgId = null;
        handedOff = false;
        stopHandoffPolling();
        body.innerHTML = '';
        renderFreshGreeting();
      },
      function () { /* cancel — no-op */ }
    );
  }

  async function pollOperatorMessages() {
    if (!handedOff || !conversationId) return;
    try {
      var url = endpoint + '/quoxchat/poll/' + encodeURIComponent(conversationId) +
        '?widget_id=' + encodeURIComponent(widgetId) +
        '&visitor_id=' + encodeURIComponent(visitorId) +
        (lastOperatorMsgId ? '&after=' + encodeURIComponent(lastOperatorMsgId) : '');
      var resp = await fetch(url);
      if (!resp.ok) return;
      var data = await resp.json();
      var msgs = (data && data.messages) || [];
      for (var i = 0; i < msgs.length; i++) {
        lastOperatorMsgId = msgs[i].id;
        appendOperatorMessage(msgs[i].sender_name, msgs[i].content);
        history.push({ role: 'assistant', content: msgs[i].content });
        // UX HOLES FIX: a human replied; name them on the strip.
        showHandoffStrip('You are chatting with ' + (msgs[i].sender_name || 'the team'));
      }
      if (data && data.status && data.status !== 'handed_off') {
        handedOff = false;
        stopHandoffPolling();
      }
    } catch (_) { /* transient poll failure — next tick retries */ }
  }

  function startHandoffPolling(operatorJoined) {
    handedOff = true;
    // QC-HOLES honest strip: while nobody has picked up, do not claim a
    // live queue. The poll flips the copy the moment a human replies.
    showHandoffStrip(operatorJoined === false
      ? 'The team has been notified. I will keep helping until a teammate joins.'
      : undefined);
    if (pollTimer) return;
    pollTimer = setInterval(pollOperatorMessages, 10000);
    pollOperatorMessages();
  }

  // QCX-4.5: greeting picker. Uses /config greeting_variants when present
  // so returning visitors don't see the same welcome every session.
  var greetingVariants = [];
  // QCX-6e: Art.52 transparency disclosure shown above the very first
  // bot message in a conversation. Set from /config response.
  var aiDisclosureText = 'ℹ️ AI assistant: automated responses may be inaccurate.';
  var privacyPolicyUrl = null;
  var dpaUrl = null;
  // QCX-6k — pre-message consent. consentGiven persists in localStorage
  // so a returning visitor doesn't re-consent on every visit.
  var consentRequired = false;
  var consentText = 'I understand this is an AI assistant and consent to the processing of my messages.';
  var consentGiven = false;
  try { consentGiven = localStorage.getItem('qx_consent_' + widgetId) === '1'; } catch (_) {}

  // QUOXCHAT-PRO P1 — human availability from /config. null until config
  // loads; humans are assumed available unless the server says otherwise.
  // Offline ONLY affects human-handoff expectations: the AI keeps answering.
  var availability = null; // { operator_online, within_office_hours, human_available }
  function humanAvailable() {
    return !availability || availability.human_available !== false;
  }

  // Bot-detection action gate: off by default, null until /config returns a
  // bot_protection block. When present, a fresh invisible token is minted
  // per outgoing message and attached as captcha_token.
  var botProtection = null; // { provider, site_key, min_score, guard }
  var botProtectionReady = null; // Promise, resolves once the provider script + widget are usable
  var turnstileToken = null;
  var TURNSTILE_CONTAINER_ID = 'qx-turnstile-' + widgetId;

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-qx-captcha-src="' + src + '"]');
      if (existing) { existing.addEventListener('load', function () { resolve(); }); if (existing.__qxLoaded) resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-qx-captcha-src', src);
      s.onload = function () { s.__qxLoaded = true; resolve(); };
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Sets up the provider SDK once bot_protection is known. Never throws: if
  // the script fails to load, getCaptchaToken() resolves null and the
  // server's fail-closed verification handles the rest.
  function initBotProtection() {
    if (!botProtection || botProtectionReady) return botProtectionReady;
    if (botProtection.provider === 'turnstile') {
      botProtectionReady = loadScriptOnce('https://challenges.cloudflare.com/turnstile/v0/api.js')
        .then(function () {
          return new Promise(function (resolve) {
            var check = function () {
              if (window.turnstile && typeof window.turnstile.render === 'function') {
                var container = document.createElement('div');
                container.id = TURNSTILE_CONTAINER_ID;
                container.style.display = 'none';
                document.body.appendChild(container);
                window.turnstile.render('#' + TURNSTILE_CONTAINER_ID, {
                  sitekey: botProtection.site_key,
                  size: 'invisible',
                  action: 'quoxchat_message',
                  callback: function (token) { turnstileToken = token; },
                });
                resolve();
              } else { setTimeout(check, 50); }
            };
            check();
          });
        })
        .catch(function () { /* non-fatal — sendCaptchaToken() degrades to null */ });
    } else {
      // reCAPTCHA v3 (default) — invisible, no DOM widget needed.
      botProtectionReady = loadScriptOnce('https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(botProtection.site_key))
        .then(function () {
          return new Promise(function (resolve) {
            if (window.grecaptcha && window.grecaptcha.ready) { window.grecaptcha.ready(resolve); }
            else { resolve(); }
          });
        })
        .catch(function () { /* non-fatal */ });
    }
    return botProtectionReady;
  }

  // Mints a fresh token for the outgoing message. Resolves null (never
  // rejects) on any failure — a null token still sends; the server fails
  // closed on verification, it never blocks the request from going out.
  async function getCaptchaToken() {
    if (!botProtection) return null;
    try {
      await initBotProtection();
      if (botProtection.provider === 'turnstile') {
        if (window.turnstile && typeof window.turnstile.execute === 'function') {
          turnstileToken = null;
          window.turnstile.execute('#' + TURNSTILE_CONTAINER_ID);
          var waited = 0;
          while (turnstileToken === null && waited < 3000) {
            await new Promise(function (r) { setTimeout(r, 50); });
            waited += 50;
          }
        }
        return turnstileToken;
      }
      if (window.grecaptcha && typeof window.grecaptcha.execute === 'function') {
        return await window.grecaptcha.execute(botProtection.site_key, { action: 'quoxchat_message' });
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  function pickGreeting() {
    if (greetingVariants.length > 0) {
      return greetingVariants[Math.floor(Math.random() * greetingVariants.length)];
    }
    return greeting;
  }

  // QCX-AGENT: active assistant display name from /config widget.name (the
  // admin-configured persona, e.g. "Corey"). Never a raw widget/agent id.
  // The collector's default name is not a persona, so it gets no label.
  var agentName = null;
  function renderAgentLabel() {
    if (!agentName) return;
    try {
      if (body.querySelector('.qx-agent-label')) return;
      var firstBot = body.querySelector('.msg-bot');
      if (!firstBot) return;
      var lbl = document.createElement('div');
      lbl.className = 'qx-agent-label';
      lbl.textContent = agentName;
      body.insertBefore(lbl, firstBot);
    } catch (_) { /* non-fatal */ }
  }

  // QCX-6e: Art.52 disclosure + greeting, rendered on every fresh
  // conversation (first open, or after "Start new chat"). Plain text —
  // escaped via textContent.
  function renderFreshGreeting() {
    var note = document.createElement('div');
    note.className = 'qx-disclosure';
    note.textContent = aiDisclosureText;
    body.appendChild(note);
    var g = pickGreeting();
    if (g) {
      appendMessage('bot', g);
      history.push({ role: 'assistant', content: g });
    }
    // QCX-AGENT: name the persona above the first bot bubble when known.
    renderAgentLabel();
  }

  function setOpen(v) {
    open = v;
    if (open) {
      hideProactive();
      panel.classList.add('open');
      bubble.style.display = 'none';
      setTimeout(function () { input.focus(); }, 50);
      if (history.length === 0) {
        renderFreshGreeting();
      }
      // QCX-6k — gate composer behind consent if required and not yet given.
      if (consentRequired && !consentGiven) renderConsentBanner();
      // QUOXCHAT-PRO P1 — outside office hours / operator offline notice.
      renderOfflineBanner();
    } else {
      // QCX-ENLARGE / QCX-PRIVACY: closing the chat also leaves enlarged mode
      // and dismisses the privacy overlay so reopening starts clean.
      if (expanded) setExpanded(false);
      privacyPanel.classList.remove('open');
      if (listening && recognizer) { try { recognizer.stop(); } catch (_) {} }
      if (canSpeak) { try { window.speechSynthesis.cancel(); } catch (_) {} }
      panel.classList.remove('open');
      bubble.style.display = customLauncher ? 'none' : 'flex';
    }
    emitStatus(open ? 'open' : 'closed');
  }

  // "Humans are offline" banner, shown when human_available === false. The
  // AI keeps answering; the leave-your-email field funnels into identify()
  // so the org can follow up.
  function renderOfflineBanner() {
    try {
      if (humanAvailable()) return;
      if (body.querySelector('[data-qx-offline]')) return;
      var banner = document.createElement('div');
      banner.setAttribute('data-qx-offline', '1');
      banner.style.cssText = 'padding:10px 12px;margin:6px 0;border-radius:10px;' +
        'background:var(--qx-chip-bg);border:1px solid var(--qx-border-strong);' +
        'font-size:11px;line-height:1.45;color:var(--qx-text)';
      var msg = document.createElement('div');
      msg.textContent = 'Our human team is offline right now. The AI assistant is still here and will keep answering. ' +
        'If you would like a human follow-up, leave your email below and we will get back to you.';
      msg.style.cssText = 'margin-bottom:8px';
      banner.appendChild(msg);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px';
      var emailInput = document.createElement('input');
      emailInput.type = 'email';
      emailInput.placeholder = 'you@example.com';
      // B2 a11y fix: no visible <label> for this field, only a placeholder.
      emailInput.setAttribute('aria-label', 'Your email address');
      emailInput.style.cssText = 'flex:1;padding:5px 8px;border:1px solid var(--qx-border);border-radius:6px;' +
        'font-size:11px;font-family:inherit;background:var(--qx-bg);color:var(--qx-text);outline:none;min-width:0';
      var leaveBtn = document.createElement('button');
      leaveBtn.type = 'button';
      leaveBtn.textContent = 'Leave email';
      leaveBtn.style.cssText = 'background:' + accentColor + ';color:#fff;border:0;padding:5px 10px;' +
        'border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;flex-shrink:0';
      leaveBtn.addEventListener('click', function () {
        var email = (emailInput.value || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          emailInput.style.borderColor = '#ef4444';
          return;
        }
        identify({ email: email });
        banner.removeChild(row);
        msg.textContent = 'Thanks. A human will follow up at ' + email + ' as soon as we are back online. ' +
          'The AI assistant can keep helping you in the meantime.';
      });
      emailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); leaveBtn.click(); }
      });
      row.appendChild(emailInput);
      row.appendChild(leaveBtn);
      banner.appendChild(row);
      // Top of the body so it reads as a status notice, above messages.
      if (body.firstChild) body.insertBefore(banner, body.firstChild);
      else body.appendChild(banner);
    } catch (_) { /* non-fatal */ }
  }

  // QCX-6k — pre-message consent banner. Renders into the body above any
  // greeting, disables the composer until accepted. Re-runnable: clears
  // any previously inserted banner before re-adding.
  function renderConsentBanner() {
    try {
      var existing = body.querySelector('[data-qx-consent]');
      if (existing) existing.remove();
      var banner = document.createElement('div');
      banner.setAttribute('data-qx-consent', '1');
      banner.style.cssText = 'padding:10px 12px;margin:6px 0;border-radius:10px;' +
        'background:rgba(0,229,255,0.06);border:1px solid rgba(0,229,255,0.3);font-size:11px;line-height:1.45';
      var msg = document.createElement('div');
      msg.textContent = consentText;
      msg.style.cssText = 'margin-bottom:8px';
      banner.appendChild(msg);
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;justify-content:flex-end';
      var declineBtn = document.createElement('button');
      declineBtn.type = 'button';
      declineBtn.textContent = 'Decline';
      declineBtn.style.cssText = 'background:transparent;border:1px solid var(--qx-border);' +
        'color:inherit;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit';
      declineBtn.addEventListener('click', function () {
        // Decline: keep banner, disable composer permanently for this session.
        input.disabled = true;
        sendBtn.disabled = true;
        input.placeholder = 'Consent required to use this chat.';
      });
      var acceptBtn = document.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.textContent = 'Accept';
      acceptBtn.style.cssText = 'background:var(--q-cyan,#00e5ff);color:#000;border:0;' +
        'padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:600;font-size:11px;font-family:inherit';
      acceptBtn.addEventListener('click', function () {
        consentGiven = true;
        try { localStorage.setItem('qx_consent_' + widgetId, '1'); } catch (_) {}
        banner.remove();
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      });
      actions.appendChild(declineBtn);
      actions.appendChild(acceptBtn);
      banner.appendChild(actions);
      // Insert at top of body so it's always visible above any messages.
      if (body.firstChild) body.insertBefore(banner, body.firstChild);
      else body.appendChild(banner);
      // Lock the composer until consent given.
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = 'Please accept the consent notice to continue.';
    } catch (_) { /* non-fatal */ }
  }

  // QCX-6e — render Privacy + DPA links into the branding footer when
  // /config returns them. Re-runnable: clears any previously inserted
  // policy links before re-adding so a config refresh doesn't dupe.
  function renderPolicyLinks() {
    if (!showBranding || typeof brand === 'undefined' || !brand) return;
    try {
      var existing = brand.querySelectorAll('[data-qx-policy]');
      for (var i = 0; i < existing.length; i++) existing[i].remove();
      var addLink = function (href, label) {
        if (!href) return;
        var sep = document.createElement('span');
        sep.setAttribute('data-qx-policy', '1');
        sep.textContent = ' · ';
        brand.appendChild(sep);
        var a = document.createElement('a');
        a.setAttribute('data-qx-policy', '1');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        a.style.cssText = 'color:inherit;text-decoration:underline';
        brand.appendChild(a);
      };
      addLink(privacyPolicyUrl, 'Privacy');
      addLink(dpaUrl, 'DPA');
    } catch (_) { /* non-fatal */ }
  }

  // ─── QCX-4.4b: visitor upload ─────────────────────────────────────────
  var pendingAttachments = []; // [{file_id, name, mime, is_image, size, preview_url?}]

  function renderAttachStrip() {
    attachStrip.innerHTML = '';
    if (pendingAttachments.length === 0) { attachStrip.style.display = 'none'; return; }
    attachStrip.style.display = 'flex';
    for (var i = 0; i < pendingAttachments.length; i++) {
      (function (att, idx) {
        var chip = document.createElement('div');
        chip.className = 'qx-attach-chip';
        var thumb = '';
        if (att.is_image && att.preview_url) {
          thumb = '<span class="qx-att-thumb" style="background-image:url(' + att.preview_url + ')"></span>';
        } else {
          thumb = '<span class="qx-att-icon" aria-hidden="true">📎</span>';
        }
        chip.innerHTML =
          thumb +
          '<span class="qx-att-name"></span>' +
          '<button class="qx-att-x" type="button" aria-label="Remove attachment">×</button>';
        chip.querySelector('.qx-att-name').textContent = att.name;
        chip.querySelector('.qx-att-x').addEventListener('click', function () {
          pendingAttachments.splice(idx, 1);
          renderAttachStrip();
        });
        attachStrip.appendChild(chip);
      })(pendingAttachments[i], i);
    }
  }

  async function uploadFile(file) {
    // Client-side bounds mirror the server so the user gets a fast error
    // instead of a 413 round-trip.
    if (file.size > 10 * 1024 * 1024) {
      appendMessage('err', 'That file is too large. Maximum size is 10MB.');
      return;
    }
    var att = {
      file_id: null,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      is_image: (file.type || '').indexOf('image/') === 0,
      size: file.size,
      preview_url: null,
      uploading: true,
    };
    // Image preview — synchronous-ish via FileReader.
    if (att.is_image) {
      try {
        att.preview_url = await new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsDataURL(file);
        });
      } catch (_) { /* fall back to paperclip icon */ }
    }
    pendingAttachments.push(att);
    renderAttachStrip();

    var form = new FormData();
    form.append('widget_id', widgetId);
    form.append('visitor_id', visitorId);
    if (conversationId) form.append('conversation_id', conversationId);
    form.append('file', file);
    try {
      var resp = await fetch(endpoint + '/quoxchat/visitor/upload', { method: 'POST', body: form });
      if (!resp.ok) {
        // Map the two failure modes visitors actually hit to plain language
        // instead of raw error codes; fall back to one honest generic line.
        var errData = await resp.json().catch(function () { return {}; });
        var reason = typeof errData.error === 'string' ? errData.error : '';
        var uploadMsg = 'Upload failed. Please try again.';
        if (resp.status === 413 || /too large/i.test(reason)) {
          uploadMsg = 'That file is too large. Maximum size is 10MB.';
        } else if (resp.status === 415 || /unsupported mime/i.test(reason)) {
          uploadMsg = 'That file type is not supported. Please try a different file.';
        }
        appendMessage('err', uploadMsg);
        pendingAttachments.splice(pendingAttachments.indexOf(att), 1);
        renderAttachStrip();
        return;
      }
      var data = await resp.json();
      att.file_id = data.file_id;
      att.uploading = false;
      renderAttachStrip();
    } catch (err) {
      appendMessage('err', 'Upload failed. Please try again.');
      pendingAttachments.splice(pendingAttachments.indexOf(att), 1);
      renderAttachStrip();
    }
  }

  attachBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) uploadFile(file);
    fileInput.value = ''; // reset so the same file can be picked again
  });
  renderAttachStrip();

  // SSE parser: reads the response body and invokes onEvent({event, data})
  // for each frame (terminated by \n\n; `event:`/`data:` lines only).
  async function consumeSse(resp, onEvent) {
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        var raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        var ev = 'message';
        var dataLines = [];
        var lines = raw.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length === 0) continue;
        var data = null;
        try { data = JSON.parse(dataLines.join('\n')); } catch (_) { continue; }
        try { onEvent({ event: ev, data: data }); } catch (_) { /* keep going */ }
      }
    }
  }

  // ─── Send ──────────────────────────────────────────────────────────────
  // actionKind is only a string when a quick-action chip triggered the send
  // (button/keydown handlers pass an Event object here, which is ignored).
  async function send(actionKind) {
    if (sending) return;
    // QCX-6k — block message send until consent given.
    if (consentRequired && !consentGiven) {
      renderConsentBanner();
      return;
    }
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    // UX HOLES FIX: keep a handle on the visitor bubble so a handed-off
    // reply can mark it delivered instead of the send just going silent.
    var userMsg = appendMessage('user', text);
    history.push({ role: 'user', content: text });
    sending = true;
    sendBtn.disabled = true;
    var streamMsg = appendMessage('bot', '');
    streamMsg.classList.add('typing');
    // QCX-4.2 real 3-dot indicator replaces the ellipsis placeholder.
    streamMsg.innerHTML = '<span class="typing-dots" aria-label="Assistant is typing"><span></span><span></span><span></span></span>';
    emitStatus('thinking');
    var turnFailed = false;
    var accumulated = '';
    var doneBody = null;
    var errorBody = null;
    // QUOXCHAT-PRO visitor name: set when a human_handoff tool call lands
    // in THIS turn (LLM-triggered path — the chip path asks pre-send).
    var handoffThisTurn = false;
    try {
      // QCX-4.4b: include resolved attachment ids; pending uploads are skipped.
      var sentAttachments = pendingAttachments.filter(function (a) { return a.file_id && !a.uploading; });
      var sendBody = {
        widget_id: widgetId,
        visitor_id: visitorId,
        conversation_id: conversationId,
        conversation_history: history.slice(-10),
        message: text,
        page_url: window.location.pathname,
        attachment_ids: sentAttachments.map(function (a) { return a.file_id; }),
        stream: true,
      };
      // CHIP DETERMINISM: name the builtin action so the server runs the
      // tool deterministically (falls back to the normal LLM flow when the
      // action is unknown or disabled for this widget).
      if (typeof actionKind === 'string' && actionKind) {
        sendBody.action = actionKind;
      }
      // CAPTCHA #127 — OFF BY DEFAULT: no bot_protection config means this
      // block never runs — no provider script, no token, no captcha_token
      // field at all on the wire.
      if (botProtection) {
        sendBody.captcha_token = await getCaptchaToken();
      }
      var resp = await fetch(endpoint + '/quoxchat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(sendBody),
      });
      // Clear the strip as soon as we've taken the ids into the request.
      pendingAttachments = [];
      renderAttachStrip();
      if (!resp.ok) {
        turnFailed = true;
        emitStatus('error');
        streamMsg.remove();
        if (resp.status === 404) {
          // A 404 on /message is an embed misconfiguration: not transient.
          appendMessage('err', 'Chat is misconfigured on this site (check the embed endpoint).');
        } else if (resp.status === 402 || resp.status === 403) {
          // Licence gate (402) or domain gate (403): not fixable by
          // retrying, so surface the server's specific message when present.
          var gateBody = null;
          try { gateBody = await resp.json(); } catch (_) { /* noop */ }
          appendMessage('err', (gateBody && gateBody.message) || 'Chat is not available on this site right now.');
        } else {
          // Read whichever text field the server sent (middleware here use
          // error/message/response inconsistently) before an honest fallback.
          var errBody = null;
          try { errBody = await resp.json(); } catch (_) { /* body may be empty or non-JSON */ }
          var errText = errBody && (errBody.response || errBody.message || errBody.error);
          appendMessage('err', (typeof errText === 'string' && errText) ||
            'The assistant hit a temporary problem answering that. Please try again in a moment.');
        }
        return;
      }
      var ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/event-stream') !== -1 && resp.body && resp.body.getReader) {
        // QCX-4.3: tool cards accrue in insertion order, keyed by name. Each
        // tool_start appends a card; the next tool_result for that name
        // updates its state. Cards render BEFORE the streamed text bubble.
        var toolCardsByName = {};
        var lastToolName = null;
        var insertCard = function (name) {
          var card = document.createElement('div');
          card.className = 'msg msg-tool';
          card.innerHTML = renderToolCard({ name: name, state: 'running' });
          // Tool cards go above the in-progress bot bubble.
          body.insertBefore(card, streamMsg);
          toolCardsByName[name] = card;
          body.scrollTop = body.scrollHeight;
          return card;
        };

        await consumeSse(resp, function (ev) {
          if (ev.event === 'token' && ev.data && typeof ev.data.delta === 'string') {
            if (accumulated === '') {
              streamMsg.classList.remove('typing');
              streamMsg.textContent = '';
              emitStatus('streaming');
            }
            accumulated += ev.data.delta;
            streamMsg.textContent = accumulated;
            body.scrollTop = body.scrollHeight;
          } else if (ev.event === 'tool_start' && ev.data && ev.data.name) {
            emitStatus('tool');
            lastToolName = ev.data.name;
            var card = insertCard(ev.data.name);
            card.innerHTML = renderToolCard({ name: ev.data.name, state: 'running', input: ev.data.input });
          } else if (ev.event === 'tool_result' && ev.data && ev.data.name) {
            var card2 = toolCardsByName[ev.data.name] || insertCard(ev.data.name);
            card2.innerHTML = renderToolCard({
              name: ev.data.name,
              state: ev.data.ok ? 'ok' : 'error',
              error: ev.data.error,
            });
            // QUOXCHAT-PRO P1 — a successful handoff while humans are
            // offline resets expectations immediately: banner explains the
            // AI keeps answering and captures an email for follow-up.
            if (ev.data.name === 'human_handoff' && ev.data.ok) {
              renderOfflineBanner();
              // QUOXCHAT-PRO P2 — handoff requested this turn: nobody has
              // joined yet, use the honest awaiting copy.
              startHandoffPolling(false);
              // QUOXCHAT-PRO visitor name: LLM/server triggered this
              // handoff, so the pre-send ask never ran — offer the name
              // form after the turn settles (see below, once
              // conversation_id is known).
              handoffThisTurn = true;
            }
          } else if (ev.event === 'done') {
            doneBody = ev.data || {};
          } else if (ev.event === 'error') {
            errorBody = ev.data || {};
          }
        });
      } else {
        // Fallback: server returned JSON (e.g. pre-QCX-4.1 collector). Use
        // the old buffered path so callers on mixed versions still render.
        var data = await resp.json();
        doneBody = data;
      }

      if (errorBody) {
        turnFailed = true;
        emitStatus('error');
        streamMsg.remove();
        appendMessage('err', errorBody.response || 'The assistant hit a temporary problem answering that. Please try again in a moment.');
        return;
      }
      if (doneBody) {
        if (doneBody.conversation_id) { conversationId = doneBody.conversation_id; try { localStorage.setItem('qx_conv_' + widgetId, conversationId); } catch (_) { /* private mode */ } }
        // Staged handoff: handed_off:true can carry either a muted team-ack
        // or a real AI answer while the handoff awaits pickup. Always render
        // whatever reply the server sent.
        if (doneBody.handed_off) {
          markDelivered(userMsg);
          startHandoffPolling(doneBody.operator_joined === true);
          var handoffReply = typeof doneBody.response === 'string' ? doneBody.response.trim() : '';
          if (handoffReply) {
            streamMsg.classList.remove('typing');
            streamMsg.innerHTML = renderMarkdown(handoffReply);
            history.push({ role: 'assistant', content: handoffReply });
          } else {
            streamMsg.remove();
          }
          // A data-collection chip can still be missing a required field
          // while handed off; render the real form, not just the ack.
          if (doneBody.needs_input && Array.isArray(doneBody.needs_input.fields) && doneBody.needs_input.fields.length > 0) {
            renderDataCollectionForm(doneBody.needs_input);
          }
          // QUOXCHAT-PRO visitor name: chatting with a human while still
          // anonymous — ask once (skippable). Submit stamps the
          // conversation via identify(conversation_id).
          if (!visitorName && !nameAsked) askVisitorName('post', function () {});
          return;
        }
        // needs_input: the server's `response` is the short natural-language
        // ask, not a fabricated success. Render it, then a real inline form.
        if (doneBody.needs_input && Array.isArray(doneBody.needs_input.fields) && doneBody.needs_input.fields.length > 0) {
          streamMsg.classList.remove('typing');
          var niText = (typeof doneBody.response === 'string' && doneBody.response.trim()) || 'Could you share a few more details?';
          streamMsg.innerHTML = renderMarkdown(niText);
          history.push({ role: 'assistant', content: niText });
          renderDataCollectionForm(doneBody.needs_input);
          return;
        }
        var finalText = doneBody.response || accumulated || '';
        // UX HOLES FIX: never remove a reply bubble in silence. An empty
        // reply that is not a handoff ack gets an explicit retry prompt.
        if (!String(finalText).trim()) {
          streamMsg.remove();
          appendMessage('err', 'No reply received, please try again.');
          return;
        }
        streamMsg.classList.remove('typing');
        // QCX-4.2: re-render the final text as markdown once streaming ends.
        // Streaming keeps plain text so mid-token HTML can't be malformed.
        streamMsg.innerHTML = renderMarkdown(finalText);
        history.push({ role: 'assistant', content: finalText });
        speakReply(finalText);
        // Decorations must never destroy an already-rendered reply, so any
        // throw here (bad source entry, name-ask failure) stays contained.
        try {
          // Confidence badge + source chips, derived from the top RAG score.
          var firstSource = (doneBody.sources || []).filter(function (s) { return s && typeof s === 'object'; })[0];
          var topScore = (firstSource && typeof firstSource.score === 'number') ? firstSource.score : null;
          var confHtml = renderConfidenceBadge(topScore);
          var chipsHtml = renderSourceChips(normalizeSources(doneBody.sources));
          if (confHtml || chipsHtml) {
            var meta = document.createElement('div');
            meta.className = 'qx-meta';
            meta.innerHTML = confHtml + chipsHtml;
            body.appendChild(meta);
            body.scrollTop = body.scrollHeight;
          }
        } catch (decorErr) { /* decoration only — the reply stays */ }
        try { renderRating(doneBody.message_id); } catch (rateErr) { /* optional */ }
        // QUOXCHAT-PRO visitor name: an LLM-triggered handoff landed this
        // turn and we still have no name — ask now that conversation_id is
        // known, so a submit stamps the conversation for the operators.
        try {
          if (handoffThisTurn && !visitorName && !nameAsked) {
            askVisitorName('post', function () {});
          }
        } catch (askErr) { /* ask is optional — the reply stays */ }
      }
    } catch (err) {
      turnFailed = true;
      emitStatus('error');
      // VERIFIED STREAMING: an SSE drop mid-stream means the claim check never
      // finished, so any partial text is unverified. It is never kept as the
      // answer and never enters history; show the retry/error state instead.
      try { streamMsg.remove(); } catch (_) {}
      appendMessage('err', accumulated && accumulated.trim()
        ? 'The connection dropped before the answer was checked, so it was not shown. Please try again.'
        : 'Network error. Please try again.');
    } finally {
      sending = false;
      sendBtn.disabled = false;
      // QCX-LAUNCHER: after an error, the 'error' status stands — the host
      // launcher decides how long to show it. Clean turns settle to idle.
      if (!turnFailed) emitStatus('idle');
    }
  }

  // WAVE5: one thumbs rating per completed AI answer -> POST /quoxchat/feedback.
  function renderRating(messageId) {
    if (!ratingsEnabled || !conversationId) return;
    var wrap = document.createElement('div');
    wrap.className = 'qx-rating';
    wrap.setAttribute('part', 'rating');
    var btns = [];
    var note = document.createElement('span');
    note.setAttribute('role', 'status');
    [['up', 'Helpful', '\uD83D\uDC4D'], ['down', 'Not helpful', '\uD83D\uDC4E']].forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qx-rate';
      b.setAttribute('aria-label', d[1]);
      b.setAttribute('data-rating', d[0]);
      b.textContent = d[2];
      b.addEventListener('click', async function () {
        if (b.disabled) return;
        btns.forEach(function (x) { x.disabled = true; });
        var ok = false;
        try {
          var payload = { widget_id: widgetId, visitor_id: visitorId, conversation_id: conversationId, rating: d[0] };
          if (messageId) payload.message_id = messageId;
          var r = await fetch(endpoint + '/quoxchat/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          ok = !!(r && r.ok);
        } catch (_) { ok = false; }
        if (ok) {
          note.textContent = 'Thanks for the feedback';
        } else {
          btns.forEach(function (x) { x.disabled = false; });
          note.textContent = 'Could not send feedback, try again';
        }
      });
      btns.push(b);
      wrap.appendChild(b);
    });
    wrap.appendChild(note);
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
  }

  // ─── Events ────────────────────────────────────────────────────────────
  bubble.addEventListener('click', function () { setOpen(true); });
  closeBtn.addEventListener('click', function () { setOpen(false); });
  resetBtn.addEventListener('click', function () { if (!sending) startNewChat(); });
  // QCX-ENLARGE: toggle the two-column enlarged modal; clicking the scrim shrinks.
  expandBtn.addEventListener('click', function () { setExpanded(!expanded); });
  scrim.addEventListener('click', function () { setExpanded(false); });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Escape closes the nearest open surface: an inline form/confirm bubble
  // first, then the privacy panel, then the whole chat panel.
  shadow.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var openForm = shadow.querySelector('[data-qx-form="1"]');
    if (openForm) {
      var dismiss = openForm.querySelector('a');
      if (dismiss) dismiss.click();
      return;
    }
    if (privacyPanel.classList.contains('open')) {
      privacyPanel.classList.remove('open');
      return;
    }
    if (open) setOpen(false);
  });

  // ─── First-seen ping ──────────────────────────────────────────────────
  try {
    fetch(endpoint + '/quoxchat/first-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: widgetId }),
      keepalive: true,
    }).catch(function () {});
  } catch (_) { /* noop */ }

  // ─── QCX-4.5: Per-widget config (name, avatar, greetings, theme) ──
  // /config is cached on the collector side and returns neutral defaults
  // for demo / unknown widgets, so this fetch never blocks the widget.
  (function loadConfig() {
    try {
      fetch(endpoint + '/quoxchat/config/' + encodeURIComponent(widgetId))
        .then(function (r) {
          // /config returns neutral defaults even for unknown widgets, so a
          // 404 here means the embed endpoint itself is wrong (e.g. a
          // double /quoxchat path). Say so instead of failing silently.
          if (r.status === 404) {
            console.warn('[QuoxChat] config fetch returned 404 — chat is misconfigured on this site (check the embed endpoint)');
            appendMessage('err', 'Chat is misconfigured on this site (check the embed endpoint).');
          }
          return r.ok ? r.json() : null;
        })
        .then(function (cfg) {
          if (!cfg || !cfg.widget) return;
          var w = cfg.widget;
          if (w.name) {
            titleSpan.textContent = w.name;
            // An admin-set name is a persona, surfaced in the subtitle, side
            // rail, and above the first bubble; the generic default isn't.
            if (w.name !== 'Chat with us') {
              agentName = w.name;
              subtitleSpan.style.display = 'block';
              vizName.textContent = agentName;
              vizName.style.display = 'block';
              renderAgentLabel();
            }
          }
          if (w.avatar_url) {
            avatarEl.style.backgroundImage = 'url(' + w.avatar_url.replace(/[()"']/g, '') + ')';
            avatarEl.style.display = 'inline-block';
            vizAvatar.innerHTML = '';
            vizAvatar.style.backgroundImage = 'url(' + w.avatar_url.replace(/[()"']/g, '') + ')';
          }
          if (w.greeting) greeting = w.greeting;
          if (Array.isArray(w.greeting_variants) && w.greeting_variants.length > 0) {
            greetingVariants = w.greeting_variants;
          }
          // QCX-6e — Art.52 disclosure + privacy / DPA links.
          if (typeof w.ai_disclosure_text === 'string' && w.ai_disclosure_text.length > 0) {
            aiDisclosureText = w.ai_disclosure_text;
          }
          if (typeof w.privacy_policy_url === 'string') privacyPolicyUrl = w.privacy_policy_url;
          if (typeof w.dpa_url === 'string') dpaUrl = w.dpa_url;
          // QCX-6k — consent flag + custom text.
          if (w.consent_required === true) consentRequired = true;
          if (typeof w.consent_text === 'string' && w.consent_text.length > 0) {
            consentText = w.consent_text;
          }
          renderPolicyLinks();
          // QCX-ENLARGE: refresh the side-rail data links (privacy / DPA urls
          // may have just arrived).
          renderSideLinks();
          // If consent is required and not yet given, gate the composer
          // until the visitor accepts.
          if (consentRequired && !consentGiven && open) {
            renderConsentBanner();
          }
          // Server-side theme wins over data-theme attribute when set.
          if (['auto', 'light', 'dark'].indexOf(w.theme) >= 0 && w.theme !== 'auto') {
            host.setAttribute('data-theme', w.theme);
          }
          // Admin-set accent (Style tab / presets). An explicit embed
          // attribute wins; otherwise the server value re-colours the
          // accent surfaces. Strict hex only, so nothing can be injected.
          if (!accentAttr && typeof w.accent_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(w.accent_color)) {
            var ac = w.accent_color;
            accentColor = ac;
            var accSt = document.createElement('style');
            accSt.setAttribute('data-qx-accent', ac);
            accSt.textContent = ':host{--qx-user-bg:' + ac + '}' +
              '.bubble,.header{background:' + ac + '}' +
              '.msg a{color:' + ac + '}' +
              '.qx-action-chip:hover{border-color:' + ac + ';color:' + ac + '}' +
              '.input:focus{border-color:' + ac + '}';
            shadow.appendChild(accSt);
          }
          // Per-widget style_overrides: already sanitised server-side,
          // appended as a separate <style> block so it cascades last.
          if (typeof w.style_overrides === 'string' && w.style_overrides.length > 0) {
            var ovr = document.createElement('style');
            ovr.setAttribute('data-qx-style-overrides', '1');
            ovr.textContent = w.style_overrides;
            shadow.appendChild(ovr);
          }
          // Off by default: w.bot_protection is null unless the admin
          // enabled it with a site key. Kick off provider-script loading
          // now so the token is ready for the first message.
          if (w.bot_protection && w.bot_protection.enabled === true && w.bot_protection.site_key) {
            botProtection = w.bot_protection;
            initBotProtection();
          }
          // QUOXCHAT-PRO P1 — human availability. If the panel is already
          // open and humans are offline, surface the banner now.
          if (w.availability && typeof w.availability === 'object') {
            availability = w.availability;
            if (open) renderOfflineBanner();
          }
          // PRO-3 — quick-action chips from enabled builtin actions.
          if (Array.isArray(w.actions)) renderActionChips(w.actions);
          // P-V — Professional features, server-gated (absent/false on Standard).
          if (w.features && w.features.voice === true) enableVoice();
          if (w.features && w.features.proactive === true && Array.isArray(w.proactive) && !customLauncher) {
            scheduleProactive(w.proactive);
          }
        })
        .catch(function () { /* config is best-effort; widget stays usable */ });
    } catch (_) { /* noop */ }
  })();

  // QC-HOLES: boot-time handoff state. The server gate binds this visitor to
  // any open handed-off conversation for 24h; without this check the widget
  // showed a fresh greeting and then silently re-attached on the first send
  // ("Connected to the team queue" out of nowhere). Ask the visitor instead.
  (function checkOpenHandoff() {
    try {
      fetch(endpoint + '/quoxchat/handoff-state?widget_id=' + encodeURIComponent(widgetId) +
        '&visitor_id=' + encodeURIComponent(visitorId))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (st) {
          if (!st || st.open !== true || !st.conversation_id) return;
          conversationId = st.conversation_id;
          renderConfirmBubble(
            'You have an open conversation with our team from earlier. Continue it, or start fresh?',
            function () {
              startHandoffPolling(st.operator_joined === true);
            },
            function () {
              // Start fresh: close it server-side so the gate lets go.
              try {
                fetch(endpoint + '/quoxchat/conversation/close', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ widget_id: widgetId, visitor_id: visitorId, conversation_id: st.conversation_id }),
                }).catch(function () {});
              } catch (_) {}
              conversationId = null;
            },
            'Continue',
            'Start fresh'
          );
        })
        .catch(function () { /* state check is best-effort */ });
    } catch (_) { /* noop */ }
  })();

  // GDPR Article 15 export: POST /quoxchat/visitor/export, JSON download.
  async function requestMyData() {
    try {
      var resp = await fetch(endpoint + '/quoxchat/visitor/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widget_id: widgetId, visitor_id: visitorId, conversation_id: conversationId || recalledConversationId() }),
      });
      if (!resp.ok) {
        appendMessage('err', 'Could not export your data right now. Please try again.');
        return;
      }
      var blob = await resp.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'quoxchat-my-data-' + widgetId + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      appendMessage('bot', 'Your data has been downloaded as a JSON file.');
    } catch (_) {
      appendMessage('err', 'Could not export your data right now. Please try again.');
    }
  }

  // GDPR Art.17 erasure: window.confirm, then POST /visitor/erase with
  // confirm:true. skipConfirm=true when the caller (the privacy panel's
  // two-click delete) already confirmed.
  // Remove every localStorage key this widget wrote for this widgetId.
  function clearVisitorStorage() {
    var prefixes = ['qx_visitor_', 'qx_vname_', 'qx_vemail_', 'qx_consent_',
      'qx_nameasked_', 'qx_conv_', 'qx_pa_', 'qx_readaloud_'].map(function (p) { return p + widgetId; });
    try {
      var doomed = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && prefixes.some(function (p) { return k.indexOf(p) === 0; })) doomed.push(k);
      }
      doomed.forEach(function (k) { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* private mode */ }
  }

  // Erase proof of possession: the last conversation id this browser saw.
  function recalledConversationId() {
    try { return localStorage.getItem('qx_conv_' + widgetId) || ''; } catch (_) { return ''; }
  }

  async function eraseMyData(skipConfirm) {
    if (skipConfirm !== true) {
      var ok = window.confirm(
        'This will permanently delete all your conversations on this site. ' +
        'This cannot be undone. Continue?'
      );
      if (!ok) return;
    }
    try {
      var resp = await fetch(endpoint + '/quoxchat/visitor/erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widget_id: widgetId, visitor_id: visitorId, conversation_id: conversationId || recalledConversationId(), confirm: true }),
      });
      if (!resp.ok) {
        appendMessage('err', 'Could not delete your data right now. Please try again.');
        return;
      }
      var data = await resp.json().catch(function () { return {}; });
      var deleted = data.deleted || {};
      clearVisitorStorage();
      // Clear in-memory identity/consent/conversation so nothing lingers.
      visitorName = null;
      visitorEmail = null;
      consentGiven = false;
      nameAsked = false;
      conversationId = null;
      handedOff = false;
      lastOperatorMsgId = null;
      stopHandoffPolling();
      visitorId = generateVisitorId();
      history = [];
      body.innerHTML = '';
      appendMessage('bot',
        'Your data has been deleted, including your name, email and consent stored in this browser. ' +
        'Removed: ' + (deleted.messages || 0) + ' messages, ' +
        (deleted.conversations || 0) + ' conversations.'
      );
    } catch (_) {
      appendMessage('err', 'Could not delete your data right now. Please try again.');
    }
  }

  // "Email me this transcript": POST /quoxchat/transcript/email. The server
  // resolves the recipient from the visitor's identified email; if unknown,
  // we prompt, identify(), and retry once.
  // QUOXCHAT-EMAIL P2 — the transcript button mints its token from the SAME
  // per-widget bot_protection config the message path uses (one captcha
  // system). getCaptchaToken() resolves null when the widget has no
  // bot_protection; the server then only sends to identify-vouched emails.

  var transcriptBusy = false;
  async function emailTranscriptRequest(retried) {
    if (transcriptBusy) return;
    if (!conversationId) {
      appendMessage('bot', 'Send a message first, then I can email you the transcript.');
      return;
    }
    transcriptBusy = true;
    try {
      var token = await getCaptchaToken();
      var resp = await fetch(endpoint + '/quoxchat/transcript/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widget_id: widgetId,
          visitor_id: visitorId,
          conversation_id: conversationId,
          captcha_token: token,
        }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (data.success) {
        appendMessage('bot', 'Transcript sent to ' + (data.masked_email || 'your email') + '.');
        return;
      }
      if (data.error === 'visitor_email_unknown' && !retried) {
        var email = window.prompt('Where should we send the transcript? Enter your email:');
        if (email === null) return; // cancelled
        email = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          appendMessage('err', 'That does not look like a valid email address.');
          return;
        }
        identify({ email: email });
        // identify() is fire-and-forget; give auth a moment to persist the
        // email before the server re-resolves it.
        await new Promise(function (r) { setTimeout(r, 800); });
        transcriptBusy = false;
        return emailTranscriptRequest(true);
      }
      appendMessage('err', data.message || 'The transcript could not be emailed right now.');
    } catch (_) {
      appendMessage('err', 'Network error. Please try again.');
    } finally {
      transcriptBusy = false;
    }
  }

  // In-widget privacy panel: data export (GDPR Art.15), delete-my-data with
  // a two-click confirm (Art.17), email-transcript, and policy links.
  var privacyPanel = document.createElement('div');
  privacyPanel.className = 'qx-privacy';
  var privHead = document.createElement('div');
  privHead.className = 'qx-privacy-head';
  var privTitle = document.createElement('span');
  privTitle.textContent = 'Privacy & your data';
  var privClose = document.createElement('button');
  privClose.className = 'close';
  privClose.type = 'button';
  privClose.setAttribute('aria-label', 'Close privacy panel');
  privClose.textContent = '×';
  privHead.appendChild(privTitle);
  privHead.appendChild(privClose);
  var privBody = document.createElement('div');
  privBody.className = 'qx-privacy-body';
  privacyPanel.appendChild(privHead);
  privacyPanel.appendChild(privBody);
  panel.appendChild(privacyPanel);
  privClose.addEventListener('click', function () { privacyPanel.classList.remove('open'); });

  function openPrivacyPanel() {
    privBody.innerHTML = '';
    var note = document.createElement('div');
    note.className = 'qx-privacy-note';
    note.textContent = 'Your conversation data on this site, under your control.';
    privBody.appendChild(note);
    var mkBtn = function (icon, label, cls) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qx-privacy-btn' + (cls ? ' ' + cls : '');
      b.innerHTML = icon + '<span></span>';
      b.querySelector('span').textContent = label;
      privBody.appendChild(b);
      return b;
    };
    var dl = mkBtn('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
      'Download my data (JSON export)');
    dl.title = 'Download a copy of your conversation data (GDPR Article 15)';
    dl.addEventListener('click', function () {
      privacyPanel.classList.remove('open');
      requestMyData();
    });
    var tr = mkBtn('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>',
      'Email me this transcript');
    tr.title = 'Email me a copy of this conversation';
    tr.addEventListener('click', function () {
      privacyPanel.classList.remove('open');
      emailTranscriptRequest(false);
    });
    var del = mkBtn('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
      'Delete my data', 'qx-danger');
    del.title = 'Permanently delete all your conversation data on this site (GDPR Article 17)';
    // Two-click confirm: the first click arms, the second executes.
    var armed = false;
    del.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        del.querySelector('span').textContent = 'Click again to permanently delete everything';
        return;
      }
      privacyPanel.classList.remove('open');
      eraseMyData(true);
    });
    if (privacyPolicyUrl || dpaUrl) {
      var links = document.createElement('div');
      links.className = 'qx-privacy-links';
      var addPolicy = function (href, label) {
        if (!href) return;
        var a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        links.appendChild(a);
      };
      addPolicy(privacyPolicyUrl, 'Privacy policy');
      addPolicy(dpaUrl, 'DPA');
      privBody.appendChild(links);
    }
    var gd = document.createElement('div');
    gd.className = 'qx-privacy-note';
    gd.textContent = 'Export covers GDPR Article 15 (access). Deletion covers Article 17 (erasure) and is permanent.';
    privBody.appendChild(gd);
    if (voiceEnabled) {
      var vn = document.createElement('div');
      vn.className = 'qx-privacy-note';
      vn.textContent = "Voice input uses your browser's speech recognition.";
      privBody.appendChild(vn);
    }
    privacyPanel.classList.add('open');
  }

  // QCX-ENLARGE: data links at the bottom of the enlarged-mode side rail.
  function renderSideLinks() {
    try {
      sideLinks.innerHTML = '';
      var add = function (label, handler, href) {
        var a = document.createElement('a');
        if (href) {
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        } else {
          a.href = '#';
          a.addEventListener('click', function (e) { e.preventDefault(); handler(); });
        }
        a.textContent = label;
        sideLinks.appendChild(a);
      };
      add('My data & privacy', openPrivacyPanel);
      add('Email transcript', function () { emailTranscriptRequest(false); });
      if (privacyPolicyUrl) add('Privacy policy', null, privacyPolicyUrl);
      if (dpaUrl) add('DPA', null, dpaUrl);
    } catch (_) { /* non-fatal */ }
  }
  renderSideLinks();

  // Footer link into the privacy panel (replaces the old My data / Delete /
  // Email transcript trio; all three now live inside the panel).
  if (showBranding && typeof brand !== 'undefined' && brand) {
    try {
      var sep1 = document.createElement('span');
      sep1.textContent = ' · ';
      brand.appendChild(sep1);
      var dataLink = document.createElement('a');
      dataLink.href = '#';
      dataLink.textContent = 'My data';
      dataLink.title = 'Manage your conversation data (export, delete, email transcript)';
      dataLink.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
      dataLink.addEventListener('click', function (e) { e.preventDefault(); openPrivacyPanel(); });
      brand.appendChild(dataLink);
    } catch (_) { /* non-fatal */ }
  }

  // window.QuoxChat.identify({email, name, user_id, user_hash, ...}). An
  // optional user_hash (HMAC-SHA256 of user_id, see
  // docs/QUOXCHAT_IDENTITY_VERIFICATION.md) marks the visitor verified.
  function identify(attrs) {
    if (!attrs || typeof attrs !== 'object') return;
    // QUOXCHAT-PRO visitor name: a host page (or the pre-handoff form)
    // naming the visitor marks the name known locally, so the in-chat ask
    // is skipped from here on.
    rememberVisitorIdentity(attrs);
    try {
      var body = { widget_id: widgetId, visitor_id: visitorId, attrs: attrs };
      // When a conversation exists, send it so the server can stamp
      // name/email onto the conversation row (handoff labels, LogsTab).
      if (conversationId) body.conversation_id = conversationId;
      if (attrs.user_id) body.user_id = attrs.user_id;
      if (attrs.user_hash) body.user_hash = attrs.user_hash;
      if (attrs.allowance_sig) body.allowance_sig = attrs.allowance_sig;
      if (attrs.allowance_exp) body.allowance_exp = attrs.allowance_exp;
      // Returns the fetch promise so internal callers (the pre-handoff
      // name form) can wait for auth to persist before handing off.
      return fetch(endpoint + '/quoxchat/events/visitor-identified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (_) { /* non-fatal — identify() must never throw on the host page */ }
  }

  // QUOXCHAT-PRO visitor name: seed identity from the embed script tag
  // (data-user-name / data-user-email) — silent, no visitor-facing ask.
  if (embedUserName || embedUserEmail) {
    var embedAttrs = {};
    if (embedUserName) embedAttrs.name = embedUserName;
    if (embedUserEmail) embedAttrs.email = embedUserEmail;
    identify(embedAttrs);
  }

  // Expose minimal programmatic API for host page
  window.QuoxChat = window.QuoxChat || {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!open); },
    sendMessage: function (text) { input.value = text; send(); },
    identify: identify,
    requestMyData: requestMyData,
    eraseMyData: eraseMyData,
    // QUOXCHAT-PRO P0 — programmatic transcript-email trigger.
    emailTranscript: function () { emailTranscriptRequest(false); },
    // QCX-ENLARGE / QCX-PRIVACY: programmatic access to the new surfaces.
    expand: function (v) { setExpanded(v !== false); },
    openPrivacy: function () { setOpen(true); openPrivacyPanel(); },
    // QCX-LAUNCHER: latest status for hosts that attach listeners late.
    getStatus: function () { return lastStatus; },
  };
  emitStatus('ready');
  }

  var scriptTag = (document.currentScript && document.currentScript.getAttribute('data-widget-id') && document.currentScript) ||
    (function () {
      var scripts = document.querySelectorAll('script[data-widget-id]');
      return scripts[scripts.length - 1];
    })();

  if (typeof window.customElements !== 'undefined' && !window.customElements.get('quox-chat')) {
    var QuoxChatElement = (function () {
      var Base = window.HTMLElement;
      function QuoxChat() { return Reflect.construct(Base, [], QuoxChat); }
      QuoxChat.prototype = Object.create(Base.prototype, { constructor: { value: QuoxChat, configurable: true, writable: true } });
      Object.setPrototypeOf(QuoxChat, Base);
      QuoxChat.prototype.connectedCallback = function () { boot(elementSource(this)); };
      return QuoxChat;
    })();
    window.customElements.define('quox-chat', QuoxChatElement);
  }

  // A script-tag embed wins when present; otherwise a <quox-chat> element
  // already in the page boots the widget (late-added elements boot via the
  // connectedCallback above).
  if (scriptTag) boot(scriptTag);
})();
