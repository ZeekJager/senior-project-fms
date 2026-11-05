import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import express, { type RequestHandler } from 'express';

// The API documentation page (FMS-65): Swagger UI on the committed docs/openapi.yaml, served by the backend at
// /api-docs outside production. The spec is the repo's file, not a generated copy, so the page cannot drift from
// it; and the routes are compared with the spec in CI (test/integration/openapi.test.ts).

/** Production serves no documentation page: the spec is committed, and the API's callers know it. */
export const apiDocsEnabledFor = (nodeEnv: string) => nodeEnv !== 'production';

/** docs/openapi.yaml, found by walking up from `from` (the source tree and a build sit at different depths). Null when absent. */
export function findSpec(from: string = __dirname): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'docs', 'openapi.yaml');
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Where swagger-ui-dist's static files are, or null when the package is not installed (a production image has no dev dependencies). */
function findUi(): string | null {
  try {
    return path.dirname(createRequire(__filename).resolve('swagger-ui-dist/package.json'));
  } catch {
    return null;
  }
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fleet Management System API</title>
    <link rel="stylesheet" href="/api-docs/swagger-ui.css" />
    <link rel="icon" type="image/png" href="/api-docs/favicon-32x32.png" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/api-docs/swagger-ui-bundle.js"></script>
    <script src="/api-docs/init.js"></script>
  </body>
</html>
`;

// "Try it out" calls the API from this origin. The session is the HttpOnly cookie set by POST /auth/login, which the
// page sends like any other (credentials: include), so sign in with that operation first.
const INIT = `window.ui = SwaggerUIBundle({
  url: '/api-docs/openapi.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  tagsSorter: 'alpha',
  requestInterceptor: function (request) {
    request.credentials = 'include';
    return request;
  },
});
`;

/**
 * The page, the spec and Swagger UI's files, for `app.use('/api-docs', ...)`. Plain middleware, not routes: the
 * documentation is not part of the API it documents, so the route check (openapi.test.ts) does not list it.
 * Null when the spec or the UI package cannot be found, so the app starts without a page rather than not at all.
 */
export function apiDocs(specPath: string | null = findSpec(), uiDir: string | null = findUi()): RequestHandler | null {
  if (!specPath || !uiDir) return null;
  const files = express.static(uiDir, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') });
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path === '/' || req.path === '') return void res.type('html').set('Cache-Control', 'no-cache').send(PAGE);
    if (req.path === '/init.js') return void res.type('js').set('Cache-Control', 'no-cache').send(INIT);
    if (req.path === '/openapi.yaml') return void res.type('application/yaml').set('Cache-Control', 'no-cache').sendFile(specPath);
    return files(req, res, next);
  };
}
