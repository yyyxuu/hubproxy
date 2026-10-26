import { defineConfig } from 'vitest/config'

// Vitest 配置：node 环境运行 test/ 目录下的测试
// （Worker 逻辑通过 buildHandler 依赖注入 fetch，因此无需 Workers 运行时即可测试）
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
