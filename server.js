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
    SECURITY HEADERS (FIRST!)
================================ */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
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
app.use(sanitizeInput); // Sanitize all inputs

/* ================================
    RATE LIMITING (IMPORTANT!)
================================ */
// Apply general rate limiting to all API routes
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
});

/* ================================
    MONGODB CONNECTION
================================ */
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    if (process.env.NODE_ENV === "production") {
      // Don't log in production
    } else {
      console.log("✅ MongoDB Connected");
    }
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
    process.exit(1); // Exit if DB connection fails
  });

/* ================================
    ROUTES
================================ */
app.use("/api/auth", authRoutes);

// Health check (no sensitive info)
app.get("/", (req, res) => {
  res.json({
    status: "online",
    timestamp: Date.now(),
  });
});

// Health check for monitoring
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Backward compatibility: redirect /api/session/* to /api/auth/session/*
app.use("/api/session", (req, res) => {
  const newUrl = `/api/auth/session${req.url}`;
  res.redirect(307, newUrl); // 307 preserves POST/GET method
});

/* ================================
    SOCKET.IO HANDLERS (SECURED)
================================ */

// Helper function
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
  const clientIP = socket.handshake.address;

  if (process.env.NODE_ENV !== "production") {
    console.log("🔌 Client connected:", socket.id);
  }

  // QR Code generated - desktop sends this
  socket.on("qr-generated", (data) => {
    const { sessionId, type, email } = data;

    if (process.env.NODE_ENV !== "production") {
      console.log("📱 QR generated for session:", sessionId, "Type:", type);
    }

    // Join room for this session
    socket.join(sessionId);
  });

  // Face captured from mobile
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
        // LOGIN: Verify face matches registered user
        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
          if (process.env.NODE_ENV !== "production") {
            console.log("❌ User not found:", email);
          }

          trackSuspiciousActivity(clientIP, "User not found attempt");

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

        // Compare faces
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
          if (process.env.NODE_ENV !== "production") {
            console.log("❌ Face does not match!");
          }

          trackSuspiciousActivity(clientIP, "Failed face verification");

          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Biometric verification failed",
          });
          return;
        }

        // ✅ FACE MATCHED!
        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Face matched! Login approved");
        }

        // Get or create QR session
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

        // Update to verified
        QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          verifiedAt: Date.now(),
          matchDistance: distance,
        });

        // Emit success to desktop
        io.to(sessionId).emit("face-verification-complete", {
          sessionId,
          success: true,
          faceDescriptor: decryptedDescriptor,
          email: email,
          userId: user._id.toString(),
          message: "Biometric verification successful",
        });
      } else if (type === "register") {
        // REGISTRATION: Just send face descriptor back
        if (process.env.NODE_ENV !== "production") {
          console.log("📝 Face captured for registration");
        }

        io.to(sessionId).emit("face-verified", {
          sessionId,
          success: true,
          faceDescriptor: decryptedDescriptor,
          message: "Biometric data captured",
        });
      } else if (type === "update-face") {
        // UPDATE FACE: Update user's face descriptor
        if (process.env.NODE_ENV !== "production") {
          console.log("🔄 Face captured for update");
        }

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

        // Update face descriptor
        user.faceDescriptor = decryptedDescriptor;

        if (!user.faceDescriptors) {
          user.faceDescriptors = [];
        }
        user.faceDescriptors.push(decryptedDescriptor);

        // Keep only last 3 descriptors
        if (user.faceDescriptors.length > 3) {
          user.faceDescriptors = user.faceDescriptors.slice(-3);
        }

        await user.save();

        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Face data updated for user:", user.email);
        }

        // Update QRAuthManager session to verified
        QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          updatedAt: Date.now(),
          type: "update-face",
        });

        // Emit success
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
  if (process.env.NODE_ENV === "production") {
    // Don't log in production
  } else {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(
      `🔒 Security: ${process.env.NODE_ENV === "production" ? "ENABLED" : "DEV MODE"}`,
    );
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
