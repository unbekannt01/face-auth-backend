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

  // Generate auth session - SUPPORTS login, register, update-face
  generateAuthSession(userId, email = null, type = "login") {
    const sessionId = this.generateSessionId();
    const session = {
      sessionId,
      userId: userId ? userId.toString() : null,
      email,
      type, // 'login', 'register', or 'update-face'
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    };

    this.sessions.set(sessionId, session);
    console.log(`✅ QR Session created: ${sessionId} (type: ${type})`);

    return sessionId;
  }

  // Store session data (used by /api/session/create)
  storeSessionData(sessionId, data) {
    console.log(`💾 Storing session data for: ${sessionId}`);

    // If session exists, merge data
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      Object.assign(existing, data);
      this.sessions.set(sessionId, existing);
    } else {
      // Create new session with data
      const session = {
        sessionId,
        ...data,
        status: data.status || "pending",
        createdAt: data.createdAt || Date.now(),
        expiresAt: data.expiresAt || Date.now() + 10 * 60 * 1000,
      };
      this.sessions.set(sessionId, session);
    }

    console.log(`✅ Session data stored for: ${sessionId}`);
  }

  // Get session
  getAuthSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      console.log(`❌ Session not found: ${sessionId}`);
      return null;
    }

    // Check if expired
    if (Date.now() > session.expiresAt) {
      console.log(`⏰ Session expired: ${sessionId}`);
      this.sessions.delete(sessionId);
      return null;
    }

    console.log(
      `✅ Session found: ${sessionId} (status: ${session.status}, type: ${session.type || "unknown"})`,
    );
    return session;
  }

  // Update session status (IMPORTANT FOR LOGIN & UPDATE-FACE)
  updateAuthStatus(sessionId, status, additionalData = {}) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      console.error(`❌ Session not found for update: ${sessionId}`);
      return false;
    }

    session.status = status;
    Object.assign(session, additionalData);

    this.sessions.set(sessionId, session);
    console.log(`✅ Session updated: ${sessionId} -> Status: ${status}`);

    return true;
  }

  // Verify face - mark session as verified
  verifyFace(sessionId, faceDescriptor) {
    const session = this.getAuthSession(sessionId);

    if (!session) {
      console.error(`❌ Cannot verify - session not found: ${sessionId}`);
      return false;
    }

    session.faceDescriptor = faceDescriptor;
    session.status = "verified";
    session.verifiedAt = Date.now();

    this.sessions.set(sessionId, session);

    console.log(
      `✅ Face verified for session: ${sessionId} (type: ${session.type})`,
    );
    return true;
  }

  // Complete authentication (for login/update-face)
  completeAuth(sessionId) {
    const session = this.getAuthSession(sessionId);

    if (!session) {
      console.error(`❌ Cannot complete - session not found: ${sessionId}`);
      return null;
    }

    if (session.status !== "verified") {
      console.error(
        `❌ Cannot complete - session not verified: ${sessionId} (status: ${session.status})`,
      );
      return null;
    }

    // Mark as completed
    session.status = "completed";
    session.completedAt = Date.now();
    this.sessions.set(sessionId, session);

    console.log(`✅ Auth completed: ${sessionId} (type: ${session.type})`);

    // Keep session for 1 minute after completion, then delete
    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        console.log(`🗑️ Cleaning up completed session: ${sessionId}`);
        this.sessions.delete(sessionId);
      }
    }, 60000);

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

    return cleaned;
  }

  // Generate unique session ID
  generateSessionId() {
    return (
      "qr_" +
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  // Get all sessions (for debugging)
  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      sessionId: id,
      userId: session.userId,
      email: session.email,
      type: session.type,
      status: session.status,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    }));
  }
}

// Create singleton instance
const qrAuthManager = new QRAuthManager();

// Export with sessions exposed for emergency fixes
module.exports = qrAuthManager;
module.exports.QRAuthManager = QRAuthManager;
