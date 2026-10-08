import { describe, expect, it } from 'vitest';
import type { RequestUser } from '../../types/express';
import { depotScope, ownDriverScope, scopeClause } from './scope';

const user = (roles: string[], depotId: string | null = '7'): RequestUser => ({
  id: '42',
  publicId: '00000000-0000-4000-8000-000000000042',
  roles,
  permissions: [],
  depotId,
});

describe('depotScope', () => {
  it.each(['admin', 'fleet_manager', 'fleet_owner', 'compliance_officer'])('%s sees every depot', (role) => {
    expect(depotScope(user([role], null))).toEqual({ kind: 'all' });
    expect(depotScope(user([role], '7'))).toEqual({ kind: 'all' });
  });

  it.each(['dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk'])('%s is limited to their depot', (role) => {
    expect(depotScope(user([role], '7'))).toEqual({ kind: 'depot', depotId: '7' });
  });

  it('fails closed: a depot-scoped user with no depot sees nothing, not everything', () => {
    expect(depotScope(user(['dispatcher'], null))).toEqual({ kind: 'none' });
  });

  it('fails closed for an anonymous caller or an unknown role', () => {
    expect(depotScope(undefined)).toEqual({ kind: 'none' });
    expect(depotScope({ ...user([]), id: null })).toEqual({ kind: 'none' });
    expect(depotScope(user(['some_new_role'], null))).toEqual({ kind: 'none' });
  });

  it('lets the broadest role win for a user with several', () => {
    expect(depotScope(user(['dispatcher', 'admin'], '7'))).toEqual({ kind: 'all' });
  });
});

describe('ownDriverScope', () => {
  it('limits a driver to their own records', () => {
    expect(ownDriverScope(user(['driver']))).toEqual({ kind: 'own', userId: '42' });
  });

  it('does not limit anyone who holds another role as well', () => {
    expect(ownDriverScope(user(['driver', 'dispatcher']))).toEqual({ kind: 'all' });
    expect(ownDriverScope(user(['dispatcher']))).toEqual({ kind: 'all' });
    expect(ownDriverScope(user(['admin']))).toEqual({ kind: 'all' });
  });

  it('gives an anonymous caller nothing', () => {
    expect(ownDriverScope(undefined)).toEqual({ kind: 'none' });
  });
});

describe('scopeClause', () => {
  it('builds a parameterised condition for each scope', () => {
    expect(scopeClause({ kind: 'all' }, 'v.depot_id', 2)).toEqual({ sql: 'TRUE', params: [] });
    expect(scopeClause({ kind: 'depot', depotId: '7' }, 'v.depot_id', 2)).toEqual({ sql: 'v.depot_id = $2', params: ['7'] });
    expect(scopeClause({ kind: 'own', userId: '42' }, 'user_id', 1)).toEqual({ sql: 'user_id = $1', params: ['42'] });
    expect(scopeClause({ kind: 'none' }, 'depot_id', 1)).toEqual({ sql: 'FALSE', params: [] });
  });

  it('never puts a value in the SQL text', () => {
    const { sql } = scopeClause({ kind: 'depot', depotId: "7'; DROP TABLE x; --" }, 'depot_id', 1);
    expect(sql).toBe('depot_id = $1');
  });

  it.each(["depot_id; DROP TABLE x", 'a b', '"depot_id"', '1depot', '', 'a.b.c'])('rejects the column %j', (column) => {
    expect(() => scopeClause({ kind: 'all' }, column, 1)).toThrow(/Invalid column/);
  });
});
