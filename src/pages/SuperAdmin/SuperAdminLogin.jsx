import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../../firebase';

const SuperAdminLogin = () => {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Clear any existing super-admin session on mount
  useEffect(() => {
    sessionStorage.removeItem('superAdminAuthenticated');
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Authenticate via Firebase Auth using admin Email + Password
      const userCredential = await signInWithEmailAndPassword(auth, id.trim(), password);
      const user = userCredential.user;

      // Verify the user holds the 'super_admin' / 'founder' role in Firestore
      const superAdminDoc = await getDoc(doc(db, 'super_admins', user.uid));

      if (!superAdminDoc.exists()) {
        await auth.signOut();
        throw new Error('Access Denied. This portal is for Founders only.');
      }

      sessionStorage.setItem('superAdminAuthenticated', 'true');
      sessionStorage.setItem('superAdminEmail', user.email);

      // Navigate to the Dashboard
      navigate('/super_admin/LIO-73-23/2372/SYSTEM/dashboard');

    } catch (err) {
      console.error('Super Admin login error:', err);
      if (
        err.code === 'auth/invalid-credential' ||
        err.code === 'auth/user-not-found' ||
        err.code === 'auth/wrong-password'
      ) {
        setError('Invalid credentials. Access denied.');
      } else {
        setError(err.message || 'Login failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0a0a0f 0%, #1a0a2e 50%, #0a0f1a 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
        padding: '1rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Animated background orbs */}
      <div style={{
        position: 'absolute', top: '15%', left: '10%', width: '300px', height: '300px',
        background: 'radial-gradient(circle, rgba(139,0,0,0.15) 0%, transparent 70%)',
        borderRadius: '50%', filter: 'blur(40px)', animation: 'pulse 4s ease-in-out infinite',
      }} />
      <div style={{
        position: 'absolute', bottom: '20%', right: '10%', width: '250px', height: '250px',
        background: 'radial-gradient(circle, rgba(75,0,130,0.15) 0%, transparent 70%)',
        borderRadius: '50%', filter: 'blur(40px)', animation: 'pulse 6s ease-in-out infinite',
      }} />

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Fira+Code:wght@400;500&display=swap');
        @keyframes pulse { 0%,100%{opacity:0.6;transform:scale(1)} 50%{opacity:1;transform:scale(1.1)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @keyframes scan { 0%{transform:translateY(-100%)} 100%{transform:translateY(400px)} }
        .sa-input { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.1) !important;
          color: #e0e0e0 !important; border-radius: 8px; padding: 14px 16px; width: 100%; font-size: 14px;
          transition: all 0.3s ease; outline: none; font-family: 'Fira Code', monospace; }
        .sa-input:focus { border-color: rgba(180,0,60,0.7) !important; background: rgba(180,0,60,0.06) !important;
          box-shadow: 0 0 0 3px rgba(180,0,60,0.15); }
        .sa-input::placeholder { color: rgba(255,255,255,0.25); }
        .sa-btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #8b0000, #b0003a);
          border: none; border-radius: 8px; color: white; font-size: 14px; font-weight: 600;
          cursor: pointer; transition: all 0.3s ease; letter-spacing: 1px; text-transform: uppercase; }
        .sa-btn:hover:not(:disabled) { background: linear-gradient(135deg, #a00000, #cc0044);
          box-shadow: 0 6px 24px rgba(180,0,60,0.4); transform: translateY(-1px); }
        .sa-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      `}</style>

      <div style={{
        background: 'rgba(10,10,20,0.8)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(180,0,60,0.3)',
        borderRadius: '16px',
        padding: '48px 40px',
        width: '100%',
        maxWidth: '420px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
        animation: 'fadeIn 0.6s ease-out',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Scan line animation */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
          background: 'linear-gradient(90deg, transparent, rgba(180,0,60,0.6), transparent)',
          animation: 'scan 3s linear infinite',
        }} />

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{
            width: '60px', height: '60px',
            background: 'linear-gradient(135deg, rgba(139,0,0,0.3), rgba(75,0,130,0.3))',
            border: '1px solid rgba(180,0,60,0.4)',
            borderRadius: '12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
            fontSize: '28px',
          }}>🔐</div>
          <h1 style={{
            color: '#ffffff', fontSize: '22px', fontWeight: '700',
            margin: '0 0 6px', letterSpacing: '0.5px',
          }}>System Access</h1>
          <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: '12px', margin: 0, fontFamily: 'Fira Code, monospace', letterSpacing: '1.5px' }}>
            FOUNDERS PORTAL · RESTRICTED
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(180,0,60,0.12)', border: '1px solid rgba(180,0,60,0.4)',
            borderRadius: '8px', padding: '12px 14px', marginBottom: '20px',
            color: '#ff6b8a', fontSize: '13px',
          }}>
            ⚠ {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.5)', fontSize: '11px', fontWeight: '600', marginBottom: '8px', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
              Admin ID (Email)
            </label>
            <input
              type="email"
              className="sa-input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="founder@pms.system"
              required
              autoFocus
            />
          </div>

          <div>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.5)', fontSize: '11px', fontWeight: '600', marginBottom: '8px', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
              Password
            </label>
            <input
              type="password"
              className="sa-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              required
            />
          </div>

          <div style={{ marginTop: '8px' }}>
            <button type="submit" className="sa-btn" disabled={loading}>
              {loading ? '⏳ Authenticating...' : '⚡ Access Portal'}
            </button>
          </div>
        </form>

        <div style={{ marginTop: '28px', textAlign: 'center' }}>
          <p style={{ color: 'rgba(255,255,255,0.15)', fontSize: '11px', margin: 0, fontFamily: 'Fira Code, monospace' }}>
            UNAUTHORIZED ACCESS IS A CRIMINAL OFFENCE
          </p>
        </div>
      </div>
    </div>
  );
};

export default SuperAdminLogin;
