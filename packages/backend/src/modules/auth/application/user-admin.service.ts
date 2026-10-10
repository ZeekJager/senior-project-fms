import type { Pool, PoolClient } from 'pg';
import { createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { RequestUser } from '../../../types/express';
import type { UserStatus } from '../domain/auth-policy';
import type { DepotDirectory } from '../domain/depot-directory';
import {
  DEPOT_SCOPED_ROLES,
  RESET_TOKEN_TTL_SECONDS,
  SETUP_TOKEN_TTL_SECONDS,
  USER_ADMIN_EVENTS,
  depotRequired,
  emailTaken,
  lastAdmin,
  mayAssignRole,
  ownRolesForbidden,
  ownStatusForbidden,
  passwordProblem,
  passwordTokenInvalid,
  roleEscalation,
  unknownRole,
  userDepotNotFound,
  userNotFound,
  weakPassword,
  type PasswordTokenView,
  type RoleView,
  type UserView,
} from '../domain/user-admin';
import { writeAuthAudit } from '../infrastructure/auth-audit';
import { UNSET_HASH, hashPassword } from '../infrastructure/password-hasher';
import { newPasswordLink, passwordLinkHash } from '../infrastructure/password-link';
import type { AdminUserRow, RoleRow, UserAdminRepository } from '../infrastructure/user-admin.repository';

export interface AdminCaller {
  user: RequestUser;
  correlationId: string;
  ip?: string;
}

export interface UserCreate {
  email: string;
  full_name: string;
  phone?: string | null;
  depot_id?: string | null;
  roles: string[];
}

export interface UserUpdate {
  email?: string;
  full_name?: string;
  phone?: string | null;
  depot_id?: string | null;
  status?: UserStatus;
  roles?: string[];
}

export interface UserListQuery {
  page: number;
  page_size: number;
  search?: string;
  role?: string;
  status?: UserStatus;
  depot_id?: string;
}

export interface UserAdminDeps {
  db: Pool;
  users: UserAdminRepository;
  /** Depots live in the fleet module (provided through the composition root). */
  depots: Pick<DepotDirectory, 'publicIdOf' | 'resolveActive'>;
  events: EventBus;
  /** The account event other modules keep copies by (fleet.driver_accounts). */
  accountChangedEvent: string;
}

/**
 * User and role administration (FMS-78): onboarding without SQL. Admins
 * (users:write) create accounts, assign roles and deactivate them. Rules:
 * nobody grants a role carrying permissions they lack (and only an admin
 * grants admin), nobody changes their own roles or deactivates themselves,
 * the last active admin stays, and deactivating ends the user's sessions in
 * the same request. New accounts get a one-time link to set their password.
 */
export class UserAdminService {
  constructor(private readonly deps: UserAdminDeps) {}

  async list(query: UserListQuery): Promise<{ items: UserView[]; total: number }> {
    const { db, users, depots } = this.deps;
    let depotId: string | undefined;
    if (query.depot_id) {
      const resolved = await depots.resolveActive(query.depot_id);
      if (!resolved) return { items: [], total: 0 };
      depotId = resolved;
    }
    const { rows, total } = await users.list(db, { page: query.page, page_size: query.page_size, search: query.search, role: query.role, status: query.status, depotId });
    return { items: await Promise.all(rows.map((r) => this.view(r))), total };
  }

  async get(userId: string): Promise<UserView> {
    const row = await this.deps.users.findByPublicId(this.deps.db, userId);
    if (!row) throw userNotFound();
    return this.view(row);
  }

  async roles(): Promise<RoleView[]> {
    return (await this.deps.users.roles(this.deps.db)).map((r) => ({ name: r.name, description: r.description, permissions: r.permissions }));
  }

  /**
   * POST /users: the account (no password yet), its roles, and a setup link
   * valid 72 hours, returned once. One transaction; audited.
   */
  async create(caller: AdminCaller, input: UserCreate): Promise<{ user: UserView; passwordSetup: PasswordTokenView }> {
    const { db, users } = this.deps;
    const ctx = mutationContext(caller);
    const result = await withTransaction(db, async (client) => {
      const roleRows = await this.assignableRoles(client, caller, input.roles, []);
      const depotId = await this.resolveDepot(client, input.depot_id ?? null);
      requireDepotFor(input.roles, depotId);
      if (await users.emailTaken(client, input.email)) throw emailTaken();
      const row = await users.insertUser(ctx, client, {
        email: input.email,
        full_name: input.full_name,
        phone: input.phone ?? null,
        depot_id: depotId,
        password_hash: UNSET_HASH,
      });
      const userId = row.id as string;
      await users.setRoles(ctx, client, userId, roleRows.map((r) => r.id), [], input.roles);
      const link = newPasswordLink();
      const expiresAt = await users.issueToken(ctx, client, { userId, purpose: 'setup', tokenHash: link.hash, ttlSeconds: SETUP_TOKEN_TTL_SECONDS });
      return { row: await users.findById(client, userId), link: link.value, expiresAt };
    });
    const user = await this.view(result.row);
    await this.deps.events.publish([
      event(caller, USER_ADMIN_EVENTS.created, { user_id: user.id, roles: user.roles }),
      event(caller, this.deps.accountChangedEvent, { user_id: user.id }),
    ]);
    return { user, passwordSetup: { token: result.link, purpose: 'setup', expires_at: result.expiresAt } };
  }

  /**
   * PATCH /users/{id}: profile, home depot, status and roles. A status other
   * than active revokes every refresh session in the same transaction; the
   * user's next request already fails (authenticate reloads the account).
   */
  async update(caller: AdminCaller, userId: string, patch: UserUpdate): Promise<UserView> {
    const { db, users } = this.deps;
    const ctx = mutationContext(caller);
    const self = userId === caller.user.publicId;
    if (self && patch.roles !== undefined) throw ownRolesForbidden();
    if (self && patch.status !== undefined && patch.status !== 'active') throw ownStatusForbidden();

    const outcome = await withTransaction(db, async (client) => {
      const current = await users.lock(client, userId);
      if (!current) throw userNotFound();

      const roles = patch.roles ?? current.roles;
      const rolesChanged = patch.roles !== undefined && [...patch.roles].sort().join() !== [...current.roles].sort().join();
      await this.assertMayManage(client, caller, current.roles);
      const roleRows = rolesChanged ? await this.assignableRoles(client, caller, patch.roles!, current.roles) : [];

      const data: Record<string, unknown> = {};
      if (patch.email !== undefined && patch.email !== current.email) {
        if (await users.emailTaken(client, patch.email, current.id)) throw emailTaken();
        data.email = patch.email;
      }
      if (patch.full_name !== undefined) data.full_name = patch.full_name;
      if (patch.phone !== undefined) data.phone = patch.phone;
      const depotId = patch.depot_id !== undefined ? await this.resolveDepot(client, patch.depot_id) : current.depotId;
      if (depotId !== current.depotId) data.depot_id = depotId;
      requireDepotFor(roles, depotId);
      if (patch.status !== undefined && patch.status !== current.status) data.status = patch.status;

      // The last active admin keeps the role and stays active. Through the API
      // the caller is itself an active admin, so this only bites when two
      // admins demote each other at once: the row locks serialise the two,
      // and the second sees no admin left.
      const losesAdmin =
        current.roles.includes('admin') && current.status === 'active' && ((rolesChanged && !roles.includes('admin')) || (data.status !== undefined && data.status !== 'active'));
      if (losesAdmin && (await users.otherActiveAdmins(client, current.id)) === 0) throw lastAdmin();

      if (Object.keys(data).length > 0) await users.updateUser(ctx, client, current.id, data);
      if (rolesChanged) await users.setRoles(ctx, client, current.id, roleRows.map((r) => r.id), current.roles, roles);
      const deactivated = data.status !== undefined && data.status !== 'active';
      const revoked = deactivated ? await users.revokeAllSessions(client, current.id) : 0;
      return { before: current, after: await users.findById(client, current.id), data, rolesChanged, deactivated, revoked };
    });

    const user = await this.view(outcome.after);
    const events: DomainEvent[] = [];
    if (outcome.rolesChanged) {
      const before = new Set(outcome.before.roles);
      const after = new Set(outcome.after.roles);
      events.push(
        event(caller, USER_ADMIN_EVENTS.roleChanged, {
          user_id: user.id,
          added: [...after].filter((r) => !before.has(r)).sort(),
          removed: [...before].filter((r) => !after.has(r)).sort(),
        }),
      );
    }
    if (outcome.deactivated) events.push(event(caller, USER_ADMIN_EVENTS.deactivated, { user_id: user.id, status: user.status, sessions_revoked: outcome.revoked }));
    if (Object.keys(outcome.data).length > 0) events.push(event(caller, this.deps.accountChangedEvent, { user_id: user.id }));
    await this.deps.events.publish(events);
    return user;
  }

  /** POST /users/{id}/password-reset: a new one-time link (1 hour); older open links stop working. */
  async issueReset(caller: AdminCaller, userId: string): Promise<PasswordTokenView> {
    const { db, users } = this.deps;
    return withTransaction(db, async (client) => {
      const user = await users.lock(client, userId);
      if (!user) throw userNotFound();
      await this.assertMayManage(client, caller, user.roles);
      const link = newPasswordLink();
      const purpose = user.hasPassword ? 'reset' : 'setup';
      const expiresAt = await users.issueToken(mutationContext(caller), client, {
        userId: user.id,
        purpose,
        tokenHash: link.hash,
        ttlSeconds: purpose === 'reset' ? RESET_TOKEN_TTL_SECONDS : SETUP_TOKEN_TTL_SECONDS,
      });
      return { token: link.value, purpose, expires_at: expiresAt };
    });
  }

  /**
   * POST /auth/password (public): sets the password with a one-time link.
   * The link is used up; every existing session of the user ends (a reset
   * after a compromise must throw the intruder out).
   */
  async setPassword(token: string, password: string, meta: { correlationId: string; ip?: string; userAgent?: string }): Promise<void> {
    const { db, users } = this.deps;
    await withTransaction(db, async (client) => {
      const open = await users.lockOpenToken(client, passwordLinkHash(token));
      if (!open) throw passwordTokenInvalid();
      const account = await users.findById(client, open.userId);
      const problem = passwordProblem(password, account.email);
      if (problem) throw weakPassword(problem);
      const ctx = { userId: account.id, correlationId: meta.correlationId };
      await users.updateUser(ctx, client, account.id, { password_hash: await hashPassword(password) });
      await users.useToken(client, open.id);
      const revoked = await users.revokeAllSessions(client, account.id);
      await writeAuthAudit(client, {
        action: 'auth.password_set',
        actorId: account.id,
        subjectId: account.id,
        correlationId: meta.correlationId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { purpose: open.purpose, sessions_revoked: revoked },
      });
    });
  }

  /**
   * The roles to grant, checked: each exists and is active, and every role
   * added or removed is one the caller may assign (mayAssignRole).
   */
  private async assignableRoles(client: PoolClient, caller: AdminCaller, wanted: readonly string[], current: readonly string[]): Promise<RoleRow[]> {
    const all = new Map((await this.deps.users.roles(client)).map((r) => [r.name, r]));
    const rows = wanted.map((name, i) => {
      const role = all.get(name);
      if (!role) throw unknownRole(i);
      return role;
    });
    const changed = [...wanted.filter((r) => !current.includes(r)), ...current.filter((r) => !wanted.includes(r))];
    for (const name of changed) {
      const role = all.get(name);
      if (!mayAssignRole(caller.user, name, role?.permissions ?? [])) throw roleEscalation(name);
    }
    return rows;
  }

  /**
   * Managing an account (editing it, deactivating it, issuing it a reset
   * link) is as strong as holding its roles: whoever resets an admin's
   * password can sign in as that admin. So the caller must be able to assign
   * every role the account holds.
   */
  private async assertMayManage(client: PoolClient, caller: AdminCaller, roles: readonly string[]): Promise<void> {
    const all = new Map((await this.deps.users.roles(client)).map((r) => [r.name, r]));
    for (const name of roles) {
      if (!mayAssignRole(caller.user, name, all.get(name)?.permissions ?? [])) throw roleEscalation(name);
    }
  }

  /** The internal id of the home depot named by `publicId` (null clears it); share-locked in `client`'s transaction. */
  private async resolveDepot(client: PoolClient, publicId: string | null): Promise<string | null> {
    if (publicId === null) return null;
    const depotId = await this.deps.depots.resolveActive(publicId, client);
    if (!depotId) throw userDepotNotFound();
    return depotId;
  }

  private async view(row: AdminUserRow): Promise<UserView> {
    return {
      id: row.publicId,
      email: row.email,
      full_name: row.fullName,
      phone: row.phone,
      depot_id: row.depotId === null ? null : await this.deps.depots.publicIdOf(row.depotId),
      status: row.status,
      roles: row.roles,
      has_password: row.hasPassword,
      last_login_at: row.lastLoginAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

}

/** Depot-scoped roles see one depot only: without a home depot they would see nothing. */
function requireDepotFor(roles: readonly string[], depotId: string | null): void {
  if (depotId === null && roles.some((r) => DEPOT_SCOPED_ROLES.includes(r))) throw depotRequired();
}

function event(caller: AdminCaller, type: string, payload: Record<string, unknown>): DomainEvent {
  return createEvent(type, payload, { actor: caller.user.publicId, correlationId: caller.correlationId });
}

function mutationContext(caller: AdminCaller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
