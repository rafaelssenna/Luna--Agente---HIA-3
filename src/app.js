// src/app.js

/**
 * Entry point for the WhatsApp chatbot (Webhook + IA).
 * Fluxo oficial (uma coisa por vez):
 * 1) Apresentação + caixinha → 2) validar responsável → 3) breve explicação + enviar vídeo → 4) interesse → handoff.
 *
 * Observações das mudanças:
 * - ❌ Removida a caixinha "automática" com texto fixo no app.js. Agora a IA (prompt) decide quando/como enviar o menu (send_menu).
 * - ✅ Buffer/merge em TODA a conversa: removidos todos os usos de `bypassBuffer`.
 * - ▶️ Clique de botão continua imediato (sem debounce) para boa UX.
 * - 🎬 `send_video` aceita `followup` vindo do prompt; fallback curto não cita Jonas.
 */

import express from 'express';
import { Buffer } from 'buffer';
import { PORT } from './config.js';
import {
  getHistory,
  appendToHistory,
  resetHistory,
} from './conversationStore.js';
import { queueMessage, queueMedia, queueMenu } from './queue.js';
import { generateReplyWithTools, transcribeAudio } from './openaiClient.js';
import { normalizeNumber, downloadMessageMedia, setTypingStatus } from './uazapiClient.js';

const app = express();

// ======= LOG CONFIG =======
const LOG_TRANSCR = (process.env.LOG_TRANSCR ?? '1') !== '0';
const LOG_PREVIEW_LEN = Number(process.env.LOG_PREVIEW_LEN || 160);
const short = (v, n = LOG_PREVIEW_LEN) => {
  try {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length <= n ? s : s.slice(0, n) + '…';
  } catch { return ''; }
};
const maskNumber = (n='') => String(n).replace(/\D/g,'').replace(/(\d{2})\d+(\d{4})/, '$1******$2');

// --- Middlewares de parsing (aceitar qualquer formato que a Uazapi mande) ---
app.use(express.json({ limit: '5mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // x-www-form-urlencoded
app.use(express.text({ type: '*/*', limit: '5mb' }));          // text/plain, etc.

// ===== BUFFER DE AGRUPAMENTO DE MENSAGENS =====
// Agrupa mensagens consecutivas do usuário para evitar que a IA responda
// a cada mensagem separadamente. Se o usuário mandar 3 mensagens em 7s,
// a Luna espera o tempo acabar e responde todas de uma vez.
const USER_MERGE_WINDOW_MS = 7000; // 7 segundos
const pendingByUser = new Map(); // number -> { combinedText, lastRaw, timer, processing, messageCount }

// Se true, botões também passam pelo buffer (default: false para melhor UX)
const BUFFER_BUTTONS = (process.env.BUFFER_BUTTONS || 'false').toLowerCase() === 'true';

// --- Anti-duplicação de caixinha (menu) enviada pela IA ---
const MENU_DEDUP_WINDOW_MS = Number(process.env.MENU_DEDUP_WINDOW_MS || 120000); // 2 min
const lastMenuAt = new Map(); // number -> timestamp

// ===== DELAY "DIGITANDO..." (APARECE IMEDIATAMENTE) =====
// Quando a Luna vai responder, a Uazapi mostra "digitando..." ANTES de enviar.
// Isso NÃO atrasa a resposta da IA, apenas mostra o indicador para o usuário.
// O tempo de "digitando" é aleatório entre 1.5-3.5s para parecer humano.
const MIN_MESSAGE_DELAY_MS = Number(process.env.MIN_MESSAGE_DELAY_MS || 1500); // 1.5s
const MAX_MESSAGE_DELAY_MS = Number(process.env.MAX_MESSAGE_DELAY_MS || 3500); // 3.5s

// Utilitários
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function randomDelay() {
  const ms = MIN_MESSAGE_DELAY_MS + Math.random() * (MAX_MESSAGE_DELAY_MS - MIN_MESSAGE_DELAY_MS);
  await delay(ms);
}
function toTitleCase(s) {
  return String(s || '').trim().replace(/\s+/g,' ').split(' ')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

// ========== Extração de contato (vCard/contacts) ==========
function parseVCard(v) {
  const res = { name: '', phone: '' };
  const s = String(v || '');
  const nameMatch = s.match(/^\s*FN:(.+)$/m) || s.match(/^\s*N:(.+)$/m);
  if (nameMatch) res.name = toTitleCase(nameMatch[1].trim());
  const waid = s.match(/waid=(\d+)/i);
  if (waid) res.phone = waid[1];
  if (!res.phone) {
    const tel = s.match(/^\s*TEL[^:]*:(.+)$/mi);
    if (tel) res.phone = tel[1].replace(/[^\d]/g, '');
  }
  return res;
}
function extractContactFromRaw(raw) {
  const msg = raw?.message || raw?.data?.message || {};
  if (typeof msg?.vcard === 'string') return parseVCard(msg.vcard);
  const contact = msg?.contact || null;
  if (contact?.vcard) return parseVCard(contact.vcard);
  const contacts = Array.isArray(msg?.contacts) ? msg.contacts : null;
  if (contacts && contacts[0]) {
    if (contacts[0].vcard) return parseVCard(contacts[0].vcard);
    const name = contacts[0].name || contacts[0].displayName || '';
    const phone = contacts[0].phone || contacts[0].number || '';
    if (name || phone) return { name: toTitleCase(name), phone: String(phone).replace(/[^\d]/g, '') };
  }
  return { name: '', phone: '' };
}

/* =========================================================
 *      EXTRATOR ROBUSTO PARA WHATSAPP MESSAGE ID (WAID)
 * =======================================================*/

/**
 * Heurística: parece um WhatsApp message id?
 *
 * A Uazapi às vezes envia o id da mensagem de áudio em campos que não seguem o
 * padrão de 20+ caracteres ou que começam com 3EB0. Para aumentar a
 * compatibilidade, consideramos IDs com pelo menos 16 caracteres ou que
 * iniciam com 3EB0. Isso evita capturar IDs muito curtos (por exemplo,
 * “rf4…” do CRM) mas relaxa a condição anterior que exigia 20+ caracteres.
 */
function isLikelyWAId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (!s) return false;
  return s.length >= 16 || /^3EB0/i.test(s);
}

/** Tenta extrair com caminhos explícitos e, se precisar, varre recursivamente. */
function getWhatsAppMessageId(raw) {
  try {
    // 1) Caminhos explícitos mais comuns (UAZAPI + Cloud API)
    // Além de key.id, também incluímos id planos em message/chat/root, pois o WhatsApp message id pode
    // estar ali dependendo da forma que o payload foi serializado pela UAZAPI ou Cloud API.
    const cands = [
      // key.id em diferentes níveis
      raw?.message?.key?.id,
      raw?.data?.message?.key?.id,
      raw?.chat?.message?.key?.id,
      raw?.data?.chat?.message?.key?.id,
      // key.id diretamente em chat (algumas versões colocam key dentro de chat)
      raw?.chat?.key?.id,
      raw?.data?.chat?.key?.id,
      raw?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.key?.id,
      raw?.data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.key?.id,
      // id plano em diferentes níveis
      raw?.message?.id,
      raw?.data?.message?.id,
      raw?.chat?.id,
      raw?.data?.chat?.id,
      raw?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id,
      raw?.data?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id,
      raw?.id,
      raw?.data?.id
    ].filter(Boolean);
    for (const id of cands) {
      if (typeof id === 'string') {
        const s = id.trim();
        if (!s) continue;
        // Ignora IDs muito curtos (<8) ou parecendo id de CRM (ex.: 'rf...')
        if (s.length < 8 || /^rf[0-9a-z]+$/i.test(s)) continue;
        return { id: s, source: 'explicit-path' };
      }
    }

    // 2) Varredura: procura qualquer objeto com key.id ou id. Não exigimos heurística, mas
    // evitamos capturar o id no topo do payload (ex.: rf4f... da UAZAPI). A primeira ocorrência
    // encontrada é usada. O caminho é registrado para debugging.
    let found = null, foundSource = '';
    const visit = (v, path = 'root') => {
      if (!v || found) return;
      if (typeof v !== 'object') return;

      const idFromKey = v?.key && typeof v.key.id === 'string' ? v.key.id : null;
      const idFlat    = typeof v?.id === 'string' ? v.id : null;
      // Captura key.id, exceto se for a chave da raiz (root.key.id)
      if (!found && idFromKey && path !== 'root') {
        found = idFromKey;
        foundSource = path + '.key.id';
        return;
      }
      // Captura id plano, exceto se for o id do próprio root (payload) ou de data
      if (!found && idFlat) {
        const fullPath = path + '.id';
        if (fullPath !== 'root.id' && fullPath !== 'root.data.id') {
          found = idFlat;
          foundSource = fullPath;
          return;
        }
      }
      for (const [k, val] of Object.entries(v)) {
        visit(val, path + '.' + k);
        if (found) return;
      }
    };
    visit(raw, 'root');
    if (found) return { id: found, source: foundSource };

    return { id: null, source: 'not-found' };
  } catch {
    return { id: null, source: 'error' };
  }
}

// ========== Busca recursiva por aliases comuns + normalização de botões ==========
const norm = (s='') =>
  String(s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g,' ').trim();

function canonicalizeMenuChoice(text='') {
  const t = norm(text);
  if (
    t === 'sim' || t.startsWith('sim,') ||
    t.includes('quero saber mais') || t.startsWith('quero') ||
    /^ok$|^pode$|^pode sim$|^manda$|^manda ai$|^envia$|^pode enviar$|^vamos$/.test(t)
  ) return { isButton: true, value: 'sim' };

  if (
    t === 'nao' || t === 'não' || t.startsWith('nao,') || t.startsWith('não,') ||
    t.includes('encerrar contato') || t.startsWith('encerrar') ||
    t.includes('nao quero') || t.includes('não quero') ||
    t.includes('pode encerrar') || t.includes('pode parar') || t === 'cancelar'
  ) return { isButton: true, value: 'nao' };

  return { isButton: false, value: '' };
}

function deepFindAliases(obj) {
  let foundNumber, foundText, foundType;
  const numberKeys = new Set(['number', 'from', 'phone', 'sender', 'chatid', 'chatId']);
  const textKeys   = new Set(['text', 'body', 'message', 'textMessage', 'caption']);

  function walk(val) {
    if (!val || typeof val !== 'object') return;
    for (const [k, v] of Object.entries(val)) {
      const key = k.toLowerCase();
      if (!foundNumber && numberKeys.has(key) && (typeof v === 'string' || typeof v === 'number')) {
        foundNumber = String(v);
      }
      if (!foundText && textKeys.has(key) && typeof v === 'string') {
        foundText = v;
      }
      if (!foundType && key === 'type' && typeof v === 'string') {
        foundType = v;
      }

      if (!foundText) {
        if (key === 'button_reply' && v && typeof v === 'object') {
          const id = typeof v.id === 'string' && v.id.trim() ? v.id.trim() : null;
          const payload = typeof v.payload === 'string' && v.payload.trim() ? v.payload.trim() : null;
          const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : null;
          const text = typeof v.text === 'string' && v.text.trim() ? v.text.trim() : null;
          foundText = id || payload || title || text;
          if (foundText) foundType = 'button';
        }
        else if (key === 'button' && v && typeof v === 'object') {
          const id = typeof v.id === 'string' && v.id.trim() ? v.id.trim() : null;
          const payload = typeof v.payload === 'string' && v.payload.trim() ? v.payload.trim() : null;
          const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : null;
          const text = typeof v.text === 'string' && v.text.trim() ? v.text.trim() : null;
          foundText = id || payload || title || text;
          if (foundText) foundType = 'button';
        }
        else if (key === 'interactive' && v && typeof v === 'object') {
          const br = v.button_reply || v.buttonReply || null;
          const lr = v.list_reply || v.listReply || null;
          if (br && typeof br === 'object') {
            const id = typeof br.id === 'string' && br.id.trim() ? br.id.trim() : null;
            const payload = typeof br.payload === 'string' && br.payload.trim() ? br.payload.trim() : null;
            const title = typeof br.title === 'string' && br.title.trim() ? v.title.trim() : null;
            const text = typeof br.text === 'string' && br.text.trim() ? br.text.trim() : null;
            foundText = id || payload || title || text;
            if (foundText) foundType = 'button';
          } else if (lr && typeof lr === 'object') {
            const id = typeof lr.id === 'string' && lr.id.trim() ? lr.id.trim() : null;
            const payload = typeof lr.payload === 'string' && lr.payload.trim() ? v.payload.trim() : null;
            const title = typeof lr.title === 'string' && lr.title.trim() ? lr.title.trim() : null;
            const text = typeof lr.text === 'string' && lr.text.trim() ? v.text.trim() : null;
            foundText = id || payload || title || text;
            if (foundText) foundType = 'button';
          }
        }
        else if ((key === 'selectedbuttonid' || key === 'selectedid' || key === 'buttonid') && typeof v === 'string') {
          const val = v.trim();
          if (val) { foundText = val; foundType = 'button'; }
        }
      }

      if (v && typeof v === 'object') walk(v);
    }
  }

  walk(obj);

  // EXTRA: olhar objeto chat desserializado (UAZAPI costuma enviar chat como string -> JSON)
  const chatObj =
    (obj && obj.chat && typeof obj.chat === 'object') ? obj.chat :
    (obj && obj.data && obj.data.chat && typeof obj.data.chat === 'object') ? obj.data.chat :
    null;

  if (chatObj) {
    if (!foundNumber) {
      const n = chatObj.number || chatObj.from || chatObj.phone || chatObj.chatid || chatObj.chatId;
      if (n) foundNumber = String(n);
    }
    if (!foundType && typeof chatObj.type === 'string') foundType = chatObj.type;

    if (!foundText) {
      const maybeText = chatObj.caption || chatObj.text || chatObj.body || chatObj.textMessage;
      if (typeof maybeText === 'string' && maybeText.trim()) foundText = maybeText;
    }
    if (!foundText && !foundType && (chatObj.image || chatObj.imagePreview || chatObj.audio || chatObj.audioMessage)) {
      foundType = (chatObj.audio || chatObj.audioMessage) ? 'audio' : 'image';
    }
  }

  // Fallback: Cloud API
  const cloudMsg = obj?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!foundNumber && cloudMsg?.from) foundNumber = String(cloudMsg.from);
  if (!foundText) {
    if (cloudMsg?.interactive?.button_reply) {
      const br = cloudMsg.interactive.button_reply;
      foundText = br.id || br.payload || br.title || br.text || foundText;
      if (foundText) foundType = 'button';
    } else if (cloudMsg?.button) {
      const b = cloudMsg.button;
      foundText = b.payload || b.id || b.text || foundText;
      if (foundText) foundType = 'button';
    } else {
      foundText = cloudMsg?.text?.body || foundText;
    }
  }
  if (!foundType && cloudMsg?.type) foundType = cloudMsg.type;

  // Normaliza "sim/nao" digitados como botão
  if (foundText && foundType !== 'button') {
    const ali = canonicalizeMenuChoice(foundText);
    if (ali.isButton) {
      foundType = 'button';
      foundText = ali.value;
    }
  }

  return { number: foundNumber, text: foundText, type: foundType ?? 'text' };
}

/** Extrai payload + possível contato (vCard/contacts) */
function extractPayload(raw) {
  const base = deepFindAliases(raw);
  const c = extractContactFromRaw(raw);

  const root = raw || {};
  const chat = (root.chat && typeof root.chat === 'object') ? root.chat
            : (root.data && root.data.chat && typeof root.data.chat === 'object') ? root.data.chat
            : null;

  const hasImage =
    !!(base?.image || base?.imagePreview) ||
    !!(chat?.image || chat?.imagePreview) ||
    !!(root?.message?.image);

  const hasAudio =
    base?.type === 'audio' || base?.type === 'ptt' ||
    !!(base?.audio || base?.audioMessage) ||
    !!(chat?.audio || chat?.audioMessage || chat?.voice || chat?.voiceMessage) ||
    !!(root?.message?.audio || root?.message?.audioMessage || root?.message?.voice);

  // NOVO: extrai WA message id de forma segura
  const { id: waId, source: waIdSource } = getWhatsAppMessageId(root);
  if (LOG_TRANSCR) {
    console.log('🧭 audioId resolver', {
      waIdPreview: waId ? (waId.slice(0,12) + '…' + waId.slice(-6)) : null,
      waIdSource
    });
  }

  return {
    ...base,
    contactName: c.name,
    contactPhone: c.phone,
    hasMedia: !!(hasImage || hasAudio),
    // tenta mesmo se o 'type' tiver vindo como 'media' pela UAZAPI
    audioId: waId && (hasAudio || base?.type === 'media' || base?.type === 'ptt') ? waId : (hasAudio ? waId : null),
  };
}

/** Envia TEXTO (respeita buffer) */
async function sendTextMessage(number, message, opts = {}) {
  // Não aguardamos randomDelay aqui: o próprio queueMessage calculará e enviará
  // o delay adequado para a Uazapi, exibindo "Digitando..." para o usuário.
  await queueMessage(number, message, opts);
}

/** Envia o VÍDEO e, opcionalmente, um follow-up curto (texto vem do prompt) */
async function sendDemoVideo(number, followupText = '') {
  const url = process.env.VIDEO_URL;
  if (!url) {
    console.error('VIDEO_URL não definido. Não foi possível enviar o vídeo.');
    return;
  }
  await randomDelay();
  await queueMedia(number, url, '', { type: 'video' });
  const follow = String(followupText || '').trim() || 'Fez sentido na sua empresa?';
  await sendTextMessage(number, follow); // sem bypassBuffer; queueMessage gerencia delay
}

/** Handoff para humano (mensagens sem bypass) */
async function handoffToHuman(leadNumber, leadName = '', extras = {}) {
  const human = process.env.REDIRECT_PHONE;
  const humanName = process.env.HUMAN_NAME || 'Jonas';
  
  console.log('🔄 HANDOFF INICIADO');
  console.log('   Lead:', leadNumber);
  console.log('   REDIRECT_PHONE:', human || 'NÃO CONFIGURADO');
  
  if (!human) {
    console.error('❌ ERRO: REDIRECT_PHONE não definido no .env — não é possível fazer handoff!');
    console.error('   Configure REDIRECT_PHONE=5511999999999 no arquivo .env');
    return;
  }
  
  const prettyLead = normalizeNumber(leadNumber);

  const lines = ['Novo lead para contato'];
  lines.push(leadName ? `Lead: ${leadName} | WhatsApp: ${prettyLead}` : `Lead WhatsApp: ${prettyLead}`);

  if (extras?.responsavelName || extras?.responsavelPhone) {
    lines.push('Responsável indicado:');
    if (extras?.responsavelName) lines.push(`- Nome: ${extras.responsavelName}`);
    if (extras?.responsavelPhone) lines.push(`- Telefone: ${extras.responsavelPhone}`);
  } else {
    lines.push('Status: Demonstrou interesse e autorizou contato.');
  }

  console.log('✅ Enviando notificação para:', human);
  await randomDelay();
  await queueMessage(human, lines.join('\n')); // Envia pro Jonas

  console.log('✅ HANDOFF CONCLUÍDO - Lead encaminhado com sucesso!');
}

/** Normaliza req.body (aceita payloads “embrulhados” e campos stringificados) */
function normalizeBody(req) {
  let body = req.body;

  // Se veio como string única, tenta parsear
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }

  // Caso clássico: { someKey: "{...json...}" }
  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    if (keys.length === 1 && typeof body[keys[0]] === 'string') {
      try { body = JSON.parse(body[keys[0]]); } catch {}
    }
  }

  // NOVO: parseia campos stringificados comuns (chat, message, data)
  const maybeParse = (v) => {
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  };

  if (body && typeof body === 'object') {
    for (const k of ['chat', 'message', 'data']) {
      if (k in body) body[k] = maybeParse(body[k]);
    }
    if (body.data && typeof body.data === 'object') {
      for (const k of ['chat', 'message']) {
        if (k in body.data) body.data[k] = maybeParse(body.data[k]);
      }
    }
  }

  return body ?? {};
}

/** Processa a mensagem (após debounce/agregação) */
async function handleAggregatedMessage(raw, mergedText) {
  try {
    // Extração de dados (número, texto, mídia, vCard)
    let { number, text, contactName, contactPhone, audioId, hasMedia } = extractPayload(raw);
    
    // IMPORTANTE: Se temos mergedText do buffer, ele tem prioridade total
    // pois contém todas as mensagens agrupadas
    if (mergedText && mergedText.trim()) {
      if (LOG_TRANSCR && text && text !== mergedText) {
        console.log('📝 Texto do payload sobrescrito pelo buffer:', {
          payloadText: short(text, 40),
          mergedText: short(mergedText, 80)
        });
      }
      text = mergedText;
    }

    if (LOG_TRANSCR) {
      console.log('🔎 PROBE (handleAggregatedMessage)', {
        number: maskNumber(number || contactPhone || ''),
        hasText: !!(text && String(text).trim()),
        textLength: text ? String(text).length : 0,
        hasMedia: !!hasMedia,
        audioId: audioId || null,
        textPreview: short(text || '', 80)
      });
    }

    // Caso a mensagem seja um áudio sem texto, baixamos e transcrevemos
    if ((!text || !String(text).trim()) && audioId) {
      try {
        if (LOG_TRANSCR) console.log('🎤 AUDIO → download/transcribe', { audioId, transcribe: true });
        const audioResp = await downloadMessageMedia(audioId, true);

        if (LOG_TRANSCR) {
          console.log('🛰️ UAZAPI ← /message/download keys', Object.keys(audioResp || {}));
          if (typeof audioResp?.transcription === 'string') {
            console.log('📝 UAZAPI transcription (preview)', short(audioResp.transcription));
          }
        }

        let transcribed = '';
        const candidates = ['transcription', 'transcript', 'text', 'texto', 'message', 'mensagem', 'result'];
        for (const key of candidates) {
          if (audioResp && typeof audioResp[key] === 'string' && audioResp[key].trim()) {
            transcribed = audioResp[key].trim();
            break;
          }
        }
        if (!transcribed && audioResp && typeof audioResp === 'object') {
          const scan = (o) => {
            if (!o || typeof o !== 'object' || transcribed) return;
            for (const [, v] of Object.entries(o)) {
              if (typeof v === 'string' && v.trim() && v.split(' ').length > 2) { transcribed = v.trim(); return; }
              if (typeof v === 'object') scan(v);
            }
          };
          scan(audioResp);
        }
        if (!transcribed && audioResp && audioResp.base64) {
          if (LOG_TRANSCR) console.log('🎤 AUDIO → fallback Whisper (OpenAI) com base64');
          try {
            const buffer = Buffer.from(audioResp.base64, 'base64');
            transcribed = await transcribeAudio(buffer, 'audio.mp3');
          } catch (e) {
            console.error('❌ Whisper fallback error:', e?.message || e);
          }
        }
        if (transcribed) {
          if (LOG_TRANSCR) console.log('📝 TRANSCRIPT (final, preview):', short(transcribed));
          text = transcribed;

          // 🔽 NOVO: se o áudio disser claramente "sim"/"não", normaliza como intenção direta
          const ali = canonicalizeMenuChoice(String(text || ''));
          if (ali.isButton) {
            text = ali.value; // 'sim' | 'nao'
            if (LOG_TRANSCR) console.log('✅ Intenção por áudio normalizada como', ali.value);
          }
        } else {
          console.warn('⚠️ Sem transcrição após todas as tentativas.');
        }
      } catch (err) {
        console.error('❌ Falha ao baixar/transcrever áudio:', err?.message || err);
      }
    } else if ((!text || !String(text).trim()) && hasMedia && !audioId) {
      console.warn('⚠️ Mídia recebida, mas sem WhatsApp message id válido — não é possível baixar.');
    }

    if (!number && contactPhone) {
      number = contactPhone;
      contactPhone = '';
    }

    // Agora aceitamos mídia sem texto (desde que tenha número)
    if (!number || (!text && !contactPhone && !audioId && !hasMedia)) {
      console.warn('⚠️ Payload sem {number,text/contact/mídia}. Ignorando processamento.');
      return;
    }

    // Normaliza número
    number = normalizeNumber(number);

    // Se enviou contato sem texto, gera linha para histórico
    let messageForHistory = text;
    if (!text && contactPhone) {
      messageForHistory = `Compartilhou o contato: ${contactName || ''} ${contactPhone}`.trim();
    } else if (audioId && text) {
      // Ao tratar áudio com texto, registramos apenas o texto puro no histórico
      // para que a IA reaja como se fosse uma mensagem digitada e evite fluxos errados.
      messageForHistory = text;
    } else if (!text && hasMedia) {
      messageForHistory = '[mídia recebida]';
    }

    // Registra no histórico (apenas user/assistant)
    if (messageForHistory) {
      if (LOG_TRANSCR) console.log('📚 HIST add (user):', short(messageForHistory));
      await appendToHistory(number, 'user', String(messageForHistory));
    }

    // Conversa inteira é decidida pela IA (prompt) — inclusive a 1ª mensagem
    const histAll = await getHistory(number);
    const historyForAI = histAll.filter(m => m.role === 'user' || m.role === 'assistant');

    const result = await generateReplyWithTools(historyForAI, number);
    if (!result) return;

    console.log('🤖 RESPOSTA DA IA RECEBIDA:');
    console.log('   tool_calls:', result.tool_calls ? `${result.tool_calls.length} chamadas` : 'nenhuma');
    console.log('   function_call:', result.function_call ? result.function_call.name : 'nenhuma');
    console.log('   content:', result.content ? `"${result.content.substring(0, 50)}..."` : 'vazio');

    // OTIMIZAÇÃO: Processa TODAS as tool calls, não apenas a primeira
    // Isso permite que Luna envie múltiplas mensagens em sequência
    const toolCalls = [];
    if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
      // Formato moderno: tool_calls array
      for (const tc of result.tool_calls) {
        if (tc && tc.function) {
          console.log('   📞 Tool call detectada:', tc.function.name);
          toolCalls.push({ name: tc.function.name, arguments: tc.function.arguments });
        }
      }
    } else if (result.function_call) {
      // Formato legado: function_call único
      console.log('   📞 Function call detectada:', result.function_call.name);
      toolCalls.push({ name: result.function_call.name, arguments: result.function_call.arguments });
    }
    
    console.log('   Total de funções a executar:', toolCalls.length);

    // Implementação das ferramentas chamadas pela IA
    const mapping = {
      async send_text(a) {
        const msg = a.message || '';
        if (!msg) return;
        await queueMessage(a.number, msg);
        await appendToHistory(number, 'assistant', msg);
      },
      async send_menu(a) {
        // Anti‑duplicação de menu em janela curta. Se tentar enviar outro menu
        // em sequência, respondemos com um texto de fallback para evitar
        // silêncio — a IA pode pedir menu novamente logo após o usuário
        // interagir, mas queremos dar um feedback curto.
        const now = Date.now();
        const last = lastMenuAt.get(a.number) || 0;
        const text = a.text || '';
        const choices = Array.isArray(a.choices) ? a.choices : [];
        const footer = a.footerText || 'Escolha uma das opções';
        if (now - last < MENU_DEDUP_WINDOW_MS) {
          // Menu foi enviado recentemente — em vez de silenciar, envia
          // o mesmo texto introdutório (ou uma frase padrão) como mensagem.
          const fallback = text && text.trim()
            ? text.trim()
            : 'Certo! Me diga SIM ou NÃO para eu continuar.';
          await queueMessage(a.number, fallback);
          if (fallback) await appendToHistory(number, 'assistant', fallback);
          console.log('↪️ Menu deduplicado. Enviado fallback de texto.');
          return;
        }
        const menuPayload = { type: 'button', text, choices, footerText: footer };
        await queueMenu(a.number, menuPayload);
        lastMenuAt.set(a.number, now);
        if (text) await appendToHistory(number, 'assistant', text);
      },
      async handoff(a) {
        console.log('📲 FUNÇÃO HANDOFF CHAMADA!');
        console.log('   Argumentos:', JSON.stringify(a));
        const extras = {};
        if (a.responsible_name) extras.responsavelName = a.responsible_name;
        if (a.responsible_phone) extras.responsavelPhone = normalizeNumber(a.responsible_phone);
        await appendToHistory(number, 'assistant', '[handoff]');
        let leadName = '';
        try {
          const hist = await getHistory(number);
          for (const m of hist) {
            if (m.role === 'meta') {
              const st = JSON.parse(m.content);
              if (st && st.leadName) { leadName = st.leadName; break; }
            }
          }
        } catch {}
        console.log('   Chamando handoffToHuman...');
        await handoffToHuman(a.number, leadName, extras);
      },
    };

    // Processa todas as tool calls em sequência
    if (toolCalls.length > 0) {
      console.log('⚙️ EXECUTANDO FUNÇÕES...');
      for (const call of toolCalls) {
        const { name, arguments: argsRaw } = call;
        console.log(`   🔧 Executando: ${name}`);
        let args;
        try {
          args = argsRaw ? JSON.parse(argsRaw) : {};
        } catch (err) {
          console.error('Erro ao parsear argumentos da função:', err);
          args = {};
        }
        if (args && args.number === 'user_number') {
          args.number = number;
        }
        if (name === 'handoff') {
          console.log('   🎯 HANDOFF DETECTADO! Preparando para executar...');
          if (contactPhone && !args.responsible_phone) {
            args.responsible_phone = normalizeNumber(contactPhone);
          }
          if (contactName && !args.responsible_name) {
            args.responsible_name = contactName;
          }
        }

        if (mapping[name]) {
          await mapping[name](args || {});
          console.log(`   ✅ ${name} executado!`);
        } else {
          console.warn('❌ Chamada de função desconhecida:', name);
        }
      }
    } else if (result.content) {
      console.log('💬 IA respondeu com texto puro (sem funções)');
      const msg = result.content.trim();
      if (msg) {
        await queueMessage(number, msg);
        await appendToHistory(number, 'assistant', msg);
      }
    }
  } catch (err) {
    console.error('❌ Erro processando mensagem (aggregated):', err);
  }
}

/** Webhook: aceita /webhook e /webhooks */
app.post(['/webhook', '/webhooks'], async (req, res) => {
  const raw = normalizeBody(req);

  // Log seguro do payload
  try {
    const rawStr = JSON.stringify(raw);
    const preview = rawStr.length > 1000 ? rawStr.slice(0, 1000) + '... (truncado)' : rawStr;
    console.log('🛰️ Webhook recebido (pré):', preview);
  } catch {
    console.log('🛰️ Webhook recebido (pré): payload não serializável.');
  }

  // Precisamos do número para agrupar por usuário
  const probe = extractPayload(raw);
  if (LOG_TRANSCR) {
    console.log('🔎 PROBE (webhook)', {
      number: maskNumber(probe.number || probe.contactPhone || ''),
      type: probe.type,
      hasText: !!(probe.text && probe.text.trim()),
      hasMedia: !!probe.hasMedia,
      audioId: probe.audioId || null,
      textPreview: short(probe.text || ''),
    });
  }
  if (!probe?.number && !probe?.contactPhone) {
    console.warn('⚠️ Payload sem {number/contact}. ACK 200.');
    return res.status(200).send('ACK: payload sem number/contact.');
  }

  const number = normalizeNumber(probe.number || probe.contactPhone || '');

  // ⚡ ATIVA "DIGITANDO" IMEDIATAMENTE (feedback visual instantâneo)
  // O status fica ativo durante todo o processamento (buffer + IA)
  setTypingStatus(number).catch(() => {}); // Non-blocking, erro não é crítico
  
  // 🛡️ PROTEÇÃO EXTRA: Verifica se já existe entrada sendo processada
  // Isso previne que webhooks duplicados ou muito rápidos criem múltiplos processamentos
  const existingEntry = pendingByUser.get(number);
  if (existingEntry?.processing) {
    console.log(`🚫 Mensagem ignorada - buffer já está processando para ${maskNumber(number)}`);
    return res.sendStatus(200);
  }

  // ✅ Clique de BOTÃO: processa com ou sem buffer baseado na config
  if (probe.type === 'button') {
    if (!BUFFER_BUTTONS) {
      // Botões processados IMEDIATAMENTE (padrão - melhor UX)
      try {
        await handleAggregatedMessage(raw, probe.text || '');
      } catch (e) {
        console.error('handleAggregatedMessage (button) error', e);
      }
      return res.sendStatus(200);
    }
    // Se BUFFER_BUTTONS=true, botões passam pelo buffer normal (cai no código abaixo)
  }

  // 🔁 Mensagens comuns (e botões se BUFFER_BUTTONS=true): Buffer de 7s
  const entry = pendingByUser.get(number) || { 
    combinedText: '', 
    lastRaw: null, 
    timer: null, 
    processing: false,
    messageCount: 0 
  };
  
  // Previne race condition: se já está processando, ignora novas mensagens
  if (entry.processing) {
    console.log(`⏳ Buffer já processando para ${maskNumber(number)}, ACK sem adicionar ao buffer`);
    return res.sendStatus(200);
  }
  
  const newTextPart = probe.text || '';
  const previousText = entry.combinedText;
  entry.combinedText = [entry.combinedText, newTextPart].filter(Boolean).join(' ').trim();
  entry.lastRaw = raw;
  entry.messageCount = (entry.messageCount || 0) + 1;

  if (LOG_TRANSCR) {
    console.log('🔄 Buffer atualizado:', {
      number: maskNumber(number),
      messageCount: entry.messageCount,
      previousText: short(previousText, 50),
      newText: short(newTextPart, 50),
      combinedText: short(entry.combinedText, 80),
      timerActive: !!entry.timer
    });
  }

  if (entry.timer) {
    console.log(`⏱️ Timer cancelado para ${maskNumber(number)}, reiniciando contagem (${USER_MERGE_WINDOW_MS}ms)`);
    clearTimeout(entry.timer);
  }
  
  entry.timer = setTimeout(async () => {
    console.log(`⚡ Timer disparado para ${maskNumber(number)}:`, {
      messageCount: entry.messageCount,
      combinedText: short(entry.combinedText, 100)
    });
    
    entry.processing = true;
    try {
      await handleAggregatedMessage(entry.lastRaw, entry.combinedText);
    } catch (e) {
      console.error('handleAggregatedMessage error', e);
    } finally {
      pendingByUser.delete(number);
      console.log(`✅ Buffer processado e limpo para ${maskNumber(number)}`);
    }
  }, USER_MERGE_WINDOW_MS);

  pendingByUser.set(number, entry);
  return res.sendStatus(200); // ACK imediato
});

// Health check
app.get('/', (_req, res) => {
  res.send('Uazapi bot is running.');
});

app.listen(PORT, () => {
  console.log(`✅ Bot server listening on port ${PORT}`);
});
