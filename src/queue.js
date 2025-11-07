// src/queue.js

/**
 * ===== SISTEMA DE FILAS E DELAYS =====
 * 
 * Controla o envio de mensagens para o WhatsApp com dois mecanismos:
 * 
 * 1. BUFFER ANTI-FLOOD (4s entre mensagens de TEXTO):
 *    - Evita que a Luna mande várias mensagens seguidas muito rápido
 *    - Se tentar mandar outra mensagem antes de 4s, ela é silenciosamente ignorada
 *    - Mídia (vídeo/imagem) NÃO passa pelo buffer - é enviada na hora
 * 
 * 2. DELAY "DIGITANDO..." (1.5-3.5s aleatório):
 *    - Quando vai enviar uma mensagem, a Uazapi mostra "digitando..." ANTES
 *    - Esse tempo NÃO atrasa a resposta da IA, apenas mostra o indicador
 *    - É calculado aqui e enviado para a Uazapi via campo 'delay'
 *    - Aparece IMEDIATAMENTE quando a mensagem for enviada
 */

import { query } from './db.js';
import { normalizeNumber, sendText, sendMedia } from './uazapiClient.js';
import { sendMenu } from './uazapiClient.js';

// ===== CÁLCULO DO DELAY "DIGITANDO..." =====
// Gera um tempo aleatório entre MIN e MAX para parecer humano
const MIN_DELAY_MS = Number(process.env.MIN_MESSAGE_DELAY_MS || 1500); // 1.5s
const MAX_DELAY_MS = Number(process.env.MAX_MESSAGE_DELAY_MS || 3500); // 3.5s

function computeRandomDelay() {
  const min = isNaN(MIN_DELAY_MS) ? 0 : MIN_DELAY_MS;
  const max = isNaN(MAX_DELAY_MS) ? min : MAX_DELAY_MS;
  if (max <= min) return Math.max(0, Math.floor(min));
  const rnd = min + Math.random() * (max - min);
  return Math.max(0, Math.floor(rnd));
}

// Intervalo mínimo entre mensagens de TEXTO
// OTIMIZAÇÃO: Reduzido de 7s para 4s para respostas mais rápidas
const BUFFER_MS = 4000;

/** Garante linha na tabela */
async function ensureRow(number) {
  await query(
    `INSERT INTO sessions(number, history, last_response_ts)
       VALUES ($1, '[]', NULL)
       ON CONFLICT (number) DO NOTHING`,
    [number]
  );
}

/** Pode enviar texto agora? (respeita buffer) */
async function canSendTextNow(number, now) {
  const { rows } = await query(
    'SELECT last_response_ts FROM sessions WHERE number = $1',
    [number]
  );
  const last = rows?.[0]?.last_response_ts
    ? new Date(rows[0].last_response_ts)
    : null;
  if (!last) return true;
  return now - last >= BUFFER_MS;
}

/**
 * ===== ENVIA TEXTO COM BUFFER E DELAY =====
 * 
 * Envia mensagem de texto respeitando:
 * 1. BUFFER de 4s: Se já mandou uma mensagem há menos de 4s, ignora silenciosamente
 * 2. DELAY "digitando": Calcula tempo aleatório e passa para Uazapi mostrar indicador
 * 
 * O delay "digitando" aparece IMEDIATAMENTE quando a mensagem for enviada.
 * Não atrasa a resposta da IA, só mostra o indicador visual.
 */
export async function queueMessage(numberRaw, text, opts = {}) {
  const number = normalizeNumber(numberRaw);
  const now = new Date();
  const bypass = !!opts.bypassBuffer;

  try {
    await ensureRow(number);

    // ===== VERIFICAÇÃO DO BUFFER (4s) =====
    if (!bypass && !(await canSendTextNow(number, now))) {
      // Última mensagem foi enviada há menos de 4s - IGNORA silenciosamente
      return;
    }

    // ===== CÁLCULO DO DELAY "DIGITANDO" =====
    // Se opts.delay foi passado, usa esse valor. Senão, gera aleatório (1.5-3.5s)
    let delayMs = null;
    if (opts && typeof opts.delay === 'number' && !isNaN(opts.delay)) {
      delayMs = Math.max(0, Math.floor(opts.delay));
    } else {
      delayMs = computeRandomDelay(); // Aleatório entre 1500-3500ms
    }

    // Envia para Uazapi com o delay - ela mostrará "digitando" por delayMs antes de enviar
    await sendText(number, text, { delay: delayMs });

    // Atualiza timestamp da última mensagem (para o buffer de 7s)
    await query(
      `UPDATE sessions SET last_response_ts = $2 WHERE number = $1`,
      [number, now]
    );
  } catch (err) {
    console.error('Error in queueMessage for', number, err.message);
  }
}

/** Envia MÍDIA imediatamente, SEM buffer (não altera last_response_ts) */
export async function queueMedia(numberRaw, fileUrl, caption = '', opts = {}) {
  let actualCaption = caption;
  let options = opts;
  if (typeof caption === 'object' && caption !== null) {
    options = caption;
    actualCaption = '';
  }
  const number = normalizeNumber(numberRaw);
  try {
    await ensureRow(number);
    await sendMedia(number, fileUrl, actualCaption, options?.type || '');
  } catch (err) {
    console.error('Error in queueMedia for', number, err.message);
  }
}

/**
 * ===== ENVIA MENU (BOTÕES) COM BUFFER E DELAY =====
 * 
 * Menu funciona igual ao texto:
 * 1. BUFFER de 4s: Respeita o intervalo mínimo entre envios
 * 2. DELAY "digitando": Mostra indicador antes de exibir o menu
 */
export async function queueMenu(numberRaw, menuPayload, opts = {}) {
  const number = normalizeNumber(numberRaw);
  const now = new Date();
  const bypass = !!opts.bypassBuffer;

  try {
    await ensureRow(number);

    // ===== VERIFICAÇÃO DO BUFFER (4s) =====
    if (!bypass && !(await canSendTextNow(number, now))) {
      // Última mensagem foi há menos de 4s - IGNORA
      return;
    }

    // ===== CÁLCULO DO DELAY "DIGITANDO" =====
    let delayMs = null;
    if (opts && typeof opts.delay === 'number' && !isNaN(opts.delay)) {
      delayMs = Math.max(0, Math.floor(opts.delay));
    } else {
      delayMs = computeRandomDelay(); // Aleatório 1500-3500ms
    }

    // Envia menu com delay "digitando"
    await sendMenu(number, menuPayload, { delay: delayMs });

    // Atualiza timestamp da última mensagem
    await query(
      `UPDATE sessions SET last_response_ts = $2 WHERE number = $1`,
      [number, now]
    );
  } catch (err) {
    console.error('Error in queueMenu for', number, err.message);
  }
}
