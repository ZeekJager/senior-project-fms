const { Pool } = require('pg');

// Use the runtime app credentials, not the admin ones!
// fms_app was specifically granted the correct read/write permissions.
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'fms_app',
  password: process.env.DB_PASS || 'apppassword',
  database: process.env.DB_NAME || 'fms_db',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
