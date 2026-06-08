import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Cloud,
  Copy,
  Download,
  Loader2,
  MessageCircle,
  Play,
  RotateCcw,
  Settings2,
  Smartphone,
  User,
  Volume2,
} from 'lucide-react';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc, type Firestore } from 'firebase/firestore';

type SaveStatus = 'idle' | 'saving' | 'saved';

type SavedState = {
  text: string;
  selectedVoice: string;
};

class TtsRequestError extends Error {
  status: number;
  retryable: boolean;

  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = 'TtsRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

const VOICES = [
  { id: 'Leda', name: 'Leda', description: 'Clear, bright voice' },
  { id: 'Kore', name: 'Kore', description: 'Warm, natural voice' },
  { id: 'Zephyr', name: 'Zephyr', description: 'Light, energetic voice' },
  { id: 'Puck', name: 'Puck', description: 'Playful, expressive voice' },
  { id: 'Charon', name: 'Charon', description: 'Deep, steady voice' },
];

const LOCAL_STORAGE_KEY = 'listening-lab:last-state';
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
const appId = import.meta.env.VITE_APP_ID || 'listening-lab-v1';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasFirebaseConfig = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

function getFirebaseServices(): { app: FirebaseApp; db: Firestore } | null {
  if (!hasFirebaseConfig) return null;

  try {
    const app = initializeApp(firebaseConfig);
    return { app, db: getFirestore(app) };
  } catch (error) {
    console.error('Unable to initialize Firebase.', error);
    return null;
  }
}

const firebaseServices = getFirebaseServices();

function loadLocalState(): SavedState | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedState) : null;
  } catch {
    return null;
  }
}

function saveLocalState(state: SavedState) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
}

async function getGeminiErrorMessage(response: Response) {
  try {
    const data = await response.json();
    return data.error?.message || response.statusText || `Request failed with status ${response.status}`;
  } catch {
    return response.statusText || `Request failed with status ${response.status}`;
  }
}

function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [text, setText] = useState('');
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0].id);
  const [isLoading, setIsLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [playError, setPlayError] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const localState = loadLocalState();
    if (localState?.text) setText(localState.text);
    if (localState?.selectedVoice) setSelectedVoice(localState.selectedVoice);
  }, []);

  useEffect(() => {
    if (!firebaseServices) return undefined;

    const auth = getAuth(firebaseServices.app);
    signInAnonymously(auth).catch((error) => {
      console.error('Anonymous sign-in failed.', error);
    });

    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
  }, []);

  useEffect(() => {
    if (!firebaseServices || !user) return;

    const loadUserData = async () => {
      try {
        const docRef = doc(firebaseServices.db, 'artifacts', appId, 'users', user.uid, 'settings', 'lastState');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data() as Partial<SavedState>;
          if (data.text) setText(data.text);
          if (data.selectedVoice) setSelectedVoice(data.selectedVoice);
        }
      } catch (error) {
        console.error('Unable to load cloud state.', error);
      }
    };

    loadUserData();
  }, [user]);

  useEffect(() => {
    if (!text && selectedVoice === VOICES[0].id) return undefined;

    setSaveStatus('saving');
    const saveTimeout = window.setTimeout(async () => {
      const state = { text, selectedVoice };
      saveLocalState(state);

      if (firebaseServices && user) {
        try {
          const docRef = doc(firebaseServices.db, 'artifacts', appId, 'users', user.uid, 'settings', 'lastState');
          await setDoc(docRef, { ...state, updatedAt: new Date().toISOString() }, { merge: true });
        } catch (error) {
          console.error('Unable to save cloud state.', error);
        }
      }

      setSaveStatus('saved');
      window.setTimeout(() => setSaveStatus('idle'), 2500);
    }, 800);

    return () => window.clearTimeout(saveTimeout);
  }, [text, selectedVoice, user]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const pcmToWav = (pcmData: Int16Array, sampleRate = 24000) => {
    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 32 + pcmData.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, pcmData.length * 2, true);

    for (let i = 0; i < pcmData.length; i += 1) {
      view.setInt16(44 + i * 2, pcmData[i], true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  };

  const attemptPlay = async () => {
    if (!audioRef.current) return;

    try {
      setPlayError(false);
      audioRef.current.load();
      await audioRef.current.play();
    } catch {
      setPlayError(true);
    }
  };

  const fetchAudio = async (retryCount = 0) => {
    if (!text.trim() || isLoading) return;

    if (!apiKey) {
      setTtsError('Missing Gemini API key. Add VITE_GEMINI_API_KEY in GitHub Secrets or your local .env file.');
      return;
    }

    setIsLoading(true);
    setTtsError(null);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: selectedVoice },
                },
              },
            },
          }),
        },
      );

      if (!response.ok) {
        const details = await getGeminiErrorMessage(response);

        if (response.status === 429) {
          throw new TtsRequestError(
            response.status,
            `Gemini TTS quota or rate limit was reached. ${details}`,
            false,
          );
        }

        if (response.status >= 500) {
          throw new TtsRequestError(response.status, `Gemini service error ${response.status}. ${details}`, true);
        }

        throw new TtsRequestError(response.status, `Gemini request error ${response.status}. ${details}`, false);
      }

      const data = await response.json();
      const base64Audio = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error('The TTS response did not include audio data.');

      const binaryString = atob(base64Audio);
      const pcmData = new Int16Array(binaryString.length / 2);

      for (let i = 0; i < binaryString.length; i += 2) {
        pcmData[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
      }

      const wavBlob = pcmToWav(pcmData);
      const url = URL.createObjectURL(wavBlob);
      setAudioUrl((currentUrl) => {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        return url;
      });
      window.setTimeout(() => attemptPlay(), 100);
    } catch (error) {
      const shouldRetry = error instanceof TtsRequestError ? error.retryable : true;

      if (shouldRetry && retryCount < 3) {
        window.setTimeout(() => fetchAudio(retryCount + 1), 1000 * 2 ** retryCount);
        return;
      }

      setTtsError(error instanceof Error ? error.message : 'Unable to generate audio.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = () => {
    if (!audioUrl) return;

    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `listening_lab_${Date.now()}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCopy = async () => {
    if (!text) return;

    await navigator.clipboard.writeText(text);
    setSaveStatus('saved');
    window.setTimeout(() => setSaveStatus('idle'), 2000);
  };

  const handleReplay = () => {
    if (!audioRef.current) return;

    setPlayError(false);
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(() => setPlayError(true));
  };

  const isCloudActive = Boolean(firebaseServices && user);

  return (
    <div className="safe-area-inset min-h-screen bg-[#F8FAFC] text-slate-800">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:py-10">
        <header className="flex items-center justify-between rounded-3xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-indigo-600 p-2.5 text-white">
              <Volume2 size={24} />
            </div>
            <div>
              <h1 className="text-xl font-black leading-none text-slate-900">Listening Lab</h1>
              <div className="mt-1.5 flex items-center gap-2">
                <div className={`h-1.5 w-1.5 rounded-full ${isCloudActive ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  {isCloudActive ? 'Cloud Active' : 'Local Save'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center">
              {saveStatus === 'saving' && <Loader2 size={18} className="animate-spin text-indigo-400" />}
              {saveStatus === 'saved' && <Check size={18} className="text-emerald-500" />}
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-100 bg-slate-50 text-slate-400">
              <User size={20} />
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <main className="space-y-6 lg:col-span-2">
            <section className="space-y-5 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <div className="flex items-center justify-between">
                <label htmlFor="tts-text" className="flex items-center gap-2.5 text-sm font-bold text-slate-700">
                  <MessageCircle size={20} className="text-indigo-500" />
                  Text to speech
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleCopy}
                    disabled={!text}
                    className="p-2 text-slate-400 transition-colors hover:text-indigo-600 disabled:opacity-20"
                    title="Copy text"
                  >
                    <Copy size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setText('')}
                    className="rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-400 transition-colors hover:text-red-500"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <textarea
                id="tts-text"
                className="h-72 w-full resize-none rounded-[1.5rem] border-none bg-slate-50/50 p-6 text-xl font-medium leading-relaxed outline-none transition-all focus:bg-white focus:ring-4 focus:ring-indigo-500/10"
                placeholder="Paste or type text here, then generate listening audio."
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </section>

            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                <button
                  type="button"
                  onClick={() => fetchAudio()}
                  disabled={isLoading || !text.trim()}
                  className="flex flex-[2] items-center justify-center gap-3 rounded-[2rem] bg-indigo-600 px-6 py-6 font-black text-white shadow-xl shadow-indigo-100 transition-all hover:bg-indigo-700 active:scale-95 disabled:bg-slate-200"
                >
                  {isLoading ? <Loader2 className="animate-spin" /> : <Play size={28} fill="currentColor" />}
                  <span className="text-lg">{audioUrl ? 'Generate Again' : 'Generate Audio'}</span>
                </button>

                <div className="flex flex-1 gap-4">
                  <button
                    type="button"
                    onClick={handleReplay}
                    disabled={!audioUrl}
                    className={`flex flex-1 items-center justify-center rounded-[2rem] border-2 bg-white font-black transition-all active:scale-95 ${
                      audioUrl
                        ? 'border-indigo-100 text-indigo-600 shadow-sm hover:bg-indigo-50'
                        : 'border-slate-100 text-slate-200'
                    }`}
                    title="Replay"
                  >
                    <RotateCcw size={28} />
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={!audioUrl}
                    className={`flex flex-1 items-center justify-center rounded-[2rem] border-2 bg-white font-black transition-all active:scale-95 ${
                      audioUrl
                        ? 'border-indigo-100 text-indigo-600 shadow-sm hover:bg-indigo-50'
                        : 'border-slate-100 text-slate-200'
                    }`}
                    title="Download audio"
                  >
                    <Download size={28} />
                  </button>
                </div>
              </div>

              {(playError || ttsError) && (
                <div className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-amber-700">
                  <AlertCircle size={20} className="shrink-0" />
                  <p className="text-xs font-bold leading-tight">
                    {ttsError ||
                      'The browser blocked automatic playback. Tap replay once after the audio is generated.'}
                  </p>
                </div>
              )}
            </section>
          </main>

          <aside className="space-y-6">
            <section className="space-y-5 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 px-1 font-black uppercase italic tracking-wider text-slate-800">
                <Settings2 size={18} className="text-indigo-500" />
                Select Voice
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                {VOICES.map((voice) => (
                  <button
                    type="button"
                    key={voice.id}
                    onClick={() => setSelectedVoice(voice.id)}
                    className={`flex flex-col rounded-2xl border-2 p-5 text-left transition-all duration-300 ${
                      selectedVoice === voice.id
                        ? 'border-indigo-500 bg-indigo-50/30 ring-4 ring-indigo-500/5'
                        : 'border-slate-50 bg-slate-50/30 hover:border-slate-200'
                    }`}
                  >
                    <span className="font-black text-slate-900">{voice.name}</span>
                    <span className="mt-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {voice.description}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="relative overflow-hidden rounded-[2rem] bg-slate-900 p-8 text-white shadow-2xl">
              <div className="absolute right-0 top-0 p-4 opacity-10">
                <Smartphone size={100} />
              </div>
              <h2 className="mb-4 flex items-center gap-3 text-lg font-black">
                <Cloud size={20} className="text-indigo-400" />
                Save Mode
              </h2>
              <p className="text-xs font-medium leading-relaxed text-slate-400">
                Your latest text and selected voice are saved locally in this browser. Add Firebase environment
                variables if you want cross-device cloud sync.
              </p>
            </section>
          </aside>
        </div>

        <audio ref={audioRef} src={audioUrl ?? undefined} preload="auto" />
      </div>
    </div>
  );
}

export default App;
