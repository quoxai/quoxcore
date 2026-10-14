/**
 * StyleTab — QCX-5h
 *
 * Per-widget visual customisation editor: theme preset, accent colour,
 * raw CSS overrides. Saves to embed_config_json. Live preview iframe
 * loads /quoxchat-demo.html?widget=<public_key> (the shipped demo page)
 * so admins see their changes in seconds (reload the iframe after save).
 *
 * The plan's "5 Levels of CSS Control": preset → accent → CSS variables
 * → ::part() selectors → full override. Levels 1, 2, and 5 ship in this
 * file. Levels 3 and 4 are currently documented inline as hints; they
 * can be promoted into structured editors in a follow-up.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeStyleConfig, parseExistingStyleConfig } from './styleTabUtils';
import './StyleTab.css';
import { diffEmbedConfig } from './embedConfigPatch'

const PRESETS = [
  { value: 'auto',  label: 'Auto (system)', desc: 'Follows the visitor’s prefers-color-scheme.' },
  { value: 'light', label: 'Light',         desc: 'Force the light palette.' },
  { value: 'dark',  label: 'Dark',          desc: 'Force the dark palette.' },
];

// One-click style presets: a named palette = a theme + an accent colour (the
// same two values the fields below edit, so a preset is just a shortcut and
// never touches the Custom CSS box).
export const STYLE_PRESETS = [
  { id: 'violet',   label: 'Violet',   theme: 'auto',  accent: '#a855f7' },
  { id: 'indigo',   label: 'Indigo',   theme: 'light', accent: '#6366f1' },
  { id: 'corporate', label: 'Corporate blue', theme: 'light', accent: '#1e40af' },
  { id: 'ocean',    label: 'Ocean',    theme: 'light', accent: '#0891b2' },
  { id: 'emerald',  label: 'Emerald',  theme: 'light', accent: '#10b981' },
  { id: 'forest',   label: 'Forest',   theme: 'light', accent: '#166534' },
  { id: 'sunset',   label: 'Sunset',   theme: 'light', accent: '#f97316' },
  { id: 'rose',     label: 'Rose',     theme: 'light', accent: '#ec4899' },
  { id: 'crimson',  label: 'Crimson',  theme: 'light', accent: '#dc2626' },
  { id: 'midnight', label: 'Midnight', theme: 'dark',  accent: '#818cf8' },
  { id: 'graphite', label: 'Graphite', theme: 'dark',  accent: '#94a3b8' },
  { id: 'neon',     label: 'Neon',     theme: 'dark',  accent: '#22d3ee' },
];

const CSS_HINT = `/* Advanced: leave blank unless you write CSS. Theme + accent above cover most needs. */
/* Available shadow-DOM classes (no leading qx-, just write CSS) */
/* .gcb         — message bubble (variants: --user, --assistant, --system, --error) */
/* .gct         — typing indicator                                                  */
/* .gcb-conf    — confidence badge (--high, --med, --low)                           */
/* .gcc         — citation card                                                     */
/* .gtc         — tool-call card (data-state="running|ok|error")                    */
/* .gac         — attachment chip                                                   */
/* .qx-chip     — citation chip                                                     */
/* .panel       — chat panel container                                              */
/* .header      — top bar                                                           */
/* .body        — scrollable message list                                           */
/* .footer      — composer area                                                     */
/* .input       — message textarea                                                  */
/* .send        — send button                                                       */
/* .bubble      — closed-state floating button                                      */

/* CSS variables you can override */
/* --qx-bg, --qx-panel-bg, --qx-body-bg                                             */
/* --qx-text, --qx-text-muted                                                       */
/* --qx-border, --qx-border-strong                                                  */
/* --qx-bot-bg, --qx-user-bg, --qx-user-fg                                          */
/* --qx-tool-bg, --qx-tool-fg, --qx-tool-border                                     */
/* --qx-conf-{high|med|low}-bg, --qx-conf-{high|med|low}-fg                         */
`;

export default function StyleTab({ widget, orgId, authFetch, onWidgetChange }) {
  const seed = useMemo(() => parseExistingStyleConfig(widget), [widget]);
  const [theme, setTheme] = useState(seed.theme);
  const [accent, setAccent] = useState(seed.accent_color || '#a855f7');
  const [css, setCss] = useState(seed.style_overrides);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const iframeRef = useRef(null);

  const previewSrc = useMemo(() => {
    const key = widget?.public_key || widget?.id || 'demo';
    return `/quoxchat-demo.html?widget=${encodeURIComponent(key)}`;
  }, [widget]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const prev = parseExistingStyleConfig(widget);
      const baseCfg = (() => {
        if (widget?.embed_config && typeof widget.embed_config === 'object') return widget.embed_config;
        if (typeof widget?.embed_config_json === 'string') {
          try { return JSON.parse(widget.embed_config_json); } catch { return {}; }
        }
        return {};
      })();
      const merged = mergeStyleConfig(baseCfg, {
        theme,
        accent_color: accent,
        style_overrides: css,
      });
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embed_config_json: JSON.stringify(diffEmbedConfig(baseCfg, merged)) }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${resp.status})`);
      }
      try { const d = await resp.json(); if (d?.widget && onWidgetChange) onWidgetChange(d.widget) } catch {}
      setSavedAt(Date.now());
      // Reload the preview iframe so the visitor-facing changes appear.
      try { if (iframeRef.current) iframeRef.current.src = iframeRef.current.src; } catch {}
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="style-tab">
      <div className="style-tab__editor">
        <h2>Style</h2>
        <p className="style-tab__subtitle">
          Theme, accent and full-CSS overrides. Saved CSS is sanitised server-side and
          injected into the widget’s shadow DOM.
        </p>

        <div className="style-tab__field" role="group" aria-label="Style presets">
          <span>Style presets</span>
          <div className="style-tab__color-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {STYLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-label={`Preset ${p.label}`}
                aria-pressed={theme === p.theme && accent.toLowerCase() === p.accent}
                onClick={() => { setTheme(p.theme); setAccent(p.accent); }}
                style={{ borderLeft: `10px solid ${p.accent}` }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <small>Sets theme and accent in one click. Save to apply.</small>
        </div>

        <label className="style-tab__field">
          <span>Theme preset</span>
          <select
            aria-label="Theme preset"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <small>{(PRESETS.find((p) => p.value === theme) || {}).desc}</small>
        </label>

        <div className="style-tab__field">
          <span>Accent color</span>
          <div className="style-tab__color-row">
            <input
              type="color"
              aria-label="Pick a colour"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
            <input
              type="text"
              aria-label="Accent color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              placeholder="#a855f7"
            />
          </div>
          <small>Used for the floating bubble, send button, and link colour.</small>
        </div>

        <label className="style-tab__field style-tab__field--block">
          <span>Custom CSS</span>
          <textarea
            aria-label="Custom CSS"
            spellCheck={false}
            rows={14}
            value={css}
            onChange={(e) => setCss(e.target.value)}
            placeholder={CSS_HINT}
          />
          <small>
            32 KB max. <code>&lt;/style&gt;</code>, <code>&lt;script&gt;</code>,{' '}
            <code>javascript:</code> URIs are stripped on save.
          </small>
        </label>

        <div className="style-tab__actions">
          <button
            type="button"
            className="style-tab__save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save style'}
          </button>
          {savedAt && !error && (
            <span className="style-tab__saved">Saved.</span>
          )}
          {error && (
            <span className="style-tab__error">Save failed: {error}</span>
          )}
        </div>
      </div>

      <div className="style-tab__preview">
        <div className="style-tab__preview-head">Live preview</div>
        <iframe
          ref={iframeRef}
          title="Widget preview"
          src={previewSrc}
          className="style-tab__iframe"
        />
      </div>
    </div>
  );
}
