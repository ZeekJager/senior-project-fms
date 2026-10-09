const rule = require('../rules/no-cross-module-import');
const { tsRuleTester, backend } = require('./rule-tester');

const trip = backend('src/modules/trip/application/plan-trip.ts');
const tripApi = backend('src/modules/trip/api/trip.routes.ts');

tsRuleTester().run('no-cross-module-import', rule, {
  valid: [
    // Another module through its index (AC: importing modules/maintenance passes).
    { filename: trip, code: "import { scheduleService } from '../../maintenance';" },
    { filename: trip, code: "import { scheduleService } from '../../maintenance/index';" },
    { filename: trip, code: "import { scheduleService } from '../../maintenance/index.ts';" },
    { filename: tripApi, code: "import { authorize } from '../../auth';" },
    // Anything inside the module's own folder.
    { filename: trip, code: "import { Trip } from '../domain/trip';" },
    { filename: tripApi, code: "import { TripRepository } from '../infrastructure/trip.repository';" },
    // Shared code, config and packages.
    { filename: trip, code: "import { AppError } from '../../../shared/errors/app-error';" },
    { filename: trip, code: "import { config } from '../../../config';" },
    { filename: trip, code: "import { Router } from 'express';" },
    // The composition root and app code outside any module are not checked.
    { filename: backend('src/modules/index.ts'), code: "import { tripModule } from './trip';" },
    { filename: backend('src/app.ts'), code: "import { authenticate } from './modules/auth/api/authenticate';" },
    { filename: backend('test/integration/x.test.ts'), code: "import { TokenService } from '../../src/modules/auth/application/token.service';" },
    // Shared code importing shared code.
    { filename: backend('src/shared/http/route-access.ts'), code: "import { AppError } from '../errors/app-error';" },
  ],
  invalid: [
    // AC: importing modules/maintenance/domain/x.ts from modules/trip fails.
    {
      filename: trip,
      code: "import { x } from '../../maintenance/domain/x';",
      errors: [{ messageId: 'deepImport', data: { from: 'trip', spec: '../../maintenance/domain/x', to: 'maintenance' } }],
    },
    { filename: trip, code: "import { x } from '../../maintenance/domain/x.ts';", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "import type { Part } from '../../maintenance/domain/part';", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "export { x } from '../../maintenance/infrastructure/repo';", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "export * from '../../maintenance/application/service';", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "const m = await import('../../maintenance/domain/x');", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "const m = require('../../maintenance/domain/x');", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "import m = require('../../maintenance/domain/x');", errors: [{ messageId: 'deepImport' }] },
    { filename: trip, code: "let p: import('../../maintenance/domain/x').Part;", errors: [{ messageId: 'deepImport' }] },
    // A module's own index is not a way in to another module's internals.
    { filename: trip, code: "import { x } from '../../auth/infrastructure/session.repository';", errors: [{ messageId: 'deepImport' }] },
    // Windows paths are normalised.
    {
      filename: 'C:\\repo\\packages\\backend\\src\\modules\\trip\\application\\plan-trip.ts',
      code: "import { x } from '../../maintenance/domain/x';",
      errors: [{ messageId: 'deepImport' }],
    },
    // Shared code never imports a module, not even its index.
    {
      filename: backend('src/shared/http/route-access.ts'),
      code: "import { authorize } from '../../modules/auth';",
      errors: [{ messageId: 'sharedImportsModule', data: { spec: '../../modules/auth', to: 'auth' } }],
    },
  ],
});
