import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'example-tools/index': 'src/example-tools/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  // tsup auto-externalizes peerDependencies + dependencies; listing here is
  // belt-and-suspenders so a future refactor doesn't silently inline them.
  external: [
    '@btx-tools/challenges-sdk',
    '@modelcontextprotocol/sdk',
    'zod',
  ],
});
