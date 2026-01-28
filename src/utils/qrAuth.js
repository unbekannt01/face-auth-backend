const { v4: uuidv4 } = require('uuid');

// In-memory store for pending authentications (production me Redis use karo)
const pendingAuths = new Map();

class QRAuthManager {
  // Generate unique session for QR login
  static generateAuthSession(userId) {
    const sessionId = uuidv4();
    const authData = {
      sessionId,
      userId,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    };
    
    pendingAuths.set(sessionId, authData);
    
    // Auto-cleanup after expiry
    setTimeout(() => {
      pendingAuths.delete(sessionId);
    }, 5 * 60 * 1000);
    
    return sessionId;
  }
  
  // Get auth session
  static getAuthSession(sessionId) {
    const session = pendingAuths.get(sessionId);
    
    if (!session) return null;
    
    // Check if expired
    if (Date.now() > session.expiresAt) {
      pendingAuths.delete(sessionId);
      return null;
    }
    
    return session;
  }
  
  // Update session status
  static updateAuthStatus(sessionId, status, data = {}) {
    const session = pendingAuths.get(sessionId);
    
    if (!session) return false;
    
    session.status = status;
    session.updatedAt = Date.now();
    Object.assign(session, data);
    
    pendingAuths.set(sessionId, session);
    return true;
  }
  
  // Complete authentication
  static completeAuth(sessionId) {
    const session = pendingAuths.get(sessionId);
    
    if (!session || session.status !== 'verified') {
      return null;
    }
    
    pendingAuths.delete(sessionId);
    return session;
  }
}

module.exports = QRAuthManager;