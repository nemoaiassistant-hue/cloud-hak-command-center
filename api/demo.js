// /api/demo.js — Proxy for Dograh text chat sessions (client demo)
// Creates a chat session, sends messages, returns agent replies

const DOGRAH_URL = process.env.DOGRAH_API_URL || 'http://localhost:8000';
const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse params from query (GET) or body (POST)
  const body = req.body || {};
  const action = req.query?.action || body.action;
  const workflow_id = req.query?.workflow_id || body.workflow_id;
  const run_id = req.query?.run_id || body.run_id;
  const message = req.query?.message || body.message;

  try {
    const token = await dograhLogin();

    // Action: get agent info (for the demo page header)
    if ((!action || action === 'info') && workflow_id) {
      const wfResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const workflows = await wfResp.json();
      const wf = workflows.find(w => w.id === parseInt(workflow_id));
      if (!wf) return res.status(404).json({ error: 'Agent not found' });

      // Get the global prompt to extract business name / greeting
      const detailResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/fetch/${workflow_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const detail = await detailResp.json();
      const globalNode = (detail.workflow_definition?.nodes || []).find(n => n.type === 'globalNode');
      const startNode = (detail.workflow_definition?.nodes || []).find(n => n.type === 'startCall');

      // Extract first line of global prompt as description
      const globalPrompt = globalNode?.data?.prompt || '';
      const firstLine = globalPrompt.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';

      return res.json({
        name: wf.name,
        greeting: startNode?.data?.greeting || firstLine.substring(0, 100) || 'Hello! How can I help you today?',
        description: firstLine.substring(0, 200),
        workflow_id: parseInt(workflow_id),
      });
    }

    // Action: create new chat session
    if (action === 'start' && workflow_id) {
      const resp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${workflow_id}/text-chat/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Demo-${Date.now()}` }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: `Failed to start session: ${err.substring(0, 200)}` });
      }
      const session = await resp.json();
      // Extract messages from session_data
      const messages = (session.session_data?.turns || []).map(t => ({
        role: t.role || (t.type === 'user' ? 'user' : 'assistant'),
        content: t.text || t.content || '',
      }));
      return res.json({
        run_id: session.workflow_run_id,
        revision: session.revision,
        messages,
        is_completed: session.is_completed,
      });
    }

    // Action: send message
    if (action === 'send' && workflow_id && run_id && message) {
      const resp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${workflow_id}/text-chat/sessions/${run_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: `Message failed: ${err.substring(0, 200)}` });
      }
      const session = await resp.json();
      const messages = (session.session_data?.turns || []).map(t => ({
        role: t.role || (t.type === 'user' ? 'user' : 'assistant'),
        content: t.text || t.content || '',
      }));
      return res.json({
        run_id: session.workflow_run_id,
        revision: session.revision,
        messages,
        is_completed: session.is_completed,
      });
    }

    return res.status(400).json({ error: 'Invalid action. Use: info, start, or send' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
