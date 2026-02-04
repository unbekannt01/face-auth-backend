// backend/src/routes/auth.js
// UPDATED: Added face update and password change routes + SESSION MANAGEMENT

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const QRAuthManager = require("../utils/qrAuth");
const authMiddleware = require("../middleware/auth");

// Helper: Calculate Euclidean distance between two face descriptors
function euclideanDistance(desc1, desc2) {
  if (desc1.length !== desc2.length) return Infinity;

  return Math.sqrt(
    desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0),
  );
}

// Helper: Find best match among stored descriptors
function findBestMatch(inputDescriptor, storedDescriptors, threshold = 0.6) {
  let minDistance = Infinity;

  for (const storedDesc of storedDescriptors) {
    const distance = euclideanDistance(inputDescriptor, storedDesc);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return {
    distance: minDistance,
    isMatch: minDistance < threshold,
  };
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET || "your-secret-key", {
    expiresIn: "7d",
  });
}

/* ================================
   SESSION MANAGEMENT ROUTES
================================ */

// @route   POST /api/auth/session/create
// @desc    Create session for QR code flow
// @access  Public
router.post("/session/create", (req, res) => {
  try {
    const { sessionId, email, password, type } = req.body;

    if (!sessionId || !email || !type) {
      return res.status(400).json({
        success: false,
        message: "SessionId, email, and type are required",
      });
    }

    console.log(`📋 Creating session: ${sessionId} (type: ${type})`);

    // Store session data in QRAuthManager
    const sessionData = {
      sessionId,
      email,
      password,
      type,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    QRAuthManager.storeSessionData(sessionId, sessionData);

    console.log(`✅ Session created: ${sessionId}`);

    res.json({
      success: true,
      sessionId,
      message: "Session created successfully",
    });
  } catch (error) {
    console.error("❌ Session creation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during session creation",
    });
  }
});

// @route   GET /api/auth/session/:sessionId
// @desc    Get session data (used by mobile)
// @access  Public
router.get("/session/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;

    console.log(`📋 Fetching session: ${sessionId}`);

    const session = QRAuthManager.getAuthSession(sessionId);

    if (!session) {
      console.error(`❌ Session not found: ${sessionId}`);
      return res.status(404).json({
        success: false,
        message: "Session not found or expired",
      });
    }

    console.log(`✅ Session found: ${sessionId} (type: ${session.type})`);

    // Return session data
    const responseData = {
      sessionId: session.sessionId,
      email: session.email,
      type: session.type,
      status: session.status,
      expiresAt: session.expiresAt,
    };

    // Include password only for login/register
    if (session.type === "login" || session.type === "register") {
      responseData.password = session.password;
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Session fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during session fetch",
    });
  }
});

/* ================================
   AUTHENTICATION ROUTES
================================ */

// @route   POST /api/auth/register
// @desc    Register user with face data
// @access  Public
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, faceDescriptor } = req.body;

    // Validation
    if (!email || !password || !name || !faceDescriptor) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required fields",
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User already exists",
      });
    }

    // Validate face descriptor (should be array of 128 numbers)
    if (!Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
      return res.status(400).json({
        success: false,
        message: "Invalid face descriptor",
      });
    }

    // Create user
    const user = new User({
      email,
      password,
      name,
      faceDescriptor,
      faceDescriptors: [faceDescriptor], // Store multiple for better matching
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during registration",
    });
  }
});

// @route   POST /api/auth/login/initiate
// @desc    Initiate login - Validate email & password
// @access  Public
router.post("/login/initiate", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("🔑 Login initiate request for:", email);

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      console.log("❌ User not found:", email);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Verify password IMMEDIATELY
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      console.log("❌ Invalid password for:", email);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Password is correct - generate QR session
    const sessionId = QRAuthManager.generateAuthSession(
      user._id,
      email,
      "login",
    );

    console.log("✅ Login credentials verified! Session:", sessionId);

    res.json({
      success: true,
      sessionId,
      message: "Credentials verified! Scan QR code with mobile device",
    });
  } catch (error) {
    console.error("Login initiation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
});

// @route   POST /api/auth/login/complete
// @desc    Complete login after face verification
// @access  Public
router.post("/login/complete", async (req, res) => {
  try {
    const { sessionId } = req.body;

    console.log("🔑 Login complete request for session:", sessionId);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID required",
      });
    }

    // Get session from QRAuthManager
    const session = QRAuthManager.completeAuth(sessionId);

    if (!session) {
      console.error("❌ Session not found or not verified:", sessionId);

      // Debug: Check if session exists at all
      const checkSession = QRAuthManager.getAuthSession(sessionId);
      if (checkSession) {
        console.error("Session exists but status is:", checkSession.status);
      }

      return res.status(401).json({
        success: false,
        message: "Session not verified or expired. Please try again.",
      });
    }

    console.log("✅ Session found:", session);

    // Get user
    const user = await User.findById(session.userId);
    if (!user) {
      console.error("❌ User not found:", session.userId);
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    console.log("✅ Login successful for:", user.email);

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        lastLogin: user.lastLogin,
      },
    });
  } catch (error) {
    console.error("Login completion error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      "-password -faceDescriptor -faceDescriptors",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   GET /api/auth/verify
// @desc    Verify Token
// @access  Private
router.get("/verify", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      "-password -faceDescriptor",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* ================================
   FACE UPDATE ROUTES
================================ */

// @route   POST /api/auth/update-face/initiate
// @desc    Initiate face update - Generate QR for mobile
// @access  Private
router.post("/update-face/initiate", authMiddleware, async (req, res) => {
  try {
    console.log("📸 Face update initiate request from user:", req.userId);

    // Find user
    const user = await User.findById(req.userId);
    if (!user) {
      console.error("❌ User not found:", req.userId);
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    console.log("👤 User found:", user.email);

    // Generate QR session for face update
    const sessionId = QRAuthManager.generateAuthSession(
      user._id,
      user.email,
      "update-face",
    );

    console.log("✅ Face update session created:", sessionId);

    res.json({
      success: true,
      sessionId,
      message: "Face update session created. Scan QR code with mobile device",
    });
  } catch (error) {
    console.error("❌ Face update initiation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during face update initiation",
    });
  }
});

// @route   POST /api/auth/update-face/complete
// @desc    Complete face update after mobile capture
// @access  Public
router.post("/update-face/complete", async (req, res) => {
  try {
    const { sessionId } = req.body;

    console.log("📸 Face update complete request for session:", sessionId);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID required",
      });
    }

    // Get session from QRAuthManager
    const session = QRAuthManager.completeAuth(sessionId);

    if (!session) {
      console.error("❌ Session not found or not verified:", sessionId);
      return res.status(401).json({
        success: false,
        message: "Session not verified or expired. Please try again.",
      });
    }

    console.log("✅ Face update session verified");

    res.json({
      success: true,
      message: "Face update completed successfully",
    });
  } catch (error) {
    console.error("❌ Face update completion error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* ================================
   PASSWORD CHANGE ROUTE
================================ */

// @route   PUT /api/auth/change-password
// @desc    Change user's password
// @access  Private
router.put("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    console.log("🔑 Password change request from user:", req.userId);

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Please provide current and new password",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long",
      });
    }

    // Find user
    const user = await User.findById(req.userId);
    if (!user) {
      console.error("❌ User not found:", req.userId);
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    console.log("👤 User found:", user.email);

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      console.error("❌ Current password is incorrect for:", user.email);
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    console.log("✅ Current password verified");

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      console.error("❌ New password same as current for:", user.email);
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password",
      });
    }

    // Update password (will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    console.log("✅ Password changed successfully for:", user.email);

    res.json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("❌ Password change error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during password change",
    });
  }
});

// DEBUG: Get all sessions (remove in production)
router.get("/debug/sessions", (req, res) => {
  const sessions = QRAuthManager.getAllSessions();
  res.json({ sessions });
});

module.exports = router;
