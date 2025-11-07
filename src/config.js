// src/config.js

/**
 * Configuration module.
 *
 * Reads required environment variables and exposes them as named exports.
 * Throws descriptive errors if mandatory variables are missing. You can
 * customise the delay between outbound messages and the listening port
 * via the SEND_DELAY_MS and PORT environment variables respectively.
 */

// Base URL of your Uazapi instance (e.g. https://api.uazapi.dev).
export const UAZAPI_BASE_URL = process.env.UAZAPI_BASE_URL;
// API token issued by Uazapi. This will be sent in the `token` header.
export const UAZAPI_TOKEN    = process.env.UAZAPI_TOKEN;
// OpenAI API key used to authenticate requests to ChatGPT.
export const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
// Optional: override the system prompt via environment variable. If not
// provided the default prompt defined in prompt.js will be used.
export const PRODUCT_PROMPT  = process.env.PRODUCT_PROMPT;

// Delay between outgoing messages in milliseconds. Defaults to 30 seconds.
export const SEND_DELAY_MS   = parseInt(process.env.SEND_DELAY_MS || '30000', 10);
// Port for the HTTP server to listen on. Defaults to 3000.
export const PORT            = parseInt(process.env.PORT || '3000', 10);

// PostgreSQL connection settings. These variables are optional – if not provided
// the bot will continue to run but persistent conversation history will not
// be stored. When configured, the bot will persist user sessions in a
// `sessions` table with columns `number`, `history` and `last_response_ts`.
// See db.js for connection setup and migrations.sql for table creation.
export const PG_HOST     = process.env.PG_HOST;
export const PG_PORT     = process.env.PG_PORT;
export const PG_USER     = process.env.PG_USER;
export const PG_PASSWORD = process.env.PG_PASSWORD;
export const PG_DATABASE = process.env.PG_DATABASE;

// Validate required variables
if (!UAZAPI_BASE_URL) {
  throw new Error('UAZAPI_BASE_URL is not set');
}
if (!UAZAPI_TOKEN) {
  throw new Error('UAZAPI_TOKEN is not set');
}
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set');
}
