import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  db, auth, googleProvider, signInWithPopup, onAuthStateChanged, User,
  collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, Timestamp, writeBatch, getDocFromServer, where, getDocs, limit,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from './firebase';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, ThumbsUp, Trash2, Eye, EyeOff, LogIn, LogOut,
  AlertCircle, CheckCircle2, Loader2, Presentation, X,
  Plus, Users, ArrowLeft, LogIn as JoinIcon
} from 'lucide-react';
import { cn } from './lib/utils';
import { nanoid } from 'nanoid';

// --- Constants ---
const SESSION_TIMEOUT_MS = 5 * 60 * 60 * 1000; // 5 hours

// --- Types ---
interface Question {
  id: string;
  text: string;
  upvotes: number;
  createdAt: Timestamp;
  isSelected: boolean;
  authorId: string;
  classroomId: string;
}

interface Classroom {
  id: string;
  roomCode: string;
  instructorId: string;
  createdAt: Timestamp;
  isActive: boolean;
}

// --- Socket Initialization ---
const socket: Socket = io();

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [isInstructor, setIsInstructor] = useState(false);
  const [showPresentation, setShowPresentation] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // Classroom State
  const [currentClassroom, setCurrentClassroom] = useState<Classroom | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  // Auth Extras
  const [rememberMe, setRememberMe] = useState(false);

  // --- Inactivity Tracking ---
  const updateActivity = useCallback(() => {
    const isRemembered = localStorage.getItem('anonclass_remember') === 'true';
    if (!isRemembered && auth.currentUser) {
      localStorage.setItem('anonclass_lastActive', Date.now().toString());
    }
  }, []);

  useEffect(() => {
    // Listen for activity
    window.addEventListener('mousedown', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('scroll', updateActivity);
    window.addEventListener('touchstart', updateActivity);

    return () => {
      window.removeEventListener('mousedown', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('scroll', updateActivity);
      window.removeEventListener('touchstart', updateActivity);
    };
  }, [updateActivity]);

  // --- Auth & Initial Setup ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        // Check timeout if not remembered
        const isRemembered = localStorage.getItem('anonclass_remember') === 'true';
        if (!isRemembered) {
          const lastActive = parseInt(localStorage.getItem('anonclass_lastActive') || '0');
          const now = Date.now();
          if (!lastActive || now - lastActive > SESSION_TIMEOUT_MS) {
            handleLogout();
            setAuthReady(true);
            return;
          }
          // Update activity on successful load/refresh
          localStorage.setItem('anonclass_lastActive', now.toString());
        }
      }

      setUser(u);
      setAuthReady(true);
      if (u?.email === "6831503045@lamduan.mfu.ac.th") {
        setIsInstructor(true);
      } else {
        setIsInstructor(false);
      }
    });

    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Firebase connection error: Client is offline.");
        }
      }
    };
    testConnection();

    return () => unsubscribe();
  }, []);

  // --- Real-time Questions (Filtered by Classroom) ---
  useEffect(() => {
    if (!authReady || !currentClassroom) {
      setQuestions([]);
      return;
    }

    const q = query(
      collection(db, 'questions'),
      where('classroomId', '==', currentClassroom.id),
      orderBy('upvotes', 'desc'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const qs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Question));
      setQuestions(qs);
    }, (error) => {
      console.error("Firestore Error:", error);
    });

    return () => unsubscribe();
  }, [authReady, currentClassroom]);

  // --- Socket Updates ---
  useEffect(() => {
    socket.on("selection_update", (id: string | null) => {
      setSelectedQuestionId(id);
    });
    return () => {
      socket.off("selection_update");
    };
  }, []);

  // --- Actions ---
  const handleLogin = async () => {
    try {
      // Set persistence based on Remember Me
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);

      if (rememberMe) {
        localStorage.setItem('anonclass_remember', 'true');
        localStorage.removeItem('anonclass_lastActive');
      } else {
        localStorage.setItem('anonclass_remember', 'false');
        localStorage.setItem('anonclass_lastActive', Date.now().toString());
      }

      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => {
    auth.signOut();
    setCurrentClassroom(null);
    localStorage.removeItem('anonclass_remember');
    localStorage.removeItem('anonclass_lastActive');
  };

  const handleCreateClassroom = async () => {
    if (!user || !isInstructor) return;
    setIsCreating(true);
    setError(null);

    try {
      const roomCode = nanoid(6).toUpperCase();
      const classroomId = nanoid();
      const classroomRef = doc(db, 'classrooms', classroomId);

      const newClassroom = {
        id: classroomId,
        roomCode,
        instructorId: user.uid,
        createdAt: Timestamp.now(),
        isActive: true
      };

      await setDoc(classroomRef, newClassroom);
      setCurrentClassroom(newClassroom);
    } catch (err) {
      console.error("Failed to create classroom:", err);
      setError("Failed to create classroom. Please try again.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinClassroom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;

    setIsJoining(true);
    setError(null);

    try {
      const q = query(
        collection(db, 'classrooms'),
        where('roomCode', '==', joinCode.trim().toUpperCase()),
        where('isActive', '==', true),
        limit(1)
      );

      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        setError("Invalid room code or classroom is no longer active.");
        setIsJoining(false);
        return;
      }

      const classroomData = snapshot.docs[0].data() as Classroom;
      setCurrentClassroom({ ...classroomData, id: snapshot.docs[0].id });
    } catch (err) {
      console.error("Failed to join classroom:", err);
      setError("An error occurred while joining. Please try again.");
    } finally {
      setIsJoining(false);
    }
  };

  const handleUpvote = async (questionId: string) => {
    if (!user || isInstructor || !currentClassroom) return;
    const voteId = `${user.uid}_${questionId}`;
    const voteRef = doc(db, 'votes', voteId);
    const questionRef = doc(db, 'questions', questionId);

    try {
      const batch = writeBatch(db);
      batch.set(voteRef, { userId: user.uid, questionId, classroomId: currentClassroom.id });
      batch.update(questionRef, { upvotes: questions.find(q => q.id === questionId)!.upvotes + 1 });
      await batch.commit();
    } catch (error) {
      console.error("Upvote failed:", error);
    }
  };

  const handleSelectQuestion = (id: string | null) => {
    if (!isInstructor) return;
    socket.emit("select_question", id);
    if (id) {
      updateDoc(doc(db, 'questions', id), { isSelected: true });
    }
  };

  const selectedQuestion = useMemo(() =>
    questions.find(q => q.id === selectedQuestionId),
    [questions, selectedQuestionId]
  );

  if (!authReady) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-neutral-200">
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b border-neutral-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setCurrentClassroom(null)}>
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center text-white font-bold">A</div>
            <h1 className="text-xl font-semibold tracking-tight">AnonClass</h1>
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium leading-none">{user.displayName}</p>
                  <p className="text-xs text-neutral-500">{isInstructor ? 'Instructor' : 'Student'}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="p-2 hover:bg-neutral-100 rounded-full transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5 text-neutral-600" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                  />
                  <span className="text-xs text-neutral-500 group-hover:text-neutral-700 transition-colors">Remember Me</span>
                </label>
                <button
                  onClick={handleLogin}
                  className="flex items-center gap-2 bg-neutral-900 text-white px-4 py-2 rounded-full text-sm font-medium hover:bg-neutral-800 transition-all active:scale-95"
                >
                  <LogIn className="w-4 h-4" />
                  Sign In
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {!currentClassroom ? (
          <div className="max-w-md mx-auto space-y-8 py-12">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold tracking-tight">Welcome to AnonClass</h2>
              <p className="text-neutral-500">Join a classroom or create a new session.</p>
            </div>

            {user ? (
              <div className="space-y-6">
                {/* Join Classroom */}
                <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="flex items-center gap-2 text-neutral-700">
                    <JoinIcon className="w-5 h-5" />
                    <h3 className="font-semibold">Join a Classroom</h3>
                  </div>
                  <form onSubmit={handleJoinClassroom} className="space-y-3">
                    <input
                      type="text"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      placeholder="Enter Room Code (e.g. AB12CD)"
                      className="w-full p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none transition-all font-mono text-center text-lg tracking-widest"
                      maxLength={6}
                    />
                    {error && (
                      <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-xs font-medium">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                      </div>
                    )}
                    <button
                      type="submit"
                      disabled={isJoining || joinCode.length < 4}
                      className="w-full bg-neutral-900 text-white py-3 rounded-xl font-medium hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 transition-all flex items-center justify-center gap-2"
                    >
                      {isJoining ? <Loader2 className="w-4 h-4 animate-spin" /> : "Join Session"}
                    </button>
                  </form>
                </div>

                {/* Create Classroom (Instructors Only) */}
                {isInstructor && (
                  <div className="bg-neutral-900 text-white rounded-2xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center gap-2">
                      <Plus className="w-5 h-5 text-neutral-400" />
                      <h3 className="font-semibold">Instructor Panel</h3>
                    </div>
                    <p className="text-sm text-neutral-400">Start a new classroom session to receive anonymous questions from your students.</p>
                    <button
                      onClick={handleCreateClassroom}
                      disabled={isCreating}
                      className="w-full bg-white text-neutral-900 py-3 rounded-xl font-medium hover:bg-neutral-100 transition-all flex items-center justify-center gap-2"
                    >
                      {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create New Classroom"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white border border-neutral-200 rounded-2xl p-8 text-center space-y-6">
                <div className="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto">
                  <Users className="w-8 h-8 text-neutral-400" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold">Sign in to get started</h3>
                  <p className="text-sm text-neutral-500">Sign in with your university account to join or create classrooms.</p>
                </div>
                <div className="space-y-4">
                  <label className="flex items-center justify-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                    />
                    <span className="text-sm text-neutral-600 group-hover:text-neutral-900 transition-colors">Remember Me</span>
                  </label>
                  <button
                    onClick={handleLogin}
                    className="w-full bg-neutral-900 text-white py-4 rounded-xl font-medium hover:bg-neutral-800 transition-all shadow-lg shadow-neutral-200"
                  >
                    Sign In with Google
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Classroom Info & Submission */}
            <div className="lg:col-span-4 space-y-6">
              <div className="bg-white border border-neutral-200 rounded-2xl p-6 space-y-6 shadow-sm">
                <button
                  onClick={() => setCurrentClassroom(null)}
                  className="flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Leave Classroom
                </button>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-400">Room Code</span>
                    <h2 className="text-4xl font-black tracking-tighter text-neutral-900">{currentClassroom.roomCode}</h2>
                  </div>

                  <div className="p-4 bg-neutral-50 rounded-xl flex flex-col items-center gap-2">
                    <p className="text-xs text-neutral-500 text-center">Share this code with your students to join the session.</p>
                  </div>
                </div>
              </div>

              {/* Question Submission (Students Only) */}
              {!isInstructor ? (
                <QuestionForm user={user!} classroomId={currentClassroom.id} />
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center space-y-2">
                  <AlertCircle className="w-6 h-6 text-amber-600 mx-auto" />
                  <h3 className="font-semibold text-amber-900">Instructor Mode</h3>
                  <p className="text-xs text-amber-700">You are managing this session. Instructors cannot submit questions.</p>
                </div>
              )}

              {isInstructor && (
                <div className="bg-neutral-900 text-white rounded-2xl p-6 space-y-4 shadow-xl shadow-neutral-200">
                  <div className="flex items-center gap-2">
                    <Presentation className="w-5 h-5 text-neutral-400" />
                    <h2 className="font-semibold">Instructor Controls</h2>
                  </div>
                  <p className="text-sm text-neutral-300">Select a question from the feed to display it in presentation mode.</p>
                  <button
                    onClick={() => setShowPresentation(true)}
                    disabled={!selectedQuestionId}
                    className={cn(
                      "w-full py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2",
                      selectedQuestionId
                        ? "bg-white text-neutral-900 hover:bg-neutral-100"
                        : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                    )}
                  >
                    Open Presentation Mode
                  </button>
                </div>
              )}
            </div>

            {/* Right Column: Feed */}
            <div className="lg:col-span-8 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight">Question Feed</h2>
                <div className="text-sm text-neutral-500 bg-neutral-100 px-3 py-1 rounded-full">
                  {questions.length} Questions
                </div>
              </div>

              <div className="space-y-4">
                <AnimatePresence mode="popLayout">
                  {questions.map((q) => (
                    <QuestionCard
                      key={q.id}
                      question={q}
                      onUpvote={() => handleUpvote(q.id)}
                      onSelect={() => handleSelectQuestion(q.id)}
                      isSelected={selectedQuestionId === q.id}
                      isInstructor={isInstructor}
                    />
                  ))}
                </AnimatePresence>

                {questions.length === 0 && (
                  <div className="py-20 text-center space-y-2">
                    <p className="text-neutral-400 font-medium">No questions yet.</p>
                    <p className="text-sm text-neutral-500">Be the first to ask something!</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Presentation Mode Modal */}
      <AnimatePresence>
        {showPresentation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-neutral-900 flex flex-col items-center justify-center p-8 text-center"
          >
            <button
              onClick={() => setShowPresentation(false)}
              className="absolute top-8 right-8 p-3 bg-neutral-800 text-white rounded-full hover:bg-neutral-700 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="max-w-4xl w-full space-y-12">
              <div className="space-y-4">
                <span className="text-neutral-500 font-mono tracking-widest uppercase text-sm">Now Presenting</span>
                <div className="h-1 w-24 bg-neutral-700 mx-auto rounded-full" />
              </div>

              {selectedQuestion ? (
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  key={selectedQuestion.id}
                  className="space-y-8"
                >
                  <h2 className="text-4xl sm:text-6xl font-bold text-white leading-tight">
                    "{selectedQuestion.text}"
                  </h2>
                  <div className="flex items-center justify-center gap-4 text-neutral-400">
                    <div className="flex items-center gap-2">
                      <ThumbsUp className="w-6 h-6" />
                      <span className="text-2xl font-semibold">{selectedQuestion.upvotes}</span>
                    </div>
                    <div className="w-1.5 h-1.5 bg-neutral-700 rounded-full" />
                    <span className="text-xl">Anonymous Student</span>
                  </div>
                </motion.div>
              ) : (
                <div className="text-neutral-500 text-2xl">No question selected.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Sub-components ---

function QuestionForm({ user, classroomId }: { user: User, classroomId: string }) {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError("Question cannot be empty");
      return;
    }
    if (text.length > 300) {
      setError("Question exceeds limit (300 chars)");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // AI Moderation
      const modRes = await fetch('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      if (!modRes.ok) {
        throw new Error("Moderation API failed");
      }

      const modData = await modRes.json();

      if (modData.isInappropriate) {
        setError("Your question was flagged as inappropriate.");
        setIsSubmitting(false);
        return;
      }

      const finalPath = modData.suggestedText || text;

      // Submit to Firestore
      const newQuestionRef = doc(collection(db, 'questions'));
      await setDoc(newQuestionRef, {
        text: finalPath,
        upvotes: 0,
        createdAt: Timestamp.now(),
        isSelected: false,
        authorId: user.uid,
        classroomId: classroomId
      });

      setText('');
    } catch (err) {
      console.error("Submission error:", err);
      // Fallback
      try {
        const newQuestionRef = doc(collection(db, 'questions'));
        await setDoc(newQuestionRef, {
          text: text,
          upvotes: 0,
          createdAt: Timestamp.now(),
          isSelected: false,
          authorId: user.uid,
          classroomId: classroomId
        });
        setText('');
      } catch (innerErr) {
        setError("Failed to submit question. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-neutral-200 rounded-2xl p-6 space-y-4 shadow-sm">
      <div className="space-y-2">
        <label className="text-sm font-semibold text-neutral-700">Ask Anonymously</label>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder="What's on your mind?"
          className="w-full min-h-[120px] p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none transition-all resize-none text-sm"
          maxLength={300}
        />
        <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-wider text-neutral-400">
          <span>{text.length} / 300</span>
          <span>Anonymous</span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-xs font-medium">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting || !text.trim()}
        className="w-full bg-neutral-900 text-white py-3 rounded-xl font-medium hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
      >
        {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Submit Question
      </button>
    </form>
  );
}

interface QuestionCardProps {
  key?: string | number;
  question: Question;
  onUpvote: () => void;
  onSelect: () => void;
  isSelected: boolean;
  isInstructor: boolean;
}

function QuestionCard({ question, onUpvote, onSelect, isSelected, isInstructor }: QuestionCardProps) {
  const scale = Math.min(1 + (question.upvotes * 0.05), 1.2);
  const isTop = question.upvotes >= 5;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "group relative bg-white border rounded-2xl p-6 transition-all duration-300",
        isSelected ? "border-neutral-900 ring-2 ring-neutral-900 shadow-lg" : "border-neutral-200 hover:border-neutral-300 shadow-sm",
        isTop && !isSelected && "border-amber-200 bg-amber-50/30"
      )}
      style={{ transform: `scale(${scale})`, transformOrigin: 'left center' }}
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-2">
            {isTop && (
              <span className="text-[10px] font-bold uppercase tracking-tighter bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                Trending
              </span>
            )}
            <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-widest">
              {new Date(question.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <p className={cn(
            "text-neutral-800 leading-relaxed",
            question.upvotes > 10 ? "text-xl font-semibold" : "text-base font-medium"
          )}>
            {question.text}
          </p>

          <div className="flex items-center gap-4">
            <button
              onClick={onUpvote}
              disabled={isInstructor}
              className={cn(
                "flex items-center gap-1.5 transition-colors",
                isInstructor ? "text-neutral-300 cursor-not-allowed" : "text-neutral-500 hover:text-neutral-900"
              )}
            >
              <ThumbsUp className="w-4 h-4" />
              <span className="text-sm font-bold">{question.upvotes}</span>
            </button>

            {isInstructor && (
              <button
                onClick={onSelect}
                className={cn(
                  "flex items-center gap-1.5 text-sm font-medium transition-colors",
                  isSelected ? "text-neutral-900" : "text-neutral-400 hover:text-neutral-600"
                )}
              >
                {isSelected ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                {isSelected ? 'Selected' : 'Select'}
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
