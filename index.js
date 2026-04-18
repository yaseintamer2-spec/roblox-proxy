const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const METRICS_TTL = 90 * 1000;

function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data, ttl) {
    cache.set(key, { data, time: Date.now(), ttl: ttl || CACHE_TTL });
}

// ── CONVERT GAME ID TO UNIVERSE ID ───────────────────────────
async function toUniverseId(gameId) {
    const cacheKey = "universe_" + gameId;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const res = await fetch(
        `https://apis.roblox.com/universes/v1/places/${gameId}/universe`
    );
    const data = await res.json();

    if (!data.universeId) throw new Error("Could not convert game ID to universe ID");

    setCache(cacheKey, data.universeId, 24 * 60 * 60 * 1000); // cache for 24 hours (never changes)
    return data.universeId;
}

// ── PING ──────────────────────────────────────────────────────
app.get("/ping", (req, res) => {
    res.send("pong");
});

// ── REFRESH USER CACHE ────────────────────────────────────────
app.get("/refresh/:userId", async (req, res) => {
    const userId = req.params.userId;
    cache.delete("clothing_" + userId);
    cache.delete("passes_" + userId);
    cache.delete("all_" + userId);
    res.json({ success: true, message: "Cache cleared for " + userId });
});

// ── GAME METRICS (pass game ID, auto converts to universe ID) ─
app.get("/metrics/:gameId", async (req, res) => {
    const gameId = req.params.gameId;

    try {
        // Auto convert game ID → universe ID
        const universeId = await toUniverseId(gameId);

        const cacheKey = "metrics_" + universeId;
        const cached = getCache(cacheKey);
        if (cached) return res.json(cached);

        // Fetch game details and votes in parallel
        const [detailsRes, votesRes] = await Promise.all([
            fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
            fetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`)
        ]);

        const detailsData = await detailsRes.json();
        const votesData = await votesRes.json();

        const game = (detailsData.data || [])[0];
        const votes = (votesData.data || [])[0];

        if (!game) {
            return res.status(404).json({ error: "Game not found" });
        }

        const activePlayers = game.playing || 0;
        const totalVisits = game.visits || 0;

        // Visits per minute calculation
        const prevKey = "prev_visits_" + universeId;
        const prev = cache.get(prevKey);
        let visitsPerMinute = 0;

        if (prev) {
            const minutesElapsed = (Date.now() - prev.time) / 60000;
            const visitDiff = totalVisits - prev.visits;
            visitsPerMinute = minutesElapsed > 0
                ? Math.round(visitDiff / minutesElapsed)
                : 0;
        }

        cache.set(prevKey, { visits: totalVisits, time: Date.now() });

        // Like/dislike ratio
        const upVotes = votes ? votes.upVotes || 0 : 0;
        const downVotes = votes ? votes.downVotes || 0 : 0;
        const totalVotes = upVotes + downVotes;
        const likeDislikeRatio = totalVotes > 0
            ? Math.round((upVotes / totalVotes) * 1000) / 10
            : 0;

        const result = {
            activePlayers,
            visitsPerMinute: Math.max(0, visitsPerMinute),
            likeDislikeRatio
        };

        setCache(cacheKey, result, METRICS_TTL);
        res.json(result);

    } catch (e) {
        res.status(500).json({ error: "Failed to fetch metrics: " + e.message });
    }
});

// ── CLOTHING ──────────────────────────────────────────────────
app.get("/clothing/:userId", async (req, res) => {
    const userId = req.params.userId;
    const cacheKey = "clothing_" + userId;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = `https://catalog.roblox.com/v1/search/items/details?CreatorTargetId=${userId}&Category=3&Limit=120`;
        const response = await fetch(url);
        const data = await response.json();

        const items = (data.data || [])
            .filter(item => item.price && item.price > 0)
            .map(item => ({
                id: item.id,
                name: item.name,
                price: item.price,
                type: "Clothing"
            }));

        setCache(cacheKey, items, CACHE_TTL);
        res.json(items);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch clothing" });
    }
});

// ── GAMEPASSES ────────────────────────────────────────────────
app.get("/gamepasses/:userId", async (req, res) => {
    const userId = req.params.userId;
    const cacheKey = "passes_" + userId;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    try {
        const gamesRes = await fetch(
            `https://games.roblox.com/v2/users/${userId}/games?accessFilter=2&limit=50&sortOrder=Asc`
        );
        const gamesData = await gamesRes.json();
        const universeIds = (gamesData.data || []).map(g => g.id);

        const passes = [];
        const seen = new Set();

        await Promise.all(universeIds.map(async (universeId) => {
            try {
                const passRes = await fetch(
                    `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?passView=Full&pageSize=100`
                );
                const passData = await passRes.json();
                for (const pass of (passData.gamePasses || [])) {
                    if (pass.price && pass.price > 0 && !seen.has(pass.id)) {
                        seen.add(pass.id);
                        passes.push({
                            id: pass.id,
                            name: pass.displayName || pass.name,
                            price: pass.price,
                            type: "GamePass"
                        });
                    }
                }
            } catch (_) {}
        }));

        setCache(cacheKey, passes, CACHE_TTL);
        res.json(passes);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch gamepasses" });
    }
});

// ── ALL ITEMS COMBINED ────────────────────────────────────────
app.get("/all/:userId", async (req, res) => {
    const userId = req.params.userId;
    const cacheKey = "all_" + userId;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    try {
        const [clothingRes, passesRes] = await Promise.all([
            fetch(`http://localhost:${PORT}/clothing/${userId}`),
            fetch(`http://localhost:${PORT}/gamepasses/${userId}`)
        ]);

        const clothing = await clothingRes.json();
        const passes = await passesRes.json();
        const all = [
            ...(Array.isArray(clothing) ? clothing : []),
            ...(Array.isArray(passes) ? passes : [])
        ];

        setCache(cacheKey, all, CACHE_TTL);
        res.json(all);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch all items" });
    }
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
