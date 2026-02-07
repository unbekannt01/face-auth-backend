// backend/src/routes/auth.js

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const User = require("../models/User");
const QRAuthManager = require("../utils/qrAuth");
const authMiddleware = require("../middleware/auth");

// Import security middleware
const {
  validateSignature,
  // rateLimiters,
  encryptFaceDescriptor,
  decryptFaceDescriptor,
  trackSuspiciousActivity,
} = require("../middleware/security");

// Helper: Calculate Euclidean distance
function euclideanDistance(desc1, desc2) {
  if (desc1.length !== desc2.length) return Infinity;

  return Math.sqrt(
    desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0),
  );
}

// Helper: Find best match
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
   VALIDATION RULES
================================ */
const registerValidation = [
  body("email").isEmail().normalizeEmail().withMessage("Invalid email format"),
  body("password")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),
  body("name")
    .trim()
    .isLength({ min: 2 })
    .withMessage("Name must be at least 2 characters"),
  body("faceDescriptor").isArray().withMessage("Invalid biometric data"),
];

const loginValidation = [
  body("email").isEmail().normalizeEmail().withMessage("Invalid email format"),
  body("password").notEmpty().withMessage("Password required"),
];

const passwordChangeValidation = [
  body("currentPassword").notEmpty().withMessage("Current password required"),
  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters"),
];

/* ================================
   SESSION MANAGEMENT ROUTES
================================ */

// @route   POST /api/auth/session/create
router.post("/session/create", (req, res) => {
  try {
    const { sessionId, email, password, type } = req.body;

    if (!sessionId || !email || !type) {
      return res.status(400).json({
        success: false,
        message: "SessionId, email, and type are required",
      });
    }

    // Store session data in QRAuthManager
    const sessionData = {
      sessionId,
      email: email.toLowerCase(),
      password,
      type,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    QRAuthManager.storeSessionData(sessionId, sessionData);

    res.json({
      success: true,
      sessionId,
      message: "Session created successfully",
    });
  } catch (error) {
    console.error("Session creation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during session creation",
    });
  }
});

// @route   GET /api/auth/session/:sessionId
router.get("/session/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = QRAuthManager.getAuthSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found or expired",
      });
    }

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
    console.error("Session fetch error:", error);
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
router.post(
  "/register",
  registerValidation,
  async (req, res) => {
    try {
      // Check validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: errors.array()[0].msg,
        });
      }

      const { email, password, name, faceDescriptor } = req.body;

      // Check if user exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        trackSuspiciousActivity(req.ip, "Duplicate registration");
        return res.status(400).json({
          success: false,
          message: "User already exists",
        });
      }

      // Decrypt face descriptor if encrypted
      let decryptedDescriptor = faceDescriptor;
      if (typeof faceDescriptor === "string" && faceDescriptor.includes(":")) {
        decryptedDescriptor = decryptFaceDescriptor(faceDescriptor);
        if (!decryptedDescriptor) {
          return res.status(400).json({
            success: false,
            message: "Invalid biometric data",
          });
        }
      }

      // Validate face descriptor
      if (
        !Array.isArray(decryptedDescriptor) ||
        decryptedDescriptor.length !== 128
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid biometric data format",
        });
      }

      // Create user
      const user = new User({
        email: email.toLowerCase(),
        password,
        name,
        faceDescriptor: decryptedDescriptor,
        faceDescriptors: [decryptedDescriptor],
      });

      await user.save();

      // Generate token
      const token = generateToken(user._id);

      res.status(201).json({
        success: true,
        message: "Registration successful",
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
  },
);

// @route   POST /api/auth/login/initiate
router.post(
  "/login/initiate",
  loginValidation,
  async (req, res) => {
    try {
      // Check validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: errors.array()[0].msg,
        });
      }

      const { email, password } = req.body;

      // Check if user exists
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        trackSuspiciousActivity(req.ip, "Login - user not found");
        return res.status(401).json({
          success: false,
          message: "Invalid credentials",
        });
      }

      // Verify password IMMEDIATELY
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        trackSuspiciousActivity(req.ip, "Login - invalid password");
        return res.status(401).json({
          success: false,
          message: "Invalid credentials",
        });
      }

      // Password is correct - generate QR session
      const sessionId = QRAuthManager.generateAuthSession(
        user._id,
        email.toLowerCase(),
        "login",
      );

      res.json({
        success: true,
        sessionId,
        message: "Credentials verified. Scan QR code",
      });
    } catch (error) {
      console.error("Login initiation error:", error);
      res.status(500).json({
        success: false,
        message: "Server error during login",
      });
    }
  },
);

// @route   POST /api/auth/login/complete
router.post("/login/complete", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID required",
      });
    }

    // Get session from QRAuthManager
    const session = QRAuthManager.completeAuth(sessionId);

    if (!session) {
      trackSuspiciousActivity(req.ip, "Invalid session");
      return res.status(401).json({
        success: false,
        message: "Session not verified or expired",
      });
    }

    // Get user
    const user = await User.findById(session.userId);
    if (!user) {
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
router.post("/update-face/initiate", authMiddleware, async (req, res) => {
  try {
    // Find user
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate QR session for face update
    const sessionId = QRAuthManager.generateAuthSession(
      user._id,
      user.email,
      "update-face",
    );

    res.json({
      success: true,
      sessionId,
      message: "Face update session created",
    });
  } catch (error) {
    console.error("Face update initiation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/auth/update-face/complete
router.post("/update-face/complete", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session ID required",
      });
    }

    // Get session from QRAuthManager
    const session = QRAuthManager.completeAuth(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: "Session not verified or expired",
      });
    }

    res.json({
      success: true,
      message: "Face update completed successfully",
    });
  } catch (error) {
    console.error("Face update completion error:", error);
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
router.put(
  "/change-password",
  authMiddleware,
  passwordChangeValidation,
  async (req, res) => {
    try {
      // Check validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: errors.array()[0].msg,
        });
      }

      const { currentPassword, newPassword } = req.body;

      // Find user
      const user = await User.findById(req.userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Verify current password
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        trackSuspiciousActivity(req.ip, "Wrong current password");
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
      }

      // Check if new password is same as current
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        return res.status(400).json({
          success: false,
          message: "New password must be different",
        });
      }

      // Update password
      user.password = newPassword;
      await user.save();

      res.json({
        success: true,
        message: "Password changed successfully",
      });
    } catch (error) {
      console.error("Password change error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  },
);

// DEBUG ROUTE - Remove in production
if (process.env.NODE_ENV !== "production") {
  router.get("/debug/sessions", (req, res) => {
    const sessions = QRAuthManager.getAllSessions();
    res.json({ sessions });
  });
}

module.exports = router;
