// Integration-test setup file: wraps every test in a rolled-back transaction.
import { afterAll, afterEach, beforeEach } from 'vitest';
import { pool } from '../../src/db';
import { installTransactionalPool } from './transactional-pool';

const tx = installTransactionalPool(pool);

beforeEach(() => tx.begin());
afterEach(() => tx.rollback());
afterAll(() => pool.end());
