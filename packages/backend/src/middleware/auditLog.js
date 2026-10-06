const { pool } = require('../db');

// Table and column names are spliced into SQL (they cannot be bound as
// parameters), so only plain schema-qualified identifiers are accepted.
// Callers pass literals like 'fleet.vehicles'; request-body keys must never
// reach SQL unchecked.
const TABLE_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function assertTable(tableName) {
  if (!TABLE_RE.test(tableName)) {
    throw new Error(`Invalid table name '${tableName}': use schema.table, e.g. 'fleet.vehicles'`);
  }
}

function assertColumns(keys) {
  for (const k of keys) {
    if (!COLUMN_RE.test(k)) throw new Error(`Invalid column name '${k}'`);
  }
}

// Soft delete (DoD #6): every core table has is_active, except auth.users,
// whose is_active is generated from status and cannot be written directly.
function softDeleteSql(tableName) {
  return tableName === 'auth.users'
    ? `UPDATE ${tableName} SET status = 'inactive' WHERE id = $1`
    : `UPDATE ${tableName} SET is_active = FALSE WHERE id = $1`;
}

/**
 * Middleware that injects a `dbMutate` helper into the request object.
 * This ensures all mutations (INSERT, UPDATE, DELETE) automatically
 * write to audit.audit_logs inside a single PostgreSQL transaction.
 *
 * `tableName` is schema-qualified ('fleet.depots'); it is stored as the
 * audit entry's entity_type.
 */
function auditLogMiddleware(req, res, next) {
  
  req.dbMutate = async function (tableName, action, recordId = null, data = {}) {
    assertTable(tableName);
    assertColumns(Object.keys(data));
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      let oldState = null;
      let newState = null;
      let finalRecordId = recordId;

      // 1. Fetch old state for UPDATE and DELETE
      if (['UPDATE', 'DELETE'].includes(action.toUpperCase()) && recordId) {
        const resOld = await client.query(`SELECT * FROM ${tableName} WHERE id = $1`, [recordId]);
        if (resOld.rows.length === 0) {
          throw new Error(`Record ${recordId} not found in ${tableName}`);
        }
        oldState = resOld.rows[0];
      }

      // 2. Perform the actual mutation
      if (action.toUpperCase() === 'DELETE') {
        // Soft delete interception!
        await client.query(softDeleteSql(tableName), [recordId]);
        
        const resNew = await client.query(`SELECT * FROM ${tableName} WHERE id = $1`, [recordId]);
        newState = resNew.rows[0];
      } 
      else if (action.toUpperCase() === 'UPDATE') {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setString = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        
        await client.query(`UPDATE ${tableName} SET ${setString} WHERE id = $1`, [recordId, ...values]);
        
        const resNew = await client.query(`SELECT * FROM ${tableName} WHERE id = $1`, [recordId]);
        newState = resNew.rows[0];
      } 
      else if (action.toUpperCase() === 'INSERT') {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        
        const resInsert = await client.query(
          `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`, 
          values
        );
        newState = resInsert.rows[0];
        finalRecordId = newState.id;
      }

      // 3. Write to audit.audit_logs
      // We stringify the JSONB data.
      await client.query(
        `INSERT INTO audit.audit_logs 
          (entity_type, entity_id, action, old_values, new_values, user_id, correlation_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tableName,
          finalRecordId,
          action.toUpperCase(),
          oldState ? JSON.stringify(oldState) : null,
          newState ? JSON.stringify(newState) : null,
          req.user ? req.user.id : null,
          req.correlationId
        ]
      );

      await client.query('COMMIT');
      return newState;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  next();
}

module.exports = auditLogMiddleware;
