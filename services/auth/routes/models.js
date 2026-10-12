/**
 * REG-3: Model registry routes.
 *
 * GET    /api/models              — list active models (org-scoped filtering TBD)
 * GET    /api/models/:modelId     — detail for one model
 * POST   /api/models              — admin-only: register a new model
 * PATCH  /api/models/:modelId     — admin-only: update (risk_tier, status, etc.)
 *
 * Keeps models queryable via API so the plugin + compliance UIs can render
 * inventory, risk tier, data residency, and deprecation state without
 * reading static JS config.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { createModel, getModel, listModels, updateModel } from '../lib/reg.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const { provider, include_deprecated } = req.query;
    const models = listModels(db, {
      provider: provider || undefined,
      includeDeprecated: include_deprecated === 'true',
    });
    res.json({ success: true, data: models });
  } catch (err) {
    console.error('[models] list failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:modelId', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const model = getModel(db, req.params.modelId);
    if (!model) return res.status(404).json({ success: false, error: 'Model not found' });
    res.json({ success: true, data: model });
  } catch (err) {
    console.error('[models] get failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', requireAuth, (req, res) => {
  try {
    if (!req.user || req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin role required' });
    }
    const db = getDb();
    const model = createModel(db, { ...req.body, is_core: 0 });
    res.status(201).json({ success: true, data: model });
  } catch (err) {
    console.error('[models] create failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.patch('/:modelId', requireAuth, (req, res) => {
  try {
    if (!req.user || req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin role required' });
    }
    const db = getDb();
    const existing = getModel(db, req.params.modelId);
    if (!existing) return res.status(404).json({ success: false, error: 'Model not found' });
    const updated = updateModel(db, req.params.modelId, req.body);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[models] update failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
