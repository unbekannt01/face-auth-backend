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
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/faceauth")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Error:", err));

// Routes
app.use("/api/auth", authRoutes);

// Test route
app.get("/", (req, res) => {
  res.json({ message: "🚀 Face Auth Backend Running!" });
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
