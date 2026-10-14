/**
 * Imported FIRST by the shipped bins (bin/quox.js, bin/quoxon.js), before anything that loads React: ES modules
 * evaluate in import order, and React picks its build from NODE_ENV when it is first loaded. The development
 * build roughly doubles CPU per animation frame (measured: ~51% vs 12-30% at 12 fps, 100x40). An explicit
 * NODE_ENV (a developer's, or a test runner's) is always kept.
 */
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
