// bzm-vitals-dashboard — generator, not viewer.
// The pipeline: fetch every Engine's artifacts.zip for a master (or read local
// artifacts) → read its records lazily in memory, namespaced by sessionId →
// parse and adapt legacy records → attribute → aggregate → embed one data blob
// → emit one self-contained HTML file. Nothing is extracted to disk; --extract
// is a debugging aid only (extract.ts).

export * from './http.js';
export * from './api.js';
export * from './zip.js';
export * from './extract.js';
export * from './cache.js';
export * from './parse.js';
export * from './legacy-adapter.js';
export * from './attribute.js';
export * from './aggregate.js';
export * from './report.js';
export * from './local.js';
export * from './render.js';
export { runCli, type RunCliOptions } from './cli.js';
