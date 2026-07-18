import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import KeyExpiryPopup from './KeyExpiryPopup';
import LoadingPage from './LoadingPage';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { currentUser, userRole, loading: authLoading } = useAuth();
  const [isExpired, setIsExpired] = useState(false);
  const [loadingExpiry, setLoadingExpiry] = useState(true);

  // ── REFRESH FIX ──
  // While Firebase Auth is still re-hydrating (authLoading=true), show a
  // loading screen instead of immediately redirecting. This prevents the
  // "Not Found / logged out" flash on browser refresh.
  const adminEmail = sessionStorage.getItem('adminEmail');
  const actualRole = allowedRoles?.includes('admin') && adminEmail ? 'admin' : userRole;

  useEffect(() => {
    const checkExpiry = async () => {
      try {
        let q;
        if (actualRole === 'admin' && adminEmail) {
          q = query(
            collection(db, 'product_keys'),
            where('adminEmail', '==', adminEmail)
          );
        } else if (actualRole === 'teacher' && currentUser?.email) {
          q = query(
            collection(db, 'product_keys'),
            where('facultyEmails', 'array-contains', currentUser.email)
          );
        }

        if (q) {
          const snapshot = await getDocs(q);
          if (!snapshot.empty) {
            const docs = snapshot.docs.map(d => d.data());
            docs.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

            const mostRecentKey = docs[0];
            if (mostRecentKey && mostRecentKey.validUntil) {
              const expiryDate = new Date(mostRecentKey.validUntil);
              expiryDate.setHours(23, 59, 59, 999);
              if (expiryDate < new Date()) {
                setIsExpired(true);
              }
            }
          }
        }
      } catch (err) {
        console.error('Error checking expiry:', err);
      } finally {
        setLoadingExpiry(false);
      }
    };

    if ((actualRole === 'admin' && adminEmail) || (actualRole === 'teacher' && currentUser)) {
      checkExpiry();
    } else {
      setLoadingExpiry(false);
    }
  }, [actualRole, adminEmail, currentUser]);

  // ── REFRESH FIX: Wait for Firebase Auth to resolve before making any routing decision ──
  if (authLoading) {
    return <LoadingPage message="Restoring your session..." />;
  }

  // Check for admin session: sessionStorage (fast path) OR Firebase Auth (after refresh)
  if (allowedRoles && allowedRoles.includes('admin')) {
    const adminAuthenticated = sessionStorage.getItem('adminAuthenticated');
    // Accept either sessionStorage flag OR Firebase-confirmed admin role
    const isAdmin = adminAuthenticated === 'true' || (currentUser && userRole === 'admin');

    if (isAdmin) {
      if (loadingExpiry) return <LoadingPage message="Verifying subscription..." />;
      if (isExpired) return <KeyExpiryPopup role="admin" />;
      return children;
    }
  }

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(userRole)) {
    return <Navigate to="/" replace />;
  }

  if (loadingExpiry) return <LoadingPage message="Verifying subscription..." />;
  if (isExpired) return <KeyExpiryPopup role={actualRole} />;

  return children;
};

export default ProtectedRoute;
