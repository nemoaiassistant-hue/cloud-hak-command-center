// /api/chat.js — AI assistant for the Command Center
// Uses Z.AI GLM with function calling to execute commands on the dashboard

const GH_OWNER = 'nemoaiassistant-hue';
const GH_REPO = 'cloud-hak-command-center';
const GH_PATH = 'data/clients.json';
const GH_BRANCH = 'main';

const ZAI_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';

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

  if (name === 'get_voice_status') {
    // Fetch live data from Dograh
    const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
    const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';
    try {
      const loginResp = await fetch(`${DOGRAH_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nima@cloud-hak.com', password: DOGRAH_PASS }),
      });
      if (!loginResp.ok) throw new Error('Dograh login failed');
      const { token } = await loginResp.json();

      const wfResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const workflows = await wfResp.json();

      // Get runs for each workflow
      const agents = await Promise.all(workflows.map(async (wf) => {
        try {
          const runsResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${wf.id}/runs`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 50 }),
          });
          const runsData = await runsResp.json();
          const runs = runsData.runs || [];
          const totalSecs = runs.reduce((s, r) => s + ((r.cost_info || {}).call_duration_seconds || 0), 0);
          const voiceCalls = runs.filter(r => r.mode !== 'textchat').length;
          const textChats = runs.filter(r => r.mode === 'textchat').length;
          const client = data.clients.find(c => c.dograhAgentId === wf.id);
          return {
            id: wf.id, name: wf.name, status: wf.status || 'active',
            client: client ? client.name : 'Unmapped',
            sessions: runs.length, voiceCalls, textChats,
            minutes: Math.round(totalSecs / 60 * 10) / 10,
            lastSession: runs.length > 0 ? (runs[0].created_at || 'unknown') : 'never',
          };
        } catch (e) {
          return { id: wf.id, name: wf.name, status: 'error', client: 'Unknown', sessions: 0, minutes: 0 };
        }
      }));

      return { total_agents: agents.length, active_agents: agents.filter(a => a.status === 'active').length, agents };
    } catch (e) {
      return { error: `Could not reach Dograh: ${e.message}. The server may be offline.` };
    }
  }

  if (name === 'create_agent') {
    const { website_url, business_name, client_name, agent_type } = args;
    // Ensure URL has protocol
    const url = website_url.match(/^https?:\/\//) ? website_url : `https://${website_url}`;
    const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
    const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';
    const zaiKey = process.env.ZAI_API_KEY;

    try {
      // Step 1: Scrape the website
      const scrapeResp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      });
      if (!scrapeResp.ok) throw new Error(`Could not fetch website (${scrapeResp.status})`);
      const html = await scrapeResp.text();

      // Extract text content from HTML
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 8000);

      if (text.length < 100) throw new Error('Not enough content extracted from website');

      // Step 2: Generate agent prompts using Z.AI
      const isVoice = agent_type === 'voice';
      const genResp = await fetch(ZAI_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${zaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-4.5',
          messages: [{
            role: 'system',
            content: `You are an expert at creating AI agent prompts for ${isVoice ? 'voice' : 'chat'} assistants. Given website content, generate a complete agent persona. Respond ONLY with valid JSON, no markdown fences.`
          }, {
            role: 'user',
            content: `Create an AI agent for this business based on their website content below.

Business name: ${business_name || '(extract from website)'}
Agent type: ${isVoice ? 'Voice agent (WebRTC widget on website)' : 'Text chat agent'}

Website content:
${text}

Generate a JSON object with these exact keys:
{
  "business_name": "the actual business name from the website",
  "greeting": "A natural greeting the agent says when someone starts a conversation. Mention the business name. ${isVoice ? 'Keep it short for voice (10-15 words).' : 'Keep it friendly and brief.'}",
  "global_prompt": "A detailed system prompt for the agent. Include: who the agent is, its role, ${isVoice ? 'keep responses 2-3 sentences max for voice, use simple spoken language, avoid special characters.' : 'respond in natural chat format.'} Include all services, pricing, FAQs, booking info, business hours, and contact details found on the website. Tell the agent to be helpful, warm, and professional. If specific details aren't on the website, tell the agent to acknowledge and offer to help connect them with the team.",
  "main_prompt": "The main conversation prompt. Include all knowledge about services, treatments, pricing, FAQs, and common questions organized by category. Include relevant questions the agent should ask. Include a wrap-up section offering to book appointments or connect them with the team.",
  "summary": "One sentence summary of what this agent does"
}`
          }],
          temperature: 0.4,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
      });

      if (!genResp.ok) throw new Error('LLM generation failed');
      const genData = await genResp.json();
      let agentConfig;
      try {
        agentConfig = JSON.parse(genData.choices[0].message.content);
      } catch (e) {
        // Fallback: try to extract JSON from the response
        const match = genData.choices[0].message.content.match(/\{[\s\S]*\}/);
        if (match) agentConfig = JSON.parse(match[0]);
        else throw new Error('Could not parse agent config from LLM');
      }

      const finalBusinessName = agentConfig.business_name || business_name || 'New Business';
      const agentName = `${finalBusinessName} AI Assistant`;

      // Step 3: Construct workflow definition (MUST use string IDs to match SDK format)
      const workflowDef = {
        nodes: [
          { id: "1", type: "startCall", position: { x: 0, y: 0 }, data: { name: "Start", greeting_type: "text", prompt: `Greet the visitor warmly. Tell them your name and that you're the AI assistant for ${finalBusinessName}. Ask how you can help them today. ${isVoice ? 'Keep it short and conversational for voice.' : ''}`, greeting: agentConfig.greeting, allow_interrupt: isVoice, add_global_prompt: true, delayed_start: false, delayed_start_duration: 2, extraction_enabled: false, pre_call_fetch_enabled: false } },
          { id: "2", type: "agentNode", position: { x: 400, y: 200 }, data: { name: "Main Conversation", prompt: agentConfig.main_prompt, allow_interrupt: true, add_global_prompt: true, extraction_enabled: false } },
          { id: "3", type: "globalNode", position: { x: 0, y: 0 }, data: { name: "Global Node", prompt: agentConfig.global_prompt } },
          { id: "4", type: "endCall", position: { x: 400, y: 200 }, data: { name: "End Call", prompt: "The conversation is complete. Say a brief polite goodbye and end naturally.", add_global_prompt: false, extraction_enabled: false } },
        ],
        edges: [
          { id: "1-2", source: "1", target: "2", data: { label: "Continue to main", condition: "Move to the main conversation after greeting and understanding the visitor's needs." } },
          { id: "1-4", source: "1", target: "4", data: { label: "End immediately", condition: "End if the visitor does not want to continue." } },
          { id: "2-4", source: "2", target: "4", data: { label: "End conversation", condition: "End when the visitor's questions are fully answered." } },
        ],
        viewport: { zoom: 0.8, x: 100, y: 50 },
      };

      // Step 4: Login to Dograh and create the workflow
      const loginResp = await fetch(`${DOGRAH_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nima@cloud-hak.com', password: DOGRAH_PASS }),
      });
      if (!loginResp.ok) throw new Error('Dograh login failed');
      const { token: dograhToken } = await loginResp.json();

      const createResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/create/definition`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dograhToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: agentName,
          workflow_definition: workflowDef,
        }),
      });

      if (!createResp.ok) {
        const errText = await createResp.text();
        throw new Error(`Dograh create failed: ${createResp.status} ${errText.substring(0, 200)}`);
      }

      const created = await createResp.json();
      const wfId = created.id;

      // Step 5: Publish the workflow (so it's active, not just a draft)
      try {
        await fetch(`${DOGRAH_URL}/api/v1/workflow/${wfId}/publish`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${dograhToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch (e) {
        // Publishing may need a separate step - that's OK
      }

      // Step 6: Save to demos array in clients.json (if no client_name specified)
      if (!client_name) {
        try {
          const ghToken = process.env.GH_TOKEN;
          const ghResp = await fetch(`https://api.github.com/repos/nemoaiassistant-hue/cloud-hak-command-center/contents/data/clients.json`, {
            headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
          });
          const ghData = await ghResp.json();
          const fileContent = JSON.parse(Buffer.from(ghData.content, 'base64').toString('utf8'));
          if (!fileContent.demos) fileContent.demos = [];
          fileContent.demos.push({
            agentId: wfId,
            business: finalBusinessName,
            website: website_url,
            type: isVoice ? 'voice' : 'chat',
            created: new Date().toISOString(),
          });
          await fetch(`https://api.github.com/repos/nemoaiassistant-hue/cloud-hak-command-center/contents/data/clients.json`, {
            method: 'PUT',
            headers: { Authorization: `token ${ghToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `Add demo: ${finalBusinessName}`,
              content: Buffer.from(JSON.stringify(fileContent, null, 2)).toString('base64'),
              sha: ghData.sha,
            }),
          });
        } catch (e) {
          // Non-fatal — agent is created, just won't show in Demo Lab
        }
      }

      // Step 7: Map to existing client if specified
      if (client_name) {
        const client = data.clients.find(c =>
          c.name.toLowerCase().includes(client_name.toLowerCase()) ||
          client_name.toLowerCase().includes(c.name.toLowerCase().split(' ')[0])
        );
        if (client) {
          client.dograhAgentId = wfId;
          if (!client.services['voice-agents']) client.services['voice-agents'] = true;
          client.mrr = recalcMrr(client, services);
          await saveToGitHub(ghToken, data, sha);
        }
      }

      const clientNote = client_name ? `Mapped to ${client_name}. ` : '';
      const demoUrl = `${process.env.VERCEL_URL ? 'https://cloud-hak-command-center.vercel.app' : ''}/demo.html?agent=${wfId}`;
      return {
        success: true,
        agent_id: wfId,
        agent_name: agentName,
        business: finalBusinessName,
        summary: agentConfig.summary,
        demo_url: demoUrl,
        message: `Agent "${agentName}" created on Dograh. ID #${wfId}. ${agentConfig.summary} ${clientNote}Demo link for client: ${demoUrl}`
      };
    } catch (e) {
      return { error: `Failed to create agent: ${e.message}` };
    }
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
  {
    type: 'function',
    function: {
      name: 'get_voice_status',
      description: 'Check the status of AI voice agents running on Dograh — agent names, session counts, minutes used, last activity. Use when asked about voice agents, calls, or if agents are online.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description: 'Create a new AI agent (voice or chat) on Dograh by scraping a business website. Automatically generates the agent persona, knowledge base, and conversation flow from the website content. Returns the agent ID and details.',
      parameters: {
        type: 'object',
        properties: {
          website_url: { type: 'string', description: 'The business website URL to scrape (e.g. "https://airwayclinic.se")' },
          business_name: { type: 'string', description: 'Business name (optional, will be extracted from website if not provided)' },
          client_name: { type: 'string', description: 'Client name in Command Center to map the agent to (e.g. "Airway Clinic")' },
          agent_type: { type: 'string', enum: ['voice', 'chat'], description: 'Voice agent (WebRTC widget) or text chat agent', default: 'chat' },
        },
        required: ['website_url'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are the Cloud Hak Command Center AI assistant. You help manage clients, services, and pricing for Cloud Hak (a private AI agency).

You can:
- Toggle services on/off for clients
- Set custom pricing or discounts
- Look up client details and MRR
- Give agency-wide overviews
- Check the status of AI voice agents (Dograh platform)
- Create new AI agents from a business website URL (automatically scrapes the site, generates the agent persona, creates it on Dograh, and maps it to a client)

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
