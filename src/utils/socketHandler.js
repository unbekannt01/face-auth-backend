// backend/src/utils/socketHandler.js
// FINAL FIXED: Proper QRAuthManager session handling

const User = require('../models/User');
const QRAuthManager = require('./qrAuth');

// Euclidean distance
function euclideanDistance(desc1, desc2) {
  if (!desc1 || !desc2 || desc1.length !== desc2.length) {
    return Infinity;
  }

  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    sum += Math.pow(desc1[i] - desc2[i], 2);
  }
  return Math.sqrt(sum);
}

function setupSocketHandlers(io) {
  const activeSessions = new Map();

  io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    /* ============================
       QR GENERATED (DESKTOP)
    ============================ */
    socket.on('qr-generated', (data) => {
      const { sessionId, type, email } = data;

      console.log('📱 QR generated:', sessionId, type);

      activeSessions.set(sessionId, {
        socketId: socket.id,
        type,
        email,
        timestamp: Date.now()
      });

      socket.join(sessionId);
    });

    /* ============================
       FACE CAPTURED (MOBILE)
    ============================ */
    socket.on('face-captured', async (data) => {
      const { sessionId, faceDescriptor, email, type } = data;

      console.log('📸 Face captured:', sessionId, type);

      try {
        if (type === 'login') {
          const user = await User.findOne({ email: email.toLowerCase() });

          if (!user) {
            return io.to(sessionId).emit('face-verification-complete', {
              success: false,
              message: 'User not found'
            });
          }

          if (!user.faceDescriptor?.length) {
            return io.to(sessionId).emit('face-verification-complete', {
              success: false,
              message: 'No face registered'
            });
          }

          const distance = euclideanDistance(user.faceDescriptor, faceDescriptor);
          const threshold = 0.6;

          console.log('🔍 Distance:', distance);

          if (distance > threshold) {
            return io.to(sessionId).emit('face-verification-complete', {
              success: false,
              message: 'Face does not match'
            });
          }

          // 🔥 CRITICAL FIX
          const updated = QRAuthManager.updateAuthStatus(sessionId, 'verified', {
            userId: user._id.toString(),
            email: user.email,
            verifiedAt: Date.now(),
            matchDistance: distance
          });

          console.log(updated 
            ? '✅ QR session VERIFIED' 
            : '❌ QR session update FAILED');

          return io.to(sessionId).emit('face-verification-complete', {
            success: true,
            userId: user._id.toString(),
            email: user.email,
            message: 'Face verified successfully'
          });
        }

        if (type === 'register') {
          return io.to(sessionId).emit('face-verified', {
            success: true,
            faceDescriptor,
            message: 'Face captured successfully'
          });
        }

      } catch (err) {
        console.error('❌ Face verification error:', err);
        io.to(sessionId).emit('face-verification-complete', {
          success: false,
          message: 'Verification failed'
        });
      }
    });

    /* ============================
       DISCONNECT
    ============================ */
    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);

      for (const [sessionId, session] of activeSessions.entries()) {
        if (session.socketId === socket.id) {
          activeSessions.delete(sessionId);
        }
      }
    });
  });

  /* ============================
     CLEANUP EXPIRED SESSIONS
  ============================ */
  setInterval(() => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000;

    for (const [sessionId, session] of activeSessions.entries()) {
      if (now - session.timestamp > timeout) {
        console.log('🗑️ Cleaning expired session:', sessionId);
        activeSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = setupSocketHandlers;
