// backend/src/utils/qrAuth.js
// FIXED: QR Auth Manager with proper session handling

class QRAuthManager {
  constructor() {
    this.sessions = new Map();
    // Auto-cleanup old sessions
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000); // Every minute
  }

  // Generate auth session
  generateAuthSession(userId, email = null) {
    const sessionId = this.generateSessionId();
    const session = {
      userId,
      email,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000), // 10 minutes
    };
    
    this.sessions.set(sessionId, session);
    console.log(' QR Session created:', sessionId);
    
    return sessionId;
  }

  // Get session
  getAuthSession(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return null;
    }
    
    // Check if expired
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return session;
  }

  // Update session status (IMPORTANT FOR LOGIN)
  updateAuthStatus(sessionId, status, additionalData = {}) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      console.error(' Session not found:', sessionId);
      return false;
    }
    
    session.status = status;
    Object.assign(session, additionalData);
    
    this.sessions.set(sessionId, session);
    console.log(' Session updated:', sessionId, 'Status:', status);
    
    return true;
  }

  // Complete authentication (for login)
  completeAuth(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      console.error(' Session not found:', sessionId);
      return null;
    }
    
    if (session.status !== 'verified') {
      console.error(' Session not verified:', sessionId, 'Status:', session.status);
      return null;
    }
    
    // Mark as completed
    session.status = 'completed';
    this.sessions.set(sessionId, session);
    
    console.log(' Auth completed:', sessionId);
    
    // Delete session after a delay (optional)
    setTimeout(() => {
      this.sessions.delete(sessionId);
      console.log('🗑️ Session deleted:', sessionId);
    }, 30000); // Delete after 30 seconds
    
    return session;
  }

  // Cleanup expired sessions
  cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🗑️ Cleaned ${cleaned} expired sessions`);
    }
  }

  // Generate unique session ID
  generateSessionId() {
    return 'qr_' + Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }

  // Get all sessions (for debugging)
  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      sessionId: id,
      ...session
    }));
  }
}

// Create singleton instance
const qrAuthManager = new QRAuthManager();

// Export with sessions exposed for emergency fixes
module.exports = qrAuthManager;
module.exports.QRAuthManager = QRAuthManager;