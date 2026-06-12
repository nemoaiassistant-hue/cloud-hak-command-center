// /api/chat.js — AI assistant for the Command Center
// Uses Z.AI GLM with function calling to execute commands on the dashboard

const GH_OWNER = 'nemoaiassistant-hue';
const GH_REPO = 'cloud-hak-command-center';
const GH_PATH = 'data/clients.json';
const GH_BRANCH = 'main';

const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

// ---- GitHub helpers (same as config.js) ----
async function getFromGitHub(token) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'cloud-hak-command-center' },
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}`);
  const data = await resp.json();
  return { json: JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')), sha: data.sha };
}

async function saveToGitHub(token, content, sha) {
  const resp = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'cloud-hak-command-center', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'AI assistant update', content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'), sha, branch: GH_BRANCH }),
  });
  if (!resp.ok) throw new Error(`GitHub save ${resp.status}`);
  return resp.json();
}

function getEffectivePrice(serviceId, defaultPrice, client) {
  const cp = client.customPricing?.[serviceId];
  if (cp) {
    if (cp.price != null) return cp.price;
    if (cp.discount != null) return Math.round(defaultPrice * (1 - cp.discount / 100));
  }
  return defaultPrice;
}

function recalcMrr(client, services) {
  const prices = {};
  services.forEach(s => { prices[s.id] = s.price; });
  return Object.entries(client.services)
    .filter(([_, on]) => on)
    .reduce((sum, [id]) => sum + getEffectivePrice(id, prices[id] || 0, client), 0);
}

// ---- Function execution ----
async function executeFunction(name, args, ghToken, config) {
  const { json: data, sha } = await getFromGitHub(ghToken);
  const services = data.services;

  // Build a lookup for fuzzy matching
  const findClient = (name) => {
    const lower = name.toLowerCase();
    return data.clients.find(c =>
      c.name.toLowerCase().includes(lower) ||
      lower.includes(c.name.toLowerCase().split(' ')[0])
    );
  };

  const findService = (name) => {
    const lower = name.toLowerCase();
    return services.find(s =>
      s.id === lower ||
      s.name.toLowerCase().includes(lower) ||
      lower.includes(s.name.toLowerCase().split(' ')[0]) ||
      s.id.replace('_', ' ').includes(lower)
    );
  };

  if (name === 'toggle_service') {
    const client = findClient(args.client);
    if (!client) return { error: `Client "${args.client}" not found. Available: ${data.clients.map(c => c.name).join(', ')}` };
    const svc = findService(args.service);
    if (!svc) return { error: `Service "${args.service}" not found. Available: ${services.map(s => s.name).join(', ')}` };

    client.services[svc.id] = args.active;
    client.mrr = recalcMrr(client, services);
    await saveToGitHub(ghToken, data, sha);

    return {
      success: true,
      message: `${svc.name} is now ${args.active ? 'ON' : 'OFF'} for ${client.name}. MRR updated to £${client.mrr}/mo.`
    };
  }

  if (name === 'set_pricing') {
    const client = findClient(args.client);
    if (!client) return { error: `Client "${args.client}" not found` };
    const svc = findService(args.service);
    if (!svc) return { error: `Service "${args.service}" not found` };

    if (!client.customPricing) client.customPricing = {};

    if (args.price == null && args.discount == null) {
      // Reset to default
      delete client.customPricing[svc.id];
      return { success: true, message: `Reset ${svc.name} for ${client.name} to default price (£${svc.price}/mo).` };
    }

    if (!client.customPricing[svc.id]) client.customPricing[svc.id] = {};
    if (args.price != null) client.customPricing[svc.id].price = Number(args.price);
    if (args.discount != null) client.customPricing[svc.id].discount = Number(args.discount);

    client.mrr = recalcMrr(client, services);
    await saveToGitHub(ghToken, data, sha);

    const eff = getEffectivePrice(svc.id, svc.price, client);
    return {
      success: true,
      message: `Updated ${svc.name} pricing for ${client.name}. Effective price: £${eff}/mo. MRR: £${client.mrr}/mo.`
    };
  }

  if (name === 'get_client_info') {
    const client = findClient(args.client);
    if (!client) return { error: `Client not found` };

    const active = Object.entries(client.services)
      .filter(([_, on]) => on)
      .map(([id]) => {
        const s = services.find(sv => sv.id === id);
        const eff = getEffectivePrice(id, s?.price || 0, client);
        return `${s?.name || id}: £${eff}/mo`;
      });

    return {
      name: client.name,
      status: client.status,
      mrr: client.mrr,
      active_services: active,
      contact: client.contact,
      email: client.email,
    };
  }

  if (name === 'get_overview') {
    return {
      total_mrr: data.clients.reduce((s, c) => s + c.mrr, 0),
      clients: data.clients.map(c => ({
        name: c.name,
        mrr: c.mrr,
        active_services: Object.values(c.services).filter(Boolean).length,
        status: c.status,
      })),
    };
  }

  return { error: `Unknown function: ${name}` };
}

// ---- Tool definitions for the LLM ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'toggle_service',
      description: 'Turn a service on or off for a client',
      parameters: {
        type: 'object',
        properties: {
          client: { type: 'string', description: 'Client name (e.g. "Airway Clinic", "Altri Medical", "Cloud Hak")' },
          service: { type: 'string', description: 'Service name or ID (e.g. "SEO", "websites", "voice agents", "CRM")' },
          active: { type: 'boolean', description: 'true to activate, false to deactivate' },
        },
        required: ['client', 'service', 'active'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_pricing',
      description: 'Set a custom price or discount % for a service on a client. Pass null for both to reset to default.',
      parameters: {
        type: 'object',
        properties: {
          client: { type: 'string', description: 'Client name' },
          service: { type: 'string', description: 'Service name or ID' },
          price: { type: 'number', description: 'Custom monthly price in £, or null' },
          discount: { type: 'number', description: 'Discount percentage (e.g. 20 for 20% off), or null' },
        },
        required: ['client', 'service'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_client_info',
      description: 'Get detailed info about a specific client — active services, pricing, MRR, contact info',
      parameters: {
        type: 'object',
        properties: {
          client: { type: 'string', description: 'Client name' },
        },
        required: ['client'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_overview',
      description: 'Get a high-level overview of all clients — total MRR, active services count, status',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM_PROMPT = `You are the Cloud Hak Command Center AI assistant. You help manage clients, services, and pricing for Cloud Hak (a private AI agency).

You can:
- Toggle services on/off for clients
- Set custom pricing or discounts
- Look up client details and MRR
- Give agency-wide overviews

Be concise and direct. When you execute an action, confirm what changed in one sentence. Use £ for all prices. You are speaking to Nima, the owner of Cloud Hak.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const zaiKey = process.env.ZAI_API_KEY;
  const ghToken = process.env.GH_TOKEN;

  if (!zaiKey) return res.status(500).json({ error: 'ZAI_API_KEY not set' });

  try {
    const { messages, context } = req.body;

    // Fetch current config for system context
    const { json: config } = await getFromGitHub(ghToken);
    const configSummary = config.clients.map(c => {
      const active = Object.entries(c.services).filter(([_, on]) => on).map(([id]) => {
        const s = config.services.find(sv => sv.id === id);
        return `${s?.name || id} (£${getEffectivePrice(id, s?.price || 0, c)})`;
      }).join(', ');
      return `${c.name}: MRR £${c.mrr}/mo, services: ${active || 'none'}`;
    }).join('\n');

    const fullSystem = `${SYSTEM_PROMPT}\n\nCurrent state:\n${configSummary}`;

    const allMessages = [
      { role: 'system', content: fullSystem },
      ...messages,
    ];

    // Call Z.AI
    const zaiResp = await fetch(ZAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${zaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-4.5',
        messages: allMessages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 1000,
      }),
    });

    if (!zaiResp.ok) {
      const errText = await zaiResp.text();
      console.error('Z.AI error:', zaiResp.status, errText);
      return res.status(500).json({ error: `Z.AI error: ${zaiResp.status}` });
    }

    const zaiData = await zaiResp.json();
    const reply = zaiData.choices[0].message;

    // Check if the model wants to call a function
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      const toolCall = reply.tool_calls[0];
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments);

      // Execute the function
      const result = await executeFunction(fnName, fnArgs, ghToken, config);

      // Send function result back to LLM for a natural language response
      const followUpResp = await fetch(ZAI_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${zaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'glm-4.5',
          messages: [
            ...allMessages,
            reply,
            { role: 'tool', content: JSON.stringify(result), tool_call_id: toolCall.id },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });

      if (!followUpResp.ok) {
        // If followup fails, return the function result directly
        return res.status(200).json({
          reply: result.message || JSON.stringify(result),
          action: { name: fnName, args: fnArgs, result },
        });
      }

      const followUpData = await followUpResp.json();
      const finalReply = followUpData.choices[0].message.content;

      return res.status(200).json({
        reply: finalReply,
        action: { name: fnName, args: fnArgs, result },
      });
    }

    // No function call — just return the text
    return res.status(200).json({ reply: reply.content });

  } catch (err) {
    console.error('Chat API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
