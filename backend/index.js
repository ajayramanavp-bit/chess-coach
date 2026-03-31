const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── GET CHESS.COM GAMES ───────────────────────────────────────────────────
app.get('/api/games/:username', async (req, res) => {
  const { username } = req.params;

  try {
    // Get list of monthly archives
    const archivesRes = await fetch(
      `https://api.chess.com/pub/player/${username}/games/archives`,
      { headers: { 'User-Agent': 'ChessCoachApp/1.0' } }
    );

    if (!archivesRes.ok) {
      return res.status(404).json({ error: 'Player not found on Chess.com' });
    }

    const archivesData = await archivesRes.json();
    const archives = archivesData.archives || [];

    if (!archives.length) {
      return res.json([]);
    }

    // Fetch the last 2 months of games
    const recentArchives = archives.slice(-2).reverse();
    let allGames = [];

    for (const archiveUrl of recentArchives) {
      try {
        const gamesRes = await fetch(archiveUrl, {
          headers: { 'User-Agent': 'ChessCoachApp/1.0' }
        });
        if (!gamesRes.ok) continue;
        const gamesData = await gamesRes.json();
        const games = gamesData.games || [];
        allGames = allGames.concat(games);
        if (allGames.length >= 100) break;
      } catch (e) {
        console.warn('Failed to fetch archive:', archiveUrl);
      }
    }

    // Return last 100 games
    const result = allGames.slice(-100);
    res.json(result);

  } catch (err) {
    console.error('Games fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── AI COACH CHAT ─────────────────────────────────────────────────────────
app.options('/api/chat', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/chat', async (req, res) => {
  const { message, fen, history, eval: evalScore } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided.' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server. Please add it in Railway environment variables.' });
  }

  const systemPrompt = `You are an expert chess coach. You can see the player's current game state at all times.

Current board position (FEN): ${fen || 'starting position'}
Recent moves played: ${history && history.length ? history.join(', ') : 'none yet'}
Engine evaluation: ${evalScore !== undefined && evalScore !== null ? evalScore : 'not available'}

Give concise, practical chess advice. Reference specific pieces and squares when helpful. Be encouraging but honest. Keep responses under 120 words unless the player explicitly asks for a detailed explanation.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2023-12-15'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        stream: true,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Claude API error:', errText);
      return res.status(502).json({ error: 'Claude API error: ' + errText });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (
            parsed.type === 'content_block_delta' &&
            parsed.delta &&
            parsed.delta.type === 'text_delta' &&
            parsed.delta.text
          ) {
            res.write('data: ' + JSON.stringify({ text: parsed.delta.text }) + '\n\n');
          }
          if (parsed.type === 'message_stop') {
            res.write('data: [DONE]\n\n');
          }
        } catch (_) {
          // skip malformed lines
        }
      }
    }

    res.end();

  } catch (err) {
    console.error('Chat route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// ── START SERVER ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Chess Coach backend running on port ' + PORT);
});