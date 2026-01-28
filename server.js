// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
require("dotenv").config();

const authRoutes = require("./src/routes/auth");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://192.168.1.100:3000"], // Add your local IP
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://192.168.1.100:3000"]
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Error:", err));

// Temporary session storage (in production use Redis)
const sessions = new Map();

// Session cleanup after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.timestamp > 10 * 60 * 1000) {
      sessions.delete(key);
      console.log(`🗑️ Session expired: ${key}`);
    }
  }
}, 60000);

// Routes
app.use("/api/auth", authRoutes);

// Test route
app.get("/", (req, res) => {
  res.json({ message: "🚀 Face Auth Backend Running!" });
});

// NEW ROUTE: Store session data
app.post("/api/session/create", (req, res) => {
  const { sessionId, email, password, type } = req.body;
  
  if (!sessionId || !email || !password || !type) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing required fields" 
    });
  }
  
  sessions.set(sessionId, {
    email,
    password,
    type,
    timestamp: Date.now()
  });
  
  console.log(`💾 Session created: ${sessionId} (${type})`);
  res.json({ success: true, sessionId });
});

// NEW ROUTE: Get session data
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session) {
    res.json({ success: true, data: session });
  } else {
    res.status(404).json({ 
      success: false, 
      message: "Session not found or expired" 
    });
  }
});

// Socket.IO for QR Code Communication
const activeQRSessions = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("qr-generated", (data) => {
    const { sessionId, type } = data;
    activeQRSessions.set(sessionId, { socketId: socket.id, type });
    console.log(`📱 QR Session created: ${sessionId} (${type})`);
  });

  socket.on("face-captured", async (data) => {
    const { sessionId, faceDescriptor, email, password } = data;
    const session = activeQRSessions.get(sessionId);

    if (session) {
      console.log(`✅ Face captured for session: ${sessionId}`);
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));