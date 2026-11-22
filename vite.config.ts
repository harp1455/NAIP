import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // CI 빌드 번호 (로컬 빌드는 0) — 앱의 업데이트 확인이 릴리스의 번호와 비교한다
    __BUILD__: JSON.stringify(Number(process.env.NAIP_BUILD_NUMBER ?? 0))
  },
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', target: 'es2022' }
})
