import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, auth } from '../../firebase';
import { 
  collection, query, where, getDocs, doc, setDoc, serverTimestamp, runTransaction
} from 'firebase/firestore';
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const AdminActivation = () => {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Step 1 Form Data
  const [formData, setFormData] = useState({
    productKey: '',
    adminEmail: '',
    adminPhone: '', // Keeping it for validation/records but not using it for OTP
    adminPassword: '',
  });

  // Step 2 Form Data
  const [otp, setOtp] = useState('');
  const [productKeyDoc, setProductKeyDoc] = useState(null); // Store the doc snapshot to update it later

  const navigate = useNavigate();

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleStep1Submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // 1. Validate key via backend API (Admin SDK — no Firestore rules blocking this)
      const response = await fetch(
        `${API_URL}/api/product-keys/validate?key=${encodeURIComponent(formData.productKey)}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Invalid Product Key.');
      }

      // 2. Verify matching credentials
      if (data.adminEmail !== formData.adminEmail && data.secondaryEmail !== formData.adminEmail) {
        throw new Error('Email does not match the registered Product Key.');
      }
      if (data.adminPhone !== formData.adminPhone) {
        throw new Error('The mobile number is incorrect.');
      }
      if (formData.adminPassword.length < 6) {
        throw new Error('Password must be at least 6 characters long.');
      }

      // Store validated key data for Step 2
      setProductKeyDoc({ id: data.docId, data: () => data });

      // 3. Trigger Email OTP via backend
      const otpResponse = await fetch(`${API_URL}/api/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.adminEmail })
      });

      const otpResult = await otpResponse.json();
      if (!otpResponse.ok) {
        throw new Error(otpResult.error || 'Failed to send OTP email.');
      }

      setStep(2);

    } catch (err) {
      console.error(err);
      setError(err.message || 'An error occurred during verification.');
    } finally {
      setLoading(false);
    }
  };

  const handleStep2Submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // 1. Verify OTP via Backend
      const otpResponse = await fetch(`${API_URL}/api/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.adminEmail, otp })
      });
      const otpResult = await otpResponse.json();
      if (!otpResponse.ok) throw new Error(otpResult.error || 'Invalid OTP code.');

      // 2. Create Firebase Auth account
      const userCredential = await createUserWithEmailAndPassword(auth, formData.adminEmail, formData.adminPassword);
      const user = userCredential.user;
      await updateProfile(user, { displayName: 'College Admin' });

      // 3. Burn key + provision tenant via backend (Admin SDK — no Firestore rule issues)
      const keyData = productKeyDoc.data();
      const activateResponse = await fetch(`${API_URL}/api/product-keys/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docId: productKeyDoc.id,
          uid: user.uid,
          email: formData.adminEmail,
          tenantId: keyData.tenantId,
          collegeName: keyData.collegeName,
          collegeCode: keyData.collegeCode,
          facultyLimit: keyData.facultyLimit,
          validUntil: keyData.validUntil,
          facultyEmails: keyData.facultyEmails || [],
        }),
      });
      const activateResult = await activateResponse.json();
      if (!activateResponse.ok) throw new Error(activateResult.error || 'Activation failed.');

      // 4. Set session and redirect to dashboard
      sessionStorage.setItem('adminAuthenticated', 'true');
      sessionStorage.setItem('adminEmail', formData.adminEmail);
      sessionStorage.setItem('tenantId', keyData.tenantId);
      navigate('/admin/dashboard');

    } catch (err) {
      console.error(err);
      if (err.code === 'auth/email-already-in-use') {
        setError('This email is already registered. Please use a different email or delete the existing user from Firebase Console.');
      } else {
        setError(err.message || 'Invalid OTP or error during activation.');
      }
    } finally {
      setLoading(false);

    }
  };

  const handleStartOver = () => {
    setStep(1);
    setOtp('');
    setError('');
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white p-10 rounded-xl shadow-2xl">
        
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            College Admin Activation
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {step === 1 ? 'Enter your master credentials to begin' : 'Check your email for the verification code'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4 mb-4">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {step === 1 && (
          <form className="mt-8 space-y-6" onSubmit={handleStep1Submit}>
            <div className="rounded-md shadow-sm -space-y-px">
              <div>
                <label htmlFor="productKey" className="sr-only">Product Key</label>
                <input
                  id="productKey"
                  name="productKey"
                  type="text"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Product Key (e.g., PMS-X7B9...)"
                  value={formData.productKey}
                  onChange={handleInputChange}
                />
              </div>
              <div>
                <label htmlFor="adminEmail" className="sr-only">Registered Admin Email</label>
                <input
                  id="adminEmail"
                  name="adminEmail"
                  type="email"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Registered Admin Email"
                  value={formData.adminEmail}
                  onChange={handleInputChange}
                />
              </div>
              <div>
                <label htmlFor="adminPhone" className="sr-only">Registered Phone</label>
                <input
                  id="adminPhone"
                  name="adminPhone"
                  type="tel"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Phone Number (for records)"
                  value={formData.adminPhone}
                  onChange={handleInputChange}
                />
              </div>
              <div>
                <label htmlFor="adminPassword" className="sr-only">New Password</label>
                <input
                  id="adminPassword"
                  name="adminPassword"
                  type="password"
                  required
                  minLength="6"
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Set New Account Password (Min 6 chars)"
                  value={formData.adminPassword}
                  onChange={handleInputChange}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify & Send Email OTP'}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form className="mt-8 space-y-6" onSubmit={handleStep2Submit}>
            <div className="rounded-md shadow-sm -space-y-px">
              <div>
                <label htmlFor="otp" className="sr-only">OTP Code</label>
                <input
                  id="otp"
                  name="otp"
                  type="text"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                  placeholder="Enter 6-digit OTP from your email"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
              >
                {loading ? 'Activating...' : 'Confirm OTP & Activate'}
              </button>
              <button
                type="button"
                onClick={handleStartOver}
                disabled={loading}
                className="mt-4 group relative w-full flex justify-center py-2 px-4 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                Start Over
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default AdminActivation;
