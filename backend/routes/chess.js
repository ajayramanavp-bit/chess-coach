const express = require('express');
const router = express.Router();
const axios = require('axios');

// Fetch Chess.com games
router.get('/games/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const archivesRes = await axios.get(
      `https://api.chess.com/pub/player/${username}/games/archives`,
      { headers: { 'User-Agent': 'ChessCoachApp/1.0' } }
    );
    const archives = archivesRes.data.archives;
    if (!archives || archives.length === 0) {
      return res.status(404).json({ error: 'No games found for this user' });
    }

    // Get last 2 months of games
    const recentArchives = archives.slice(-2);
    let allGames = [];

    for (const url of recentArchives) {
      const gamesRes = await axios.get(url, {
        headers: { 'User-Agent': 'ChessCoachApp/1.0' }
      });
      allGames = allGames.concat(gamesRes.data.games || []);
    }

    // Return last 100 games
    const last100 = allGames.slice(-100);
    res.json({ games: last100, total: last100.length });

  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ error: 'Chess.com username not found' });
    }
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;