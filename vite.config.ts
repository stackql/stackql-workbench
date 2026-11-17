/// <reference types="vitest/config" />
import process from 'node:process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server exists only under `tauri dev`. It binds to loopback and the
// built app does not use it: bundled assets load through the Tauri asset
// protocol with no listener.
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Rust compiler output visible in the `tauri dev` terminal.
  clearScreen: false,
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    // Tauri is configured with a fixed devUrl, so fail if the port is taken.
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WebView2 on Windows, WKWebView on macOS.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome111' : 'safari16.4',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
