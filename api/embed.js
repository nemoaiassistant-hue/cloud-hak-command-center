// /api/embed.js — Returns Dograh embed token + tunnel URLs for voice widget
const DOGRAH_URL = process.env.DOGRAH_API_URL || 'https://voice.cloud-hak.com';
const DOGRAH_PASS = process.env.DOGRAH_PASSWORD || 'CloudHak2026!';

// Tunnel URLs (updated when permanent domain is ready)
const TUNNEL_API = process.env.TUNNEL_API_URL || 'https://voice.cloud-hak.com';
const TUNNEL_UI = process.env.TUNNEL_UI_URL || 'https://voice-ui.cloud-hak.com';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const workflow_id = req.query?.workflow_id;
  if (!workflow_id) return res.status(400).json({ error: 'workflow_id required' });

  try {
    const token = await dograhLogin();

    // Get existing embed token
    let embedToken = null;
    const getResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${workflow_id}/embed-token`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (getResp.ok) {
      const data = await getResp.json();
      if (data && typeof data === 'object' && data.token) {
        embedToken = data.token;
      }
    }

    // Create if doesn't exist
    if (!embedToken) {
      const createResp = await fetch(`${DOGRAH_URL}/api/v1/workflow/${workflow_id}/embed-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!createResp.ok) throw new Error('Failed to create embed token');
      const data = await createResp.json();
      embedToken = data.token;
    }

    // Get embed config
    let config = { theme: 'light', position: 'bottom-right', button_text: 'Start Voice Call' };
    const configResp = await fetch(`${DOGRAH_URL}/api/v1/public/embed/config/${embedToken}`);
    if (configResp.ok) {
      config = await configResp.json();
    }

    return res.json({
      token: embedToken,
      widgetUrl: `/api/widget.js?token=${embedToken}&environment=production&apiEndpoint=${TUNNEL_API}`,
      apiEndpoint: TUNNEL_API,
      uiEndpoint: TUNNEL_UI,
      config,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
