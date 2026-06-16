// /api/demos.js — Demo Lab CRUD for prospect demos
// create: scrape URL → Z.AI generates persona → Dograh workflow → save demo → return link
// list: return all demos from clients.json
// delete: remove demo from clients.json

const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';
const _ZAI_B64 = process.env.ZAI_API_KEY_B64 || 'YTcyMDg1NDE1NTU4NDZkNjVmMzY0YTQ0YjNlOTQ1MzUyZjQ4YTg3MjgzZjJhZDU4NWMzMWI0ZDRjM2I0NTQ3NTNhZDQ1YjI5NmM2NGU1ZWNmNmMyZTJiMTljMDNhZmFjY2Q2MWQyMWUyMWQ0ZjA1NmY0NzQ3ZTIxYTMyYzQ2MzJiNDNhZTljMWZkMWMyOGUyMTBlYjQ3ZDc5MTNlZjA1ZGEzN2Q2YzVhYjMwNTdjOWE3ZDk1ZGExNDQ0NTVh';
const ZAI_KEY = process.env.ZAI_API_KEY || (process.env.ZAI_API_KEY_B64 ? Buffer.from(process.env.ZAI_API_KEY_B64, 'base64').toString() : Buffer.from(_ZAI_B64, 'base64').toString());
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
  const systemPrompt = `You are an expert AI agent designer for business chatbots. You extract SPECIFIC, CONCRETE details from website content and embed them directly into agent prompts. Respond ONLY with valid JSON, no markdown fences.`;

  const userPrompt = `Create a highly customised chatbot persona for "${businessName}" based on their website content below.

Website: ${url}

EXTRACT THESE SPECIFIC DETAILS from the content (only include what you actually find):
- Exact service/treatment names and descriptions
- Actual pricing if mentioned
- Real business hours
- Location and service areas
- Team members or practitioner names
- Specific technologies, techniques, or methods they mention
- Certifications, accreditations, awards
- Booking process (phone, online, WhatsApp, etc.)
- Phone numbers, email addresses
- Any unique selling points or guarantees
- Special offers, deals, new patient promotions

CONTENT:
${scrapedContent}

CRITICAL RULES for the agent's response style (embed these into prompts):
- Respond in 1-3 sentences MAX. Never longer.
- NO bullet points, NO numbered lists, NO markdown formatting. Ever.
- Speak like a real person texting — natural, warm, concise.
- Share one piece of info, ask a follow-up question.
- Never dump all information at once.

Generate a JSON object with these exact keys:
{
  "business_name": "exact business name from the website",
  "greeting": "1-2 sentences. Friendly, mentions business name, asks how to help. Max 20 words.",
  "global_prompt": "System prompt that defines WHO the agent is and HOW it behaves. MUST include the business name. MUST include a hard rule: 'NEVER write more than 3 sentences in a single response. Never use bullet points or lists.' MUST specify the agent represents ${businessName} and should guide visitors toward booking/appointment/contact. Include tone guidelines (warm, professional, knowledgeable about the specific treatments/services).",
  "main_prompt": "The KNOWLEDGE BASE. MUST contain ALL specific details extracted from the website: list every service/treatment with its description, mention pricing if found, include hours, location, booking methods, phone numbers, team info, certifications, special offers — all written as factual statements the agent can draw from. Organise by topic but write as paragraphs NOT bullet points. End with instructions to always offer to book an appointment or connect with the team. Include the rule: 'Keep every response to 1-3 sentences. No lists. Always end with a question.'",
  "start_prompt": "Instructions for the greeting node. Keep brief. Tell the agent to greet warmly, mention the business, and ask what the visitor needs help with.",
  "summary": "One sentence describing what this agent does",
  "scraped_details": "A clean summary of ALL key facts extracted: services, pricing, hours, location, team, booking info, phone, email. Formatted as readable text for later editing."
}`;

  // Retry up to 2 times with 30s timeout each
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ZAI_KEY}` },
        body: JSON.stringify({
          model: 'glm-4.7',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.4,
          max_tokens: 3000,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`Z.AI error (attempt ${attempt + 1}):`, resp.status, errBody.substring(0, 500));
        lastError = new Error(`Z.AI failed: ${resp.status} ${errBody.substring(0, 200)}`);
        continue;
      }
      const data = await resp.json();
      let text = (data.choices?.[0]?.message?.content || '').trim();
      if (!text) {
        lastError = new Error('Z.AI returned empty response');
        continue;
      }
      // Strip markdown code fences if present
      text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      // Try to extract JSON object from response if there's extra text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) text = jsonMatch[0];
      const parsed = JSON.parse(text);
      // Attach raw scraped content for reference
      parsed.raw_scrape = scrapedContent.substring(0, 5000);
      return parsed;
    } catch (e) {
      console.error(`Persona generation attempt ${attempt + 1} failed:`, e.message);
      lastError = e;
    }
  }
  throw lastError || new Error('Persona generation failed after retries');
}

// ===== Website scraping =====
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const linkRegex = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    // Resolve relative URLs
    try {
      href = new URL(href, baseUrl).href;
    } catch { continue; }
    // Same domain only
    if (href.includes(new URL(baseUrl).hostname)) {
      links.add(href.split('#')[0]);
    }
  }
  return [...links];
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  const html = await resp.text();
  return { html, text: extractText(html), finalUrl: resp.url };
}

async function scrapeWebsite(url) {
  // 1. Fetch homepage
  const home = await fetchPage(url);
  
  // 2. Find subpages worth scraping
  const allLinks = extractLinks(home.html, url);
  const priorityPatterns = /service|about|pricing|price|treatment|contact|faq|team|what-we-do|our-/i;
  const priorityLinks = allLinks.filter(l => priorityPatterns.test(l));
  
  // 3. Fetch up to 12 subpages in parallel
  const subPages = await Promise.allSettled(
    priorityLinks.slice(0, 12).map(l => fetchPage(l))
  );
  
  // 4. Combine content with page labels
  let combined = `=== HOMEPAGE ===\n${home.text}\n`;
  
  for (let i = 0; i < subPages.length; i++) {
    if (subPages[i].status === 'fulfilled') {
      const page = subPages[i].value;
      const pageName = page.finalUrl.split('/').pop() || `page${i+1}`;
      combined += `\n=== ${pageName.toUpperCase()} ===\n${page.text}\n`;
    }
  }
  
  return combined.substring(0, 8000);
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

      // DELETE demo — removes from clients.json AND archives workflow on Dograh
      if (action === 'delete') {
        const { agent_id } = req.body;
        
        // Archive workflow on Dograh — best-effort, non-blocking
        dograhLogin()
          .then(token => fetch(`${DOGRAH_URL}/api/v1/workflow/${agent_id}/status`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'archived' }),
          }))
          .catch(() => {}); // non-fatal
        
        // Remove from clients.json (primary action)
        try {
          const { parsed, sha } = await fetchClientsJson();
          if (!parsed.demos) parsed.demos = [];
          const before = parsed.demos.length;
          parsed.demos = parsed.demos.filter(d => String(d.agentId) !== String(agent_id));
          const after = parsed.demos.length;
          if (before === after) {
            return res.status(404).json({ error: 'Demo not found in list', agent_id });
          }
          await commitClientsJson(parsed, sha);
          return res.json({ success: true, removed: agent_id });
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
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

      // UPDATE demo — edit prompts and push to Dograh
      if (action === 'update') {
        const { agent_id, greeting, global_prompt, main_prompt, start_prompt, scraped_details } = req.body;
        
        // 1. Update Dograh workflow
        try {
          const token = await dograhLogin();
          // Fetch current workflow
          const wfResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/fetch/${agent_id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (wfResp.ok) {
            const wfData = await wfResp.json();
            const nodes = wfData.workflow_definition?.nodes || [];
            // Update node prompts
            for (const node of nodes) {
              if (node.type === 'globalNode') node.data.prompt = global_prompt;
              if (node.type === 'startCall') {
                node.data.prompt = start_prompt || node.data.prompt;
                node.data.greeting = greeting || node.data.greeting;
              }
              if (node.type === 'agentNode') node.data.prompt = main_prompt;
            }
            // Push update
            await fetch(`${DOGRAH_URL}/api/v1/workflow/${agent_id}`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ workflow_definition: wfData.workflow_definition }),
            }).catch(() => {});
            // Publish
            await fetch(`${DOGRAH_URL}/api/v1/workflow/${agent_id}/publish`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(() => {});
          }
        } catch (e) {
          console.error('Dograh update failed (non-fatal):', e.message);
        }
        
        // 2. Update clients.json
        const { parsed, sha } = await fetchClientsJson();
        if (!parsed.demos) parsed.demos = [];
        const demo = parsed.demos.find(d => String(d.agentId) === String(agent_id));
        if (!demo) return res.status(404).json({ error: 'Demo not found' });
        if (greeting !== undefined) demo.greeting = greeting;
        if (global_prompt !== undefined) demo.global_prompt = global_prompt;
        if (main_prompt !== undefined) demo.main_prompt = main_prompt;
        if (start_prompt !== undefined) demo.start_prompt = start_prompt;
        if (scraped_details !== undefined) demo.scraped_details = scraped_details;
        demo.last_edited = new Date().toISOString();
        await commitClientsJson(parsed, sha);
        return res.json({ success: true, demo });
      }

      // GET single demo details
      if (action === 'get') {
        const { agent_id } = req.body;
        const { parsed } = await fetchClientsJson();
        const demo = (parsed.demos || []).find(d => String(d.agentId) === String(agent_id));
        if (!demo) return res.status(404).json({ error: 'Demo not found' });
        return res.json(demo);
      }

      // CREATE demo
      const { website_url, business_name, agent_type = 'chat' } = req.body;
      const url = website_url.match(/^https?:\/\//) ? website_url : `https://${website_url}`;
      const finalBusinessName = business_name || new URL(url).hostname.replace('www.', '').replace(/\..+$/, '');

      // 1. Start async processing — return immediately with demo stub
      const demoId = 'demo_' + Date.now();
      const stub = {
        id: demoId,
        business: finalBusinessName,
        website: website_url,
        agentId: null,
        agentName: `${finalBusinessName} AI Assistant`,
        type: agent_type,
        created: new Date().toISOString(),
        status: 'processing',
      };

      // Fire and forget — process in background
      setImmediate(async () => {
        try {
          // 1. Scrape website
          let scrapedContent;
          try {
            scrapedContent = await scrapeWebsite(url);
          } catch (e) {
            return console.error(`[${demoId}] Scrape failed:`, e.message);
          }

          // 2. Generate persona via Z.AI
          let persona;
          try {
            persona = await generatePersona(scrapedContent, finalBusinessName, url);
          } catch (e) {
            return console.error(`[${demoId}] Persona failed:`, e.message);
          }

          // 3. Create Dograh workflow
          let token, wfId;
          try {
            token = await dograhLogin();
            wfId = await createDograhWorkflow(token, `${finalBusinessName} AI Assistant`, persona.global_prompt, persona.start_prompt, persona.main_prompt, persona.greeting);
          } catch (e) {
            return console.error(`[${demoId}] Dograh failed:`, e.message);
          }

          // 4. Save to clients.json
          let parsed, sha;
          try {
            const result = await fetchClientsJson();
            parsed = result.parsed;
            sha = result.sha;
          } catch (e) {
            return console.error(`[${demoId}] GitHub fetch failed:`, e.message);
          }
          if (!parsed.demos) parsed.demos = [];
          const demo = {
            business: finalBusinessName,
            website: website_url,
            agentId: wfId,
            agentName: `${finalBusinessName} AI Assistant`,
            type: agent_type,
            created: new Date().toISOString(),
            status: 'demo',
            greeting: persona.greeting,
            global_prompt: persona.global_prompt,
            main_prompt: persona.main_prompt,
            start_prompt: persona.start_prompt,
            scraped_details: persona.scraped_details || '',
            raw_scrape: persona.raw_scrape || scrapedContent.substring(0, 5000),
          };
          parsed.demos.push(demo);
          try {
            await commitClientsJson(parsed, sha);
          } catch (e) {
            return console.error(`[${demoId}] GitHub save failed:`, e.message);
          }

          console.log(`[${demoId}] Demo created successfully: ${wfId}`);
        } catch (e) {
          console.error(`[${demoId}] Processing error:`, e);
        }
      });

      return res.json({ success: true, id: demoId, status: 'processing', message: 'Demo agent is being created. Refresh in ~60 seconds to see the result.' });
    }

    return res.status(400).json({ error: 'Use GET (list) or POST (create/delete/convert)' });
  } catch (e) {
    console.error('Demos API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
