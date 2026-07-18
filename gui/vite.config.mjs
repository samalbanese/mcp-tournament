import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig(({ command }) => ({
  base: './',
  root: command === 'build' ? '.vite-src' : '.',
  publicDir: command === 'build' ? '../public' : 'public',
  esbuild: command === 'build' ? false : undefined,
  build: {
    outDir: command === 'build' ? '../dist' : 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    cssMinify: false,
    rollupOptions: { input: command === 'build' ? path.resolve('.vite-src/index.html') : undefined },
  },
}));