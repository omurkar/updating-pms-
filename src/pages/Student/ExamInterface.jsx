import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, onSnapshot, updateDoc, runTransaction } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from '../../firebase';

const ExamInterface = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionCode = searchParams.get('session');
  const rollNo = searchParams.get('roll');
  const tenantId = searchParams.get('tenant');
  
  const [student, setStudent] = useState(null);
  const [examConfig, setExamConfig] = useState(null);
  const [answers, setAnswers] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingQuestions, setUploadingQuestions] = useState({});
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [imgError, setImgError] = useState(false); 
  const [zoomedImage, setZoomedImage] = useState(null);
  const [collegeName, setCollegeName] = useState('');

  useEffect(() => {
    if (!sessionCode || !rollNo || !tenantId) { navigate('/student/login'); return; }

    const examRef = doc(db, 'colleges', tenantId, 'exams', sessionCode);
    const unsubscribeExam = onSnapshot(examRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setExamConfig(data);
        if (data.is_active === false) { alert("⚠️ Session ENDED globally."); navigate('/student/login'); }
        if (data.is_active && data.started_at && data.duration_minutes) {
          const endTime = new Date(data.started_at.toDate().getTime() + data.duration_minutes * 60000);
          const timerInterval = setInterval(() => { setTimeRemaining(endTime - new Date()); }, 1000);
          return () => clearInterval(timerInterval);
        }
      } else { alert("Session invalid."); navigate('/student/login'); }
    });

    const studentRef = doc(db, 'colleges', tenantId, 'students', `${sessionCode}_${rollNo}`);
    const unsubscribeStudent = onSnapshot(studentRef, async (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if ((data.status === 'submitted' || data.status === 'absent' || data.session_ended) && !isSubmitting) {
            if (student?.status !== 'submitted') { alert("Session ended for you."); navigate('/student/login'); return; }
        }
        setStudent({ id: snapshot.id, ...data });
        setAnswers(data.answers || {});
        if (data.status === 'registered') try { await updateDoc(studentRef, { status: 'in_progress' }); } catch (e) { console.error(e); }
      } else { navigate('/student/login'); }
    });

    const fetchCollege = async () => {
      try {
        const settingsDoc = await getDoc(doc(db, 'colleges', tenantId, 'config', 'settings'));
        if (settingsDoc.exists() && settingsDoc.data().collegeName) {
          setCollegeName(settingsDoc.data().collegeName);
        }
      } catch (e) {
        console.error("Error fetching college name:", e);
      }
    };
    fetchCollege();

    return () => { unsubscribeExam(); unsubscribeStudent(); };
  }, [sessionCode, rollNo, tenantId, navigate]); 

  const formatTime = (ms) => {
    if (ms === null) return "--:--:--";
    const seconds = Math.floor((Math.abs(ms) / 1000) % 60);
    const minutes = Math.floor((Math.abs(ms) / (1000 * 60)) % 60);
    const hours = Math.floor((Math.abs(ms) / (1000 * 60 * 60)));
    return `${ms < 0 ? '-' : ''}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleCodeChange = (idx, code) => { setAnswers(prev => ({ ...prev, [`q${idx+1}`]: { ...prev[`q${idx+1}`], code } })); };
  const handleLogoutClick = () => { if (['submitted','approved'].includes(student.status)) navigate('/student/login'); else setShowLogoutConfirm(true); };
  const confirmLogout = () => navigate('/student/login');

  const saveCodeToFiles = async () => {
    const promises = [];
    student.assigned_questions.forEach((_, index) => {
      const code = answers[`q${index+1}`]?.code;
      if (code?.trim()) {
        const refPtr = ref(storage, `exam_uploads/${sessionCode}/${rollNo}/${sessionCode}_${rollNo}_q${index+1}_code.txt`);
        promises.push(uploadBytes(refPtr, new Blob([code], { type: 'text/plain' })));
      }
    });
    await Promise.all(promises);
  };

  const handleFileUpload = async (idx, file) => {
    if (!file || file.type !== 'application/pdf') { alert("PDF only."); return; }
    setUploadingQuestions(prev => ({ ...prev, [idx]: true }));
    const key = `q${idx+1}`;
    try {
      if (answers[key]?.storage_ref) try { await deleteObject(ref(storage, answers[key].storage_ref)); } catch(e){}
      const path = `exam_uploads/${sessionCode}/${rollNo}/q${idx+1}_${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
      const snap = await uploadBytes(ref(storage, path), file);
      const url = await getDownloadURL(snap.ref);
      setAnswers(prev => ({ ...prev, [key]: { ...prev[key], file_uploaded: true, file_name: file.name, file_url: url, storage_ref: path } }));
    } catch (e) { alert("Upload Failed: " + e.message); } 
    finally { setUploadingQuestions(prev => { const n = {...prev}; delete n[idx]; return n; }); }
  };

  const handleRemoveFile = async (idx) => {
    if(!window.confirm("Remove file?")) return;
    const key = `q${idx+1}`;
    if (answers[key]?.storage_ref) try { await deleteObject(ref(storage, answers[key].storage_ref)); } catch(e){}
    setAnswers(prev => ({ ...prev, [key]: { ...prev[key], file_uploaded: false, file_name: null, file_url: null, storage_ref: null } }));
  };

  const handleAction = async (status) => {
    if (isSubmitting) return; // SECURITY FIX I-2: Guard against double-click
    if (status === 'submitted' && !window.confirm('Final Submit?')) return;
    try {
      setIsSubmitting(true);
      await saveCodeToFiles();

      const studentRef = doc(db, 'colleges', tenantId, 'students', student.id);

      if (status === 'submitted') {
        // ── SECURITY FIX I-2: Use runTransaction for final submission ──
        // Atomically verifies the student hasn't already submitted before writing.
        // Prevents double-submission from double-click, network retry, or tab duplication.
        await runTransaction(db, async (transaction) => {
          const freshDoc = await transaction.get(studentRef);
          if (!freshDoc.exists()) throw new Error('Student session not found.');
          if (freshDoc.data().status === 'submitted') {
            throw new Error('Your exam has already been submitted.');
          }
          transaction.update(studentRef, { status: 'submitted', answers, submittedAt: new Date().toISOString() });
        });
        alert('Submitted!');
        navigate('/student/login');
      } else {
        // Draft saves are idempotent — no transaction needed
        await updateDoc(studentRef, { status, answers });
        alert(status === 'in_progress' ? 'Draft Saved!' : 'Approval Requested!');
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setIsSubmitting(false);
    }
  };


  if (!student) return <div className="text-center p-10">Loading...</div>;
  const isLocked = ['approval_requested','submitted'].includes(student.status) || student.session_ended;
  const canFinal = student.status === 'approved';
  const hasFiles = Object.values(answers).some(a => a?.file_uploaded);
  const isUploading = Object.keys(uploadingQuestions).length > 0;

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      
      <div className="bg-blue-600 text-white shadow-lg sticky top-0 z-[50] px-4 py-3 flex justify-between items-center">
        <h1 className="text-xl font-bold flex items-center gap-2">
          {collegeName && (
            <span className="bg-white text-blue-600 px-2 py-0.5 rounded shadow-sm text-sm tracking-wider uppercase font-extrabold border border-blue-200">
              {collegeName}
            </span>
          )}
          <span>Practical Exam - {student.session_code}</span>
        </h1>
        <div className="flex items-center gap-4">
            {timeRemaining !== null && <div className={`font-mono font-bold text-xl px-4 py-1 rounded ${timeRemaining < 0 ? 'bg-red-600 animate-pulse' : 'bg-blue-800'}`}>⏳ {formatTime(timeRemaining)}</div>}
            <button onClick={handleLogoutClick} className="bg-red-500 hover:bg-red-600 px-4 py-2 rounded font-bold border border-red-400">Logout</button>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-[95vw]">
        
        {/* STUDENT PROFILE */}
        <div className="bg-white rounded-lg shadow-md p-4 mb-6 flex items-center gap-6 border-l-8 border-blue-600">
            <div className="flex-shrink-0">
                {student.image && !imgError ? (
                    <img src={student.image} alt="Profile" onError={()=>setImgError(true)} onClick={()=>setZoomedImage(student.image)} className="w-24 h-24 rounded-lg object-cover border-4 border-gray-200 shadow-sm cursor-pointer hover:scale-105 transition" />
                ) : (
                    <div className="w-24 h-24 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-3xl">{student.name?.substring(0,2).toUpperCase() || 'ST'}</div>
                )}
            </div>
            <div>
                <h2 className="text-3xl font-bold text-gray-800">{student.name}</h2>
                <div className="text-lg text-gray-500 font-medium">Roll: <span className="text-black font-bold">{student.roll_no}</span></div>
                <div className="mt-2 inline-block px-3 py-1 bg-blue-50 text-blue-700 text-sm font-bold rounded-full border border-blue-200">Active Session</div>
            </div>
        </div>

        {/* QUESTIONS GRID */}
        <div className={`grid gap-6 ${examConfig?.allowed_url ? 'grid-cols-2' : 'grid-cols-1 max-w-5xl mx-auto'}`}>
            <div className="flex flex-col gap-6">
                <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-2xl font-bold mb-4 border-b pb-2 text-gray-700">Your Assigned Questions</h2>
                <div className="space-y-8">
                    {student.assigned_questions?.map((q, idx) => {
                    const ans = answers[`q${idx+1}`] || { code: '', file_uploaded: false };
                    const uploading = uploadingQuestions[idx];
                    return (
                        <div key={idx} className="border-2 border-gray-200 rounded-xl p-5 hover:border-blue-300 transition bg-gray-50">
                            <div className="flex justify-between items-start mb-3">
                                <div className="font-bold text-lg text-blue-900">Question {idx+1}</div>
                                <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded">Max: {q.marks}</span>
                            </div>
                            
                            <div className="font-medium text-gray-800 mb-4 text-lg">{q.topic}</div>

                            {/* QUESTION IMAGE */}
                            {q.image && (
                                <div className="mb-4 bg-gray-50 p-2 rounded border border-gray-200 inline-block">
                                    <img src={q.image} alt="Question Diagram" className="max-h-64 object-contain rounded cursor-pointer" onClick={() => setZoomedImage(q.image)} title="Click to Zoom" />
                                </div>
                            )}
                            
                            <div className="mb-4">
                                <label className="block text-gray-600 font-bold mb-2 text-sm uppercase">Type Code / Answer:</label>
                                <textarea value={ans.code||''} onChange={e=>handleCodeChange(idx,e.target.value)} disabled={isLocked} onCopy={e=>e.stopPropagation()} onPaste={e=>e.stopPropagation()} onCut={e=>e.stopPropagation()} className="w-full border border-gray-300 rounded-lg px-4 py-3 h-40 font-mono text-sm focus:ring-2 focus:ring-blue-500" placeholder="// Type here..." />
                            </div>
                            
                            <div className="bg-white p-4 rounded-lg border border-gray-200">
                                <label className="block text-gray-600 font-bold mb-2 text-sm uppercase">{ans.file_uploaded ? "✅ File Uploaded" : "Upload Output (PDF)"}</label>
                                <div className="flex items-center gap-4">
                                    <input type="file" onChange={e=>handleFileUpload(idx,e.target.files[0])} disabled={isLocked||uploading} accept="application/pdf" className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
                                    {uploading && <div className="text-blue-600 text-sm font-bold animate-pulse">Uploading...</div>}
                                </div>
                                {ans.file_uploaded && !uploading && (
                                <div className="mt-3 flex justify-between bg-green-50 p-2 rounded border border-green-200">
                                    <span className="text-green-700 text-sm font-medium truncate max-w-[200px]">📄 {ans.file_name}</span>
                                    {!isLocked && <button onClick={()=>handleRemoveFile(idx)} className="text-xs text-red-600 font-bold border border-red-200 px-2 rounded bg-white">Remove</button>}
                                </div>
                                )}
                            </div>
                        </div>
                    );
                    })}
                </div>
                </div>

                <div className="bg-white rounded-lg shadow-md p-6 flex justify-end gap-4 border-t-2 border-gray-100">
                    {!isLocked && ( <> <button onClick={()=>handleAction('in_progress')} disabled={isSubmitting||isUploading} className="bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-bold">Save Draft</button> <button onClick={()=>handleAction('approval_requested')} disabled={isSubmitting||isUploading||!hasFiles} className="bg-yellow-500 hover:bg-yellow-600 text-white px-6 py-3 rounded-lg font-bold">Request Approval</button> </> )}
                    {canFinal && <button onClick={()=>handleAction('submitted')} disabled={isSubmitting||isUploading} className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 rounded-lg font-bold shadow-lg">Final Submit</button>}
                    {student.status === 'submitted' && <div className="bg-green-100 text-green-800 px-6 py-3 rounded-lg font-bold w-full text-center">✅ Submitted</div>}
                    {student.status === 'approval_requested' && <div className="bg-yellow-100 text-yellow-800 px-6 py-3 rounded-lg font-bold w-full text-center">⏳ Pending Approval</div>}
                </div>
            </div>

            {examConfig?.allowed_url && (
                <div className="sticky top-20 h-[85vh] bg-gray-100 rounded-lg border-2 border-blue-200 overflow-hidden shadow-inner flex flex-col">
                    <div className="bg-gray-200 px-4 py-2 text-xs font-mono text-gray-600 border-b">Resource Window (Read Only)</div>
                    <iframe src={examConfig.allowed_url} title="Resource" className="w-full h-full bg-white" sandbox="allow-scripts allow-same-origin allow-forms" />
                </div>
            )}
        </div>
        <div className="text-center mt-12 mb-8"><p className="text-2xl font-serif text-gray-400 italic">all the best</p></div>
      </div>

      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 text-center max-w-sm w-full shadow-2xl">
            <h3 className="text-xl font-bold mb-4">Leave Session?</h3>
            <p className="text-gray-600 mb-6">Not submitted yet. Log out?</p>
            <div className="flex gap-3 justify-center"><button onClick={()=>setShowLogoutConfirm(false)} className="px-5 py-2 bg-gray-200 rounded font-bold">Cancel</button><button onClick={confirmLogout} className="px-5 py-2 bg-red-600 text-white rounded font-bold">Yes, Logout</button></div>
          </div>
        </div>
      )}

      {zoomedImage && (
        <div className="fixed inset-0 z-[9999] bg-black bg-opacity-90 flex items-center justify-center p-4" onClick={()=>setZoomedImage(null)}>
            <div className="relative max-w-4xl max-h-full">
                <button onClick={()=>setZoomedImage(null)} className="absolute -top-12 right-0 text-white text-4xl font-bold">&times;</button>
                <img src={zoomedImage} alt="Full Size" className="max-w-full max-h-[85vh] rounded-lg border-4 border-white" onClick={e=>e.stopPropagation()} />
            </div>
        </div>
      )}
    </div>
  );
};

export default ExamInterface;