// backend/src/utils/socketHandler.js
// FIXED: Socket handler that properly updates QRAuthManager sessions

const User = require('../models/User');
const QRAuthManager = require('./qrAuth');

// Euclidean distance function
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
  // Store active sessions
  const activeSessions = new Map();

  io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // QR Code generated - desktop sends this
    socket.on('qr-generated', (data) => {
      const { sessionId, type, email } = data;
      console.log('📱 QR generated for session:', sessionId, 'Type:', type);
      
      activeSessions.set(sessionId, {
        socketId: socket.id,
        type: type,
        email: email,
        timestamp: Date.now()
      });

      // Join room for this session
      socket.join(sessionId);
    });

    // Face captured from mobile
    socket.on('face-captured', async (data) => {
      const { sessionId, faceDescriptor, email, password, type } = data;
      
      console.log('📸 Face captured for session:', sessionId);
      console.log('Type:', type, 'Email:', email);

      try {
        if (type === 'login') {
          // LOGIN: Verify face matches registered user
          const user = await User.findOne({ email: email.toLowerCase() });

          if (!user) {
            console.log('❌ User not found:', email);
            io.to(sessionId).emit('face-verification-complete', {
              sessionId,
              success: false,
              message: 'User not found'
            });
            return;
          }

          if (!user.faceDescriptor || user.faceDescriptor.length === 0) {
            console.log('❌ No face data for user:', email);
            io.to(sessionId).emit('face-verification-complete', {
              sessionId,
              success: false,
              message: 'No face data registered'
            });
            return;
          }

          // Compare faces
          const distance = euclideanDistance(user.faceDescriptor, faceDescriptor);
          const threshold = 0.6;

          console.log('🔍 Face comparison - Distance:', distance, 'Threshold:', threshold);

          if (distance > threshold) {
            console.log('❌ Face does not match!');
            io.to(sessionId).emit('face-verification-complete', {
              sessionId,
              success: false,
              message: 'Face does not match registered face. Please try again.'
            });
            return;
          }

          //  FACE MATCHED! 
          console.log(' Face matched! Login approved');

          //  CRITICAL FIX: Update QRAuthManager session status to 'verified'
          // This is what was missing! Without this, /api/auth/login/complete returns 401
          QRAuthManager.updateAuthStatus(sessionId, 'verified', {
            userId: user._id.toString(),
            email: user.email,
            verifiedAt: Date.now(),
            matchDistance: distance
          });
          console.log(' QRAuthManager session updated to VERIFIED');

          // Emit success to desktop
          io.to(sessionId).emit('face-verification-complete', {
            sessionId,
            success: true,
            faceDescriptor: faceDescriptor,
            email: email,
            message: 'Face verified successfully'
          });

        } else if (type === 'register') {
          // REGISTRATION: Just send face descriptor back
          console.log(' Face captured for registration');
          io.to(sessionId).emit('face-verified', {
            sessionId,
            success: true,
            faceDescriptor: faceDescriptor,
            message: 'Face captured successfully'
          });
        }

      } catch (error) {
        console.error('❌ Face verification error:', error);
        io.to(sessionId).emit('face-verification-complete', {
          sessionId,
          success: false,
          message: 'Verification failed. Please try again.'
        });
      }
    });

    // Client disconnect
    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);
      
      // Clean up sessions for this socket
      for (const [sessionId, session] of activeSessions.entries()) {
        if (session.socketId === socket.id) {
          activeSessions.delete(sessionId);
        }
      }
    });
  });

  // Clean up old sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    
    for (const [sessionId, session] of activeSessions.entries()) {
      if (now - session.timestamp > timeout) {
        console.log('🗑️ Cleaning up old session:', sessionId);
        activeSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = setupSocketHandlers;