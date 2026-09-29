import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Cria um pool de ligações ao PostgreSQL usando a variável do .env
export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});