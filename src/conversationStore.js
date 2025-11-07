// src/conversationStore.js

/**
 * Persistent conversation store backed by PostgreSQL.
 *
 * Each WhatsApp number is associated with a row in the `sessions` table.
 * The `history` column contains a JSON array of message objects
 * (with `role` and `content` fields), and `last_response_ts` tracks
 * the timestamp of the last outbound response.
 */

import { query } from './db.js';
import { normalizeNumber } from './uazapiClient.js';

// OTIMIZAÇÃO: Cache em memória para reduzir consultas ao banco
// Limpa cache automaticamente após 5 minutos de inatividade
const historyCache = new Map();
const CACHE_TTL_MS = 300000; // 5 minutos

function setCacheEntry(number, history) {
  historyCache.set(number, { history, timestamp: Date.now() });
}

function getCacheEntry(number) {
  const entry = historyCache.get(number);
  if (!entry) return null;
  // Verifica se o cache expirou
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    historyCache.delete(number);
    return null;
  }
  return entry.history;
}

function invalidateCache(number) {
  historyCache.delete(number);
}

// Garante que a linha exista (idempotente)
async function ensureSessionRow(num) {
  await query(
    `INSERT INTO sessions(number, history, last_response_ts)
     VALUES ($1, '[]', NULL)
     ON CONFLICT (number) DO NOTHING`,
    [num]
  );
}

/**
 * Busca o histórico do número (array de {role, content})
 * OTIMIZAÇÃO: Usa cache em memória para reduzir queries ao banco
 */
export async function getHistory(numberRaw) {
  const number = normalizeNumber(numberRaw);
  
  // Tenta obter do cache primeiro
  const cached = getCacheEntry(number);
  if (cached !== null) return cached;
  
  try {
    await ensureSessionRow(number);
    const { rows } = await query('SELECT history FROM sessions WHERE number = $1', [number]);
    const h = rows?.[0]?.history;
    const history = Array.isArray(h) ? h : (h ?? []);
    
    // Armazena no cache
    setCacheEntry(number, history);
    return history;
  } catch (err) {
    console.error('Error fetching history for', number, err.message);
    return [];
  }
}

/**
 * Append no histórico com UPSERT seguro.
 * OTIMIZAÇÃO: Usa cache e single query com array_append do PostgreSQL
 */
export async function appendToHistory(numberRaw, role, content) {
  const number = normalizeNumber(numberRaw);
  try {
    await ensureSessionRow(number);
    const current = await getHistory(number);
    const next = [...current, { role, content }];
    
    // Atualiza banco e cache simultaneamente
    await query(
      'UPDATE sessions SET history = $2 WHERE number = $1',
      [number, JSON.stringify(next)]
    );
    
    // Atualiza cache
    setCacheEntry(number, next);
    return next;
  } catch (err) {
    console.error('Error updating history for', number, err.message);
    return [];
  }
}

/**
 * Reset (delete) a sessão do número.
 * OTIMIZAÇÃO: Limpa cache junto com o banco
 */
export async function resetHistory(numberRaw) {
  const number = normalizeNumber(numberRaw);
  try {
    await query('DELETE FROM sessions WHERE number = $1', [number]);
    invalidateCache(number);
  } catch (err) {
    console.error('Error resetting history for', number, err.message);
  }
}

/**
 * Retrieve the persisted session state for a given WhatsApp number.
 *
 * The bot stores state information as a JSON payload inside the
 * conversation history with the special role `meta`. Whenever the
 * state transitions, a new meta message containing the serialised
 * state is appended to the history. This helper walks the history
 * from the end backwards and returns the most recent valid state.
 * If no state is found, it returns a default initial state with
 * `step: 'intro'`.
 *
 * @param {string} numberRaw WhatsApp number
 * @returns {Promise<object>} The last saved state or a default state
 */
export async function getSessionState(numberRaw) {
  const number = normalizeNumber(numberRaw);
  const history = await getHistory(number);
  // walk backwards to find the last meta entry
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'meta') {
      try {
        const state = JSON.parse(m.content);
        if (state && typeof state === 'object' && state.step) {
          return state;
        }
      } catch {
        /* ignore invalid JSON */
      }
    }
  }
  // default initial state
  return { step: 'intro', videoSent: false, leadName: null, responsibleOk: null };
}

/**
 * Persist a new session state for a given number. The state is
 * serialised to a JSON string and appended to the conversation
 * history as a message with role `meta`. Using appendToHistory ensures
 * that the state is stored alongside the chat log and will survive
 * restarts.
 *
 * @param {string} numberRaw WhatsApp number
 * @param {object} state Arbitrary JSON-serialisable session state
 */
export async function saveSessionState(numberRaw, state) {
  const number = normalizeNumber(numberRaw);
  try {
    await appendToHistory(number, 'meta', JSON.stringify(state));
  } catch (err) {
    console.error('Error saving state for', number, err.message);
  }
}
