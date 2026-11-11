import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // stripInternal keeps members marked `@internal` (CacheEvents.emit, sinkFor) out of the
  // published declarations.
  dts: { compilerOptions: { stripInternal: true } },
  target: 'node22',
  clean: true,
  sourcemap: true,
});
