import { afterEach } from 'vitest';
import { takeInstalledTracers } from './engine.js';

/*
 * `unit-traced` only: every span the existing engine tests started through the tracer
 * `makeEngine` installed must have ended exactly once, with no write after its end.
 */
afterEach(() => {
  for (const tracer of takeInstalledTracers()) tracer.assertAllEnded();
});
