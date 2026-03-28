import express from "express";
import { createServer as createHttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { GoogleGenAI } from "@google/genai";

// Initialize Express
const app = express();
const httpServer = createHttpServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;

// Middleware
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Vite dev mode
}));
app.use(express.json());

// Gemini AI Setup
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// API Routes
app.post("/api/moderate", async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Invalid text" });
  }

  try {
    const prompt = `
      You are a classroom Q&A moderator. 
      Analyze the following question from a student: "${text}"
      
      Tasks:
      1. Detect if it's inappropriate, offensive, or irrelevant to a classroom setting.
      2. If it's appropriate, suggest a clearer, more professional phrasing (only if needed, otherwise return the original).
      
      Return a JSON object with:
      - "isInappropriate": boolean
      - "suggestedText": string
      - "reason": string (optional, why it was flagged)
    `;

    const result = await genAI.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
      }
    });

    const responseText = result.text;
    const moderation = JSON.parse(responseText);
    res.json(moderation);
  } catch (error) {
    console.error("AI Moderation Error:", error);
    // Fallback: assume it's okay but don't suggest changes
    res.json({ isInappropriate: false, suggestedText: text });
  }
});

// Socket.io for real-time "Selected Question" state
let selectedQuestionId: string | null = null;

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Send current state to new connection
  socket.emit("selection_update", selectedQuestionId);

  socket.on("select_question", (questionId: string | null) => {
    selectedQuestionId = questionId;
    io.emit("selection_update", selectedQuestionId);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Vite middleware setup
async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupVite();
