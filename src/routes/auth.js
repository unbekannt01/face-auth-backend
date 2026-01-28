const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const QRAuthManager = require('../utils/qrAuth');
const authMiddleware = require('../middleware/auth');

// Helper: Calculate Euclidean distance between two face descriptors
function euclideanDistance(desc1, desc2) {
  if (desc1.length !== desc2.length) return Infinity;
  
  return Math.sqrt(
    desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0)
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
    isMatch: minDistance < threshold
  };
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// @route   POST /api/auth/register
// @desc    Register user with face data
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, faceDescriptor } = req.body;
    
    // Validation
    if (!email || !password || !name || !faceDescriptor) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide all required fields' 
      });
    }
    
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'User already exists' 
      });
    }
    
    // Validate face descriptor (should be array of 128 numbers)
    if (!Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid face descriptor' 
      });
    }
    
    // Create user
    const user = new User({
      email,
      password,
      name,
      faceDescriptor,
      faceDescriptors: [faceDescriptor] // Store multiple for better matching
    });
    
    await user.save();
    
    // Generate token
    const token = generateToken(user._id);
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name
      }
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during registration' 
    });
  }
});

// @route   POST /api/auth/login/initiate
// @desc    Initiate login - generate QR code session
// @access  Public
router.post('/login/initiate', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email is required' 
      });
    }
    
    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    // Generate QR session
    const sessionId = QRAuthManager.generateAuthSession(user._id);
    
    res.json({
      success: true,
      sessionId,
      message: 'Scan QR code with your mobile device'
    });
    
  } catch (error) {
    console.error('Login initiation error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   POST /api/auth/login/verify-face
// @desc    Verify face from mobile device
// @access  Public
router.post('/login/verify-face', async (req, res) => {
  try {
    const { sessionId, faceDescriptor } = req.body;
    
    if (!sessionId || !faceDescriptor) {
      return res.status(400).json({ 
        success: false, 
        message: 'Session ID and face descriptor required' 
      });
    }
    
    // Get session
    const session = QRAuthManager.getAuthSession(sessionId);
    if (!session) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid or expired session' 
      });
    }
    
    // Get user
    const user = await User.findById(session.userId);
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Validate face descriptor
    if (!Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid face descriptor' 
      });
    }
    
    // Compare face descriptors
    const descriptorsToCompare = user.faceDescriptors.length > 0 
      ? user.faceDescriptors 
      : [user.faceDescriptor];
    
    const matchResult = findBestMatch(faceDescriptor, descriptorsToCompare);
    
    if (!matchResult.isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Face verification failed',
        debug: { distance: matchResult.distance }
      });
    }
    
    // Update session as verified
    QRAuthManager.updateAuthStatus(sessionId, 'verified', {
      verifiedAt: Date.now(),
      matchDistance: matchResult.distance
    });
    
    res.json({
      success: true,
      message: 'Face verified successfully',
      matchConfidence: (1 - matchResult.distance).toFixed(2)
    });
    
  } catch (error) {
    console.error('Face verification error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during verification' 
    });
  }
});

// @route   POST /api/auth/login/complete
// @desc    Complete login after face verification
// @access  Public
router.post('/login/complete', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Session ID required' 
      });
    }
    
    // Complete authentication
    const session = QRAuthManager.completeAuth(sessionId);
    
    if (!session) {
      return res.status(401).json({ 
        success: false, 
        message: 'Session not verified or expired' 
      });
    }
    
    // Get user
    const user = await User.findById(session.userId);
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save();
    
    // Generate token
    const token = generateToken(user._id);
    
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
    
  } catch (error) {
    console.error('Login completion error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/auth/session/:sessionId
// @desc    Check session status (for polling from web)
// @access  Public
router.get('/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = QRAuthManager.getAuthSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        message: 'Session not found or expired' 
      });
    }
    
    res.json({
      success: true,
      status: session.status,
      expiresAt: session.expiresAt
    });
    
  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -faceDescriptor -faceDescriptors');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    res.json({
      success: true,
      user
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// Verify Token Route
router.get('/verify', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -faceDescriptor');
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    res.json({ 
      success: true, 
      user 
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

module.exports = router;