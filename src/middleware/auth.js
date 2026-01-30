const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing. Please login again.'
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
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

    // Check if token is expired (additional check)
    if (decoded.exp && decoded.exp < Date.now() / 1000) {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.'
      });
    }

    // Attach user info to request
    req.userId = decoded.userId;
    req.userEmail = decoded.email;

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    
    let errorMessage = 'Invalid or expired token. Please login again.';
    
    // Specific error messages
    if (err.name === 'TokenExpiredError') {
      errorMessage = 'Your session has expired. Please login again.';
    } else if (err.name === 'JsonWebTokenError') {
      errorMessage = 'Invalid authentication token. Please login again.';
    }
    
    return res.status(401).json({
      success: false,
      message: errorMessage
    });
  }
};