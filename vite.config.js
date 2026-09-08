import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: ao publicar uma versão nova, o service worker troca
      // sozinho na próxima abertura. O usuário não precisa reinstalar.
      registerType: 'autoUpdate',
      // Deixa o PWA testável com `npm run dev`; em produção funciona igual.
      devOptions: { enabled: true },
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'REPLA — Áurea Barbearia',
        short_name: 'Áurea',
        description: 'Agende seu horário na Áurea Barbearia',
        theme_color: '#171310',
        background_color: '#171310',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'pt-BR',
        orientation: 'portrait',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            // O Android recorta este em círculo/squircle conforme o aparelho,
            // por isso ele tem margem maior e fundo preenchido.
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Toda navegação cai no index.html — o app é uma página só.
        navigateFallback: 'index.html',
        // As chamadas ao Supabase NUNCA podem ser servidas do cache: agenda e
        // horários livres precisam ser sempre os dados atuais do banco.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co'),
            handler: 'NetworkOnly',
          },
          {
            // As fontes do Google podem ser cacheadas com folga: não mudam.
            urlPattern: ({ url }) =>
              url.hostname === 'fonts.googleapis.com' ||
              url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'fontes-google',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
