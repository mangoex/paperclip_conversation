import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

const PORT = Number(process.env.PORT || 3000);
const processedMessageIds = new Set();

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
  mode: process.env.CONVERSATION_MANAGER_MODE || process.env.GATEWAY_MODE || 'shadow',
  outbound_enabled: boolEnv('HUMANIO_ENABLE_OUTBOUND_SEND', 'ENABLE_WHATSAPP_SEND'),
  inbound_enabled: boolEnv('HUMANIO_ENABLE_INBOUND_SEND', 'ENABLE_CHATWOOT_REPLY'),
  paperclip_events_enabled: process.env.ENABLE_PAPERCLIP_EVENTS === 'true',
  paperclip_configured: Boolean(
    process.env.PAPERCLIP_API_URL &&
    process.env.COMPANY_ID &&
    process.env.CONVERSATION_MANAGER_AGENT_ID &&
    (process.env.PAPERCLIP_API_TOKEN || process.env.PAPERCLIP_API_KEY || process.env.PAPERCLIP_AGENT_TOKEN)
  ),
}));

app.get('/', async () => ({
  ok: true,
  service: 'humanio-conversation-gateway',
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
    conversation_manager_mode: process.env.CONVERSATION_MANAGER_MODE || process.env.GATEWAY_MODE || 'shadow',
    humanio_enable_outbound_send: boolEnv('HUMANIO_ENABLE_OUTBOUND_SEND', 'ENABLE_WHATSAPP_SEND'),
    humanio_enable_inbound_send: boolEnv('HUMANIO_ENABLE_INBOUND_SEND', 'ENABLE_CHATWOOT_REPLY'),
    shadow_mode_expected: (process.env.CONVERSATION_MANAGER_MODE || process.env.GATEWAY_MODE) !== 'active',
    credential_flags: {
      chatwoot_configured: hasEnv('CHATWOOT_API_URL') && hasEnv('CHATWOOT_API_TOKEN'),
      whatsapp_configured: hasEnv('WHATSAPP_PHONE_NUMBER_ID') && hasEnv('WHATSAPP_CLOUD_API_TOKEN'),
      supabase_configured: hasEnv('SUPABASE_URL') && hasEnv('SUPABASE_SERVICE_KEY'),
      paperclip_configured: hasEnv('PAPERCLIP_API_URL') && hasEnv('COMPANY_ID') && hasEnv('CONVERSATION_MANAGER_AGENT_ID') &&
        hasEnv('PAPERCLIP_API_TOKEN', 'PAPERCLIP_API_KEY', 'PAPERCLIP_AGENT_TOKEN'),
    },
  };

  app.log.info({ event }, 'chatwoot event received');

  if (process.env.ENABLE_PAPERCLIP_EVENTS === 'true') {
    const paperclipBase = process.env.PAPERCLIP_API_URL;
    const companyId = process.env.COMPANY_ID;
    const agentId = process.env.CONVERSATION_MANAGER_AGENT_ID;
    const token = process.env.PAPERCLIP_API_TOKEN || process.env.PAPERCLIP_API_KEY || process.env.PAPERCLIP_AGENT_TOKEN;

    const yaml = Object.entries(event)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');
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
      const res = await fetch(`${paperclipBase}/api/companies/${companyId}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Paperclip-Run-Id': `chatwoot-gateway-${event.message_id || Date.now()}`,
        },
        body: JSON.stringify({
          title: `ConversationManager: evento Chatwoot ${event.conversation_id || 'sin-id'}`,
          assigneeAgentId: agentId,
          status: 'todo',
          priority: 'medium',
          body: issueBody,
          description: issueBody,
          content: issueBody,
          metadata: {
            event_type: event.event_type,
            source: event.source,
            conversation_id: event.conversation_id,
            message_id: event.message_id,
            content_hash: event.content_hash,
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        app.log.error({ status: res.status, text }, 'paperclip issue create failed');
      }
    } catch (error) {
      app.log.error({ error }, 'paperclip issue create crashed');
    }
  }

  return reply.code(200).send({
    ok: true,
    mode: process.env.GATEWAY_MODE || 'shadow',
    external_messages_sent: false,
  });
});

app.listen({ port: PORT, host: '0.0.0.0' });
