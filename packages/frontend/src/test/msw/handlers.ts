import { http, HttpResponse, type RequestHandler } from 'msw'

/**
 * Default API mocks shared by every test. Keep this list small: add
 * responses for a single test with `server.use(...)` inside that test.
 */
export const handlers: RequestHandler[] = [
  // The top bar's notification inbox (FMS-49) reads this on every screen with the shell: an empty one by default.
  http.get('/api/v1/notifications', () =>
    HttpResponse.json({ data: [], meta: { request_id: 'r-0', page: 1, page_size: 20, total_items: 0, total_pages: 0, unread_count: 0 } }),
  ),
]
