const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    console.log('[Auth Middleware] Checking authorization...');
    console.log('[Auth Middleware] Authorization header:', authHeader ? 'Present' : 'Missing');

    if (!authHeader) {
      console.error('[Auth Middleware] ❌ No authorization header');
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing. Please login again.'
      });
    }

    // Extract token from "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      console.error('[Auth Middleware] ❌ Invalid authorization format');
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format'
      });
    }

    const token = parts[1];

    if (!token) {
      console.error('[Auth Middleware] ❌ No token found');
      return res.status(401).json({
        success: false,
        message: 'Token missing. Please login again.'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    );

    console.log('[Auth Middleware] ✅ Token verified. User ID:', decoded.userId);

    // Attach user info to request
    req.userId = decoded.userId;
    req.userEmail = decoded.email;

    next();
  } catch (err) {
    console.error('[Auth Middleware] Error:', err.message);
    
    let errorMessage = 'Invalid or expired token. Please login again.';
    let statusCode = 401;
    
    // Specific error messages
    if (err.name === 'TokenExpiredError') {
      errorMessage = 'Your session has expired. Please login again.';
      statusCode = 401;
    } else if (err.name === 'JsonWebTokenError') {
      errorMessage = 'Invalid authentication token. Please login again.';
      statusCode = 401;
    } else if (err.name === 'NotBeforeError') {
      errorMessage = 'Token not yet valid';
      statusCode = 401;
    }
    
    console.error('[Auth Middleware] ❌ ' + errorMessage);
    
    return res.status(statusCode).json({
      success: false,
      message: errorMessage
    });
  }
};
