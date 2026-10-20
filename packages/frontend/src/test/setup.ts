// Runs before every frontend test file.
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { server } from './msw/server'

// findBy*/waitFor wait up to 3s (default 1s): whole-screen tests that render a
// page, its queries and the shell can need more under a full parallel run.
configure({ asyncUtilTimeout: 3000 })

// Any request without a handler fails the test, so a test never reaches a
// real backend by accident.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
// jsdom has no IndexedDB (fake-indexeddb/auto adds it); the driver app keeps
// its offline queue there (FMS-81). Each test starts with an empty one.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})
afterEach(() => {
  server.resetHandlers()
  cleanup()
})
afterAll(() => server.close())
