const { pool } = require('../db');

/**
 * Middleware that injects a `dbMutate` helper into the request object.
 * This ensures all mutations (INSERT, UPDATE, DELETE) automatically
 * write to the audit_logs table inside a single PostgreSQL transaction.
 */
function auditLogMiddleware(req, res, next) {
  
  req.dbMutate = async function (tableName, action, recordId = null, data = {}) {
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
        await client.query(`UPDATE ${tableName} SET is_active = FALSE WHERE id = $1`, [recordId]);
        
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

      // 3. Write to audit_logs
      // We stringify the JSONB data.
      await client.query(
        `INSERT INTO audit_logs 
          (table_name, record_id, action, old_state, new_state, user_id, correlation_id) 
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
