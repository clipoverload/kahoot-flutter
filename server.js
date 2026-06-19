const http = require('http');
const https = require('https'); // for manual request fallback
const WebSocket = require('ws');
const cloudscraper = require('cloudscraper');

let cachedCookies = null;
let fetchPromise = null;

// ----- Automatically get cookies from play.kahoot.it -----
async function getCookies() {
  console.log('Fetching session cookies from play.kahoot.it...');
  try {
    const res = await cloudscraper.get('https://play.kahoot.it', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      },
      resolveWithFullResponse: true
    });
    console.log('Response status:', res.statusCode);
    console.log('Response headers:', JSON.stringify(res.headers));
    const setCookie = res.headers['set-cookie'];
    if (!setCookie || setCookie.length === 0) throw new Error('No cookies in response');
    const cookies = setCookie.map(c => c.split(';')[0]).join('; ');
    console.log('Cookies:', cookies.substring(0, 100) + '...');
    return cookies;
  } catch (err) {
    console.error('cloudscraper failed:', err.message);
    // Fallback: try a plain HTTPS request (might get a block page, but can help debug)
    console.log('Attempting plain HTTPS request as fallback...');
    return new Promise((resolve, reject) => {
      https.get('https://play.kahoot.it', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      }, (res) => {
        console.log('Fallback status:', res.statusCode);
        const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        console.log('Fallback cookies:', cookies.substring(0, 100) || '(none)');
        if (cookies) {
          resolve(cookies);
        } else {
          reject(new Error('No cookies even from fallback'));
        }
      }).on('error', reject);
    });
  }
}

// ----- Bot creation (now uses play.kahoot.it) -----
function createBot(pin, username, cookies, onStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://play.kahoot.it/cometd/websocket', {
      headers: {
        'Origin': 'https://play.kahoot.it',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies
      }
    });
    let clientId = null, joined = false, msgId = 0;

    ws.on('open', () => {
      onStatus('connected');
      ws.send(JSON.stringify({
        channel: '/meta/handshake',
        ext: { ack: true },
        id: String(++msgId),
        minimumVersion: '0.1',
        supportedConnectionTypes: ['websocket', 'long-polling'],
        version: '1.0'
      }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const ch = msg.channel;

      if (ch === '/meta/handshake' && msg.successful) {
        clientId = msg.clientId;
        ws.send(JSON.stringify({
          channel: '/meta/connect', clientId,
          connectionType: 'websocket', ext: { ack: true },
          id: String(++msgId)
        }));
      } else if (ch === '/meta/connect' && msg.successful) {
        ws.send(JSON.stringify({
          channel: '/meta/subscribe', clientId,
          subscription: '/service/player', id: String(++msgId)
        }));
        ws.send(JSON.stringify({
          channel: '/meta/subscribe', clientId,
          subscription: '/service/controller', id: String(++msgId)
        }));
      } else if (ch === '/meta/subscribe' && msg.successful) {
        ws.send(JSON.stringify({
          channel: '/service/controller', clientId,
          data: { gameid: pin, name: username, host: 'play.kahoot.it', type: 'login' },
          id: String(++msgId)
        }));
      } else if (ch === '/service/player') {
        const data = msg.data;
        if (data && data.playerId && !joined) {
          joined = true;
          onStatus('✅ JOINED');
          const keepAlive = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                channel: '/meta/connect', clientId,
                connectionType: 'websocket', ext: { ack: true },
                id: String(++msgId)
              }));
            }
          }, 25000);
          ws.on('close', () => clearInterval(keepAlive));
          resolve(true);
        } else if (data && data.type === 'question') {
          const choices = data.choices || [0,1,2,3];
          const answer = Math.floor(Math.random() * choices.length);
          ws.send(JSON.stringify({
            channel: '/service/controller', clientId,
            data: {
              gameid: pin, host: 'play.kahoot.it',
              type: 'message', content: String(answer),
              id: data.questionIndex || 0
            },
            id: String(++msgId)
          }));
        }
      } else if (ch === '/service/controller' && msg.data && msg.data.error) {
        onStatus('❌ ' + msg.data.error);
        ws.close();
        reject(new Error(msg.data.error));
      }
    });

    ws.on('error', err => { onStatus('❌ ' + err.message); reject(err); });
    ws.on('close', () => { if (!joined) reject(new Error('closed before join')); });
    setTimeout(() => { if (!joined) { ws.close(); reject(new Error('timeout')); } }, 15000);
  });
}

// ----- Frontend HTML (unchanged) -----
const frontend = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kahoot Flooder</title>
  <style>
    body { background:#0a0a0a; color:#0f0; font-family:monospace; padding:20px; }
    .container { max-width:700px; margin:auto; background:#111; padding:20px; border:2px solid #0f0; border-radius:8px; }
    .disclaimer { background:#300; color:#f88; padding:10px; margin-bottom:15px; border-radius:4px; text-align:center; }
    input { background:#222; color:#0f0; border:1px solid #0a0; padding:8px; margin:5px 0; width:100%; font-family:monospace; }
    button { background:#030; color:#0f0; border:2px solid #0f0; padding:10px; cursor:pointer; margin:5px; font-weight:bold; }
    button:hover { background:#050; }
    .stop { border-color:#f44; color:#f44; background:#300; }
    .log { background:#000; height:300px; overflow-y:auto; padding:10px; margin-top:10px; font-size:0.9em; }
    .log div { margin:2px 0; }
    .err { color:#f55; } .ok { color:#5f5; }
  </style>
</head>
<body>
<div class="container">
  <div class="disclaimer">⚠️ Educational use only.</div>
  <h1>Kahoot Flooder</h1>
  <label>Game PIN (7 digits)</label>
  <input type="text" id="pin" placeholder="1234567" maxlength="7">
  <label>Bot Name Prefix</label>
  <input type="text" id="prefix" value="Bot">
  <label>Number of Bots</label>
  <input type="range" id="count" min="1" max="500" value="25" oninput="document.getElementById('countVal').textContent=this.value">
  <span id="countVal">25</span>
  <br>
  <button onclick="launch()">🚀 Launch Attack</button>
  <button class="stop" onclick="stop()">⏹ STOP</button>
  <div id="progress" style="margin-top:10px;">Ready</div>
  <div class="log" id="log"></div>
</div>

<script>
  const logDiv = document.getElementById('log');
  function add(msg, cls='') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    logDiv.appendChild(d);
    logDiv.scrollTop = logDiv.scrollHeight;
  }

  let ws = null, botCount = 0, joinedCount = 0;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = () => add('Connected to server', 'ok');
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        add('[Bot ' + msg.botIndex + '] ' + msg.message, msg.message.includes('✅') ? 'ok' : (msg.message.includes('❌') ? 'err' : ''));
        if (msg.message.includes('JOINED')) {
          joinedCount++;
          document.getElementById('progress').textContent = 'Joined: ' + joinedCount + '/' + botCount;
        }
      } else if (msg.type === 'error') {
        add('ERROR: ' + msg.message, 'err');
      } else if (msg.type === 'done') {
        add('Attack finished.', 'ok');
      } else if (msg.type === 'cookie_status') {
        add(msg.message, 'ok');
      }
    };
    ws.onerror = () => add('Connection lost', 'err');
  }

  function launch() {
    const pin = document.getElementById('pin').value;
    if (!/^\\d{7}$/.test(pin)) return add('Invalid PIN', 'err');
    botCount = +document.getElementById('count').value;
    joinedCount = 0;
    document.getElementById('progress').textContent = 'Launching...';
    logDiv.innerHTML = '';
    add('Sending ' + botCount + ' bots to PIN ' + pin + '...');
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ action:'launch', pin, botCount, namePrefix: document.getElementById('prefix').value || 'Bot' }));
      }, 1000);
    } else {
      ws.send(JSON.stringify({ action:'launch', pin, botCount, namePrefix: document.getElementById('prefix').value || 'Bot' }));
    }
  }

  function stop() {
    add('Stopping attack...', 'err');
    if (ws) ws.close();
    ws = null;
    document.getElementById('progress').textContent = 'Stopped';
  }
  connect();
</script>
</body>
</html>`;

// ----- HTTP server + WebSocket -----
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(frontend);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', clientWs => {
  console.log('Browser connected');
  clientWs.on('message', async raw => {
    let req;
    try { req = JSON.parse(raw); } catch { return; }
    if (req.action !== 'launch') return;

    const { pin, botCount, namePrefix } = req;
    if (!cachedCookies) {
      if (!fetchPromise) {
        clientWs.send(JSON.stringify({ type: 'cookie_status', message: 'Fetching session cookies (first launch)...' }));
        fetchPromise = getCookies()
          .then(c => { cachedCookies = c; fetchPromise = null; return c; })
          .catch(err => {
            fetchPromise = null;
            clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to get cookies: ' + err.message }));
            throw err;
          });
      }
      try { await fetchPromise; } catch { return; }
    }
    clientWs.send(JSON.stringify({ type: 'cookie_status', message: 'Session ready' }));

    for (let i = 1; i <= botCount; i++) {
      const username = (namePrefix || 'Bot') + Math.floor(Math.random() * 9000 + 1000);
      clientWs.send(JSON.stringify({ type: 'status', botIndex: i, message: 'Starting ' + username + '...' }));
      try {
        await createBot(pin, username, cachedCookies, (statusMsg) => {
          clientWs.send(JSON.stringify({ type: 'status', botIndex: i, message: statusMsg }));
        });
      } catch (err) {
        clientWs.send(JSON.stringify({ type: 'status', botIndex: i, message: 'Failed: ' + err.message }));
      }
      await new Promise(r => setTimeout(r, 150));
    }
    clientWs.send(JSON.stringify({ type: 'done' }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Flooder running on port ' + PORT));
