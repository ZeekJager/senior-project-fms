import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/** Intercepts fetch in tests. Started and reset by src/test/setup.ts. */
export const server = setupServer(...handlers)
