import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/query/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: false,
  sourcemap: true,
  minify: true,
  external: ['react', 'react-dom', 'marc-stellar-sdk', '@tanstack/react-query'],
});