import type { RequestHandler } from 'msw'

/**
 * Default API mocks shared by every test. Keep this list small: add
 * responses for a single test with `server.use(...)` inside that test.
 */
export const handlers: RequestHandler[] = []
