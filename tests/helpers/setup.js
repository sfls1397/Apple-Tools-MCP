
import { beforeAll } from 'vitest'

process.env.APPLE_TOOLS_INDEX_DAYS_BACK = process.env.APPLE_TOOLS_INDEX_DAYS_BACK || '30'

beforeAll(() => {
  if (!process.env.HOME) {
    throw new Error('HOME environment variable must be set for real data tests')
  }
})
