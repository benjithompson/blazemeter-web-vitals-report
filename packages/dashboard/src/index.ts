// bzm-vitals-dashboard — generator, not viewer.
// Issue #2: fetch every Engine artifact for a master, extract namespaced by sessionId.
// Issue #5: the tracer bullet — fetch → extract → adapt → attribute →
//           aggregate crudely → embed → emit. #6–#9 replace the crude parts.

export * from './http.js';
export * from './api.js';
export * from './extract.js';
export * from './cache.js';
export * from './parse.js';
export * from './legacy-adapter.js';
export * from './attribute.js';
export * from './aggregate.js';
export * from './report.js';
export * from './render.js';
export { runCli, type RunCliOptions } from './cli.js';
