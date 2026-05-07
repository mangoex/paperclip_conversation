import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

const PORT = Number(process.env.PORT || 3000);

app.get('/health', async () => ({
  ok: true,
  service: 'paperclip-conversation',
  mode: process.env.GATEWAY_MODE || 'shadow',
  outbound_enabled: process.env.ENABLE_WHATSAPP_SEND === 'true',
  inbound_enabled: process.env.ENABLE_CHATWOOT_REPLY === 'true',
}));

app.post('/webhooks/chatwoot', async (request, reply) => {
  const body = request.body || {};

  const message = body.message || body;
  const conversation = body.conversation || message.conversation || {};
  const sender = body.sender || message.sender || body.contact || conversation.meta?.sender || {};

  const event = {
    event_type: 'inbound_chatwoot_event',
    source: 'chatwoot_gateway',
    conversation_id: String(conversation.id || body.conversation_id || ''),
    message_id: String(message.id || body.id || ''),
    inbox_id: String(conversation.inbox_id || body.inbox_id || ''),
    sender_phone: String(sender.phone_number || sender.phone || '').replace(/\D/g, ''),
    sender_name: sender.name || 'unknown',
    content: message.content || body.content || '',
    attachments: message.attachments || body.attachments || [],
    created_at: message.created_at || body.created_at || new Date().toISOString(),
    shadow_mode_expected: process.env.GATEWAY_MODE !== 'active',
  };

  app.log.info({ event }, 'chatwoot event received');

  if (process.env.ENABLE_PAPERCLIP_EVENTS === 'true') {
    const paperclipBase = process.env.PAPERCLIP_API_URL;
    const companyId = process.env.COMPANY_ID;
    const agentId = process.env.CONVERSATION_MANAGER_AGENT_ID;
    const token = process.env.PAPERCLIP_API_TOKEN || process.env.PAPERCLIP_API_KEY;

    const yaml = Object.entries(event)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

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
        body: yaml,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      app.log.error({ status: res.status, text }, 'paperclip issue create failed');
    }
  }

  return reply.code(200).send({
    ok: true,
    mode: process.env.GATEWAY_MODE || 'shadow',
    external_messages_sent: false,
  });
});

app.listen({ port: PORT, host: '0.0.0.0' });
