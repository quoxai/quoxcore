/**
 * Plugin loader for QuoxCLI
 *
 * Discovers and loads plugins from:
 *   1. ~/.quox/plugins/  (user plugins)
 *   2. QUOX_PLUGIN_DIR env var (custom path)
 *
 * Plugin format: each plugin is a directory with an index.js that exports:
 *   { name, version, description, register(program, context) }
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

function getPluginDirs() {
  const dirs = [join(homedir(), '.quox', 'plugins')];
  if (process.env.QUOX_PLUGIN_DIR) {
    dirs.push(process.env.QUOX_PLUGIN_DIR);
  }
  return dirs;
}

export async function discoverPlugins() {
  const plugins = [];

  for (const dir of getPluginDirs()) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const pluginPath = join(dir, entry);
      if (!statSync(pluginPath).isDirectory()) continue;

      const indexPath = join(pluginPath, 'index.js');
      if (!existsSync(indexPath)) continue;

      plugins.push({
        name: entry,
        path: pluginPath,
        indexPath,
      });
    }
  }

  return plugins;
}

export async function loadPlugin(pluginInfo) {
  try {
    const moduleUrl = pathToFileURL(pluginInfo.indexPath).href;
    const mod = await import(moduleUrl);

    if (typeof mod.register !== 'function') {
      throw new Error(`Plugin "${pluginInfo.name}" does not export a register() function`);
    }

    return {
      name: mod.name || pluginInfo.name,
      version: mod.version || '0.0.0',
      description: mod.description || '',
      register: mod.register,
    };
  } catch (err) {
    return {
      name: pluginInfo.name,
      error: err.message,
    };
  }
}

export async function loadAllPlugins(program, context) {
  const discovered = await discoverPlugins();
  const loaded = [];
  const errors = [];

  for (const pluginInfo of discovered) {
    const plugin = await loadPlugin(pluginInfo);
    if (plugin.error) {
      errors.push({ name: plugin.name, error: plugin.error });
    } else {
      try {
        plugin.register(program, context);
        loaded.push({ name: plugin.name, version: plugin.version, description: plugin.description });
      } catch (err) {
        errors.push({ name: plugin.name, error: err.message });
      }
    }
  }

  return { loaded, errors };
}
