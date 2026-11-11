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
  // 相对路径：既能部署在根路径，也能挂在飞牛网关的 /app/miscreen/ 下
  base: './',
  build: { target: 'es2022' },
});
