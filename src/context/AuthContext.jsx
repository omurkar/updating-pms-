import { createContext, useContext, useState, useEffect } from 'react';
import { 
  signInWithEmailAndPassword, 
  signOut, 
  signInWithPopup,
  onAuthStateChanged,
  setPersistence,
  browserSessionPersistence
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, googleProvider } from '../firebase';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    
    // Set persistence to session storage so each tab has independent auth state
    setPersistence(auth, browserSessionPersistence).then(() => {
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        if (user) {
          setCurrentUser(user);
          // Check user role: first try teacher_users (root-level lookup),
          // then fall back to admin_users
          try {
            // Try teacher_users lookup first (for multi-tenant resolution)
            const teacherUserDoc = await getDoc(doc(db, 'teacher_users', user.uid));
            if (teacherUserDoc.exists()) {
              setUserRole('teacher');
              const tid = teacherUserDoc.data().tenantId;
              if (tid) sessionStorage.setItem('tenantId', tid);
            } else {
              // Not a teacher — check admin_users
              const adminDoc = await getDoc(doc(db, 'admin_users', user.uid));
              if (adminDoc.exists()) {
                setUserRole('admin');
                const tid = adminDoc.data().tenantId;
                if (tid) sessionStorage.setItem('tenantId', tid);
              } else {
                // Not a college admin — check super_admins
                const superAdminDoc = await getDoc(doc(db, 'super_admins', user.uid));
                if (superAdminDoc.exists()) {
                  setUserRole('super_admin');
                } else {
                  // User is authenticated but has NO role document in Firestore.
                  // NEVER default to 'admin'. Force sign-out to prevent privilege escalation
                  console.warn(`[Security] No role doc found for UID: ${user.uid} — signing out.`);
                  setUserRole(null);
                  setCurrentUser(null);
                  await signOut(auth);
                  sessionStorage.clear();
                }
              }
            }
          } catch (error) {
            console.error('Error fetching user role:', error);
            setUserRole(null);
          }
        } else {
          setCurrentUser(null);
          setUserRole(null);
        }
        setLoading(false);
      });

      return unsubscribe;
    }).catch((error) => {
      console.error('Error setting auth persistence:', error);
      setLoading(false);
    });
  }, []);

  // Teacher login with email/password
  const teacherLogin = async (email, password) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    // Verify via teacher_users lookup
    const teacherUserDoc = await getDoc(doc(db, 'teacher_users', userCredential.user.uid));
    if (!teacherUserDoc.exists()) {
      throw new Error('Teacher account not found');
    }
    // Store tenantId for TenantContext
    const tid = teacherUserDoc.data().tenantId;
    if (tid) sessionStorage.setItem('tenantId', tid);
    return userCredential.user;
  };

  // Admin login with Google OAuth
  const adminLogin = async () => {
    const result = await signInWithPopup(auth, googleProvider);
    // Admin role is determined by admin_users document
    return result.user;
  };

  // Student login (whitelist - no Firebase Auth)
  const studentLogin = async (rollNo, name, sessionCode) => {
    // This will be handled differently - database lookup only
    // Return a mock user object for student
    return {
      uid: `${sessionCode}_${rollNo}`,
      rollNo,
      name,
      sessionCode,
      role: 'student'
    };
  };

  const logout = async () => {
    await signOut(auth);
    setCurrentUser(null);
    setUserRole(null);
    // Clear tenant info on logout
    sessionStorage.removeItem('tenantId');
  };

  const value = {
    currentUser,
    userRole,
    teacherLogin,
    adminLogin,
    studentLogin,
    logout,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
