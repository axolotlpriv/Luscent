/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Relative asset URLs so the same build works at a domain root (pages.dev)
  // and under a sub-path (github.io/<repo>/).
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
