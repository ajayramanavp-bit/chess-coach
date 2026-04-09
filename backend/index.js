const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama3-70b-8192',
  'mixtral-8x7b-32768'
];

app.use(cors());
app.use(express.json());

app.get('/api/debug-env', (req, res) => {
  res.json({
    provider: 'groq',
    expectedKey: 'GROQ_API_KEY',
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    configuredModel: process.env.GROQ_MODEL || null
  });
});

// ── GET CHESS.COM GAMES ───────────────────────────────────────────────────
app.get('/api/games/:username', async (req, res) => {
  const { username } = req.params;

  try {
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
  const { message, fen, history, legalMoves, turn, eval: evalScore } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided.' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not set on the server. Please add it in Railway environment variables.' });
  }

  const legalMoveList = Array.isArray(legalMoves) ? legalMoves.slice(0, 40) : [];
  const legalMoveSummary = legalMoveList.length
    ? legalMoveList.map((move) => `${move.san} (${move.from}-${move.to})`).join(', ')
    : 'not provided';

  const systemPrompt = `You are an expert chess coach helping with a live game.

You must stay grounded in the provided position and legal move list.
If a move is not in the legal move list, do not recommend it.
Do not invent piece locations, captures, or recaptures.
If the user's wording does not match the board, politely correct it using the current position.
When suggesting a move, prefer SAN from the legal move list and briefly explain why.
If there is uncertainty, say so instead of guessing.

Current board position (FEN): ${fen || 'starting position'}
Side to move: ${turn || 'unknown'}
Recent moves played: ${history && history.length ? history.join(', ') : 'none yet'}
Legal moves from this position: ${legalMoveSummary}
Engine evaluation: ${evalScore !== undefined && evalScore !== null ? evalScore : 'not available'}

Keep responses under 90 words unless the player asks for more detail.`;

  try {
    const configuredModel = process.env.GROQ_MODEL;
    const modelCandidates = [
      ...(configuredModel ? [configuredModel] : []),
      ...DEFAULT_GROQ_MODELS
    ].filter((model, index, list) => model && list.indexOf(model) === index);

    let groqRes = null;
    let lastGroqError = '';
    let activeModel = modelCandidates[0];

    for (const model of modelCandidates) {
      activeModel = model;
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ]
        })
      });

      if (groqRes.ok) {
        break;
      }

      const errText = await groqRes.text();
      lastGroqError = errText;
      console.error(`Groq API error for model ${model}:`, errText);

      const lowerError = errText.toLowerCase();
      const shouldTryNextModel =
        groqRes.status === 400 &&
        (lowerError.includes('model') || lowerError.includes('decommissioned') || lowerError.includes('not found'));

      if (!shouldTryNextModel) {
        return res.status(502).json({
          error: `Groq request failed (${groqRes.status}). ${errText || 'No error details returned.'}`
        });
      }
    }

    if (!groqRes || !groqRes.ok) {
      return res.status(502).json({
        error: `Groq rejected all configured models. Last attempted model: ${activeModel}. ${lastGroqError || 'No error details returned.'}`
      });
    }

    if (!groqRes.body || typeof groqRes.body.getReader !== 'function') {
      return res.status(502).json({
        error: 'Groq returned a response body that cannot be streamed by this server runtime.'
      });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Coach-Model', activeModel);

    const reader = groqRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) {
            res.write('data: ' + JSON.stringify({ text }) + '\n\n');
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
