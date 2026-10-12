/**
 * AppearanceSettings — background appearance lab
 *
 * Three modes:
 *   1. Quox — canonical default (no settings, just active/inactive)
 *   2. Image — upload, fit, darken, blur
 *   3. Orbs — editable orb list, add/randomise, base gradient, save slots
 *
 * Applied globally via services/appearance.js which writes to a <style>
 * tag overriding body / .glass-page defaults. Persisted to localStorage.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getAppearance,
  setAppearance,
  subscribeAppearance,
  resetAppearance,
  QUOX_PRESET,
  hexToRgba,
  buildOrbsBackground,
} from '../../services/appearance';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import './AppearanceSettings.css';

function useAppearanceState() {
  const [state, setState] = useState(() => getAppearance());
  useEffect(() => subscribeAppearance(setState), []);
  const update = useCallback((patch) => {
    setAppearance({ ...getAppearance(), ...patch });
  }, []);
  return [state, update];
}

// ─────────────────────── QUOX TAB ───────────────────────
function QuoxTab() {
  return (
    <div className="appearance-pane-copy">
      <p>
        The default Quox background: five radial orbs (cyan, purple, blue,
        violet, teal) over a dark gradient, with a vignette overlay.
      </p>
      <p>
        This is the canonical look used across the dashboard. Switch to{' '}
        <strong>Image</strong> or <strong>Orbs</strong> above to customise.
      </p>
    </div>
  );
}

// ─────────────────────── IMAGE TAB ───────────────────────
function ImageTab({ state, update }) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    if (file.size > 8 * 1024 * 1024) {
      alert('Image too large (max 8 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      update({ image: { ...state.image, dataUrl: e.target.result } });
    };
    reader.readAsDataURL(file);
  }, [state.image, update]);

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  return (
    <div className="appearance-pane">
      <div className="appearance-section">
        <label className="appearance-label">Background image</label>
        <div
          className={`appearance-drop ${isDragging ? 'dragover' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          {state.image.dataUrl
            ? 'Image loaded — click to replace, or drag a new one'
            : 'Click to upload, or drag an image here (max 8 MB)'}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      <div className="appearance-section">
        <label className="appearance-label">Fit</label>
        <select
          className="appearance-select"
          value={state.image.fit}
          onChange={(e) => update({ image: { ...state.image, fit: e.target.value } })}
        >
          <option value="cover">Cover — fill, crop overflow</option>
          <option value="contain">Contain — fit, letterbox</option>
          <option value="100% 100%">Stretch — exact fill (may distort)</option>
          <option value="auto">Actual size — centered</option>
          <option value="repeat">Tile — repeat</option>
        </select>
      </div>

      <div className="appearance-section">
        <label className="appearance-label">
          Darken overlay <span className="appearance-value">{state.image.darken}%</span>
        </label>
        <input
          type="range"
          min="0"
          max="100"
          value={state.image.darken}
          onChange={(e) => update({ image: { ...state.image, darken: +e.target.value } })}
          className="appearance-range"
        />
      </div>

      <div className="appearance-section">
        <label className="appearance-label">
          Blur <span className="appearance-value">{state.image.blur}px</span>
        </label>
        <input
          type="range"
          min="0"
          max="30"
          value={state.image.blur}
          onChange={(e) => update({ image: { ...state.image, blur: +e.target.value } })}
          className="appearance-range"
        />
      </div>

      {state.image.dataUrl && (
        <button
          className="appearance-btn"
          onClick={() => update({ image: { ...state.image, dataUrl: null } })}
        >
          Clear image
        </button>
      )}
    </div>
  );
}

// ─────────────────────── ORBS TAB ───────────────────────
function OrbsTab({ state, update }) {
  const orbs = state.orbs;

  const updateOrb = (i, field, value) => {
    const list = orbs.list.map((o, idx) => idx === i ? { ...o, [field]: value } : o);
    update({ orbs: { ...orbs, list } });
  };

  const removeOrb = (i) => {
    update({ orbs: { ...orbs, list: orbs.list.filter((_, idx) => idx !== i) } });
  };

  const addOrb = () => {
    const palette = ['#38bdf8', '#a855f7', '#30ff90', '#f59e0b', '#ec4899'];
    const newOrb = {
      color: palette[Math.floor(Math.random() * palette.length)],
      opacity: 0.2,
      x: Math.floor(Math.random() * 100),
      y: Math.floor(Math.random() * 100),
      w: 40,
      h: 35,
    };
    update({ orbs: { ...orbs, list: [...orbs.list, newOrb] } });
  };

  const randomise = () => {
    const list = orbs.list.map(orb => ({
      ...orb,
      color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
      opacity: Math.random() * 0.3 + 0.08,
      x: Math.floor(Math.random() * 100),
      y: Math.floor(Math.random() * 100),
      w: Math.floor(Math.random() * 50) + 25,
      h: Math.floor(Math.random() * 40) + 20,
    }));
    update({ orbs: { ...orbs, list } });
  };

  const loadQuoxPreset = () => {
    update({ orbs: JSON.parse(JSON.stringify(QUOX_PRESET)) });
  };

  return (
    <div className="appearance-pane">
      <div className="appearance-section">
        <label className="appearance-label">Custom orbs</label>
        <div className="appearance-orbs">
          {orbs.list.map((orb, i) => (
            <div key={i} className="appearance-orb">
              <div className="appearance-orb-head">
                <input
                  type="color"
                  className="appearance-orb-swatch"
                  value={orb.color}
                  onChange={(e) => updateOrb(i, 'color', e.target.value)}
                />
                <div className="appearance-orb-title">Orb {i + 1}</div>
                <button
                  type="button"
                  className="appearance-orb-remove"
                  onClick={() => removeOrb(i)}
                >×</button>
              </div>
              <OrbSlider label="Op" value={Math.round(orb.opacity * 100)} onChange={(v) => updateOrb(i, 'opacity', v / 100)} min={0} max={100} unit="%" />
              <OrbSlider label="X" value={orb.x} onChange={(v) => updateOrb(i, 'x', v)} min={0} max={100} unit="%" />
              <OrbSlider label="Y" value={orb.y} onChange={(v) => updateOrb(i, 'y', v)} min={0} max={100} unit="%" />
              <OrbSlider label="W" value={orb.w} onChange={(v) => updateOrb(i, 'w', v)} min={10} max={100} unit="%" />
              <OrbSlider label="H" value={orb.h} onChange={(v) => updateOrb(i, 'h', v)} min={10} max={100} unit="%" />
            </div>
          ))}
        </div>
        <div className="appearance-row">
          <button className="appearance-btn" onClick={addOrb}>+ Add orb</button>
          <button className="appearance-btn" onClick={randomise}>🎲 Randomise</button>
        </div>
      </div>

      <div className="appearance-section">
        <label className="appearance-label">Base gradient</label>
        <div className="appearance-row">
          <label className="appearance-color-pair">
            <input
              type="color"
              value={orbs.baseTop}
              onChange={(e) => update({ orbs: { ...orbs, baseTop: e.target.value } })}
            />
            <span>top</span>
          </label>
          <label className="appearance-color-pair">
            <input
              type="color"
              value={orbs.baseBottom}
              onChange={(e) => update({ orbs: { ...orbs, baseBottom: e.target.value } })}
            />
            <span>bottom</span>
          </label>
          <button className="appearance-btn" onClick={loadQuoxPreset} style={{ marginLeft: 'auto' }}>
            Load Quox preset
          </button>
        </div>
      </div>

      <div className="appearance-section">
        <label className="appearance-label">Save slots</label>
        <Slots state={state} update={update} />
      </div>
    </div>
  );
}

function OrbSlider({ label, value, onChange, min, max, unit }) {
  return (
    <div className="appearance-orb-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="appearance-range"
      />
      <span className="appearance-orb-val">{value}{unit}</span>
    </div>
  );
}

// ─────────────────────── SLOTS ───────────────────────
function Slots({ state, update }) {
  const slots = state.slots || [];

  const saveSlot = (i) => {
    const snapshot = {
      mode: state.mode,
      orbs: JSON.parse(JSON.stringify(state.orbs)),
      image: { ...state.image },
    };
    const next = [...slots];
    next[i] = snapshot;
    update({ slots: next });
  };

  const loadSlot = (i) => {
    const slot = slots[i];
    if (!slot) return saveSlot(i);
    update({ mode: slot.mode, orbs: slot.orbs, image: slot.image || state.image });
  };

  const clearSlot = (i, e) => {
    e.preventDefault();
    const next = [...slots];
    next[i] = null;
    update({ slots: next });
  };

  return (
    <div className="appearance-slots">
      {Array.from({ length: 5 }).map((_, i) => {
        const slot = slots[i];
        const filled = !!slot;
        const previewBg = filled
          ? (slot.mode === 'orbs'
            ? buildOrbsBackground(slot.orbs)
            : slot.mode === 'image' && slot.image?.dataUrl
              ? `url(${slot.image.dataUrl}) center/cover no-repeat`
              : '#111')
          : 'rgba(255,255,255,0.04)';
        return (
          <button
            key={i}
            className={`appearance-slot ${filled ? 'filled' : ''}`}
            style={{ background: previewBg }}
            onClick={() => loadSlot(i)}
            onContextMenu={(e) => clearSlot(i, e)}
            title={filled ? `Slot ${i + 1} — click to load, right-click to clear` : `Slot ${i + 1} — click to save current`}
          >
            {!filled && <span>{i + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────── MAIN ───────────────────────
export default function AppearanceSettings() {
  const [state, update] = useAppearanceState();

  const setMode = (mode) => update({ mode });

  return (
    <div>
      <SettingsSection
        title="Background"
        description="Choose how the dashboard background looks. Changes are saved per-browser and applied immediately."
      >
        <SettingsCard glass>
          <div className="appearance-tabs">
            <button
              className={`appearance-tab ${state.mode === 'quox' ? 'active' : ''}`}
              onClick={() => setMode('quox')}
            >
              Quox Colours
            </button>
            <button
              className={`appearance-tab ${state.mode === 'image' ? 'active' : ''}`}
              onClick={() => setMode('image')}
            >
              Image
            </button>
            <button
              className={`appearance-tab ${state.mode === 'orbs' ? 'active' : ''}`}
              onClick={() => setMode('orbs')}
            >
              Custom Orbs
            </button>
          </div>

          <div className="appearance-panes">
            {state.mode === 'quox' && <QuoxTab />}
            {state.mode === 'image' && <ImageTab state={state} update={update} />}
            {state.mode === 'orbs' && <OrbsTab state={state} update={update} />}
          </div>

          <div className="appearance-footer">
            <button className="appearance-btn" onClick={resetAppearance}>
              Reset to default
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
