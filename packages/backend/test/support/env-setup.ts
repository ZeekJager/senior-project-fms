// First integration setup file: the test environment must exist before
// transaction-per-test.ts imports the app (whose config reads it on import).
import { applyTestEnv } from './test-env';

applyTestEnv();
