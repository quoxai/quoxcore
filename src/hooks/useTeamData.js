/**
 * useTeamData Hook
 *
 * Loads team definitions and details for the Agentic Teams views.
 * Connects to the task service (port 3104) via authFetch.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { listTeams, getTeam } from '../services/teamService';
import { getBuiltInTeams } from '../config/teams/index';

export function useTeamData() {
  const { authFetch } = useAuth();
  const mountedRef = useRef(true);

  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadTeams = useCallback(async () => {
    // Always include built-in teams so they're visible regardless of task service state
    const builtIn = getBuiltInTeams();
    const builtInTeams = Object.values(builtIn).map(m => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      icon: m.icon,
      accentColor: m.accentColor,
      tier: m.tier,
      price: m.price,
      source: 'core',
      status: 'active',
      agentCount: (m.members?.length || 0) + 1,
      orchestratorId: m.orchestrator?.agentId,
      installed_at: null,
      manifest: m,
    }));

    try {
      setLoading(true);
      const data = await listTeams(authFetch);
      if (!mountedRef.current) return;
      // Merge: built-in teams first, then any custom/remote teams not already present
      const remoteTeams = (data.teams || []).filter(
        rt => !builtInTeams.some(bt => bt.id === rt.id)
      );
      setTeams([...builtInTeams, ...remoteTeams]);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // Task service unreachable — show built-in teams only
      setTeams(builtInTeams);
      setError(err.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    mountedRef.current = true;
    loadTeams();
    return () => { mountedRef.current = false; };
  }, [loadTeams]);

  return {
    teams,
    loading,
    error,
    refresh: loadTeams,
  };
}

export function useTeamDetail(teamId) {
  const { authFetch } = useAuth();
  const mountedRef = useRef(true);

  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadTeam = useCallback(async () => {
    if (!teamId) return;
    try {
      setLoading(true);
      const data = await getTeam(authFetch, teamId);
      if (!mountedRef.current) return;
      setTeam(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // Fallback: try built-in manifest
      const builtIn = getBuiltInTeams();
      if (builtIn[teamId]) {
        setTeam({
          id: teamId,
          source: 'core',
          status: 'active',
          manifest: builtIn[teamId],
        });
        setError(null);
      } else {
        setError(err.message);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [authFetch, teamId]);

  useEffect(() => {
    mountedRef.current = true;
    loadTeam();
    return () => { mountedRef.current = false; };
  }, [loadTeam]);

  return {
    team,
    loading,
    error,
    refresh: loadTeam,
  };
}
