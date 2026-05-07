import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

const PORT = Number(process.env.PORT || 3000);
const BUILD_ID = 'fast-intake-v3-error-fallback';
const processedMessageIds = new Set();
const fastIntakeHandoffKeys = new Set();
const fastIntakeReplyKeys = new Set();

function rememberMessage(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
  return false;
}

function rememberBounded(set, key, maxSize = 1000) {
  if (!key) return false;
  if (set.has(key)) return true;
  set.add(key);
  if (set.size > maxSize) {
    const first = set.values().next().value;
    set.delete(first);
  }
  return false;
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') {
    return new Date(value < 10000000000 ? value * 1000 : value).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function contentHash(...parts) {
  return createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('|'))
    .digest('hex');
}

function boolEnv(primary, fallback) {
  const value = process.env[primary] ?? process.env[fallback];
  return value === 'true';
}

function hasEnv(...names) {
  return names.some((name) => Boolean(process.env[name]));
}

function getGatewayConfig() {
  const conversationManagerMode = process.env.CONVERSATION_MANAGER_MODE || process.env.GATEWAY_MODE || 'shadow';
  const inboundEnabled = boolEnv('HUMANIO_ENABLE_INBOUND_SEND', 'ENABLE_CHATWOOT_REPLY');
  const outboundEnabled = boolEnv('HUMANIO_ENABLE_OUTBOUND_SEND', 'ENABLE_WHATSAPP_SEND');
  const fastIntakeEnabled = process.env.GATEWAY_FAST_INTAKE === 'true';
  const paperclipConfigured = hasEnv('PAPERCLIP_API_URL') &&
    hasEnv('COMPANY_ID') &&
    hasEnv('CONVERSATION_MANAGER_AGENT_ID') &&
    hasEnv('PAPERCLIP_API_TOKEN', 'PAPERCLIP_API_KEY', 'PAPERCLIP_AGENT_TOKEN');
  const chatwootConfigured = hasEnv('CHATWOOT_API_URL') && hasEnv('CHATWOOT_API_TOKEN') && hasEnv('CHATWOOT_ACCOUNT_ID');
  const whatsappConfigured = hasEnv('WHATSAPP_PHONE_NUMBER_ID') && hasEnv('WHATSAPP_CLOUD_API_TOKEN');
  const supabaseConfigured = hasEnv('SUPABASE_URL') && hasEnv('SUPABASE_SERVICE_KEY');
  const readyForShadow = process.env.ENABLE_PAPERCLIP_EVENTS === 'true' && paperclipConfigured;
  const readyForInboundSend = conversationManagerMode === 'active' && inboundEnabled && (chatwootConfigured || whatsappConfigured);
  const readyForOutboundSend = conversationManagerMode === 'active' && outboundEnabled && whatsappConfigured;

  return {
    conversation_manager_mode: conversationManagerMode,
    gateway_mode: process.env.GATEWAY_MODE || 'shadow',
    inbound_enabled: inboundEnabled,
    outbound_enabled: outboundEnabled,
    paperclip_events_enabled: process.env.ENABLE_PAPERCLIP_EVENTS === 'true',
    fast_intake_enabled: fastIntakeEnabled,
    chatwoot_reply_enabled: process.env.ENABLE_CHATWOOT_REPLY === 'true',
    whatsapp_send_enabled: process.env.ENABLE_WHATSAPP_SEND === 'true',
    inbox_filter: process.env.CHATWOOT_WHATSAPP_INBOX_ID || null,
    configured: {
      paperclip: paperclipConfigured,
      chatwoot: chatwootConfigured,
      whatsapp: whatsappConfigured,
      supabase: supabaseConfigured,
    },
    ready: {
      shadow_event_ingest: readyForShadow,
      inbound_send: readyForInboundSend,
      outbound_send: readyForOutboundSend,
    },
  };
}

function shouldSuppressPaperclipFallbackForFastIntake(config) {
  return config.fast_intake_enabled &&
    config.conversation_manager_mode === 'active' &&
    config.inbound_enabled &&
    config.configured.chatwoot;
}

function chatwootBaseUrl() {
  return String(process.env.CHATWOOT_API_URL || '').replace(/\/+$/, '');
}

function chatwootHeaders() {
  return {
    api_access_token: process.env.CHATWOOT_API_TOKEN || '',
    'Content-Type': 'application/json',
  };
}

function paperclipToken() {
  return process.env.PAPERCLIP_API_TOKEN || process.env.PAPERCLIP_API_KEY || process.env.PAPERCLIP_AGENT_TOKEN;
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function extractPhone(text) {
  const match = String(text || '').match(/(?:\+?\d[\s().-]*){8,}/);
  return match ? normalizePhone(match[0]) : '';
}

function normalizeMessagesResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.payload)) return payload.payload;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

async function fetchChatwootMessages(conversationId) {
  if (!conversationId || !process.env.CHATWOOT_ACCOUNT_ID || !chatwootBaseUrl()) return [];

  const res = await fetch(
    `${chatwootBaseUrl()}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    { headers: chatwootHeaders() },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chatwoot_messages_failed:${res.status}:${text}`);
  }

  return normalizeMessagesResponse(await res.json())
    .filter((message) => !message.private)
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
}

async function sendChatwootMessage(conversationId, content) {
  const res = await fetch(
    `${chatwootBaseUrl()}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: chatwootHeaders(),
      body: JSON.stringify({
        content,
        message_type: 'outgoing',
        private: false,
      }),
    },
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`chatwoot_send_failed:${res.status}:${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isOutgoingMessage(message) {
  const type = String(message.message_type || '').toLowerCase();
  return type === 'outgoing' || type === '1';
}

function detectQuestionType(content) {
  const text = stripTags(content).toLowerCase();
  if (text.includes('nombre') && text.includes('negocio')) return 'nombre_negocio';
  if (text.includes('servicio') || text.includes('producto') || text.includes('giro')) return 'giro';
  if (text.includes('ciudad')) return 'ciudad';
  if (text.includes('pagina web') || text.includes('página web') || text.includes('redes')) return 'web_o_redes';
  if (text.includes('telefono') || text.includes('teléfono') || text.includes('whatsapp')) return 'telefono';
  return null;
}

function assignIntakeAnswer(state, questionType, content) {
  const answer = stripTags(content);
  if (!answer) return;

  if (questionType === 'nombre_negocio' && !state.nombre_negocio) state.nombre_negocio = answer;
  if (questionType === 'giro' && !state.giro) state.giro = answer;
  if (questionType === 'ciudad' && !state.ciudad) state.ciudad = answer;
  if (questionType === 'web_o_redes' && !state.web_o_redes) state.web_o_redes = answer;
  if (questionType === 'telefono' && !state.telefono) state.telefono = extractPhone(answer) || answer;

  const phone = extractPhone(answer);
  if (phone) state.telefono = state.telefono || phone;
}

function buildIntakeState(messages, event) {
  const state = {
    nombre_contacto: event.sender_name || '',
    nombre_negocio: '',
    giro: '',
    ciudad: '',
    web_o_redes: '',
    telefono: event.sender_phone || '',
    ultimo_mensaje: stripTags(event.content),
    last_question: null,
  };

  let lastQuestion = null;
  for (const message of messages) {
    const content = stripTags(message.content);
    if (!content) continue;

    if (isOutgoingMessage(message)) {
      lastQuestion = detectQuestionType(content);
      state.last_question = lastQuestion || state.last_question;
      continue;
    }

    if (lastQuestion) {
      assignIntakeAnswer(state, lastQuestion, content);
      lastQuestion = null;
      continue;
    }

    const phone = extractPhone(content);
    if (phone) state.telefono = state.telefono || phone;
  }

  return state;
}

function nextIntakeReply(state, event) {
  const content = stripTags(event.content).toLowerCase();
  const wantsDemo = content.includes('demo') || content.includes('propuesta') || content.includes('pagina') || content.includes('página') || content.includes('chatbot');

  if (!state.nombre_negocio) {
    return wantsDemo
      ? 'Claro, con gusto. Para prepararte una demo aterrizada, ¿cual es el nombre exacto de tu negocio?'
      : 'Claro, te ayudo. Para aterrizarlo bien, ¿cual es el nombre de tu negocio?';
  }

  if (!state.giro) return 'Perfecto. ¿Que servicio o producto principal ofreces?';
  if (!state.ciudad) return 'Gracias. ¿En que ciudad atiende tu negocio?';
  if (!state.web_o_redes) return 'Gracias. ¿Tienes pagina web o redes sociales actualmente?';
  return null;
}

function compactDemoPayload(event, state) {
  return {
    event_type: 'demo_request',
    source: 'gateway_fast_intake',
    run_scope: 'single_request',
    channel: 'chatwoot_whatsapp',
    conversation_id: event.conversation_id,
    contact_phone: state.telefono || event.sender_phone,
    contact_email: '',
    nombre_contacto: state.nombre_contacto || event.sender_name || '',
    nombre_negocio: state.nombre_negocio,
    giro: state.giro,
    ciudad: state.ciudad,
    web_o_redes: state.web_o_redes || 'No proporcionado',
    ultimo_mensaje: state.ultimo_mensaje,
    intent: 'demo_request',
    resumen: 'Lead inbound con interes; intake minimo capturado por Hannia desde gateway.',
    datos_faltantes: [],
    instruccion_ceo: 'Decidir si ruta va a Closer demo intake o demo directa. No cargar historial completo.',
  };
}

function yamlFromObject(object) {
  return Object.entries(object)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        if (!value.length) return `${key}: []`;
        return `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join('\n')}`;
      }
      return `${key}: ${JSON.stringify(value)}`;
    })
    .join('\n');
}

async function createPaperclipIssue({ title, body, assigneeAgentId, metadata, runId }) {
  const paperclipBase = process.env.PAPERCLIP_API_URL;
  const companyId = process.env.COMPANY_ID;
  const token = paperclipToken();

  if (!paperclipBase || !companyId || !assigneeAgentId || !token) {
    throw new Error('paperclip_not_configured');
  }

  const res = await fetch(`${paperclipBase}/api/companies/${companyId}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Paperclip-Run-Id': runId || `chatwoot-gateway-${Date.now()}`,
    },
    body: JSON.stringify({
      title,
      assigneeAgentId,
      status: 'todo',
      priority: 'medium',
      body,
      description: body,
      content: body,
      metadata,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`paperclip_issue_failed:${res.status}:${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function runFastIntake(event) {
  const config = getGatewayConfig();
  if (!config.fast_intake_enabled || config.conversation_manager_mode !== 'active' || !config.inbound_enabled || !config.configured.chatwoot) {
    return { handled: false, reason: 'fast_intake_disabled_or_not_ready' };
  }

  const messages = await fetchChatwootMessages(event.conversation_id);
  const state = buildIntakeState(messages, event);
  const reply = nextIntakeReply(state, event);

  if (reply) {
    const replyKey = contentHash(event.conversation_id, event.content_hash, reply);
    if (rememberBounded(fastIntakeReplyKeys, replyKey, 1000)) {
      return {
        handled: true,
        complete: false,
        duplicate_reply_suppressed: true,
        reply,
        state,
      };
    }

    const sent = await sendChatwootMessage(event.conversation_id, reply);
    return {
      handled: true,
      complete: false,
      reply,
      chatwoot_message_id: sent.id || sent.message_id || null,
      state,
    };
  }

  const handoffKey = contentHash(event.conversation_id, state.nombre_negocio, state.giro, state.ciudad, state.web_o_redes);
  if (fastIntakeHandoffKeys.has(handoffKey)) {
    return { handled: false, reason: 'fast_intake_already_handed_off', state };
  }
  rememberBounded(fastIntakeHandoffKeys, handoffKey, 500);

  const confirmation = `Perfecto, ya tengo suficiente informacion para preparar tu demo. Gracias, ${state.nombre_contacto || 'te contacto pronto'}. Ya comparto tu caso con el equipo de Humanio para avanzar con la propuesta.`;
  const sent = await sendChatwootMessage(event.conversation_id, confirmation);
  const payload = compactDemoPayload(event, state);
  const yaml = yamlFromObject(payload);
  const body = [
    'Gateway fast intake completed.',
    '',
    '```yaml',
    yaml,
    '```',
  ].join('\n');
  const assigneeAgentId = process.env.CEO_AGENT_ID || process.env.CONVERSATION_MANAGER_AGENT_ID;
  const created = await createPaperclipIssue({
    title: `CEO: iniciar flujo demo inbound - ${state.nombre_negocio}`,
    body,
    assigneeAgentId,
    metadata: {
      event_type: 'demo_request',
      source: 'gateway_fast_intake',
      conversation_id: event.conversation_id,
      message_id: event.message_id,
      content_hash: event.content_hash,
    },
    runId: `gateway-fast-intake-${event.conversation_id}-${event.message_id || Date.now()}`,
  });

  return {
    handled: true,
    complete: true,
    reply: confirmation,
    chatwoot_message_id: sent.id || sent.message_id || null,
    paperclip_issue: created,
    state,
  };
}

function isIgnoredChatwootEvent(body, message, event) {
  const eventName = String(body.event || body.event_type || body.name || '').toLowerCase();
  const messageType = String(message.message_type || body.message_type || '').toLowerCase();

  if (message.private === true || body.private === true) return 'private_message';
  if (messageType === 'outgoing' || messageType === '1') return 'outgoing_message';
  if (eventName.includes('status') || eventName.includes('delivery') || eventName.includes('read')) {
    return 'status_event';
  }
  if (eventName && !['message_created', ''].includes(eventName)) return `unsupported_event:${eventName}`;
  if (!String(message.content || body.content || '').trim() && !(message.attachments || body.attachments || []).length) {
    return 'empty_message';
  }
  return null;
}

app.get('/health', async () => ({
  ok: true,
  service: 'humanio-conversation-gateway',
  build_id: BUILD_ID,
  ...getGatewayConfig(),
}));

app.get('/', async () => ({
  ok: true,
  service: 'humanio-conversation-gateway',
  build_id: BUILD_ID,
  routes: ['/health', '/webhooks/chatwoot'],
}));

app.post('/webhooks/chatwoot', async (request, reply) => {
  const body = request.body || {};

  const message = body.message || body;
  const conversation = body.conversation || message.conversation || {};
  const sender = body.sender || message.sender || body.contact || conversation.meta?.sender || {};
  const inboxId = String(conversation.inbox_id || body.inbox_id || '');
  const messageId = String(message.id || body.id || '');
  const ignoredReason = isIgnoredChatwootEvent(body, message);

  if (ignoredReason) {
    app.log.info({ ignoredReason, messageId, inboxId }, 'chatwoot event ignored');
    return reply.code(200).send({
      ok: true,
      ignored: true,
      ignored_reason: ignoredReason,
      external_messages_sent: false,
    });
  }

  if (process.env.CHATWOOT_WHATSAPP_INBOX_ID && inboxId !== String(process.env.CHATWOOT_WHATSAPP_INBOX_ID)) {
    app.log.info({ inboxId }, 'chatwoot event ignored by inbox filter');
    return reply.code(200).send({
      ok: true,
      ignored: true,
      ignored_reason: 'non_whatsapp_inbox',
      external_messages_sent: false,
    });
  }

  if (rememberMessage(messageId)) {
    app.log.info({ messageId }, 'chatwoot event ignored as duplicate');
    return reply.code(200).send({
      ok: true,
      ignored: true,
      ignored_reason: 'duplicate_message',
      external_messages_sent: false,
    });
  }

  const event = {
    event_type: 'inbound_chatwoot_event',
    source: 'chatwoot',
    source_detail: 'chatwoot_gateway',
    conversation_id: String(conversation.id || body.conversation_id || ''),
    message_id: messageId,
    inbox_id: inboxId,
    sender_phone: String(sender.phone_number || sender.phone || '').replace(/\D/g, ''),
    sender_name: sender.name || 'unknown',
    content: message.content || body.content || '',
    attachments: message.attachments || body.attachments || [],
    created_at: normalizeDate(message.created_at || body.created_at),
    content_hash: contentHash(conversation.id || body.conversation_id, messageId, message.content || body.content),
    conversation_manager_mode: getGatewayConfig().conversation_manager_mode,
    humanio_enable_outbound_send: getGatewayConfig().outbound_enabled,
    humanio_enable_inbound_send: getGatewayConfig().inbound_enabled,
    shadow_mode_expected: getGatewayConfig().conversation_manager_mode !== 'active',
    credential_flags: getGatewayConfig().configured,
  };

  app.log.info({ event }, 'chatwoot event received');

  let fastIntakeError = null;
  try {
    const fastIntakeResult = await runFastIntake(event);
    if (fastIntakeResult.handled) {
      app.log.info({ fastIntakeResult }, 'gateway fast intake handled event');
      return reply.code(200).send({
        ok: true,
        mode: getGatewayConfig().conversation_manager_mode,
        gateway_fast_intake: true,
        fast_intake_complete: Boolean(fastIntakeResult.complete),
        external_messages_sent: true,
        paperclip_event_created: Boolean(fastIntakeResult.paperclip_issue),
      });
    }
    app.log.info({ reason: fastIntakeResult.reason }, 'gateway fast intake skipped');
  } catch (error) {
    fastIntakeError = error;
    event.fast_intake_error = error.message || String(error);
    app.log.error({ error }, 'gateway fast intake failed; falling back to Paperclip event');
  }

  if (!fastIntakeError && shouldSuppressPaperclipFallbackForFastIntake(getGatewayConfig())) {
    app.log.warn({ conversation_id: event.conversation_id, message_id: event.message_id }, 'paperclip fallback suppressed during gateway fast intake');
    return reply.code(200).send({
      ok: true,
      mode: getGatewayConfig().conversation_manager_mode,
      gateway_fast_intake: true,
      paperclip_event_created: false,
      external_messages_sent: false,
      suppressed_reason: 'fast_intake_partial_event',
    });
  }

  if (process.env.ENABLE_PAPERCLIP_EVENTS === 'true') {
    const agentId = process.env.CONVERSATION_MANAGER_AGENT_ID;

    const yaml = yamlFromObject(event);
    const issueBody = [
      'ConversationManager inbound event payload.',
      '',
      '```yaml',
      yaml,
      '```',
      '',
      'Operative instruction:',
      '- Process this as MODO A / inbound_chatwoot_event.',
      '- Do not send external messages unless runtime flags authorize it.',
      '- In shadow mode, classify and create internal handoff only.',
    ].join('\n');

    try {
      await createPaperclipIssue({
        title: `ConversationManager: evento Chatwoot ${event.conversation_id || 'sin-id'}`,
        assigneeAgentId: agentId,
        body: issueBody,
        metadata: {
          event_type: event.event_type,
          source: event.source,
          conversation_id: event.conversation_id,
          message_id: event.message_id,
          content_hash: event.content_hash,
        },
        runId: `chatwoot-gateway-${event.message_id || Date.now()}`,
      });
    } catch (error) {
      app.log.error({ error }, 'paperclip issue create crashed');
    }
  }

  return reply.code(200).send({
    ok: true,
    mode: getGatewayConfig().conversation_manager_mode,
    external_messages_sent: false,
  });
});

app.listen({ port: PORT, host: '0.0.0.0' });
