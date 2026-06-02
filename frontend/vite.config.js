import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        cookieDomainRewrite: 'localhost',
      },
      '/users': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
