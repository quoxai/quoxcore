export const DEV_FALLBACK_ORG = {
  id: '01DEV000000000000000000002',
  name: 'Development Org',
  description: 'Default development organisation for testing',
  slug: 'dev',
  role: 'owner',
  member_count: 1,
  division_count: 0,
  team_count: 0,
  logo_url: null,
  membership: { role: 'owner' },
};

export const DEV_FALLBACK_SCOPE = {
  id: '01DEV000000000000000000002',
  name: 'Development Org',
  type: 'organization',
  org_id: '01DEV000000000000000000002',
};

export function isDevBypassEnabled() {
  return Boolean(
    import.meta.env.DEV
      && typeof window !== 'undefined'
      && window.localStorage?.getItem('quox_dev_bypass') === 'true'
  );
}

export function buildDevModeUser() {
  return {
    id: 'dev-user',
    email: 'dev@quox.local',
    display_name: 'Development User',
    is_dev_mode: true,
  };
}

export function isActiveDevMode(user = null) {
  return isDevBypassEnabled() || Boolean(user?.is_dev_mode);
}
