import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 저장소 안에 생기는 에이전트 작업 폴더(.claude/worktrees)의 테스트는 돌리지 않는다
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'android/**']
  }
})
