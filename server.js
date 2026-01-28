// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const authRoutes = require("./src/routes/auth");

const app = express();
const server = http.createServer(app);

/* ================================
   ✅ ALLOWED ORIGINS (LOCAL + PROD)
================================ */
const allowedOrigins = [
  "http://localhost:3000",
  "http://192.168.1.100:3000",
  "https://face-auth-frontend-lake.vercel.app"
];

/* ================================
   ✅ EXPRESS CORS (REST APIs)
================================ */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

/* ================================
   ✅ SOCKET.IO WITH CORS
================================ */
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/* ================================
   ✅ MONGODB CONNECTION
================================ */
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

/* ================================
   ✅ TEMP SESSION STORAGE
================================ */
const sessions = new Map();

// Cleanup expired sessions (10 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.timestamp > 10 * 60 * 1000) {
      sessions.delete(key);
      console.log(`🗑️ Session expired: ${key}`);
    }
  }
}, 60000);

/* ================================
   ✅ ROUTES
================================ */
app.use("/api/auth", authRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({ message: "🚀 Face Auth Backend Running!" });
});

// Create session
app.post("/api/session/create", (req, res) => {
  const { sessionId, email, password, type } = req.body;

  if (!sessionId || !email || !password || !type) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  sessions.set(sessionId, {
    email,
    password,
    type,
    timestamp: Date.now(),
  });

  console.log(`💾 Session created: ${sessionId} (${type})`);
  res.json({ success: true, sessionId });
});

// Get session
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (session) {
    res.json({ success: true, data: session });
  } else {
    res.status(404).json({
      success: false,
      message: "Session not found or expired",
    });
  }
});

/* ================================
   ✅ SOCKET.IO LOGIC
================================ */
const activeQRSessions = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("qr-generated", ({ sessionId, type }) => {
    activeQRSessions.set(sessionId, {
      socketId: socket.id,
      type,
    });
    console.log(`📱 QR Session created: ${sessionId} (${type})`);
  });

  socket.on("face-captured", (data) => {
    const { sessionId, faceDescriptor, email, password } = data;
    const session = activeQRSessions.get(sessionId);

    if (session) {
      console.log(`✅ Face verified for session: ${sessionId}`);

      io.to(session.socketId).emit("face-verified", {
        success: true,
        faceDescriptor,
        email,
        password,
      });

      activeQRSessions.delete(sessionId);
    } else {
      console.log(`❌ Session not found: ${sessionId}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

/* ================================
   ✅ SERVER START
================================ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
