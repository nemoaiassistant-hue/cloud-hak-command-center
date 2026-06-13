// /api/demos.js — Demo Lab CRUD for prospect demos
// create: scrape URL → Z.AI generates persona → Dograh workflow → save demo → return link
// list: return all demos from clients.json
// delete: remove demo from clients.json

const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';
const ZAI_KEY = process.env.ZAI_API_KEY;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = 'nemoaiassistant-hue/cloud-hak-command-center';
const FILE_PATH = 'data/clients.json';

// ===== GitHub helpers =====
async function fetchClientsJson() {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status}`);
  const data = await resp.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { parsed: JSON.parse(content), sha: data.sha };
}

async function commitClientsJson(parsed, sha) {
  const content = Buffer.from(JSON.stringify(parsed, null, 2)).toString('base64');
  const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    method: 'PUT',
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Update demos', content, sha }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GitHub commit failed: ${resp.status} ${err.substring(0, 200)}`);
  }
  return true;
}

// ===== Dograh helpers =====
async function dograhLogin() {
  const resp = await fetch(`${DOGRAH_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nima@cloud-hak.com', password: DOGRAH_PASS }),
  });
  if (!resp.ok) throw new Error('Dograh login failed');
  const { token } = await resp.json();
  return token;
}

async function createDograhWorkflow(token, agentName, globalPrompt, startPrompt, mainPrompt, greeting) {
  // IMPORTANT: Must match SDK-generated format exactly — string node IDs, proper structure
  // SDK uses: node "1" (startCall), "2" (agentNode), "3" (globalNode), "4" (endCall)
  // Edges: source/target as strings matching node IDs
  const definition = {
    nodes: [
      { id: "1", type: "startCall", position: { x: 0, y: 0 }, data: { name: "Start", greeting_type: "text", prompt: startPrompt, greeting, allow_interrupt: false, add_global_prompt: true, delayed_start: false, delayed_start_duration: 2, extraction_enabled: false, pre_call_fetch_enabled: false } },
      { id: "2", type: "agentNode", position: { x: 400, y: 200 }, data: { name: "Main Conversation", prompt: mainPrompt, allow_interrupt: true, add_global_prompt: true, extraction_enabled: false } },
      { id: "3", type: "globalNode", position: { x: 0, y: 0 }, data: { name: "Global Node", prompt: globalPrompt } },
      { id: "4", type: "endCall", position: { x: 400, y: 200 }, data: { name: "End Call", prompt: "The conversation is complete. Say a brief polite goodbye and end naturally.", add_global_prompt: false, extraction_enabled: false } },
    ],
    edges: [
      { id: "1-2", source: "1", target: "2", data: { label: "Continue to main", condition: "Move to the main conversation after greeting and understanding the visitor's needs." } },
      { id: "1-4", source: "1", target: "4", data: { label: "End immediately", condition: "End if the visitor does not want to continue." } },
      { id: "2-4", source: "2", target: "4", data: { label: "End conversation", condition: "End when the visitor's questions are fully answered." } },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  // Create workflow
  const createResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/create/definition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: agentName, workflow_definition: definition }),
  });
  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Dograh create failed: ${createResp.status} ${err.substring(0, 200)}`);
  }
  const created = await createResp.json();
  const wfId = created.id || created.workflow_id;

  // Create draft, update definition, publish
  await fetch(`${DOGRAH_URL}/api/v1/workflow/${wfId}/create-draft`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});

  await fetch(`${DOGRAH_URL}/api/v1/workflow/${wfId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_definition: definition }),
  }).catch(() => {});

  await fetch(`${DOGRAH_URL}/api/v1/workflow/${wfId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});

  return wfId;
}

// ===== Z.AI persona generation =====
async function generatePersona(scrapedContent, businessName, url) {
  const systemPrompt = `You are an AI agent designer. Generate prompts for a customer service chatbot. Respond ONLY with valid JSON, no markdown.`;

  const userPrompt = `Based on this website content, create a chatbot persona for "${businessName}".

Website: ${url}

Content (first 3000 chars):
${scrapedContent.substring(0, 3000)}

Generate a JSON object with these exact keys:
{
  "global_prompt": "System prompt describing who the bot is, its role, the business services, and behavior rules. 3-5 sentences.",
  "start_prompt": "Instructions for the greeting node. What to say, what to ask. 2-3 sentences.",
  "main_prompt": "Instructions for handling main conversation. What topics to cover, how to guide toward booking/purchase. 3-4 sentences.",
  "greeting": "The actual opening message the visitor sees. Friendly, mentions the business name, asks how to help. 1-2 sentences."
}`;

  const resp = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ZAI_KEY}` },
    body: JSON.stringify({
      model: 'glm-4.5',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.7,
      max_tokens: 1500,
    }),
  });
  if (!resp.ok) throw new Error(`Z.AI failed: ${resp.status}`);
  const data = await resp.json();
  let text = data.choices[0].message.content.trim();
  // Strip markdown code fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(text);
}

// ===== Website scraping =====
async function scrapeWebsite(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await resp.text();
  // Extract text content
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ===== LIST demos =====
    if (req.method === 'GET') {
      const { parsed } = await fetchClientsJson();
      return res.json(parsed.demos || []);
    }

    // ===== CREATE / DELETE =====
    if (req.method === 'POST') {
      const { action } = req.body;

      // DELETE demo
      if (action === 'delete') {
        const { agent_id } = req.body;
        const { parsed, sha } = await fetchClientsJson();
        if (!parsed.demos) parsed.demos = [];
        parsed.demos = parsed.demos.filter(d => d.agentId !== agent_id);
        await commitClientsJson(parsed, sha);
        return res.json({ success: true });
      }

      // CONVERT demo to client
      if (action === 'convert') {
        const { agent_id, client_name } = req.body;
        const { parsed, sha } = await fetchClientsJson();
        if (!parsed.demos) parsed.demos = [];
        const demo = parsed.demos.find(d => d.agentId === agent_id);
        if (!demo) return res.status(404).json({ error: 'Demo not found' });
        parsed.demos = parsed.demos.filter(d => d.agentId !== agent_id);
        // Would add to clients array with full onboarding in a future step
        await commitClientsJson(parsed, sha);
        return res.json({ success: true, message: `${demo.business} converted to client ${client_name}` });
      }

      // CREATE demo
      const { website_url, business_name, agent_type = 'chat' } = req.body;
      const url = website_url.match(/^https?:\/\//) ? website_url : `https://${website_url}`;
      const finalBusinessName = business_name || new URL(url).hostname.replace('www.', '').replace(/\..+$/, '');

      // 1. Scrape website
      let scrapedContent;
      try {
        scrapedContent = await scrapeWebsite(url);
      } catch (e) {
        return res.status(400).json({ error: `Could not reach ${url}: ${e.message}` });
      }
      if (!scrapedContent || scrapedContent.length < 50) {
        return res.status(400).json({ error: 'Website returned no usable content' });
      }

      // 2. Generate persona via Z.AI
      let persona;
      try {
        persona = await generatePersona(scrapedContent, finalBusinessName, url);
      } catch (e) {
        return res.status(500).json({ error: `Agent generation failed: ${e.message}` });
      }

      // 3. Create Dograh workflow
      const token = await dograhLogin();
      const agentName = `${finalBusinessName} AI Assistant`;
      const wfId = await createDograhWorkflow(token, agentName, persona.global_prompt, persona.start_prompt, persona.main_prompt, persona.greeting);

      // 4. Save to clients.json demos array
      const { parsed, sha } = await fetchClientsJson();
      if (!parsed.demos) parsed.demos = [];
      const demo = {
        business: finalBusinessName,
        website: website_url,
        agentId: wfId,
        agentName,
        type: agent_type,
        created: new Date().toISOString(),
        status: 'demo',
      };
      parsed.demos.push(demo);
      await commitClientsJson(parsed, sha);

      // 5. Return demo link
      return res.json({
        success: true,
        agent_id: wfId,
        agent_name: agentName,
        business: finalBusinessName,
        greeting: persona.greeting,
        demo_url: `https://cloud-hak-command-center.vercel.app/demo.html?agent=${wfId}`,
      });
    }

    return res.status(400).json({ error: 'Use GET (list) or POST (create/delete/convert)' });
  } catch (e) {
    console.error('Demos API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
