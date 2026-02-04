// backend/server.js
// UPDATED: Integrated session management into auth routes

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const authRoutes = require("./src/routes/auth");
const User = require("./src/models/User");
const QRAuthManager = require("./src/utils/qrAuth");

const app = express();
const server = http.createServer(app);

/* ================================
    ALLOWED ORIGINS (LOCAL + PROD)
================================ */
const allowedOrigins = [
  "http://localhost:3000",
  "http://192.168.1.100:3000",
  "https://face-auth01.vercel.app",
];

/* ================================
    EXPRESS CORS (REST APIs)
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
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

/* ================================
    ROUTES
================================ */
app.use("/api/auth", authRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({ message: "✅ Face Auth Backend Running!" });
});

// Backward compatibility: redirect /api/session/* to /api/auth/session/*
app.use("/api/session", (req, res) => {
  const newUrl = `/api/auth/session${req.url}`;
  console.log(`🔄 Redirecting: ${req.url} -> ${newUrl}`);
  res.redirect(307, newUrl); // 307 preserves POST/GET method
});

/* ================================
    SOCKET.IO HANDLERS
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
  console.log("🔌 Client connected:", socket.id);

  // QR Code generated - desktop sends this
  socket.on("qr-generated", (data) => {
    const { sessionId, type, email } = data;
    console.log("📱 QR generated for session:", sessionId, "Type:", type);

    // Join room for this session
    socket.join(sessionId);
  });

  // Face captured from mobile
  socket.on("face-captured", async (data) => {
    const { sessionId, faceDescriptor, email, password, type } = data;

    console.log("📸 Face captured for session:", sessionId);
    console.log("Type:", type, "Email:", email);

    try {
      if (type === "login") {
        // LOGIN: Verify face matches registered user
        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
          console.log("❌ User not found:", email);
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "User not found",
          });
          return;
        }

        if (!user.faceDescriptor || user.faceDescriptor.length === 0) {
          console.log("❌ No face data for user:", email);
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "No face data registered",
          });
          return;
        }

        // Compare faces
        const distance = euclideanDistance(user.faceDescriptor, faceDescriptor);
        const threshold = 0.6;

        console.log(
          "🔍 Face comparison - Distance:",
          distance,
          "Threshold:",
          threshold,
        );

        if (distance > threshold) {
          console.log("❌ Face does not match!");
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Face does not match registered face. Please try again.",
          });
          return;
        }

        // ✅ FACE MATCHED!
        console.log("✅ Face matched! Login approved");

        // Get or create QR session
        let qrSession = QRAuthManager.getAuthSession(sessionId);

        if (!qrSession) {
          console.log(
            "📋 QR session not found, creating temporary session:",
            sessionId,
          );
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
        const updated = QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          verifiedAt: Date.now(),
          matchDistance: distance,
        });

        if (updated) {
          console.log("✅ QRAuthManager session updated to VERIFIED");
        } else {
          console.error("❌ Failed to update QRAuthManager session");
        }

        // Emit success to desktop
        io.to(sessionId).emit("face-verification-complete", {
          sessionId,
          success: true,
          faceDescriptor: faceDescriptor,
          email: email,
          userId: user._id.toString(),
          message: "Face verified successfully",
        });
      } else if (type === "register") {
        // REGISTRATION: Just send face descriptor back
        console.log("📝 Face captured for registration");
        io.to(sessionId).emit("face-verified", {
          sessionId,
          success: true,
          faceDescriptor: faceDescriptor,
          message: "Face captured successfully",
        });
      } else if (type === "update-face") {
        // UPDATE FACE: Update user's face descriptor
        console.log("🔄 Face captured for update");

        // Get session to find userId
        const session = QRAuthManager.getAuthSession(sessionId);

        if (!session || !session.userId) {
          console.log("❌ Invalid session for face update:", sessionId);
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "Invalid session",
          });
          return;
        }

        const user = await User.findById(session.userId);

        if (!user) {
          console.log("❌ User not found for update:", session.userId);
          io.to(sessionId).emit("face-verification-complete", {
            sessionId,
            success: false,
            message: "User not found",
          });
          return;
        }

        // Update face descriptor
        user.faceDescriptor = faceDescriptor;

        if (!user.faceDescriptors) {
          user.faceDescriptors = [];
        }
        user.faceDescriptors.push(faceDescriptor);

        // Keep only last 3 descriptors
        if (user.faceDescriptors.length > 3) {
          user.faceDescriptors = user.faceDescriptors.slice(-3);
        }

        await user.save();

        console.log("✅ Face data updated for user:", user.email);
        console.log(
          "📊 Total descriptors stored:",
          user.faceDescriptors.length,
        );

        // Update QRAuthManager session to verified
        QRAuthManager.updateAuthStatus(sessionId, "verified", {
          userId: user._id.toString(),
          email: user.email,
          updatedAt: Date.now(),
          type: "update-face",
        });

        console.log("✅ QRAuthManager session updated to VERIFIED");

        // Emit success to both mobile and desktop
        io.to(sessionId).emit("face-verification-complete", {
          sessionId,
          success: true,
          message: "Face updated successfully",
        });
      }
    } catch (error) {
      console.error("❌ Face verification error:", error);
      io.to(sessionId).emit("face-verification-complete", {
        sessionId,
        success: false,
        message: "Verification failed. Please try again.",
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

/* ================================
    SERVER START
================================ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
