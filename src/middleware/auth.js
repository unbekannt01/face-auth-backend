const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const QRAuthManager = require('../utils/qrAuth');
const authMiddleware = require('../middleware/auth');

/* ---------------- HELPERS ---------------- */

// Euclidean distance
function euclideanDistance(desc1, desc2) {
  if (!desc1 || !desc2 || desc1.length !== desc2.length) return Infinity;

  return Math.sqrt(
    desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0)
  );
}

// Best match from multiple descriptors
function findBestMatch(inputDescriptor, storedDescriptors, threshold = 0.6) {
  let minDistance = Infinity;

  for (const stored of storedDescriptors) {
    const dist = euclideanDistance(inputDescriptor, stored);
    if (dist < minDistance) minDistance = dist;
  }

  return {
    distance: minDistance,
    isMatch: minDistance < threshold
  };
}

// JWT generator
function generateToken(user) {
  return jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '7d' }
  );
}

/* ---------------- REGISTER ---------------- */

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, faceDescriptor } = req.body;

    if (!name || !email || !password || !faceDescriptor) {
      return res.status(400).json({
        success: false,
        message: 'All fields including face data are required'
      });
    }

    if (!Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
      return res.status(400).json({
        success: false,
        message: 'Invalid face descriptor'
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      faceDescriptor,
      faceDescriptors: [faceDescriptor],
      createdAt: new Date(),
      lastLogin: new Date()
    });

    await user.save();

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ---------------- DIRECT FACE + PASSWORD LOGIN ---------------- */

router.post('/verify-login', async (req, res) => {
  try {
    const { email, password, faceDescriptor } = req.body;

    if (!email || !password || !faceDescriptor) {
      return res.status(400).json({
        success: false,
        message: 'Email, password and face data required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }

    const descriptors = user.faceDescriptors?.length
      ? user.faceDescriptors
      : [user.faceDescriptor];

    const match = findBestMatch(faceDescriptor, descriptors);

    if (!match.isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Face does not match',
        debug: { distance: match.distance }
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        lastLogin: user.lastLogin
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ---------------- QR LOGIN FLOW ---------------- */

// Step 1: Initiate QR login
router.post('/login/initiate', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const sessionId = QRAuthManager.generateAuthSession(user._id);

    res.json({
      success: true,
      sessionId,
      message: 'Scan QR with mobile to verify face'
    });

  } catch (err) {
    console.error('QR initiate error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Step 2: Mobile face verification
router.post('/login/verify-face', async (req, res) => {
  try {
    const { sessionId, faceDescriptor } = req.body;

    const session = QRAuthManager.getAuthSession(sessionId);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Invalid session' });
    }

    const user = await User.findById(session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const descriptors = user.faceDescriptors?.length
      ? user.faceDescriptors
      : [user.faceDescriptor];

    const match = findBestMatch(faceDescriptor, descriptors);

    if (!match.isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Face verification failed',
        debug: { distance: match.distance }
      });
    }

    QRAuthManager.updateAuthStatus(sessionId, 'verified', {
      verifiedAt: Date.now(),
      distance: match.distance
    });

    res.json({
      success: true,
      message: 'Face verified',
      confidence: (1 - match.distance).toFixed(2)
    });

  } catch (err) {
    console.error('Face verify error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Step 3: Complete login
router.post('/login/complete', async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = QRAuthManager.completeAuth(sessionId);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Session not verified' });
    }

    const user = await User.findById(session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        lastLogin: user.lastLogin
      }
    });

  } catch (err) {
    console.error('QR complete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ---------------- VERIFY TOKEN ---------------- */

router.get('/verify', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId)
    .select('-password -faceDescriptor -faceDescriptors');

  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  res.json({ success: true, user });
});

module.exports = router;
