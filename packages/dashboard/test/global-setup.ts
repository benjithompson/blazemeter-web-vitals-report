// vitest globalSetup: build the report's inline browser bundle before any test runs.
// render.ts imports the generated module; see scripts/build-browser.ts.
import { buildBrowserBundle } from '../scripts/build-browser.ts';

export default async function setup(): Promise<void> {
  await buildBrowserBundle();
}
