import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/helpers/setup.js'],
    include: ['tests/**/*.test.js'],
    exclude: ['tests/personal/**', 'tests/agents/**', 'node_modules/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['index.js', 'indexer.js', 'search.js', 'contacts.js', 'lib/**/*.js'],
      exclude: ['node_modules/**', 'tests/**', 'scripts/**']
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
})
