import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    inspectAttr(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-180.png'],
      manifest: {
        name: 'Takes — record. trim. share.',
        short_name: 'Takes',
        description: 'A fast, neutral vertical-video recorder and clip editor. No account, no watermark.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // ffmpeg.wasm cores (32MB) are too big for precache — cache at runtime
        globIgnores: ['**/ffmpeg/**', '**/ffmpeg-mt/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/(ffmpeg|ffmpeg-mt|ffesm)\/.*\.(js|wasm)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'ffmpeg-core', expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  // COOP/COEP allow explicit local testing of the experimental multithreaded
  // ffmpeg core with VITE_ENABLE_FFMPEG_MT=true. Production uses the verified
  // single-threaded core unless that flag is deliberately enabled at build.
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
