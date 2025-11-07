// src/openaiClient.js

/**
 * Cliente OpenAI (SDK v4) usando a Responses API — compatível com GPT-5 / GPT-5-mini.
 * - Usa `input` em vez de `messages`.
 * - Usa `max_output_tokens` em vez de `max_tokens`.
 * - Não envia `temperature` para evitar 400 “unsupported parameter”.
 */
import OpenAI from 'openai';
import { OPENAI_API_KEY, PRODUCT_PROMPT } from './config.js';
import { defaultPrompt } from './prompt.js';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY não definido.');
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Use GPT‑5‑mini by default or allow override via env. GPT‑5‑mini is configured for
// the new function calling capabilities. If OPENAI_MODEL is set, it takes precedence.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
// OTIMIZAÇÃO: Reduzido de 500 para 300 tokens - Luna deve ser concisa (1-2 frases)
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 300);

export async function generateReply(history, promptOverride = PRODUCT_PROMPT || defaultPrompt) {
  // OTIMIZAÇÃO: Prompt direto sem adições desnecessárias
  const variationPrompt = (promptOverride || '').trim();
  const messages = [];
  messages.push({ role: 'system', content: variationPrompt });
  for (const m of history) {
    if (!m || !m.role || !m.content) continue;
    if (m.role === 'meta') continue;
    let role = m.role;
    if (role !== 'user' && role !== 'assistant') role = 'user';
    messages.push({ role, content: m.content });
  }
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    });
    const text = (resp?.choices?.[0]?.message?.content || '').trim();
    return text || 'Certo! Como posso te ajudar?';
  } catch (err) {
    console.error('OpenAI error:', {
      status: err?.status,
      code: err?.code,
      param: err?.param,
      message: err?.error?.message || err?.message,
      request_id: err?.headers?.['x-request-id'] || err?.request_id,
    });
    return 'Tive um problema técnico ao gerar a resposta agora. Posso tentar novamente em instantes?';
  }
}

/**
 * Generate a reply using Chat Completions API with function calling.
 * OTIMIZAÇÃO: Usa menos tokens filtrando mensagens meta do histórico
 */
export async function generateReplyWithTools(history, number, promptOverride = PRODUCT_PROMPT || defaultPrompt) {
  const systemPrompt = (promptOverride || '').trim();
  const messages = [];
  messages.push({ role: 'system', content: systemPrompt });
  for (const m of history) {
    if (!m || !m.role || !m.content) continue;
    if (m.role === 'meta') continue;
    let role = m.role;
    if (role !== 'user' && role !== 'assistant') role = 'user';
    messages.push({ role, content: m.content });
  }
  const functions = [
    {
      name: 'send_text',
      description: 'Envia uma mensagem de texto simples via WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Sempre use "user_number".' },
          message: { type: 'string', description: 'Texto a ser enviado.' },
        },
        required: ['number', 'message'],
      },
    },
    {
      name: 'send_menu',
      description: 'Envia um menu interativo com botões (com um texto introdutório).',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Sempre use "user_number".' },
          text: { type: 'string', description: 'Texto introdutório do menu.' },
          choices: {
            type: 'array',
            items: { type: 'string', description: 'Formato "Rótulo|valor".' },
          },
          footerText: { type: 'string', nullable: true },
        },
        required: ['number', 'text', 'choices'],
      },
    },
    {
      name: 'handoff',
      description: 'Encaminha para o Jonas (humano).',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Sempre use "user_number".' },
          responsible_name: { type: 'string', nullable: true },
          responsible_phone: { type: 'string', nullable: true },
        },
        required: ['number'],
      },
    },
  ];
  try {
    // Converte functions para o formato tools (novo padrão da OpenAI)
    const tools = functions.map(f => ({ type: 'function', function: f }));
    
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    });
    const choice = resp?.choices?.[0]?.message || {};
    
    console.log('📤 OpenAI Response:');
    console.log('   tool_calls:', choice.tool_calls?.length || 0);
    console.log('   content:', choice.content ? 'sim' : 'não');
    
    return choice;
  } catch (err) {
    console.error('OpenAI function-call error:', {
      status: err?.status,
      code: err?.code,
      param: err?.param,
      message: err?.error?.message || err?.message,
      request_id: err?.headers?.['x-request-id'] || err?.request_id,
    });
    return { role: 'assistant', content: 'Tive um problema técnico ao gerar a resposta agora. Posso tentar novamente em instantes?' };
  }
}

/**
 * Transcreve um arquivo de áudio usando Whisper.
 * @param {Buffer} audioBuffer
 * @param {string} fileName
 * @returns {Promise<string>}
 */
export async function transcribeAudio(audioBuffer, fileName = 'audio.mp3') {
  try {
    if (!audioBuffer) return '';
    const resp = await openai.audio.transcriptions.create({
      file: audioBuffer,
      filename: fileName,
      model: 'whisper-1',
    });
    const txt = resp?.text || resp?.transcription || '';
    return typeof txt === 'string' ? txt.trim() : '';
  } catch (err) {
    console.error('Erro ao transcrever áudio via OpenAI:', {
      status: err?.status,
      code: err?.code,
      message: err?.error?.message || err?.message,
    });
    return '';
  }
}
