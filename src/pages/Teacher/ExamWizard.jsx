import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { collection, addDoc, doc, setDoc, getDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';
import Navbar from '../../components/Navbar';
import ProtectedRoute from '../../components/ProtectedRoute';
import ExcelJS from 'exceljs';

const ExamWizard = () => {
  const { currentUser } = useAuth();
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const location = useLocation(); 
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState(''); 
  const [showConfirmModal, setShowConfirmModal] = useState(false); 
  const [showHelpModal, setShowHelpModal] = useState(false); // State for Help Popup

  // --- DATA VIEWER MODAL STATE ---
  const [viewerModal, setViewerModal] = useState(null); // { type: 'students'|'questions', data: [] }
  
  // --- Config State ---
  const [subjectName, setSubjectName] = useState('');
  const [sessionCode, setSessionCode] = useState('');
  const [labNumber, setLabNumber] = useState(''); 
  const [studentDepartment, setStudentDepartment] = useState('');
  const [studentYear, setStudentYear] = useState('');
  const [durationHours, setDurationHours] = useState('0');
  const [durationMinutes, setDurationMinutes] = useState('0');
  const [practicalMarks, setPracticalMarks] = useState('');
  const [vivaMarks, setVivaMarks] = useState('');
  const [journalMarks, setJournalMarks] = useState('');
  const [step1Error, setStep1Error] = useState('');

  // --- Data Arrays ---
  const [studentsFile, setStudentsFile] = useState(null);
  const [students, setStudents] = useState([]); 
  const [questionsFile, setQuestionsFile] = useState(null);
  const [questions, setQuestions] = useState([]); 

  const generateSessionCode = (subject) => {
    let letters = subject.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 4) {
      letters = letters.padEnd(4, 'X');
    }
    const base = letters.substring(0, 4).toUpperCase();
    const num = Math.floor(100 + Math.random() * 900);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const letter = chars.charAt(Math.floor(Math.random() * chars.length));
    return `${base}${num}${letter}`;
  };

  useEffect(() => {
    if (location.state?.template) {
        const t = location.state.template;
        setSubjectName(t.subjectName || '');
        if (t.subjectName) {
            setSessionCode(generateSessionCode(t.subjectName));
        }
        setLabNumber(t.labNumber || '');
        setStudentDepartment(t.studentDepartment || '');
        setStudentYear(t.studentYear || '');
        setDurationHours(t.durationHours || '0');
        setDurationMinutes(t.durationMinutes || '0');
        setPracticalMarks(t.practicalMarks || '');
        setVivaMarks(t.vivaMarks || '');
        setJournalMarks(t.journalMarks || '');
        setStudents(t.students || []);
        setQuestions(t.questions || []);
    }
  }, [location.state]);

  const handleSubjectChange = (e) => {
    const subject = e.target.value;
    setSubjectName(subject);
    if (subject.trim().length > 0) {
      setSessionCode(generateSessionCode(subject));
    } else {
      setSessionCode('');
    }
  };

  // --- 📥 DOWNLOAD TEMPLATE FUNCTION ---
  const handleDownloadTemplate = async (type) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(type === 'student' ? 'Student List' : 'Question Bank');

    if (type === 'student') {
        sheet.columns = [
            { header: 'Roll No', key: 'roll', width: 15 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Image (Insert in Cell)', key: 'image', width: 25 }
        ];
        sheet.addRow({ roll: '101', name: 'Student Name Here', image: '' });
    } else {
        sheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Topic', key: 'topic', width: 50 },
            { header: 'Image (Insert in Cell)', key: 'image', width: 25 },
            { header: 'Marks', key: 'marks', width: 10 }
        ];
        sheet.addRow({ id: '1', topic: 'Write a program to...', image: '', marks: 10 });
    }

    // Generate and Download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = type === 'student' ? 'Student_List_Template.xlsx' : 'Question_Bank_Template.xlsx';
    anchor.click();
    window.URL.revokeObjectURL(url);
  };

  // --- 📸 SMART IMAGE EXTRACTOR ---
  const extractImagesFromWorkbook = (workbook, worksheet) => {
    const imageMap = {};
    const mediaList = workbook.model.media || [];

    worksheet.getImages().forEach(image => {
        const rowNumber = Math.round(image.range.tl.nativeRow) + 1; 
        const media = mediaList.find(m => m.index == image.imageId);
        
        if (media) {
            imageMap[rowNumber] = { 
                buffer: media.buffer, 
                extension: media.extension || 'png' 
            };
        }
    });
    return imageMap;
  };

  const handleStudentsUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setStudentsFile(file);
    const storagePrefix = sessionCode ? `${sessionCode}_students` : `temp_students_${Date.now()}`;

    try {
        setLoading(true);
        setLoadingText("Scanning Excel for Photos...");

        const buffer = await file.arrayBuffer();
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const worksheet = workbook.getWorksheet(1);

        const imageMap = extractImagesFromWorkbook(workbook, worksheet);
        const imageCount = Object.keys(imageMap).length;
        
        const rowPromises = [];
        let studentCount = 0;

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip Header
            
            const promise = async () => {
                const rollRaw = row.getCell(1).value; 
                const nameRaw = row.getCell(2).value; 

                if (!rollRaw || !nameRaw) return null; 

                studentCount++;
                const roll_no = rollRaw.toString().trim();
                const name = nameRaw.toString().trim();
                let imageUrl = "";

                if (imageMap[rowNumber]) {
                    try {
                        const imgData = imageMap[rowNumber];
                        const blob = new Blob([imgData.buffer], { type: `image/${imgData.extension}` });
                        const fileName = `${roll_no}_${name.replace(/\s+/g, '_')}.${imgData.extension}`;
                        const storageRef = ref(storage, `student_profiles/${storagePrefix}/${fileName}`);
                        await uploadBytes(storageRef, blob);
                        imageUrl = await getDownloadURL(storageRef);
                    } catch (err) {
                        console.error(`Upload error for ${name}`, err);
                    }
                } 
                else {
                    const cell3 = row.getCell(3);
                    if (cell3.value) {
                        if (typeof cell3.value === 'object' && cell3.value.text) imageUrl = cell3.value.text;
                        else if (typeof cell3.value === 'string') imageUrl = cell3.value;
                    }
                }
                return { roll_no, name, image: imageUrl };
            };
            rowPromises.push(promise());
        });

        if (imageCount > 0) setLoadingText(`Uploading ${imageCount} detected photos...`);

        const results = await Promise.all(rowPromises);
        const validStudents = results.filter(s => s !== null);
        
        if (validStudents.length === 0) {
            alert("❌ No valid students found. Ensure Col A = Roll, Col B = Name.");
            setStudents([]);
        } else {
            setStudents(validStudents);
            alert(`✅ UPLOAD SUCCESS:\n\n• Students Found: ${validStudents.length}\n• Photos Detected: ${imageCount}\n\nIf Photos Detected is 0, click the (?) Help icon to see how to insert images correctly.`);
        }

    } catch (error) {
        alert("Error processing file: " + error.message);
    } finally {
        setLoading(false);
        setLoadingText('');
    }
  };

  const handleQuestionsUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setQuestionsFile(file);
    const storagePrefix = sessionCode ? `${sessionCode}_questions` : `temp_questions_${Date.now()}`;

    try {
        setLoading(true);
        setLoadingText("Scanning Question Bank...");

        const buffer = await file.arrayBuffer();
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const worksheet = workbook.getWorksheet(1); 

        const imageMap = extractImagesFromWorkbook(workbook, worksheet);
        const imageCount = Object.keys(imageMap).length;

        const rowPromises = [];
        let qCount = 0;

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;

            const promise = async () => {
                const idRaw = row.getCell(1).value;    
                const topicRaw = row.getCell(2).value; 
                const marksRaw = row.getCell(4).value; 

                if (!idRaw || !topicRaw) return null;

                qCount++;
                const question_id = idRaw.toString().trim();
                const topic = topicRaw.toString().trim();
                const marks = parseInt(marksRaw) || 0;
                let imageUrl = "";

                if (imageMap[rowNumber]) {
                    try {
                        const imgData = imageMap[rowNumber];
                        const blob = new Blob([imgData.buffer], { type: `image/${imgData.extension}` });
                        const fileName = `Q${question_id}_${Date.now()}.${imgData.extension}`;
                        const storageRef = ref(storage, `question_images/${storagePrefix}/${fileName}`);
                        await uploadBytes(storageRef, blob);
                        imageUrl = await getDownloadURL(storageRef);
                    } catch (err) {
                        console.error("Question Img Error", err);
                    }
                } 
                else {
                    const cell3 = row.getCell(3);
                    if (cell3.value) {
                        if (typeof cell3.value === 'object' && cell3.value.text) imageUrl = cell3.value.text;
                        else if (typeof cell3.value === 'string') imageUrl = cell3.value;
                    }
                }
                return { question_id, topic, marks, image: imageUrl };
            };
            rowPromises.push(promise());
        });

        if (imageCount > 0) setLoadingText(`Uploading ${imageCount} question diagrams...`);

        const results = await Promise.all(rowPromises);
        const validQuestions = results.filter(q => q !== null && q.marks > 0);

        if (validQuestions.length === 0) {
            alert("❌ No valid questions found.");
            setQuestions([]);
        } else {
            setQuestions(validQuestions);
            alert(`✅ UPLOAD SUCCESS:\n\n• Questions Found: ${validQuestions.length}\n• Diagrams Detected: ${imageCount}`);
        }

    } catch (error) {
        alert("Error processing questions: " + error.message);
    } finally {
        setLoading(false);
        setLoadingText('');
    }
  };

  const validatePracticalMarksDistribution = (practicalMarks, questionsList) => {
    const targetMarks = parseInt(practicalMarks);
    if (!targetMarks || !questionsList.length) return true;
    const minPossible = Math.min(...questionsList.map(q => q.marks));
    if (targetMarks < minPossible) {
      alert(`Practical marks (${targetMarks}) < Smallest question mark (${minPossible}).`);
      return false;
    }
    return true;
  };

  const generateSlips = (studentsList, questionsList, totalPracticalMarks) => {
    const slips = {};
    studentsList.forEach((student) => {
      const selectedQuestions = [];
      let currentSum = 0;
      const shuffled = [...questionsList].sort(() => Math.random() - 0.5);
      for (const question of shuffled) {
        if (currentSum + question.marks <= totalPracticalMarks) {
          selectedQuestions.push(question);
          currentSum += question.marks;
          if (currentSum === totalPracticalMarks) break;
        }
      }
      slips[student.roll_no] = selectedQuestions;
    });
    return slips;
  };

  const handleSaveTemplate = async () => {
    const templateName = prompt("Template Name:", subjectName);
    if (!templateName) return;
    setLoading(true);
    try {
        await addDoc(collection(db, 'colleges', tenantId, 'exam_templates'), {
            template_name: templateName,
            teacher_email: currentUser.email,
            created_at: serverTimestamp(),
            subjectName, labNumber, studentDepartment, studentYear,
            durationHours, durationMinutes, practicalMarks, vivaMarks, journalMarks,
            students, questions 
        });
        alert("✅ Template Saved!");
        navigate('/teacher/dashboard');
    } catch (error) { alert("Failed: " + error.message); } 
    finally { setLoading(false); }
  };

  const handlePreLaunchValidation = () => {
    const cleanSessionCode = sessionCode.trim();
    const cleanSubject = subjectName.trim();
    const hrs = parseInt(durationHours) || 0;
    const mins = parseInt(durationMinutes) || 0;
    const totalDurationMinutes = (hrs * 60) + mins;

    if (!cleanSubject || !cleanSessionCode || !practicalMarks || !labNumber || !studentDepartment || !studentYear) {
      alert('Fill all required fields.'); return;
    }
    if (totalDurationMinutes <= 0) { alert("Duration > 0 required."); return; }
    if (students.length === 0) { alert('Upload student list.'); return; }
    if (questions.length === 0) { alert('Upload question bank.'); return; }
    if (!validatePracticalMarksDistribution(practicalMarks, questions)) return;

    setShowConfirmModal(true);
  };

  const executeLaunch = async () => {
    setShowConfirmModal(false); 
    setLoading(true);
    setLoadingText("Launching Session...");

    const cleanSessionCode = sessionCode.trim();
    const totalDurationMinutes = (parseInt(durationHours)||0)*60 + (parseInt(durationMinutes)||0);

    try {
      const totalMarks = parseInt(practicalMarks) + parseInt(vivaMarks || 0) + parseInt(journalMarks || 0);
      
      await setDoc(doc(db, 'colleges', tenantId, 'exams', cleanSessionCode), { 
        subject_name: subjectName.trim(),
        teacher_email: currentUser.email,
        upload_folder_name: "CLOUD_STORAGE",
        lab_number: labNumber.trim(),
        student_department: studentDepartment.trim(),
        student_year: studentYear.trim(),
        duration_minutes: totalDurationMinutes,
        started_at: Timestamp.now(),
        total_marks: totalMarks,
        practical_marks: parseInt(practicalMarks),
        viva_marks: parseInt(vivaMarks || 0),
        journal_marks: parseInt(journalMarks || 0),
        is_active: true,
        created_at: new Date()
      });

      const questionsRef = collection(db, 'colleges', tenantId, 'questions');
      for (const question of questions) {
        await addDoc(questionsRef, {
          session_code: cleanSessionCode,
          question_id: question.question_id,
          topic: question.topic,
          marks: question.marks,
          image: question.image || "" 
        });
      }

      const totalPracticalMarks = parseInt(practicalMarks);
      const slips = generateSlips(students, questions, totalPracticalMarks);

      for (const student of students) {
        const studentId = `${cleanSessionCode}_${student.roll_no}`;
        await setDoc(doc(db, 'colleges', tenantId, 'students', studentId), {
          roll_no: student.roll_no,
          name: student.name,
          image: student.image || "", 
          session_code: cleanSessionCode,
          lab_number: labNumber.trim(),
          department: studentDepartment.trim(), 
          year: studentYear.trim(),
          status: 'registered',
          assigned_questions: slips[student.roll_no] || [], 
          answers: {},
          scores: { practical: 0, viva: 0, journal: 0, total: 0 }
        });
      }

      // Create root-level exam_index for student login resolution
      await setDoc(doc(db, 'exam_index', cleanSessionCode), {
        tenantId: tenantId
      });

      navigate('/teacher/dashboard');
    } catch (error) {
      alert('Error creating exam: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ProtectedRoute allowedRoles={['teacher']}>
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <div className="container mx-auto px-4 py-8 max-w-4xl">
          <h1 className="text-3xl font-bold text-gray-800 mb-8">
            {location.state?.template ? `Edit Exam: ${location.state.template.template_name}` : "Create New Exam"}
          </h1>

          {/* Progress Steps */}
          <div className="mb-10">
            <div className="flex items-center justify-between w-full relative">
              <div className="absolute left-0 top-1/2 transform -translate-y-1/2 w-full h-1 bg-gray-200 -z-10"></div>
              {[{ num: 1, label: 'Config' }, { num: 2, label: 'Students' }, { num: 3, label: 'Questions' }, { num: 4, label: 'Save Template' }, { num: 5, label: 'Launch' }].map((s, index, arr) => (
                <div key={s.num} className={`flex items-center ${index !== arr.length - 1 ? 'flex-1' : ''}`}>
                  <div className="relative flex flex-col items-center">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm border-2 transition-colors duration-300 z-10 bg-gray-50 ${step >= s.num ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-300'}`}>{s.num}</div>
                    <div className={`absolute top-12 text-xs font-medium w-32 text-center ${step >= s.num ? 'text-blue-700' : 'text-gray-400'}`}>{s.label}</div>
                  </div>
                  {index !== arr.length - 1 && (<div className={`flex-1 h-1 mx-2 rounded ${step > s.num ? 'bg-blue-600' : 'bg-gray-300'}`}></div>)}
                </div>
              ))}
            </div>
            <div className="h-8"></div> 
          </div>

          {/* STEP 1: CONFIGURATION */}
          {step === 1 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-2xl font-bold mb-4">Exam Configuration</h2>
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div><label className="block text-gray-700 font-bold mb-2">Subject Name *</label><input type="text" value={subjectName} onChange={handleSubjectChange} className="w-full border rounded-lg px-4 py-2" required /></div>
                  <div><label className="block text-gray-700 font-bold mb-2">Session Code *</label><input type="text" value={sessionCode} onChange={(e) => setSessionCode(e.target.value)} className="w-full border rounded-lg px-4 py-2 bg-gray-50" placeholder="e.g., MATH123a" required /></div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-700 font-bold mb-2">Student Department *</label>
                    <select value={studentDepartment} onChange={(e) => { setStudentDepartment(e.target.value); setStep1Error(''); }} className={`w-full border-2 rounded-lg px-4 py-2 bg-white transition ${step1Error && !studentDepartment ? 'border-red-400 ring-2 ring-red-100' : 'border-gray-200'}`} required>
                      <option value="">-- Select Department --</option>
                      <option value="BScIT">BScIT</option>
                      <option value="BScCS">BScCS</option>
                      <option value="BScDS">BScDS</option>
                    </select>
                    {step1Error && !studentDepartment && (
                      <p className="text-red-500 text-xs mt-1 font-semibold flex items-center gap-1" style={{ animation: 'tooltipShake 0.3s ease-out' }}>
                        <span>⚠️</span> Please select a Department
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-gray-700 font-bold mb-2">Student Year *</label>
                    <select value={studentYear} onChange={(e) => { setStudentYear(e.target.value); setStep1Error(''); }} className={`w-full border-2 rounded-lg px-4 py-2 bg-white transition ${step1Error && !studentYear ? 'border-red-400 ring-2 ring-red-100' : 'border-gray-200'}`} required>
                      <option value="">-- Select Year --</option>
                      <option value="FIRST YEAR">FIRST YEAR</option>
                      <option value="SECOND YEAR">SECOND YEAR</option>
                      <option value="THIRD YEAR">THIRD YEAR</option>
                      <option value="FOURTH YEAR">FOURTH YEAR</option>
                    </select>
                    {step1Error && !studentYear && (
                      <p className="text-red-500 text-xs mt-1 font-semibold flex items-center gap-1" style={{ animation: 'tooltipShake 0.3s ease-out' }}>
                        <span>⚠️</span> Please select a Year
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                   <div><label className="block text-gray-700 font-bold mb-2">Lab / Room Number *</label><input type="text" value={labNumber} onChange={(e) => setLabNumber(e.target.value)} className="w-full border rounded-lg px-4 py-2" required /></div>
                   <div><label className="block text-gray-700 font-bold mb-2">Exam Duration *</label>
                    <div className="flex gap-2 items-center">
                      <div className="flex-1"><input type="number" min="0" value={durationHours} onChange={(e) => setDurationHours(e.target.value)} className="w-full border rounded-lg px-4 py-2" /><span className="text-xs text-gray-500">Hours</span></div>
                      <span className="font-bold">:</span>
                      <div className="flex-1"><input type="number" min="0" max="59" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} className="w-full border rounded-lg px-4 py-2" /><span className="text-xs text-gray-500">Minutes</span></div>
                    </div>
                  </div>
                </div>
                <div className="grid md:grid-cols-3 gap-4 bg-gray-50 p-4 rounded-lg border">
                  <div><label className="block text-gray-700 font-bold mb-2">Practical Marks *</label><input type="number" value={practicalMarks} onChange={(e) => setPracticalMarks(e.target.value)} className="w-full border rounded-lg px-4 py-2" required /></div>
                  <div><label className="block text-gray-700 font-bold mb-2">Viva Marks</label><input type="number" value={vivaMarks} onChange={(e) => setVivaMarks(e.target.value)} className="w-full border rounded-lg px-4 py-2" /></div>
                  <div><label className="block text-gray-700 font-bold mb-2">Journal Marks</label><input type="number" value={journalMarks} onChange={(e) => setJournalMarks(e.target.value)} className="w-full border rounded-lg px-4 py-2" /></div>
                </div>

                {/* Step 1 Error Tooltip */}
                {step1Error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 font-medium flex items-center gap-2" style={{ animation: 'tooltipShake 0.3s ease-out' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.96-.833-2.732 0L3.268 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    {step1Error}
                  </div>
                )}

                <div className="relative">
                  <button 
                    onClick={async () => { 
                      const totalMins = (parseInt(durationHours)||0)*60 + (parseInt(durationMinutes)||0);
                      if (!studentDepartment || !studentYear) {
                        setStep1Error('Please select a Department and Year to continue.');
                        return;
                      }
                      if (!labNumber || totalMins <= 0 || !subjectName.trim()) { 
                        alert("Please fill all required fields and set a valid duration."); 
                        return; 
                      } 

                      setLoading(true);
                      setLoadingText('Validating Session Code...');
                      
                      let currentCode = sessionCode;
                      if (!currentCode) {
                        currentCode = generateSessionCode(subjectName);
                      }

                      try {
                        let snap = await getDoc(doc(db, 'exam_index', currentCode));
                        if (snap.exists()) {
                          // Attempt 2
                          currentCode = generateSessionCode(subjectName);
                          snap = await getDoc(doc(db, 'exam_index', currentCode));
                          if (snap.exists()) {
                            setLoading(false);
                            setStep1Error('The generated session code already exists. Please change the subject name slightly or try again.');
                            return;
                          }
                        }
                      } catch (err) {
                        console.error("Error validating session code:", err);
                        setLoading(false);
                        setStep1Error('Failed to validate session code due to network error.');
                        return;
                      }

                      setSessionCode(currentCode);
                      setStep1Error('');
                      setLoading(false);
                      setStep(2); 
                    }} 
                    className={`w-full px-4 py-3 rounded-lg transition mt-4 font-bold text-lg flex items-center justify-center gap-2 ${
                      !studentDepartment || !studentYear 
                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                        : 'bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg transform hover:scale-[1.01]'
                    }`}
                  >
                    Next: Upload Students →
                  </button>
                </div>

                <style>{`
                  @keyframes tooltipShake {
                    0%, 100% { transform: translateX(0); }
                    20% { transform: translateX(-4px); }
                    40% { transform: translateX(4px); }
                    60% { transform: translateX(-2px); }
                    80% { transform: translateX(2px); }
                  }
                `}</style>
              </div>
            </div>
          )}

          {/* STEP 2: STUDENTS */}
          {step === 2 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-2xl font-bold">Upload Student List</h2>
                  <div className="flex gap-2">
                      <button onClick={() => handleDownloadTemplate('student')} className="text-sm bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition flex items-center gap-1 font-bold">
                          📥 Download Template
                      </button>
                      <button onClick={() => setShowHelpModal(true)} className="w-8 h-8 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center font-bold hover:bg-gray-300" title="How to add images?">?</button>
                  </div>
              </div>
              <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-4 text-sm text-blue-800">
                  <strong>Instruction:</strong> Upload <strong>Excel (.xlsx)</strong>.<br/>
                  <strong>Columns:</strong> <code>Roll No</code> | <code>Name</code> | <code>Image</code> (Col C)
              </div>
              <div className="space-y-4">
                <div><label className="block text-gray-700 font-bold mb-2">Excel File (.xlsx)</label><input type="file" accept=".xlsx" onChange={handleStudentsUpload} className="w-full border rounded-lg px-4 py-2" /></div>
                {students.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between bg-green-50 p-4 border border-green-200 rounded-xl">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-xl">✅</div>
                        <div>
                          <p className="font-bold text-green-800">{students.length} students loaded!</p>
                          <p className="text-xs text-green-600">{students.filter(s => s.image).length} photos detected</p>
                        </div>
                      </div>
                      <button
                        id="view-students-btn"
                        onClick={() => setViewerModal({ type: 'students', data: students })}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-white text-sm transition shadow-md hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)' }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        View List
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex gap-4">
                  <button onClick={() => setStep(1)} className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 px-4 py-2 rounded-lg">Back</button>
                  <button onClick={() => setStep(3)} disabled={students.length === 0} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50">Next: Upload Questions</button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: QUESTIONS */}
          {step === 3 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <div className="flex justify-between items-center mb-4">
                  <h2 className="text-2xl font-bold">Upload Question Bank</h2>
                  <div className="flex gap-2">
                      <button onClick={() => handleDownloadTemplate('question')} className="text-sm bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition flex items-center gap-1 font-bold">
                          📥 Download Template
                      </button>
                      <button onClick={() => setShowHelpModal(true)} className="w-8 h-8 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center font-bold hover:bg-gray-300" title="How to add images?">?</button>
                  </div>
              </div>
              <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg mb-4 text-sm text-yellow-800">
                  <strong>Instruction:</strong> Upload <strong>Excel (.xlsx)</strong>.<br/>
                  <strong>Columns:</strong> <code>ID</code> | <code>Topic</code> | <code>Image</code> (Col C) | <code>Marks</code> (Col D)
              </div>
              <div className="space-y-4">
                <div><label className="block text-gray-700 font-bold mb-2">Question Bank Excel (.xlsx)</label><input type="file" accept=".xlsx" onChange={handleQuestionsUpload} className="w-full border rounded-lg px-4 py-2" /></div>
                {questions.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between bg-green-50 p-4 border border-green-200 rounded-xl">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-xl">✅</div>
                        <div>
                          <p className="font-bold text-green-800">{questions.length} questions loaded!</p>
                          <p className="text-xs text-green-600">{questions.filter(q => q.image).length} diagrams detected</p>
                        </div>
                      </div>
                      <button
                        id="view-questions-btn"
                        onClick={() => setViewerModal({ type: 'questions', data: questions })}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-white text-sm transition shadow-md hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        View Bank
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex gap-4">
                  <button onClick={() => setStep(2)} className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 px-4 py-2 rounded-lg">Back</button>
                  <button onClick={() => { if(!validatePracticalMarksDistribution(practicalMarks, questions)) return; setStep(4); }} disabled={questions.length === 0} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50">Next: Save Template</button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: SAVE TEMPLATE */}
          {step === 4 && (
            <div className="bg-white rounded-lg shadow-md p-6 text-center">
              <h2 className="text-2xl font-bold mb-4">Save as Template?</h2>
              <div className="flex gap-4 justify-center">
                  <button onClick={() => setStep(5)} className="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-bold">Skip & Continue</button>
                  <button onClick={handleSaveTemplate} disabled={loading} className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-bold shadow-md">💾 Save Template</button>
              </div>
            </div>
          )}

          {/* STEP 5: LAUNCH */}
          {step === 5 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-2xl font-bold mb-4">Review & Launch</h2>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="font-bold mb-2">Exam Details:</h3>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <p><strong>Subject:</strong> {subjectName}</p>
                    <p><strong>Session:</strong> {sessionCode}</p>
                    <p><strong>Students:</strong> {students.length}</p>
                    <p><strong>Questions:</strong> {questions.length}</p>
                  </div>
                </div>
                <div className="grid md:grid-cols-1 gap-4 mt-6">
                    <button onClick={handlePreLaunchValidation} disabled={loading} className="w-full bg-green-600 hover:bg-green-700 text-white px-4 py-4 rounded-lg font-bold shadow-lg text-lg flex justify-center items-center gap-2">
                        <span>🚀</span> Launch Exam Now
                    </button>
                </div>
                <div className="text-center mt-4"><button onClick={() => setStep(4)} className="text-gray-500 hover:text-gray-700 text-sm underline">Back to Save Template</button></div>
              </div>
            </div>
          )}

          {/* ==================== DATA VIEWER MODAL ==================== */}
          {viewerModal && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center p-4"
              style={{ backdropFilter: 'blur(10px)', background: 'rgba(15,23,42,0.6)' }}
              onClick={() => setViewerModal(null)}
            >
              <div
                className="bg-white rounded-3xl shadow-2xl w-full flex flex-col"
                style={{ maxWidth: '860px', maxHeight: '88vh', animation: 'viewerIn 0.28s cubic-bezier(.16,1,.3,1)' }}
                onClick={e => e.stopPropagation()}
              >
                {/* Modal Header */}
                <div
                  className="flex items-center justify-between px-6 py-4 rounded-t-3xl flex-shrink-0"
                  style={{
                    background: viewerModal.type === 'students'
                      ? 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)'
                      : 'linear-gradient(135deg, #92400e 0%, #f59e0b 100%)'
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 bg-white bg-opacity-20 rounded-2xl flex items-center justify-center text-2xl">
                      {viewerModal.type === 'students' ? '👨‍🎓' : '📋'}
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-white">
                        {viewerModal.type === 'students' ? 'Student List' : 'Question Bank'}
                      </h3>
                      <p className="text-sm text-white text-opacity-80">
                        {viewerModal.data.length} {viewerModal.type === 'students' ? 'students' : 'questions'} •{' '}
                        {viewerModal.type === 'students'
                          ? `${viewerModal.data.filter(s => s.image).length} with photos`
                          : `${viewerModal.data.filter(q => q.image).length} with diagrams`
                        }
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setViewerModal(null)}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-white bg-opacity-20 hover:bg-opacity-30 text-white transition"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Stats Bar */}
                <div className="flex gap-4 px-6 py-3 bg-gray-50 border-b border-gray-100 flex-shrink-0">
                  {viewerModal.type === 'students' ? (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        <span className="text-gray-600">Total: <strong className="text-gray-800">{viewerModal.data.length}</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                        <span className="text-gray-600">With Photo: <strong className="text-gray-800">{viewerModal.data.filter(s => s.image).length}</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-gray-300 rounded-full"></span>
                        <span className="text-gray-600">No Photo: <strong className="text-gray-800">{viewerModal.data.filter(s => !s.image).length}</strong></span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                        <span className="text-gray-600">Total Questions: <strong className="text-gray-800">{viewerModal.data.length}</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
                        <span className="text-gray-600">Total Marks: <strong className="text-gray-800">{viewerModal.data.reduce((s, q) => s + (q.marks || 0), 0)}</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                        <span className="text-gray-600">With Diagram: <strong className="text-gray-800">{viewerModal.data.filter(q => q.image).length}</strong></span>
                      </div>
                    </>
                  )}
                </div>

                {/* Table Body */}
                <div className="overflow-auto flex-1">
                  {viewerModal.type === 'students' ? (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-blue-600 text-white">
                        <tr>
                          <th className="text-left px-4 py-3 font-semibold w-10">#</th>
                          <th className="text-left px-4 py-3 font-semibold w-24">Photo</th>
                          <th className="text-left px-4 py-3 font-semibold">Roll No</th>
                          <th className="text-left px-4 py-3 font-semibold">Full Name</th>
                          <th className="text-left px-4 py-3 font-semibold w-28">Photo Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewerModal.data.map((s, idx) => (
                          <tr key={idx} className={`border-b border-gray-100 hover:bg-blue-50 transition ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                            <td className="px-4 py-3 text-gray-400 text-xs font-mono">{idx + 1}</td>
                            <td className="px-4 py-3">
                              {s.image ? (
                                <img
                                  src={s.image}
                                  alt={s.name}
                                  className="w-12 h-12 rounded-xl object-cover border-2 border-blue-100 shadow-sm"
                                  onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }}
                                />
                              ) : null}
                              <div
                                className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-100 to-indigo-200 flex items-center justify-center text-blue-600 font-bold text-lg"
                                style={{ display: s.image ? 'none' : 'flex' }}
                              >
                                {(s.name || '?')[0].toUpperCase()}
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono font-bold text-gray-800">{s.roll_no}</td>
                            <td className="px-4 py-3 font-medium text-gray-800">{s.name}</td>
                            <td className="px-4 py-3">
                              {s.image ? (
                                <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-semibold">
                                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span> Photo
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 rounded-full text-xs font-semibold">
                                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full"></span> None
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-amber-600 text-white">
                        <tr>
                          <th className="text-left px-4 py-3 font-semibold w-10">#</th>
                          <th className="text-left px-4 py-3 font-semibold w-16">ID</th>
                          <th className="text-left px-4 py-3 font-semibold">Topic / Question</th>
                          <th className="text-left px-4 py-3 font-semibold w-28">Diagram</th>
                          <th className="text-right px-4 py-3 font-semibold w-20">Marks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewerModal.data.map((q, idx) => (
                          <tr key={idx} className={`border-b border-gray-100 hover:bg-amber-50 transition ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                            <td className="px-4 py-3 text-gray-400 text-xs font-mono">{idx + 1}</td>
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-amber-100 text-amber-700 font-bold text-xs">
                                Q{q.question_id}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-800 font-medium leading-snug">{q.topic}</td>
                            <td className="px-4 py-3">
                              {q.image ? (
                                <a href={q.image} target="_blank" rel="noopener noreferrer" className="group relative block">
                                  <img
                                    src={q.image}
                                    alt="diagram"
                                    className="w-14 h-10 rounded-lg object-cover border border-amber-200 group-hover:border-amber-400 transition shadow-sm"
                                    onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }}
                                  />
                                  <div className="w-14 h-10 rounded-lg bg-amber-100 items-center justify-center text-amber-600 text-xs font-semibold" style={{ display: 'none' }}>View</div>
                                </a>
                              ) : (
                                <span className="text-gray-400 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-700">
                                {q.marks} pts
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 bg-gray-50 border-t border-gray-100 rounded-b-3xl flex-shrink-0">
                  <p className="text-xs text-gray-400">Showing all {viewerModal.data.length} {viewerModal.type === 'students' ? 'students' : 'questions'}</p>
                  <button
                    onClick={() => setViewerModal(null)}
                    className="px-5 py-2 bg-gray-800 text-white rounded-xl text-sm font-semibold hover:bg-gray-900 transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          <style>{`
            @keyframes viewerIn {
              from { opacity: 0; transform: scale(0.95) translateY(16px); }
              to   { opacity: 1; transform: scale(1) translateY(0); }
            }
          `}</style>

          {/* --- HELP MODAL --- */}
          {showHelpModal && (
            <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 animate-fade-in-up">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-gray-800">How to Insert Images Correctly</h3>
                    <button onClick={() => setShowHelpModal(false)} className="text-gray-500 hover:text-gray-800 font-bold text-xl">&times;</button>
                </div>
                <div className="space-y-4 text-sm text-gray-700">
                    <p className="font-semibold text-blue-700 bg-blue-50 p-2 rounded">Use Google Sheets for best results:</p>
                    <ol className="list-decimal pl-5 space-y-2">
                        <li>Open your Excel sheet in <strong>Google Sheets</strong>.</li>
                        <li>Select the cell in the <strong>Image Column</strong> (e.g., Column C).</li>
                        <li>Go to <strong>Insert &gt; Image</strong>.</li>
                        <li><strong>IMPORTANT:</strong> Choose <strong>"Insert image in the cell"</strong>.</li>
                        <li>Upload your image.</li>
                        <li>Once done for all rows, go to <strong>File &gt; Download &gt; Microsoft Excel (.xlsx)</strong>.</li>
                        <li>Upload that file here.</li>
                    </ol>
                </div>
                <button onClick={() => setShowHelpModal(false)} className="mt-6 w-full bg-blue-600 text-white py-2 rounded-lg font-bold hover:bg-blue-700">Got it!</button>
              </div>
            </div>
          )}

          {/* --- CONFIRM MODAL --- */}
          {showConfirmModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6 text-center animate-fade-in-up">
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><span className="text-3xl">🚀</span></div>
                <h3 className="text-xl font-bold text-gray-800 mb-2">Launch Exam Session?</h3>
                <div className="flex gap-3 justify-center">
                  <button onClick={() => setShowConfirmModal(false)} className="px-5 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-bold">No, Wait</button>
                  <button onClick={executeLaunch} className="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-bold shadow-md">Yes, Launch!</button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="fixed inset-0 bg-white bg-opacity-95 flex flex-col items-center justify-center z-[60]">
                <div className="animate-spin rounded-full h-20 w-20 border-t-4 border-b-4 border-blue-600 mb-6"></div>
                <h2 className="text-3xl font-bold text-blue-800 mb-2 animate-pulse">{loadingText || "Processing..."}</h2>
                <p className="text-gray-500 text-lg">Please wait while we upload images and setup data.</p>
            </div>
          )}

        </div>
      </div>
    </ProtectedRoute>
  );
};

export default ExamWizard;