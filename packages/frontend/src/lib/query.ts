import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api/errors'

/**
 * Server state for the whole app. Query functions call `api.request`, so
 * failures arrive as ApiError carrying the contract's error code. A 4xx is
 * the server's final answer and is not retried; network and 5xx failures are.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      },
      mutations: { retry: false },
    },
  })
}
