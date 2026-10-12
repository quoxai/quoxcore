/**
 * Vite plugin: `virtual:quox-frame-deps` (GRIPE-701).
 *
 * Bundles src/services/frameDeps/entry.js (react, react-dom, jsx-runtime,
 * react-router-dom) into ONE minified classic-script IIFE with esbuild at build
 * time and exports it as a string. pluginFrameHost inlines that string into the
 * sandboxed plugin frame; no runtime fetch, no host object crosses the boundary.
 * Version-locked to package.json because it resolves from the same node_modules.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'src', 'services', 'frameDeps', 'entry.js');
const VIRTUAL = 'virtual:quox-frame-deps';
const RESOLVED = '\0' + VIRTUAL;

/** Build the IIFE string (shared by the Vite plugin and the node-run browser smokes). */
export async function buildFrameDepsCode() {
    const result = await build({
        entryPoints: [ENTRY],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent',
    });
    // A literal `</script` inside the code would terminate the inline tag.
    return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

export default function frameDepsPlugin() {
    let cached = null;
    return {
        name: 'quox-frame-deps',
        resolveId(id) { return id === VIRTUAL ? RESOLVED : null; },
        async load(id) {
            if (id !== RESOLVED) return null;
            if (!cached) cached = await buildFrameDepsCode();
            return `export default ${JSON.stringify(cached)};`;
        },
    };
}
