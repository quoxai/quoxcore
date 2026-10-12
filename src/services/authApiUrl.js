function normalizePath(path = '') {
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

export function resolveAuthApiBase({ env = import.meta.env, location = globalThis?.window?.location } = {}) {
  const explicitBase = env?.VITE_AUTH_API_URL
    || (env?.VITE_AUTH_SERVICE_URL ? `${env.VITE_AUTH_SERVICE_URL.replace(/\/$/, '')}/api` : null)
    || 'http://localhost:3101/api';

  if (location) {
    const protocol = location.protocol || '';
    const hostname = location.hostname || '';
    const isRemoteBrowser = protocol === 'https:' || !['localhost', '127.0.0.1'].includes(hostname);

    if (isRemoteBrowser) {
      return '/api';
    }
  }

  if (env?.DEV) {
    return explicitBase;
  }

  return '/api';
}

export function buildAuthApiUrl(path, options = {}) {
  return `${resolveAuthApiBase(options)}${normalizePath(path)}`;
}
