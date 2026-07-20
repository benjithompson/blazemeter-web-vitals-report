// The one place the enabled sink set is assembled from the environment. The pusher fans out
// to whatever this returns, with per-destination failure isolation — so BlazeMeter and
// InfluxDB coexist: configure both and every Sample lands in both, configure one and only
// it runs, configure neither (the local path) and the whole push subsystem stays inert.
//
// Each sink re-checks its own isEnabled() inside the pusher, so returning a disabled one is
// harmless — but we keep the set tight and only include the live ones. A future sink is one
// more entry here and nothing else.

import type { Destination } from './pusher.js';
import { BlazeMeterDestination, type BlazeMeterDeps } from './blazemeter-destination.js';
import { InfluxDestination, type InfluxDeps } from './influx-destination.js';

export function createDestinationsFromEnv(deps: BlazeMeterDeps & InfluxDeps = {}): Destination[] {
  const candidates: Destination[] = [
    new BlazeMeterDestination(deps),
    new InfluxDestination(deps),
  ];
  return candidates.filter((d) => d.isEnabled());
}
