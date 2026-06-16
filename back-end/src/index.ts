import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config()

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID as string;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET as string;
const REDIRECT_URI = "http://127.0.0.1:3001/callback";

app.get("/login", (_, res) => {
    const scope = "user-top-read";

    const authURL = 
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        scope,
        redirect_uri: REDIRECT_URI,
    });

    res.redirect(authURL);
});

app.get("/callback", async (req, res) => {
    try {
        const code = req.query.code as string;

        if (!code){
            return res.status(400).send("No code provided");
        }

        const params = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        });

        const tokenResponse = await axios.post(
            "https://accounts.spotify.com/api/token",
            params,
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );

        const access_token = tokenResponse.data.access_token;

        const topTracks = await axios.get(
            "https://api.spotify.com/v1/me/top/tracks",
            {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                },
            }
        );
        res.json(topTracks.data);
    } catch (err: any) {
        console.error(err.response?.data || err.message);
        res.status(500).send("Something went wrong");
    }
});

app.get("/", (_, res) => {
    res.send("backend alive");
});

const PORT = 3001;

app.listen(PORT, () => {
    console.log(`Server running on http://127.0.0.1:${PORT}.`)
});