import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { flattenStreams } from '../lib/format.js';
import { usePersistedString } from '../lib/viewPrefs.js';
import { buildScopeOptions } from '../lib/scopeOptions.js';

const RoadmapContext = createContext(null);

const HEALTH_POLL_MS = 30000;

/**
 * The `:roadmapId` path segment straight off the pathname (no useParams()
 * needed — this runs inside RoadmapProvider, which sits ABOVE the routed
 * `:roadmapId` Routes as their shared ancestor, see QuoxPlanView.jsx). Same
 * regex as useCurrentRoadmapId's own pathId fallback below.
 */
function pathRoadmapId(pathname) {
  const m = pathname.match(/\/quoxplan\/([^/]+)/);
  return m && m[1] !== 'streams' ? m[1] : null;
}

export function RoadmapProvider({ children }) {
  const [roadmaps, setRoadmaps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState({ ok: null, version: null });
  const [lastRoadmapId, setLastRoadmapId] = useState(null);

  // roadmapId -> flat stream array (lens=all), for the command palette search
  // index. Fetched once per roadmap per session, kept in memory only.
  const streamIndexCache = useRef(new Map());

  // QUOXPLAN-P5: division/department scope selector. `scopes` is the org's
  // raw scope list (auth service via the collector's quoxplan-meta proxy,
  // [] in the standalone dummy-data harness — see lib/api.js#getScopes),
  // fetched once. `activeScope` is persisted PER ROADMAP (the owner's
  // explicit requirement: selection is always visible, and a division
  // filter chosen on one roadmap shouldn't silently carry over to another).
  const [scopes, setScopes] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getScopes()
      .then((data) => {
        if (!cancelled) setScopes(data.scopes || []);
      })
      .catch(() => {
        if (!cancelled) setScopes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const scopeOptions = useMemo(() => buildScopeOptions(scopes), [scopes]);

  const location = useLocation();
  const activeRoadmapId = pathRoadmapId(location.pathname) || lastRoadmapId || roadmaps[0]?.id || null;
  const [activeScope, setActiveScope] = usePersistedString(
    activeRoadmapId ? `quoxplan.scope.${activeRoadmapId}` : 'quoxplan.scope.__none__',
    null
  );

  useEffect(() => {
    let cancelled = false;
    api
      .listRoadmaps()
      .then((data) => {
        if (cancelled) return;
        setRoadmaps(data.roadmaps);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const h = await api.health();
        if (!cancelled) setHealth({ ok: !!h.ok, version: h.version });
      } catch {
        if (!cancelled) setHealth({ ok: false, version: null });
      }
    }
    poll();
    const id = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const getStreamIndex = useCallback(async (roadmapId) => {
    if (streamIndexCache.current.has(roadmapId)) {
      return streamIndexCache.current.get(roadmapId);
    }
    const data = await api.listStreams(roadmapId, 'all');
    const flat = flattenStreams(data.streams);
    streamIndexCache.current.set(roadmapId, flat);
    return flat;
  }, []);

  /**
   * Forces a fresh GET /api/v1/roadmaps and updates `roadmaps` in place.
   * Needed after the onboarding wizard creates a roadmap: without this,
   * RoadmapRouteGuard wouldn't recognise the new id (roadmaps is otherwise
   * only fetched once, on mount) and would bounce the navigate() straight
   * back to roadmaps[0].
   */
  const refreshRoadmaps = useCallback(async () => {
    const data = await api.listRoadmaps({ force: true });
    setRoadmaps(data.roadmaps);
    return data.roadmaps;
  }, []);

  const value = {
    roadmaps,
    loading,
    error,
    health,
    lastRoadmapId,
    setLastRoadmapId,
    getStreamIndex,
    refreshRoadmaps,
    scopeOptions,
    activeScope,
    setActiveScope
  };

  return <RoadmapContext.Provider value={value}>{children}</RoadmapContext.Provider>;
}

export function useRoadmapCtx() {
  const ctx = useContext(RoadmapContext);
  if (!ctx) throw new Error('useRoadmapCtx must be used inside a RoadmapProvider');
  return ctx;
}

/**
 * Resolves "the roadmap we're currently looking at": the `:roadmapId` route
 * param when present, otherwise the last one visited (so the sidebar/topbar
 * stay oriented on roadmap-agnostic routes like /streams/:streamId), falling
 * back to the first roadmap once the list has loaded.
 */
export function useCurrentRoadmapId() {
  const { roadmapId: paramId } = useParams();
  const { pathname } = useLocation();
  const { roadmaps, lastRoadmapId, setLastRoadmapId } = useRoadmapCtx();

  // The view header renders OUTSIDE the `:roadmapId` route element, where
  // useParams() cannot see the param; derive it from the path so the
  // switcher label tracks deep links (`/quoxplan/streams/...` excluded).
  const roadmapId = paramId || pathRoadmapId(pathname);

  useEffect(() => {
    if (roadmapId) setLastRoadmapId(roadmapId);
  }, [roadmapId, setLastRoadmapId]);

  return roadmapId || lastRoadmapId || roadmaps[0]?.id || null;
}
