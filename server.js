// backend/server.js
// FINAL CLEAN VERSION with proper socket handler separation

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const authRoutes = require("./src/routes/auth");
const setupSocketHandlers = require("./src/utils/socketHandler");

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
   ✅ ROUTES
================================ */
app.use("/api/auth", authRoutes);

app.get("/", (req, res) => {
  res.json({ message: "🚀 Face Auth Backend Running!" });
});

/* ================================
   ✅ SOCKET HANDLER SETUP
================================ */
setupSocketHandlers(io);

/* ================================
   ✅ SERVER START
================================ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
