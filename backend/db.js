const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dialforge',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dialforge_dev',
});

module.exports = pool;
