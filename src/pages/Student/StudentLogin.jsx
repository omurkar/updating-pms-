import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import Navbar from '../../components/Navbar';

const StudentLogin = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    session_code: '',
    roll_no: '',
    full_name: '' 
  });

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);

    const sessionCode = formData.session_code.trim();
    const rollNo = formData.roll_no.trim();
    const fullNameInput = formData.full_name.trim();

    // 1. Basic Validation
    if (!sessionCode || !rollNo || !fullNameInput) {
      alert("Please enter Session Code, Roll Number, and Full Name.");
      setLoading(false);
      return;
    }

    try {
      // 2. RESOLVE TENANT via exam_index
      const examIndexDoc = await getDoc(doc(db, 'exam_index', sessionCode));
      if (!examIndexDoc.exists()) {
        alert("❌ Login Failed.\n\nInvalid Session Code, Roll Number, or Name.");
        setLoading(false);
        return;
      }
      const tenantId = examIndexDoc.data().tenantId;

      // 3. QUERY: Find student by Session Code and Roll Number in tenant-scoped collection
      const q = query(
        collection(db, 'colleges', tenantId, 'students'),
        where('session_code', '==', sessionCode),
        where('roll_no', '==', rollNo)
      );

      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        // Generic Error if Roll No/Session doesn't exist
        alert("❌ Login Failed.\n\nInvalid Session Code, Roll Number, or Name.");
        setLoading(false);
        return; 
      }

      // 4. VERIFY NAME (CASE INSENSITIVE)
      const studentDoc = querySnapshot.docs[0];
      const studentData = studentDoc.data();
      const storedName = studentData.name || "";

      // Convert both to lowercase for comparison
      if (storedName.toLowerCase() !== fullNameInput.toLowerCase()) {
        alert("❌ Login Failed.\n\nInvalid Session Code, Roll Number, or Name.");
        setLoading(false);
        return;
      }

      // --- 5. CHECK IF SESSION IS ENDED/SUBMITTED ---
      // If the teacher ended the session for this student, status becomes 'submitted' or 'absent'.
      // We block them from logging in again.
      if (studentData.status === 'submitted' || studentData.status === 'absent' || studentData.is_graded) {
        alert("⛔ Access Denied.\n\nThe session has been ended for you or you have already submitted your exam.");
        setLoading(false);
        return;
      }

      // 6. SUCCESS: Proceed to Exam Interface (pass tenantId in URL)
      navigate(`/student/exam?session=${sessionCode}&roll=${rollNo}&tenant=${tenantId}`);

    } catch (error) {
      console.error("Login Error:", error);
      alert("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <div className="container mx-auto px-4 py-12 flex justify-center items-center">
        <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full border border-gray-100">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-blue-600 mb-2">Student Login</h1>
            <p className="text-gray-500 text-sm">Enter your exam details to begin</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            
            {/* Session Code Input */}
            <div>
              <label className="block text-gray-700 font-bold mb-2">Session Code</label>
              <input
                type="text"
                value={formData.session_code}
                onChange={(e) => setFormData({...formData, session_code: e.target.value})}
                className="w-full border rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none transition"
                placeholder="e.g. JAVA492"
                required
              />
            </div>

            {/* Roll Number Input */}
            <div>
              <label className="block text-gray-700 font-bold mb-2">Roll Number</label>
              <input
                type="text"
                value={formData.roll_no}
                onChange={(e) => setFormData({...formData, roll_no: e.target.value})}
                className="w-full border rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none transition"
                placeholder="e.g. 101"
                required
              />
            </div>

            {/* Full Name Input */}
            <div>
              <label className="block text-gray-700 font-bold mb-2">Full Name</label>
              <input
                type="text"
                value={formData.full_name}
                onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                className="w-full border rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none transition"
                placeholder="e.g. Rahul Sharma"
                required
              />
              <p className="text-xs text-gray-400 mt-1">Case insensitive (e.g. rahul sharma, RAHUL SHARMA)</p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md transition transform active:scale-95 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Enter Exam'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default StudentLogin;