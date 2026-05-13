import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

const PORT = Number(process.env.PORT || 3000);
const BUILD_ID = 'fast-intake-v6-info-before-demo';
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

function normalizeText(value) {
  return stripTags(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¡!¿?.,;:\s]+/g, ' ')
    .trim();
}

function isPureGreeting(content) {
  const text = normalizeText(content);
  return [
    'hola',
    'buen dia',
    'buenos dias',
    'buenas',
    'buenas tardes',
    'buenas noches',
    'que tal',
  ].includes(text);
}

function hasCommercialIntent(content) {
  const text = normalizeText(content);
  return [
    'demo',
    'propuesta',
    'pagina',
    'web',
    'sitio',
    'chatbot',
    'bot',
    'automatizacion',
    'precio',
    'paquete',
  ].some((term) => text.includes(term));
}

function hasDemoIntent(content) {
  const text = normalizeText(content);
  return [
    'demo',
    'propuesta',
    'quiero verla',
    'pagina web',
    'página web',
    'web con chatbot',
    'chatbot para mi negocio',
  ].some((term) => text.includes(term));
}

function hasInfoIntent(content) {
  const text = normalizeText(content);
  return [
    'como funciona',
    'cómo funciona',
    'como trabajan',
    'que hacen',
    'qué hacen',
    'de que se trata',
    'de qué se trata',
    'quiero saber',
    'quiero informacion',
    'quiero info',
    'mas informacion',
    'más informacion',
  ].some((term) => text.includes(term));
}

function isAffirmative(content) {
  const text = normalizeText(content);
  return [
    'si',
    'sí',
    'claro',
    'ok',
    'va',
    'adelante',
    'por favor',
    'si por favor',
    'me interesa',
    'quiero',
    'quiero verla',
    'hazla',
  ].some((term) => text === term || text.includes(term));
}

function asksForDemoConfirmation(content) {
  const text = normalizeText(content);
  return text.includes('quieres que te prepare una demo') ||
    text.includes('quieres que prepare una demo') ||
    text.includes('quieres que te arme una demo');
}

function isDemoHandoffAnnouncement(content) {
  const text = normalizeText(content);
  return text.includes('ya comparto tu caso') ||
    text.includes('equipo de humanio para avanzar con la propuesta') ||
    text.includes('preparar tu demo');
}

function howItWorksReply({ includeIntro = false, includeQuestion = false } = {}) {
  const intro = includeIntro ? '¡Hola! Soy Hannia de Humanio. ' : '';
  const explanation = `${intro}Funciona así: creamos una página web para tu negocio y la conectamos con un chatbot de WhatsApp que responde preguntas frecuentes, presenta tus servicios y ayuda a captar prospectos o citas automáticamente.`;
  return includeQuestion
    ? `${explanation} Si quieres, puedo aterrizarlo a tu caso. ¿Cuál es el nombre exacto de tu negocio?`
    : `${explanation} Si quieres, con los datos que ya me compartiste puedo prepararte una demo personalizada.`;
}

function classifyTemplateQuickReply(content) {
  const text = normalizeText(content);
  if (['si quiero verla', 'quiero verla'].includes(text)) return 'demo_request';
  if (text === 'despues') return 'later';
  return null;
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
    hannia_introduced: false,
    info_requested: false,
    demo_requested: false,
    demo_confirmed: false,
    demo_confirmation_asked: false,
    demo_handoff_announced: false,
  };

  let lastQuestion = null;
  let lastOutgoingAskedDemoConfirmation = false;
  for (const message of messages) {
    const content = stripTags(message.content);
    if (!content) continue;

    if (isOutgoingMessage(message)) {
      if (normalizeText(content).includes('soy hannia') || normalizeText(content).includes('hannia de humanio')) {
        state.hannia_introduced = true;
      }
      if (asksForDemoConfirmation(content)) {
        state.demo_confirmation_asked = true;
        lastOutgoingAskedDemoConfirmation = true;
      } else {
        lastOutgoingAskedDemoConfirmation = false;
      }
      if (isDemoHandoffAnnouncement(content)) state.demo_handoff_announced = true;
      lastQuestion = detectQuestionType(content);
      state.last_question = lastQuestion || state.last_question;
      continue;
    }

    if (hasInfoIntent(content)) state.info_requested = true;
    if (hasDemoIntent(content) && !hasInfoIntent(content)) state.demo_requested = true;
    if (lastOutgoingAskedDemoConfirmation && isAffirmative(content)) {
      state.demo_confirmed = true;
      state.demo_requested = true;
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
  const content = stripTags(event.content);
  const wantsDemo = hasCommercialIntent(content);
  const asksHowItWorks = hasInfoIntent(content);

  if (asksHowItWorks && state.demo_handoff_announced) {
    return howItWorksReply();
  }

  if (!state.nombre_negocio && isPureGreeting(content)) {
    return state.hannia_introduced
      ? 'Estoy aquí para ayudarte. ¿Buscas información sobre una página web, un chatbot de WhatsApp o automatización con IA?'
      : '¡Hola! Soy Hannia de Humanio. Ayudamos a negocios con páginas web, chatbots de WhatsApp y automatización con IA. ¿Qué te gustaría revisar?';
  }

  if (!state.nombre_negocio && asksHowItWorks) {
    return howItWorksReply({
      includeIntro: !state.hannia_introduced,
      includeQuestion: true,
    });
  }

  if (!state.nombre_negocio) {
    const prefix = state.hannia_introduced ? '' : '¡Hola! Soy Hannia de Humanio. ';
    return wantsDemo
      ? `${prefix}Con gusto te ayudo a aterrizar una propuesta. ¿Cuál es el nombre exacto de tu negocio?`
      : `${prefix}Claro, te ayudo. Para orientarte mejor, ¿cuál es el nombre de tu negocio?`;
  }

  if (!state.giro) return 'Perfecto. ¿Qué servicio o producto principal ofreces?';
  if (!state.ciudad) return 'Gracias. ¿En qué ciudad atiende tu negocio?';
  if (!state.web_o_redes) return 'Gracias. ¿Tienes página web o redes sociales actualmente?';
  if (asksHowItWorks) return howItWorksReply();
  if (state.info_requested && !state.demo_requested && !state.demo_confirmed) {
    return 'Con esto ya puedo orientarte mejor. Para tu caso, Humanio podría ayudarte con una página web y un chatbot que explique tus servicios, atienda dudas y capte prospectos por WhatsApp. ¿Quieres que te prepare una demo personalizada?';
  }
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

  const confirmation = `Perfecto, ya tengo suficiente información para preparar tu demo. Gracias, ${state.nombre_contacto || 'te contacto pronto'}. Ya comparto tu caso con el equipo de Humanio para avanzar con la propuesta.`;
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

async function handleTemplateQuickReply(event) {
  const quickReply = classifyTemplateQuickReply(event.content);
  if (!quickReply) return { handled: false, reason: 'not_template_quick_reply' };

  const config = getGatewayConfig();
  if (config.conversation_manager_mode !== 'active' || !config.inbound_enabled || !config.configured.chatwoot) {
    return { handled: false, reason: 'quick_reply_not_ready' };
  }

  if (quickReply === 'later') {
    const text = 'Sin problema. Cuando estes listo, escribeme por aqui y con gusto te preparo la demo. Saludos.';
    const sent = await sendChatwootMessage(event.conversation_id, text);
    return {
      handled: true,
      quick_reply: quickReply,
      external_messages_sent: true,
      reply: text,
      chatwoot_message_id: sent.id || sent.message_id || null,
      paperclip_issue: null,
    };
  }

  const ack = 'Perfecto, con gusto. Ya tenemos el contexto del diagnostico que te compartimos, asi que vamos a preparar tu demo personalizada. Apenas este lista, te la mando por aqui.';
  const sent = await sendChatwootMessage(event.conversation_id, ack);
  const payload = {
    event_type: 'cold_template_demo_request',
    source: 'gateway_quick_reply',
    run_scope: 'single_request',
    channel: 'chatwoot_whatsapp',
    conversation_id: event.conversation_id,
    message_id: event.message_id,
    sender_phone: event.sender_phone,
    sender_name: event.sender_name,
    message_text: stripTags(event.content),
    intent: 'demo_request',
    instruction: 'El prospecto respondio un quick reply del template cold humanio_diagnostico_v1. NO pedir nombre/giro/ciudad. Recuperar contexto del prospecto desde Supabase/outreach_log/Paperclip por sender_phone, conversation_id o ultimo msg1, y disparar demo usando el brief cold existente.',
  };
  const body = [
    'Cold template quick reply received.',
    '',
    '```yaml',
    yamlFromObject(payload),
    '```',
  ].join('\n');
  const assigneeAgentId = process.env.CEO_AGENT_ID || process.env.CONVERSATION_MANAGER_AGENT_ID;
  const created = await createPaperclipIssue({
    title: `CEO: demo solicitada desde cold quick reply ${event.sender_phone || event.conversation_id || ''}`.trim(),
    body,
    assigneeAgentId,
    metadata: {
      event_type: payload.event_type,
      source: payload.source,
      conversation_id: event.conversation_id,
      message_id: event.message_id,
      sender_phone: event.sender_phone,
      content_hash: event.content_hash,
    },
    runId: `gateway-cold-quick-reply-${event.conversation_id}-${event.message_id || Date.now()}`,
  });

  return {
    handled: true,
    quick_reply: quickReply,
    external_messages_sent: true,
    reply: ack,
    chatwoot_message_id: sent.id || sent.message_id || null,
    paperclip_issue: created,
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

  try {
    const quickReplyResult = await handleTemplateQuickReply(event);
    if (quickReplyResult.handled) {
      app.log.info({ quickReplyResult }, 'gateway handled template quick reply');
      return reply.code(200).send({
        ok: true,
        mode: getGatewayConfig().conversation_manager_mode,
        template_quick_reply: quickReplyResult.quick_reply,
        external_messages_sent: quickReplyResult.external_messages_sent,
        paperclip_event_created: Boolean(quickReplyResult.paperclip_issue),
      });
    }
  } catch (error) {
    event.quick_reply_error = error.message || String(error);
    app.log.error({ error }, 'gateway quick reply handling failed; falling back to Paperclip event');
  }

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
