/**
 * Entry for the FRAME-LOCAL shared-deps IIFE (GRIPE-701).
 *
 * Bundled to a single classic-script IIFE at build time by
 * scripts/vite-plugin-frame-deps.mjs and inlined into the sandboxed plugin frame
 * BEFORE the plugin bundle. Plugin bundles read React & co off
 * window.__quoxSharedDeps; in the opaque-origin frame the parent's object does not
 * exist (and must never be passed in), so the frame gets its OWN copy of the
 * runtime, identical in version to the dashboard's package.json.
 *
 * Host-only surfaces (contexts, licensing, capability panels, glass components)
 * are stubs that throw a clear error only when USED, never when merely
 * destructured, so a bundle that destructures them at load still registers.
 */
import * as React from 'react';
import * as ReactDOMBase from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import * as ReactRouterDOM from 'react-router-dom';

// Same shape as the host: react-dom/client plus the react-dom named exports
// (createPortal, flushSync) so either import style resolves.
const ReactDOM = Object.assign({}, ReactDOMBase, ReactDOMClient);

function hostOnlyStub(name) {
    const msg = `[quox-plugin] ${name} is not available in isolated plugins; use window.quox RPC instead`;
    const thrower = () => { throw new Error(msg); };
    return new Proxy(Object.create(null), {
        // Property reads hand back a function that throws when CALLED / rendered.
        get(_t, prop) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
            return thrower;
        },
        has: () => true,
    });
}

const deps = {
    React,
    ReactDOM,
    ReactRouterDOM,
    ReactJSXRuntime,
    CapabilityPanels: hostOnlyStub('CapabilityPanels'),
    WorkspaceContext: hostOnlyStub('WorkspaceContext'),
    AuthContext: hostOnlyStub('AuthContext'),
    LicenseValidator: hostOnlyStub('LicenseValidator'),
    ServerSyncQueue: hostOnlyStub('ServerSyncQueue'),
    OrgScopedStorage: hostOnlyStub('OrgScopedStorage'),
};

window.__quoxSharedDeps = deps;
window.__quoxGlass = hostOnlyStub('@quox/glass');
