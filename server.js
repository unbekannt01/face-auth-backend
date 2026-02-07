// backend/server.js

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
require("dotenv").config();

// Import security middleware
const {
  getSecurityHeaders,
  sanitizeInput,
  checkIPReputation,
  rateLimiters,
  trackSuspiciousActivity,
  decryptFaceDescriptor,
} = require("./src/middleware/security");

const authRoutes = require("./src/routes/auth");
const User = require("./src/models/User");
const QRAuthManager = require("./src/utils/qrAuth");

const app = express();
const server = http.createServer(app);

/* ================================
    🔧 CRITICAL FIX: TRUST PROXY
    Must be set BEFORE any middleware
================================ */
app.set("trust proxy", true);

/* ================================
    SECURITY HEADERS
================================ */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // Allow WebSocket
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

app.use(getSecurityHeaders);
app.use(checkIPReputation);

/* ================================
    ALLOWED ORIGINS (LOCAL + PROD)
================================ */
const allowedOrigins = [
  "http://localhost:3000",
  "http://192.168.1.100:3000",
  "https://face-auth01.vercel.app",
];

// Add production URLs from env
if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

/* ================================
    EXPRESS CORS (REST APIs)
================================ */
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error(`❌ CORS blocked: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

/* ================================
    BODY PARSERS + SANITIZATION
================================ */
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(sanitizeInput);

/* ================================
    RATE LIMITING
================================ */
app.use("/api/", rateLimiters.api);

/* ================================
    SOCKET.IO WITH CORS
================================ */
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // ⚡ OPTIMIZATION: Faster ping/pong
  pingTimeout: 20000,
  pingInterval: 10000,
  // ⚡ Allow larger payloads for face data
  maxHttpBufferSize: 5e6, // 5MB
});

/* ================================
    MONGODB CONNECTION
================================ */
mongoose
  .connect(process.env.MONGODB_URI, {
    // ⚡ OPTIMIZATION: Connection pooling
    maxPoolSize: 10,
    minPoolSize: 2,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    if (process.env.NODE_ENV !== "production") {
      console.log("✅ MongoDB Connected");
    }
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
    process.exit(1);
  });

/* ================================
    ROUTES
================================ */
app.use("/api/auth", authRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    timestamp: Date.now(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    mongodb:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// Backward compatibility
app.use("/api/session", (req, res) => {
  const newUrl = `/api/auth/session${req.url}`;
  res.redirect(307, newUrl);
});

/* ================================
    SOCKET.IO HANDLERS
================================ */

function euclideanDistance(desc1, desc2) {
  if (!desc1 || !desc2 || desc1.length !== desc2.length) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    sum += Math.pow(desc1[i] - desc2[i], 2);
  }
  return Math.sqrt(sum);
}

io.on("connection", (socket) => {
  const clientIP =
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;

  if (process.env.NODE_ENV !== "production") {
    console.log("🔌 Client connected:", socket.id);
  }

  socket.on("qr-generated", (data) => {
    const { sessionId, type, email } = data;

    if (process.env.NODE_ENV !== "production") {
      console.log("📱 QR generated for session:", sessionId, "Type:", type);
    }

    socket.join(sessionId);
  });

  socket.on("face-captured", async (data) => {
    const { sessionId, faceDescriptor, email, password, type } = data;

    if (process.env.NODE_ENV !== "production") {
      console.log("📸 Face captured for session:", sessionId);
      console.log("Type:", type, "Email:", email);
    }

    try {
      // Decrypt face descriptor if encrypted
      let decryptedDescriptor = faceDescriptor;
      if (typeof faceDescriptor === "string" && faceDescriptor.includes(":")) {
        decryptedDescriptor = decryptFaceDescriptor(faceDescriptor);
        if (!decryptedDescriptor) {
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Invalid encrypted data",
          });
          return;
        }
      }

      if (type === "login") {
        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
          trackSuspiciousActivity(clientIP, "User not found");
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Authentication failed",
          });
          return;
        }

        if (!user.faceDescriptor || user.faceDescriptor.length === 0) {
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "No biometric data registered",
          });
          return;
        }

        const distance = euclideanDistance(
          user.faceDescriptor,
          decryptedDescriptor,
        );
        const threshold = 0.6;

        if (process.env.NODE_ENV !== "production") {
          console.log(
            "🔍 Face comparison - Distance:",
            distance,
            "Threshold:",
            threshold,
          );
        }

        if (distance > threshold) {
          trackSuspiciousActivity(clientIP, "Failed face verification");
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Biometric verification failed",
          });
          return;
        }

        // ✅ FACE MATCHED
        let qrSession = QRAuthManager.getAuthSession(sessionId);

        if (!qrSession) {
          const tempSession = {
            sessionId,
            userId: user._id.toString(),
            email: user.email,
            type: "login",
            status: "pending",
            createdAt: Date.now(),
            expiresAt: Date.now() + 10 * 60 * 1000,
          };
          QRAuthManager.sessions.set(sessionId, tempSession);
        }

        QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          verifiedAt: Date.now(),
          matchDistance: distance,
        });

        io.to(sessionId).emit("face-verification-complete", {
          sessionId,
          success: true,
          faceDescriptor: decryptedDescriptor,
          email: email,
          userId: user._id.toString(),
          message: "Biometric verification successful",
        });
      } else if (type === "register") {
        io.to(sessionId).emit("face-verified", {
          sessionId,
          success: true,
          faceDescriptor: decryptedDescriptor,
          message: "Biometric data captured",
        });
      } else if (type === "update-face") {
        const session = QRAuthManager.getAuthSession(sessionId);

        if (!session || !session.userId) {
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Invalid session",
          });
          return;
        }

        const user = await User.findById(session.userId);

        if (!user) {
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "User not found",
          });
          return;
        }

        user.faceDescriptor = decryptedDescriptor;

        if (!user.faceDescriptors) {
          user.faceDescriptors = [];
        }
        user.faceDescriptors.push(decryptedDescriptor);

        if (user.faceDescriptors.length > 3) {
          user.faceDescriptors = user.faceDescriptors.slice(-3);
        }

        await user.save();

        QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          updatedAt: Date.now(),
          type: "update-face",
        });

        io.to(sessionId).emit("face-verification-complete", {
          sessionId,
          success: true,
          message: "Biometric data updated",
        });
      }
    } catch (error) {
      console.error("❌ Face verification error:", error.message);

      io.to(sessionId).emit("face-verification-complete", {
        sessionId,
        success: false,
        message: "Verification failed",
      });
    }
  });

  socket.on("disconnect", () => {
    if (process.env.NODE_ENV !== "production") {
      console.log("🔌 Client disconnected:", socket.id);
    }
  });
});

/* ================================
    ERROR HANDLING
================================ */
app.use((err, req, res, next) => {
  console.error("Error:", err.message);

  res.status(err.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

/* ================================
    SERVER START
================================ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  if (process.env.NODE_ENV !== "production") {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔒 Trust proxy: ${app.get("trust proxy")}`);
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => {
    mongoose.connection.close(false, () => {
      process.exit(0);
    });
  });
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully");
  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log("MongoDB connection closed successfully");
    } catch (err) {
      console.error("Error closing MongoDB connection:", err);
    } finally {
      process.exit(0);
    }
  });
});

module.exports = { app, server, io };
