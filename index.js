const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

app.get("/ping", (req, res) => {
    res.send("pong");
});

app.get("/refresh/:userId", async (req, res) => {
    const userId = req.params.userId;
    cache.delete("clothing_" + userId);
    cache.delete("passes_" + userId);
    cache.delete("all_" + userId);
    res.json({ success: true, message: "Cache cleared for " + userId });
});

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

        setCache(cacheKey, items);
        res.json(items);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch clothing" });
    }
});

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

        setCache(cacheKey, passes);
        res.json(passes);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch gamepasses" });
    }
});

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

        setCache(cacheKey, all);
        res.json(all);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch all items" });
    }
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
