// src/db.js

/**
 * Database helper for PostgreSQL.
 * Suporta DATABASE_URL OU variáveis PG_* separadas.
 * SSL opcional com PG_SSL=true (útil para Railway/Render/Neon/Supabase).
 */

import { Pool } from 'pg';

const useUrl = !!process.env.DATABASE_URL;

const baseConfig = useUrl
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PG_HOST,
      port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
    };

const sslEnabled = String(process.env.PG_SSL || '').toLowerCase() === 'true';

const pool = new Pool({
  ...baseConfig,
  ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
});

export const query = (text, params = []) => pool.query(text, params);

// Teste de conexão amigável na subida
(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL conectado ' + (useUrl ? 'via DATABASE_URL' : 'via variáveis PG_*'));
  } catch (e) {
    console.warn('⚠️ Não consegui conectar ao PostgreSQL. Revise .env / rede / SSL.');
    console.warn('   Detalhe:', e.message);
  }
})();
