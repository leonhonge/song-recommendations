import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID as string;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET as string;
const REDIRECT_URI = "http://127.0.0.1:3001/callback";
const PORT = 3001;

// Temporary tracks to test, will implement inputting tracks dynamically later
const SEED_TRACKS = [
    { title: "Running", artist: "Zerb" },
    { title: "Don't You Cry", artist: "Sunday Scaries" },
    { title: "I Know I Know", artist: "Saiilor" },
];

const RESULT_COUNT = 30;

const MAX_SCORE: number | null = null;

// Can adjust weights based on what I am looking for
const FEATURE_WEIGHTS = {
    energy: 1.2,
    danceability: 1.0,
    tempo: 0.8,
    valence: 0.6,
    acousticness: 0.3,
};

interface AudioFeatures {
    acousticness: number;
    danceability: number;
    energy: number;
    instrumentalness: number;
    liveness: number;
    loudness: number;
    speechiness: number;
    tempo: number;
    valence: number;
}

interface SpotifyTrack {
    id: string;
    name: string;
    artists: { id: string; name: string }[];
    uri: string;
}

let accessToken: string | null = null;

// helper functions

async function mapLimit<T, R>(
    arr: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    let i = 0;

    async function worker() {
        while (true) {
            const index = i++;
            if (index >= arr.length) break;

            const item = arr[index];
            if (item === undefined) continue; 

            results[index] = await fn(item);
        }
    }

    await Promise.all(Array.from({ length: limit }, worker));

    return results;
}

async function spotifySearchTrack(title: string, artist: string): Promise<SpotifyTrack | null> {
    const response = await axios.get("https://api.spotify.com/v1/search", {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { q: `track:${title} artist:${artist}`, type: "track", limit: 1 },
    });
    return response.data.tracks.items[0] ?? null;
}

async function getArtistTopTracks(artistId: string): Promise<SpotifyTrack[]> {
    const response = await axios.get(
        `https://api.spotify.com/v1/artists/${artistId}/top-tracks`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            params: {
                market: "US",
            },
        }
    );

    return response.data.tracks;
}

async function getSeedArtistCandidates(): Promise<SpotifyTrack[]> {
    const candidates: SpotifyTrack[] = [];
    const seen = new Set<string>();

    for (const seed of SEED_TRACKS) {
        const track = await spotifySearchTrack(seed.title, seed.artist);

        if (!track) continue;

        const artistId = track.artists[0]?.id;

        if (!artistId) continue;

        const topTracks = await getArtistTopTracks(artistId);

        for (const candidate of topTracks) {
            if (seen.has(candidate.id)) continue;

            seen.add(candidate.id);
            candidates.push(candidate);
        }
    }

    return candidates;
}

// reccobeat functions

const RECCO_BASE = "https://api.reccobeats.com/v1";

async function getReccoBeatsId(spotifyId: string): Promise<string | null> {
    const response = await axios.get(`${RECCO_BASE}/track`, { params: { ids: spotifyId } });
    const tracks = response.data.content ?? response.data;
    return tracks[0]?.id ?? null;
}

async function getAudioFeatures(spotifyId: string): Promise<AudioFeatures | null> {
    const reccoId = await getReccoBeatsId(spotifyId);
    if (!reccoId) return null;

    try {
        const response = await axios.get(`${RECCO_BASE}/track/${reccoId}/audio-features`);
        return response.data;
    } catch {
        return null;
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// scoring functions

function similarityScore(target: AudioFeatures, candidate: AudioFeatures): number {
    const normalize = (key: keyof typeof FEATURE_WEIGHTS, value: number) =>
        key === "tempo" ? value / 200 : value;

    let distance = 0;
    for (const key of Object.keys(FEATURE_WEIGHTS) as (keyof typeof FEATURE_WEIGHTS)[]) {
        const diff = normalize(key, target[key]) - normalize(key, candidate[key]);
        distance += FEATURE_WEIGHTS[key] * diff * diff;
    }
    return distance;
}

// match function

async function matchTracks(): Promise<{ name: string; artist: string; score: number }[]> {
    const seedTracks = await Promise.all(
        SEED_TRACKS.map(async (seed) => {
            const track = await spotifySearchTrack(seed.title, seed.artist);
            if (!track) return null;
            return track;
        })
    );

    const seedFeatures = (
        await Promise.all(
            seedTracks
                .filter((t): t is SpotifyTrack => t !== null)
                .map((t) => getAudioFeatures(t.id))
        )
    ).filter((f): f is AudioFeatures => f !== null);

    if (seedFeatures.length === 0) {
        throw new Error("Couldn't analyze any seed tracks — check the titles/artists in SEED_TRACKS");
    }
    const target = {} as AudioFeatures;
    const first = seedFeatures[0];
    if (!first) {
        throw new Error("No seed features.")
    }
    for (const key of Object.keys(first) as (keyof AudioFeatures)[]) {
        target[key] = seedFeatures.reduce((sum, f) => sum + f[key], 0) / seedFeatures.length;
    }

    const seedIds = new Set(
        seedTracks
            .filter((t): t is SpotifyTrack => t !== null)
            .map((t) => t.id)
    );

    const candidates = (await getSeedArtistCandidates())
        .filter(track => !seedIds.has(track.id));
        
    const featuresList = await mapLimit(candidates, 5, (track) =>
        getAudioFeatures(track.id)
    );

    const scored = candidates
        .map((track, i) => {
            const features = featuresList[i];
            if (!features) return null;

            return {
                track,
                score: similarityScore(target, features),
            };
        })
        .filter((x): x is { track: SpotifyTrack; score: number } => x !== null);

    scored.sort((a, b) => a.score - b.score);
    
    if (scored.length > 0) {
        const scores = scored.map(s => s.score);

        const first = scores[0];
        if (first === undefined) return [];

        const best = first;

        const midIndex = Math.floor(scores.length / 2);
        const median = scores[midIndex] ?? best;

        const worst = scores.at(-1) ?? best;

        console.log(
            `\nScore range across ${scores.length} candidates — best: ${best.toFixed(3)}, ` +
            `median: ${median.toFixed(3)}, worst: ${worst.toFixed(3)}`
        );
    }

    const filtered = MAX_SCORE === null ? scored : scored.filter((s) => s.score <= MAX_SCORE);
    const best = filtered.slice(0, RESULT_COUNT);

    if (MAX_SCORE !== null && best.length < RESULT_COUNT) {
        console.log(`Only ${best.length} candidates scored under MAX_SCORE=${MAX_SCORE} — returning fewer than RESULT_COUNT.`);
    }

    const results = best.map((b) => ({
        name: b.track.name,
        artist: b.track.artists[0]?.name ?? "",
        score: Math.round(b.score * 1000) / 1000,
    }));

    // frontend not designed, so just log it for now
    console.log(`\nTop ${results.length} matches for your seed vibe:`);
    results.forEach((r, i) => console.log(`${i + 1}. ${r.name} — ${r.artist} (score: ${r.score})`));

    return results;
}

// actual server

const app = express();
app.use(cors());
app.use(express.json());

app.get("/login", (_req, res) => {
    const authUrl =
        "https://accounts.spotify.com/authorize?" +
        new URLSearchParams({
            response_type: "code",
            client_id: CLIENT_ID,
            scope: "user-top-read user-library-read playlist-read-private",
            redirect_uri: REDIRECT_URI,
        });
    res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).send("No code provided");

    try {
        const params = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        });
        const tokenResponse = await axios.post("https://accounts.spotify.com/api/token", params, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        accessToken = tokenResponse.data.access_token;
        res.send('Authenticated. Now hit <a href="/match">/match</a> to see your top matches.');
    } catch (err: any) {
        console.error(err.response?.data || err.message);
        res.status(500).send("Authentication failed");
    }
});

app.get("/match", async (_req, res) => {
    if (!accessToken) return res.status(401).send("Not authenticated — visit /login first");

    try {
        const results = await matchTracks();
        res.json(results);
    } catch (err: any) {
        console.error(err.response?.data || err.message);
        res.status(500).send(err.message ?? "Failed to match tracks");
    }
});

app.get("/", (_req, res) => res.send("backend alive"));

app.listen(PORT, () => console.log(`Server running on http://127.0.0.1:${PORT}`));