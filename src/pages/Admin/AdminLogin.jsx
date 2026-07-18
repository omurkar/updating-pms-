import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../../firebase';

const AdminLogin = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Clear any existing admin session when landing on the login page.
  useEffect(() => {
    sessionStorage.removeItem('adminAuthenticated');
    sessionStorage.removeItem('adminEmail');
  }, []);

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // 1. Authenticate with Firebase
      const userCredential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const user = userCredential.user;

      // 2. Verify admin role in Firestore
      const adminDoc = await getDoc(doc(db, 'admin_users', user.uid));
      
      if (!adminDoc.exists() || adminDoc.data().role !== 'admin') {
        // If they are not an admin, we sign them out immediately
        await auth.signOut();
        throw new Error('Unauthorized. You do not have Admin privileges.');
      }

      // 3. Store admin session in sessionStorage (if still relying on it)
      sessionStorage.setItem('adminAuthenticated', 'true');
      sessionStorage.setItem('adminEmail', email.trim());
      sessionStorage.setItem('tenantId', adminDoc.data().tenantId);

      // 4. Redirect to Dashboard
      navigate('/admin/dashboard');
    } catch (err) {
      // Map Firebase error codes to concise, user-friendly messages
      const code = err.code || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Incorrect password');
      } else if (code === 'auth/user-not-found') {
        setError('No account found with this email');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Please try again later');
      } else if (code === 'auth/network-request-failed') {
        setError('Network error. Check your connection');
      } else if (err.message === 'Unauthorized. You do not have Admin privileges.') {
        setError('Unauthorized access');
      } else {
        setError(err.message || 'Login failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🛡️</div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Admin Login</h1>
          <p className="text-gray-600">Enter your credentials to access the portal</p>
        </div>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleLoginSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Admin Email ID</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your Email ID"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              required
              autoFocus
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-4 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? 'Signing in...' : '✅ Login as Admin'}
          </button>
        </form>

        <div className="mt-6 flex flex-col items-center gap-2 text-sm">
          <Link to="/admin/activate" className="text-indigo-600 hover:text-indigo-800 font-medium">
            First time? Activate your account
          </Link>
          <a href="/" className="text-gray-500 hover:text-gray-700 mt-2">
            ← Back to Home
          </a>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;
