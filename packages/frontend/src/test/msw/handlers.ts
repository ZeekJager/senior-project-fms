import { http, HttpResponse, type RequestHandler } from 'msw'
import { SETTING_DEFAULTS, type Setting } from '@/features/settings'

const UNITS = { fuel_variance_threshold_pct: 'percent', health_alert_below: 'score', expiry_warning_days: 'days' } as const
const RANGES = { fuel_variance_threshold_pct: [1, 100], health_alert_below: [50, 84], expiry_warning_days: [8, 180] } as const

/** GET /settings with every setting at its default. */
export const DEFAULT_SETTINGS: Setting[] = (Object.keys(SETTING_DEFAULTS) as (keyof typeof SETTING_DEFAULTS)[]).map((key) => ({
  key,
  value: SETTING_DEFAULTS[key],
  default_value: SETTING_DEFAULTS[key],
  is_default: true,
  unit: UNITS[key],
  min: RANGES[key][0],
  max: RANGES[key][1],
  updated_by: null,
  updated_by_name: null,
  updated_at: null,
}))

/**
 * Default API mocks shared by every test. Keep this list small: add
 * responses for a single test with `server.use(...)` inside that test.
 */
export const handlers: RequestHandler[] = [
  // The top bar's notification inbox (FMS-49) reads this on every screen with the shell: an empty one by default.
  http.get('/api/v1/notifications', () =>
    HttpResponse.json({ data: [], meta: { request_id: 'r-0', page: 1, page_size: 20, total_items: 0, total_pages: 0, unread_count: 0 } }),
  ),
  // Settings (FMS-80): health badges read the alert line from them. The defaults, never changed.
  http.get('/api/v1/settings', () => HttpResponse.json({ data: DEFAULT_SETTINGS, meta: { request_id: 'r-0' } })),
]
