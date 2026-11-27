/**
 * src/project/convert.ts 브라우저 점검 — 캔버스·OffscreenCanvas·워커가 필요해 Chromium에서 돌린다.
 *
 *   node tests/convert.browser.cjs            # vite 개발 서버
 *   node tests/convert.browser.cjs --preview  # 실제 빌드(워커 번들 포함) → vite preview
 *
 * 포트 4177에서 tests/convert-harness.html을 열고, 페이지의 runChecks() 결과를 확인한다.
 * playwright는 전역 설치본을 쓴다 (require('playwright'), NODE_PATH에 전역 node_modules가 있어야 함).
 */
const { chromium } = require('playwright')
const os = require('node:os')
const path = require('node:path')

async function startServer(root) {
  const vite = await import('vite')
  if (!process.argv.includes('--preview')) {
    const server = await vite.createServer({ root, server: { port: 4177, strictPort: true }, logLevel: 'error' })
    await server.listen()
    return () => server.close()
  }
  const outDir = path.join(os.tmpdir(), 'naip-convert-check')
  await vite.build({
    root,
    logLevel: 'error',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'tests/convert-harness.html') } }
  })
  const server = await vite.preview({ root, build: { outDir }, preview: { port: 4177, strictPort: true }, logLevel: 'error' })
  return () => new Promise((resolve) => server.httpServer.close(resolve))
}

async function main() {
  const close = await startServer(path.resolve(__dirname, '..'))
  const browser = await chromium.launch()
  let failed = 0
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('http://localhost:4177/tests/convert-harness.html')
    await page.waitForFunction(() => typeof window.runChecks === 'function', null, { timeout: 30000 })
    const checks = await page.evaluate(() => window.runChecks())
    for (const c of checks) {
      if (!c.ok) failed++
      console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`)
    }
    for (const e of errors) {
      failed++
      console.log(`FAIL page error — ${e}`)
    }
    console.log(`\n${checks.length - failed}/${checks.length} passed`)
  } finally {
    await browser.close()
    await close()
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
