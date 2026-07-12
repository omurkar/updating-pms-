import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import KeyExpiryPopup from './KeyExpiryPopup';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { currentUser, userRole } = useAuth();
  const [isExpired, setIsExpired] = useState(false);
  const [loadingExpiry, setLoadingExpiry] = useState(true);

  // Determine actual role being accessed
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
            // Take the most recent key if there are multiple
            const docs = snapshot.docs.map(d => d.data());
            docs.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
            
            const mostRecentKey = docs[0];
            if (mostRecentKey && mostRecentKey.validUntil) {
              const expiryDate = new Date(mostRecentKey.validUntil);
              // End of the day for validUntil
              expiryDate.setHours(23, 59, 59, 999);
              if (expiryDate < new Date()) {
                setIsExpired(true);
              }
            }
          }
        }
      } catch (err) {
        console.error("Error checking expiry:", err);
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

  // Check for admin session via sessionStorage (admin key login)
  if (allowedRoles && allowedRoles.includes('admin')) {
    const adminAuthenticated = sessionStorage.getItem('adminAuthenticated');
    if (adminAuthenticated === 'true') {
      if (loadingExpiry) return <div>Loading...</div>;
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

  if (loadingExpiry) return <div>Loading...</div>;
  if (isExpired) return <KeyExpiryPopup role={actualRole} />;

  return children;
};

export default ProtectedRoute;
