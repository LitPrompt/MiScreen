import { defineConfig } from 'vite';

// 开发时：npm run dev:server（后端 8080）+ npm run dev:web（前端 5173，代理到后端）
export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { target: 'es2022' },
});
