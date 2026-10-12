/**
 * Docker Scanner
 */

const { readFile } = require('fs/promises');
const { existsSync } = require('fs');
const { join } = require('path');

async function scanDocker(rootPath) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  let composePath = null;
  for (const f of composeFiles) {
    const p = join(rootPath, f);
    if (existsSync(p)) { composePath = p; break; }
  }
  if (!composePath) return { services: [], profiles: [], volumes: [] };

  const content = await readFile(composePath, 'utf8');
  const services = [];
  const profiles = new Set();
  const volumes = [];

  const lines = content.split('\n');
  let inServices = false;
  let currentService = null;
  let inPorts = false;
  let inVolumes = false;
  let inProfiles = false;

  for (const line of lines) {
    const stripped = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    if (indent === 0 && stripped.match(/^services:/)) { inServices = true; continue; }
    if (indent === 0 && stripped.match(/^[a-z]/) && !stripped.match(/^services:/)) { inServices = false; continue; }
    if (!inServices) continue;

    if (indent === 2 && stripped.match(/^\s+[\w-]+:\s*$/)) {
      const name = stripped.trim().replace(':', '');
      currentService = { name, port: null, containerName: null, healthEndpoint: null, profile: null, volumeMounts: [] };
      services.push(currentService);
      inPorts = false; inVolumes = false; inProfiles = false;
      continue;
    }

    if (!currentService) continue;

    if (indent === 4) {
      inPorts = false; inVolumes = false; inProfiles = false;
      if (stripped.includes('container_name:')) {
        currentService.containerName = stripped.split(':').slice(1).join(':').trim().replace(/['"]/g, '');
      }
      if (stripped.trim() === 'ports:') { inPorts = true; continue; }
      if (stripped.trim() === 'volumes:') { inVolumes = true; continue; }
      if (stripped.trim() === 'profiles:') { inProfiles = true; continue; }
    }

    if (indent >= 6 && stripped.trim().startsWith('-')) {
      const value = stripped.trim().replace(/^-\s*/, '').replace(/['"]/g, '');
      if (inPorts && currentService) {
        const portMatch = value.match(/(\d+):(\d+)/);
        if (portMatch) currentService.port = parseInt(portMatch[1], 10);
      }
      if (inVolumes && currentService) {
        currentService.volumeMounts.push(value);
        volumes.push({ service: currentService.name, mount: value });
      }
      if (inProfiles && currentService) {
        currentService.profile = value;
        profiles.add(value);
      }
    }
  }

  return {
    services: services.map((s) => ({
      name: s.name,
      port: s.port,
      containerName: s.containerName,
      healthEndpoint: s.healthEndpoint,
      profile: s.profile,
      hasVolumeMounts: s.volumeMounts.length > 0,
    })),
    profiles: [...profiles],
    volumes,
  };
}

module.exports = { scanDocker };
