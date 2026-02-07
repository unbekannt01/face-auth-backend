// backend/src/middleware/security.js

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ═══════════════════════════════════════════════════════════
// ENCRYPTION UTILITIES
// ═══════════════════════════════════════════════════════════

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );
  
  let encrypted = cipher.update(JSON.stringify(text));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );
  
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return JSON.parse(decrypted.toString());
}

// ═══════════════════════════════════════════════════════════
// REQUEST SIGNATURE VALIDATION (HMAC)
// ═══════════════════════════════════════════════════════════

const SECRET_KEY = process.env.API_SECRET_KEY || 'your-secret-key-change-in-production';

function generateSignature(data, timestamp) {
  const payload = JSON.stringify(data) + timestamp;
  return crypto
    .createHmac('sha256', SECRET_KEY)
    .update(payload)
    .digest('hex');
}

function validateSignature(req, res, next) {
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];
  
  if (!signature || !timestamp) {
    return res.status(401).json({
      success: false,
      message: 'Invalid request - missing security headers'
    });
  }
  
  // Check if request is not older than 5 minutes (replay attack protection)
  const requestTime = parseInt(timestamp);
  const currentTime = Date.now();
  
  if (currentTime - requestTime > 5 * 60 * 1000) {
    return res.status(401).json({
      success: false,
      message: 'Request expired'
    });
  }
  
  // Validate signature
  const expectedSignature = generateSignature(req.body, timestamp);
  
  if (signature !== expectedSignature) {
    console.error('⚠️ Invalid signature detected!');
    return res.status(401).json({
      success: false,
      message: 'Invalid request signature'
    });
  }
  
  next();
}

// ═══════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════

const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { success: false, message },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

// Different limits for different routes
const rateLimiters = {
  // Auth routes - strict
  auth: createRateLimiter(
    15 * 60 * 1000, // 15 minutes
    5, // 5 requests max
    'Too many authentication attempts. Please try again later.'
  ),
  
  // Face verification - very strict
  face: createRateLimiter(
    10 * 60 * 1000, // 10 minutes
    3, // 3 attempts max
    'Too many face verification attempts. Please wait.'
  ),
  
  // General API - moderate
  api: createRateLimiter(
    15 * 60 * 1000,
    100,
    'Too many requests. Please slow down.'
  )
};

// ═══════════════════════════════════════════════════════════
// REQUEST SANITIZATION
// ═══════════════════════════════════════════════════════════

function sanitizeInput(req, res, next) {
  // Remove any potentially dangerous characters
  const sanitize = (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj;
    
    const cleaned = Array.isArray(obj) ? [] : {};
    
    for (let key in obj) {
      if (typeof obj[key] === 'string') {
        // Remove script tags, SQL injection attempts, etc.
        cleaned[key] = obj[key]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/['"`;]/g, '') // Remove quotes and semicolons
          .trim();
      } else if (typeof obj[key] === 'object') {
        cleaned[key] = sanitize(obj[key]);
      } else {
        cleaned[key] = obj[key];
      }
    }
    
    return cleaned;
  };
  
  if (req.body) {
    req.body = sanitize(req.body);
  }
  
  if (req.query) {
    req.query = sanitize(req.query);
  }
  
  next();
}

// ═══════════════════════════════════════════════════════════
// ANTI-DEBUGGING & CONSOLE PROTECTION (Frontend will use this)
// ═══════════════════════════════════════════════════════════

function getSecurityHeaders(req, res, next) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';");
  
  // Remove server identification
  res.removeHeader('X-Powered-By');
  
  next();
}

// ═══════════════════════════════════════════════════════════
// IP-BASED ACCESS CONTROL (Optional)
// ═══════════════════════════════════════════════════════════

const suspiciousIPs = new Set();
const ipAttempts = new Map();

function trackSuspiciousActivity(ip, reason) {
  const attempts = ipAttempts.get(ip) || 0;
  ipAttempts.set(ip, attempts + 1);
  
  if (attempts > 10) {
    suspiciousIPs.add(ip);
    console.error(`🚨 IP ${ip} marked as suspicious: ${reason}`);
  }
}

function checkIPReputation(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  
  if (suspiciousIPs.has(ip)) {
    console.error(`⛔ Blocked suspicious IP: ${ip}`);
    return res.status(403).json({
      success: false,
      message: 'Access denied'
    });
  }
  
  next();
}

// ═══════════════════════════════════════════════════════════
// FACE DESCRIPTOR ENCRYPTION
// ═══════════════════════════════════════════════════════════

function encryptFaceDescriptor(req, res, next) {
  if (req.body.faceDescriptor) {
    try {
      req.body.faceDescriptor = encrypt(req.body.faceDescriptor);
      req.body._encrypted = true;
    } catch (error) {
      console.error('❌ Face descriptor encryption failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Security error'
      });
    }
  }
  next();
}

function decryptFaceDescriptor(encryptedData) {
  try {
    return decrypt(encryptedData);
  } catch (error) {
    console.error('❌ Face descriptor decryption failed:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
  // Encryption
  encrypt,
  decrypt,
  encryptFaceDescriptor,
  decryptFaceDescriptor,
  
  // Request validation
  validateSignature,
  generateSignature,
  sanitizeInput,
  
  // Rate limiting
  rateLimiters,
  
  // Security headers
  getSecurityHeaders,
  
  // IP protection
  checkIPReputation,
  trackSuspiciousActivity,
  
  // Constants
  SECRET_KEY,
  ENCRYPTION_KEY
};