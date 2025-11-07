// src/uazapiClient.js

/**
 * Cliente Uazapi — encapsula os endpoints de envio usados pelo bot.
 * Usa caminhos oficiais `/send/text`, `/send/media` e `/send/menu`.
 * Normaliza números, evita duplicações de `/api` e trata erros de forma descritiva.
 * É possível sobrescrever caminhos via env:
 *   - UAZAPI_SEND_TEXT_PATH
 *   - UAZAPI_SEND_MEDIA_PATH
 *   - UAZAPI_SEND_MENU_PATH
 */

import axios from 'axios';
import FormData from 'form-data';
import { UAZAPI_BASE_URL, UAZAPI_TOKEN, OPENAI_API_KEY } from './config.js';

const LOG_TRANSCR = (process.env.LOG_TRANSCR ?? '1') !== '0';
const short = (v, n = Number(process.env.LOG_PREVIEW_LEN || 160)) => {
  try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length <= n ? s : s.slice(0,n)+'…'; } catch { return ''; }
};

function cleanBaseURL(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/+$/, '');
}

export function normalizeNumber(n) {
  if (!n) return n;
  let s = String(n);
  if (s.includes('@')) s = s.split('@')[0];
  return s.replace(/\D/g, '');
}

const api = axios.create({
  baseURL: cleanBaseURL(UAZAPI_BASE_URL) || '',
  timeout: 20000,
});

function ensureEnv() {
  const base = cleanBaseURL(UAZAPI_BASE_URL);
  if (!base) throw new Error('UAZAPI_BASE_URL não configurado.');
  if (!UAZAPI_TOKEN) throw new Error('UAZAPI_TOKEN não configurado.');
  return base;
}

function buildHeaders(json = true) {
  const base = { token: UAZAPI_TOKEN, convert: 'true' };
  return json ? { 'Content-Type': 'application/json', ...base } : base;
}

const ENV_TEXT  = process.env.UAZAPI_SEND_TEXT_PATH  || null;
const ENV_MEDIA = process.env.UAZAPI_SEND_MEDIA_PATH || null;
const ENV_MENU  = process.env.UAZAPI_SEND_MENU_PATH  || null;

// Priorize rotas oficiais, mantendo algumas legadas para texto/mídia
const TEXT_PATHS = [
  ENV_TEXT,
  '/send/text', '/api/send/text',
  '/send-text', '/api/send-text',
  '/message/text', '/api/message/text',
  '/messages/text', '/api/messages/text',
].filter(Boolean);

const MEDIA_PATHS = [
  ENV_MEDIA,
  '/send/media', '/api/send/media',
  '/send-media', '/api/send-media',
  '/message/media', '/api/message/media',
  '/messages/media', '/api/messages/media',
].filter(Boolean);

// Rotas de menu (somente oficiais). NÃO usar '/menu' ou '/api/menu'.
const MENU_PATHS = [
  ENV_MENU,
  '/send/menu', '/send-menu',
  '/api/send/menu', '/api/send-menu',
].filter(Boolean);

// Retorna base e variante com /api (sem duplicar).
function getBaseVariants(base) {
  const noApi = cleanBaseURL(base).replace(/\/api$/, '');
  const withApi = `${noApi}/api`;
  return Array.from(new Set([noApi, withApi]));
}

// Evita base terminando com /api combinada com path iniciando em /api.
function isInvalidCombo(base, path) {
  return base.endsWith('/api') && path.startsWith('/api/');
}

async function postFirst2xx(paths, data, headers) {
  const base = ensureEnv();
  const bases = getBaseVariants(base);
  const attempts = [];
  const seenUrls = new Set();

  for (const b of bases) {
    for (const candidate of paths) {
      const p = candidate.startsWith('/') ? candidate : `/${candidate}`;
      if (isInvalidCombo(b, p)) continue;
      const url = `${b}${p}`;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      try {
        const res = await api.post(url, data, { headers, validateStatus: () => true });
        attempts.push({ url, status: res.status, body: res.data });
        if (res.status >= 200 && res.status < 300) {
          return res.data;
        }
      } catch (e) {
        attempts.push({ url, status: 'NETWORK_ERROR', body: e?.message || String(e) });
      }
    }
  }
  const last = attempts.at(-1) || {};
  const body = typeof last.body === 'object' ? JSON.stringify(last.body) : String(last.body);
  throw new Error(`Uazapi falhou em todos os paths. Último: ${last.status} POST ${last.url} → ${body}`);
}

/** Envia texto */
/**
 * Envia texto
 *
 * Aceita um terceiro parâmetro opcional com configurações adicionais. O único
 * campo atualmente utilizado é `delay`, que define um atraso em milissegundos
 * antes do envio para exibir o status “Digitando…”. Caso não seja
 * informado, o delay será zero. Outros campos como replyid ou mentions
 * continuam definidos internamente.
 *
 * @param {string} number Número do destinatário (pode conter máscara ou @)
 * @param {string} text   Texto a ser enviado
 * @param {object} opts   Opções adicionais (ex.: { delay: 1500 })
 */
export async function sendText(number, text, opts = {}) {
  const delayMs = (opts && typeof opts.delay === 'number' && !isNaN(opts.delay))
    ? Math.max(0, Math.floor(opts.delay))
    : 0;
  const payload = {
    number: normalizeNumber(number),
    text,
    linkPreview: false,
    // doc oficial usa replyid em minúsculas
    replyid: '',
    mentions: '',
    readchat: true,
    delay: delayMs,
  };
  return postFirst2xx(TEXT_PATHS, payload, buildHeaders(true));
}

/**
 * Envia mídia (URL remota) — tenta JSON e faz fallback para multipart.
 *
 * @param {string} number        Número do destinatário
 * @param {string} fileUrl       URL do arquivo remoto
 * @param {string} caption       Legenda opcional
 * @param {string} type          Tipo da mídia (ex.: 'video', 'image')
 */
export async function sendMedia(number, fileUrl, caption = '', type = '') {
  const num = normalizeNumber(number);

  // 1) JSON
  const jsonPayload = {
    number: num,
    type: type || '',
    file: fileUrl,
    text: caption || '',
    readchat: true,
    delay: 0,
  };
  try {
    return await postFirst2xx(MEDIA_PATHS, jsonPayload, buildHeaders(true));
  } catch (_jsonErr) {
    // 2) multipart/form-data
    const form = new FormData();
    form.append('number', num);
    form.append('file', fileUrl);
    if (caption) form.append('text', caption);
    form.append('type', type || 'video');
    const headers = { ...form.getHeaders(), ...buildHeaders(false) };
    return postFirst2xx(MEDIA_PATHS, form, headers);
  }
}

/**
 * Envia um menu interativo (caixinha).
 * IMPORTANTE: payload FLAT (sem { menu: { ... } }).
 */
/**
 * Envia um menu interativo (buttons, listas ou carrossel de botões).
 *
 * Aceita um terceiro parâmetro opcional com configurações adicionais. O campo
 * `delay` define um atraso em milissegundos para exibir o status “Digitando…”
 * antes de mostrar o menu para o usuário. Caso não seja informado, o delay
 * será zero.
 *
 * @param {string} number      Número do destinatário
 * @param {object} menuPayload Objeto flat contendo type, text, choices, etc.
 * @param {object} opts        Opções adicionais (ex.: { delay: 2000 })
 */
export async function sendMenu(number, menuPayload, opts = {}) {
  const num = normalizeNumber(number);
  const delayMs = (opts && typeof opts.delay === 'number' && !isNaN(opts.delay))
    ? Math.max(0, Math.floor(opts.delay))
    : 0;
  const payload = {
    number: num,
    ...menuPayload, // type, text, choices, footerText, etc. direto no topo
    readchat: true,
    delay: delayMs,
  };
  return postFirst2xx(MENU_PATHS, payload, buildHeaders(true));
}

/**
 * ===== ATIVA STATUS "DIGITANDO..." IMEDIATAMENTE =====
 * 
 * Faz a Uazapi mostrar o indicador "digitando..." para o usuário.
 * Esse status fica ativo por ~25 segundos ou até enviar uma mensagem.
 * 
 * Use isso NO INÍCIO do processamento para dar feedback visual imediato.
 * 
 * @param {string} number Número do destinatário
 * @returns {Promise<void>}
 */
export async function setTypingStatus(number) {
  const num = normalizeNumber(number);
  const payload = {
    number: num,
    status: 'composing', // ou 'typing' dependendo da API
  };

  // Tenta vários endpoints possíveis para "presence"
  const possiblePaths = [
    '/chat/presence',
    '/api/chat/presence',
    '/send/presence',
    '/api/send/presence',
    '/presence',
    '/api/presence',
  ];

  try {
    ensureEnv();
    
    // Tenta cada endpoint até conseguir
    for (const path of possiblePaths) {
      try {
        await api.post(path, payload, { 
          headers: buildHeaders(true),
          validateStatus: () => true,
        });
        // Se chegou aqui sem erro, sucesso
        return;
      } catch (e) {
        // Continua tentando próximo endpoint
        continue;
      }
    }
    
    // Se nenhum funcionou, não é crítico - apenas não mostra "digitando"
    console.log('⚠️ Nenhum endpoint de presence funcionou (não crítico)');
  } catch (err) {
    // Erro não crítico - bot continua funcionando
    console.log('⚠️ Erro ao definir status "digitando":', err?.message);
  }
}

/**
 * Baixa a mídia de uma mensagem. Se `transcribe` for true, a Uazapi transcreve
 * o áudio com Whisper usando sua OPENAI_API_KEY; caso false, retorna Base64.
 *
 * @param {string} messageId   ID da mensagem (message.key.id) do webhook
 * @param {boolean} transcribe Se true, pede transcrição automática
 * @returns {Promise<object>}  Objeto da Uazapi com transcrição e/ou base64/link
 */
export async function downloadMessageMedia(messageId, transcribe = false) {
  const payload = {
    id: messageId,
    return_base64: !transcribe,
    generate_mp3: true,
    return_link: false,
    transcribe: Boolean(transcribe),
    openai_apikey: OPENAI_API_KEY,
    download_quoted: false,
  };
  try {
    ensureEnv();
    if (LOG_TRANSCR) {
      // Não loga a chave da OpenAI
      const logged = { ...payload };
      delete logged.openai_apikey;
      console.log('🛰️ UAZAPI → POST /message/download', logged);
    }
    const res = await api.post('/message/download', payload, { headers: buildHeaders(true) });
    if (LOG_TRANSCR) {
      console.log('🛰️ UAZAPI ← /message/download status', res.status, 'keys', Object.keys(res.data || {}));
    }
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.error('❌ UAZAPI download error:', status ?? 'no-status', short(body || err.message));
    throw new Error(`Erro ao baixar ou transcrever mídia (${status ?? 'no-status'}): ${body || err.message}`);
  }
}
