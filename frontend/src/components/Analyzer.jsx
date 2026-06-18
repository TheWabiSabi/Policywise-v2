import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { supabase } from '../supabaseClient';
import { auth } from '../authClient';
import { toast } from 'react-hot-toast';

// --- THE API BRIDGE ---
import { API_BASE } from '../config';

// --- HELPER COMPONENT: RESTORE BENEFIT CARD ---
const RestoreBenefitDetailsCard = ({ value = '', policyText = '' }) => {
  const text = `${value} ${policyText}`.toLowerCase();

  // Q1: Same illness?
  let sameIllness = 'Not Specified';
  let sameIllnessGood = null;
  if (text.includes('any illness') || text.includes('related') || text.includes('same illness')) {
    sameIllness = 'Any Illness ✓'; sameIllnessGood = true;
  } else if (text.includes('different illness') || text.includes('unrelated only') || text.includes('different disease')) {
    sameIllness = 'Diff. Illness Only'; sameIllnessGood = false;
  }

  // Q2: Same person?
  let samePerson = 'Not Specified';
  let samePersonGood = null;
  if (text.includes('same member') || text.includes('same person') || text.includes('any member') || text.includes('any person') || text.includes('floater')) {
    samePerson = 'Any Person ✓'; samePersonGood = true;
  } else if (text.includes('different member') || text.includes('different person')) {
    samePerson = 'Diff. Person Only'; samePersonGood = false;
  }

  // Q3: Unlimited or once?
  let frequency = 'Not Specified';
  let frequencyGood = null;
  if (text.includes('unlimited')) {
    frequency = 'Unlimited ✓'; frequencyGood = true;
  } else if (text.includes('once') || text.includes('1 time') || text.includes('one time')) {
    frequency = 'Once per Year'; frequencyGood = false;
  } else if (text.includes('multiple') || text.includes('twice') || text.includes('2 times') || text.includes('two times')) {
    frequency = 'Multiple Times ✓'; frequencyGood = true;
  }

  // Q4: After partial or full exhaustion?
  let trigger = 'Not Specified';
  let triggerGood = null;
  if (text.includes('partial') || text.includes('after partial')) {
    trigger = 'After Partial Use ✓'; triggerGood = true;
  } else if (text.includes('full exhaustion') || text.includes('after exhaustion') || text.includes('not on first claim') || text.includes('after the first')) {
    trigger = 'After Full Use Only'; triggerGood = null; // neutral — this is standard
  }

  const items = [
    { label: 'Same Illness?', answer: sameIllness, good: sameIllnessGood },
    { label: 'Same Person?', answer: samePerson, good: samePersonGood },
    { label: 'Frequency', answer: frequency, good: frequencyGood },
    { label: 'Activation', answer: trigger, good: triggerGood },
  ];

  // If all 4 are unresolved, the policy text is too generic to parse — show a friendly fallback
  const allUnresolved = items.every(it => it.good === null);

  return (
    <div className="mt-4 bg-gradient-to-r from-teal-50 to-indigo-50/30 rounded-xl p-4 border border-teal-100/50 shadow-sm w-full">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-teal-600 bg-teal-100 p-1 rounded-md text-xs">🔍</span>
        <h5 className="font-bold text-teal-800 text-xs uppercase tracking-widest">Restore Benefit Conditions</h5>
      </div>

      {allUnresolved ? (
        <div className="flex items-start gap-3 bg-white/60 rounded-lg p-3 border border-slate-100">
          <span className="text-base mt-0.5">📋</span>
          <div>
            <p className="text-xs font-bold text-slate-600 mb-1">Specific conditions not mentioned in the document</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              The policy document does not explicitly state the restore conditions (same illness, same person, frequency, activation). Before relying on this benefit, ask your insurer:
            </p>
            <ul className="mt-2 space-y-1">
              {['Is restore allowed for the same illness?', 'Is restore allowed for the same person?', 'Is restore unlimited or once per year?', 'Does restore activate after partial or full use?'].map((q, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px] text-slate-600 font-medium">
                  <span className="text-amber-500 text-xs">→</span> {q}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 print:grid-cols-4 gap-3">
          {items.map((it, i) => (
            <div key={i} className="bg-white/60 rounded-lg p-2.5 border border-white">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">{it.label}</p>
              <p className={`text-xs font-bold leading-tight ${it.good === true ? 'text-emerald-600' : it.good === false ? 'text-amber-600' : 'text-slate-600'}`}>
                {it.answer}
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-teal-700 mt-3 italic opacity-80 leading-relaxed">
        *Actual conditions may vary by policy terms. Always verify with your insurer before claiming.
      </p>
    </div>
  );
};

const callBackend = async (endpoint, body, isFile = false, token = null) => {
  // ensure we always have a fresh token if possible
  let activeToken = token;
  if (!activeToken) {
    const { data: { session: freshSession } } = await auth.getSession();
    activeToken = freshSession?.access_token;
  }

  const options = {
    method: 'POST',
    body: isFile ? body : JSON.stringify(body),
    headers: {}
  };

  if (!isFile) {
    options.headers['Content-Type'] = 'application/json';
  }

  if (activeToken) {
    options.headers['Authorization'] = `Bearer ${activeToken}`; // Send JWT context
  }

  const res = await fetch(`${API_BASE}${endpoint}`, options);
  if (!res.ok) {
    const errorText = await res.text();
    let detail = "Backend connection failed";
    try {
      const json = JSON.parse(errorText);
      if (json.detail) detail = json.detail;
    } catch {
      detail = errorText || detail;
    }
    throw new Error(detail);
  }
  return res.json();
};

// --- HELPER: PERSONALIZATION ---
const getTargetName = (policy) => {
  if (policy && policy.policy_holders && policy.policy_holders.length > 0 && policy.policy_holders[0].name) {
    const rawName = policy.policy_holders[0].name.split(' ')[0];
    return rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  }
  return 'You';
};

const getTargetPossessive = (policy) => {
  const name = getTargetName(policy);
  if (name === 'You' || name === 'Your') return 'Your';
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
};

// --- HELPER: SUM INSURED ANALYSIS ---
const SI_ANALYSIS_DATA = [
  {
    max: 10,
    status: "❌ Very Low Coverage",
    range_desc: (policy) => `${getTargetPossessive(policy)} coverage is under ₹10 Lakhs.`,
    reality: (policy) => {
      const isFamily = policy.policy_holders && policy.policy_holders.length > 1;
      const who = isFamily ? "your family" : "an individual";
      return [
        `The current sum insured is significantly below recommended market standards for ${who}. A single critical hospitalization (e.g., Cardiac or Neuro) often exceeds ₹8 Lakhs, resulting in potential out-of-pocket expenses.`,
        "With medical inflation at ~15% annually, the purchasing power of this coverage diminishes rapidly, potentially leaving you underinsured within 3 years.",
        "Advisory: This level of coverage exposes your financial portfolio to significant risk in the event of a major medical emergency."
      ];
    },
    color: "rose"
  },
  {
    max: 25,
    status: "⚠️ Basic to Moderate Coverage",
    range_desc: (policy) => `${getTargetPossessive(policy)} coverage is between ₹10 Lakhs - ₹25 Lakhs.`,
    reality: (policy) => {
      const isFamily = policy.policy_holders && policy.policy_holders.length > 1;
      const familySize = policy.policy_holders?.length || 1;

      if (isFamily) {
        return [
          `While this provides a basic safety net, it may be insufficient for a family of ${familySize}. Concurrent hospitalizations could exhaust the entire sum insured.`,
          "Coverage may be limited for advanced medical procedures such as Immunotherapy (₹20L+) or Robotic Surgeries, which are becoming standard care.",
          "For premium hospital admissions, the room rent eligibility associated with this sum insured may impose restrictions, leading to proportionate deductions."
        ];
      } else {
        return [
          "Provides a foundational safety net for an individual but may not fully cover high-cost critical illnesses or prolonged hospitalization.",
          "Coverage may be limited for advanced medical procedures such as Immunotherapy (₹20L+) or Robotic Surgeries, which are becoming standard care.",
          "For premium hospital admissions, the room rent eligibility associated with this sum insured may impose restrictions, leading to proportionate deductions."
        ];
      }
    },
    color: "amber"
  },
  {
    max: 50,
    status: "✅ Ideal & Recommended Coverage",
    range_desc: (policy) => `${getTargetPossessive(policy)} coverage is between ₹25 Lakhs - ₹50 Lakhs.`,
    reality: (policy) => {
      const isFamily = policy.policy_holders && policy.policy_holders.length > 1;
      const who = isFamily ? "your family" : "you";
      return [
        `This tier offers comprehensive financial protection for ${who}, ensuring access to approximately 95% of network hospitals without significant deductions.`,
        "The coverage is well-calibrated to handle high-cost procedures, including Organ Transplants and Cardiac surgeries.",
        "Your financial liability is minimized. Recommendation: Focus on optimizing 'Wellness Benefits' and 'OPD coverage' to enhance this portfolio."
      ];
    },
    color: "emerald"
  },
  {
    max: 9999, // > 50L
    status: "⭐ Optimal / Future-Ready Coverage",
    range_desc: (policy) => `${getTargetPossessive(policy)} coverage is above ₹50 Lakhs.`,
    reality: (policy) => {
      const isFamily = policy.policy_holders && policy.policy_holders.length > 1;
      const subject = isFamily ? "your family" : "you";
      return [
        `This is a premier tier of coverage, effectively future-proofing ${subject} against medical inflation for the next decade.`,
        "Ensures access to advanced global treatments (subject to policy terms) and premium hospital accommodations.",
        "Provides robust financial security, ensuring that long-term critical care or multiple claims do not impact your wealth preservation goals."
      ];
    },
    color: "purple"
  }
];

// --- HELPER: Compute the EFFECTIVE sum insured (Base + Bonuses - Deductibles) ---
// This is the single source of truth for what the policyholder actually gets.
const getEffectiveSITotal = (policy) => {
  const components = policy?.sum_insured?.components || [];
  let additiveTotal = 0;
  let subtractiveTotal = 0;
  let hasComponents = false;

  for (const comp of components) {
    if (!comp.value || !comp.label) continue;
    const val = parseFloat(comp.value.replace(/[^0-9.]/g, '')) || 0;
    const label = comp.label.toLowerCase();

    if (val > 0) {
      hasComponents = true;
      if (label.includes('deductible') || label.includes('co-pay')) {
        subtractiveTotal += val;
      } else {
        additiveTotal += val;
      }
    }
  }

  if (hasComponents) {
    const finalDynamicTotal = additiveTotal - subtractiveTotal;
    if (finalDynamicTotal > 0) {
      return finalDynamicTotal; // Returns raw number (e.g. 4500000)
    }
  }

  // Fallback: parse the raw total string
  const raw = String(policy?.sum_insured?.total || '0').replace(/,/g, '');
  return parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
};

const getSumInsuredAnalysis = (amountStr) => {
  if (!amountStr) return null;
  // Parse amount string (e.g. "5L", "500000", "1 Cr", "1.5 Crore") into Lakhs
  let lakhs = 0;
  const lower = amountStr.toString().toLowerCase().replace(/,/g, '').trim();

  try {
    if (lower.includes('cr')) {
      const num = parseFloat(lower.replace(/[^0-9.]/g, ''));
      lakhs = num * 100;
    } else if (lower.includes('l') || lower.includes('lakh')) {
      const num = parseFloat(lower.replace(/[^0-9.]/g, ''));
      lakhs = num; // It's already in lakhs
    } else {
      // Assume raw number
      const num = parseFloat(lower.replace(/[^0-9.]/g, ''));
      if (num < 1000) lakhs = num; // Assume lakhs if small number? No, risky. 
      // Safest to assume raw rupees if > 1000
      else lakhs = num / 100000;
    }
  } catch { return null; }

  // Find range
  return SI_ANALYSIS_DATA.find(d => lakhs < d.max) || SI_ANALYSIS_DATA[SI_ANALYSIS_DATA.length - 1];
};

// --- HELPER: SENIOR CITIZEN LOGIC ---
const hasSeniorCitizen = (policy) => {
  if (!policy || !policy.policy_holders) return false;
  return policy.policy_holders.some(p => {
    const ageNum = parseInt(String(p.age || '0').replace(/[^0-9]/g, ''));
    return ageNum > 55;
  });
};

const hasExtractedPolicyData = (policy) => {
  if (!policy) return false;
  return Boolean(
    policy.company ||
    policy.plan ||
    policy.premium ||
    policy.coverage ||
    policy.city ||
    policy.pincode ||
    policy.policy_details?.start_date ||
    policy.sum_insured?.total ||
    policy.sum_insured?.components?.length ||
    policy.policy_holders?.length ||
    Object.keys(policy.features_found || {}).length ||
    Object.keys(policy.waiting_period_status || {}).length
  );
};

// --- ANALYSIS STAGE CONFIG ---
const ANALYSIS_STAGES = [
  {
    id: 'upload',
    label: 'Document Received',
    sublabel: 'Your policy file has been uploaded securely',
    icon: '📄',
    matchPhase: ['Uploading document...', 'Reading document...'],
  },
  {
    id: 'extract',
    label: 'Extracting Policy Data',
    sublabel: 'AI is reading and parsing your policy details',
    icon: '🔍',
    matchPhase: ['Reading document...'],
  },
  {
    id: 'analyse',
    label: 'Running AI Analysis',
    sublabel: 'Comparing coverage, features & benefits in parallel',
    icon: '🧠',
    matchPhase: ['Starting analysis...', 'Running AI analysis (Pass 1 & 2 in parallel)...'],
  },
  {
    id: 'report',
    label: 'Generating Report',
    sublabel: 'Compiling your personalised policy insights',
    icon: '📊',
    matchPhase: ['Generating analysis report...'],
  },
  {
    id: 'done',
    label: 'Analysis Complete',
    sublabel: 'Your detailed report is ready',
    icon: '✅',
    matchPhase: ['Done'],
  },
];

const getActiveStageIndex = (phase, isExtracting, isComparing) => {
  if (!phase) {
    if (isExtracting) return 0;
    if (isComparing) return 2;
    return -1;
  }
  for (let i = ANALYSIS_STAGES.length - 1; i >= 0; i--) {
    if (ANALYSIS_STAGES[i].matchPhase.some(p => phase.toLowerCase().includes(p.toLowerCase().slice(0, 10)))) {
      return i;
    }
  }
  return isExtracting ? 1 : isComparing ? 2 : -1;
};

// --- THE MAIN APP ---
export default function Analyzer({ session, fullName }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const analysisId = searchParams.get('id'); // Load historic analysis

  // avatar logic
  const getInitials = () => {
    if (fullName) return fullName[0].toUpperCase();
    return session?.user?.email?.[0].toUpperCase() || '?';
  };

  const dispName = fullName || session?.user?.email;

  const [policy, setPolicy] = useState({ company: '', premium: '' });
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState({ extracting: false, comparing: false });
  const [jobPhase, setJobPhase] = useState(''); // Live progress message from backend job
  const [comparingItem, setComparingItem] = useState(null);
  const [showChat, setShowChat] = useState(false);

  // [NEW] Chat State
  const defaultWelcome = {
    role: 'ai',
    text: `Hello${fullName ? ' ' + fullName.split(' ')[0] : ''}! I am PolicyWise, your AI health insurance advisor. How can I help you today with your policy analysis or health coverage questions?`
  };
  const [chatMessages, setChatMessages] = useState([defaultWelcome]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [savedChats, setSavedChats] = useState([]); // [NEW]
  const [activeChatId, setActiveChatId] = useState('historic'); // Track current active sidebar chat
  const [editingChatId, setEditingChatId] = useState(null); // [PHASE 20] Edit UI state
  const [editTitleValue, setEditTitleValue] = useState(""); // [PHASE 20] Title text state
  const [isReadOnly, setIsReadOnly] = useState(false); // [PHASE 21] Read-only mode for admins
  const [expandedCategories, setExpandedCategories] = useState({}); // Accordion state for feature analysis
  const chatEndRef = useRef(null);

  const fileRef = useRef();
  const extractedDetailsRef = useRef(null);
  const reportSectionRef = useRef(null);
  const hasExtractedPolicy = hasExtractedPolicyData(policy);

  // Handle loading existing historic analysis from Supabase
  useEffect(() => {
    if (analysisId && session) {
      loadHistoricAnalysis(analysisId);
    }
  }, [analysisId, session]);

  const loadHistoricAnalysis = async (id) => {
    try {
      setLoading({ extracting: true, comparing: true });
      const { data, error } = await supabase
        .from('policy_analyses')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (data) {
        setPolicy(data.extracted_data);
        setReport(data.report_data);

        // [PHASE 21] If the logged-in user is NOT the owner of the analysis, enforce Read-Only mode
        // Note: New analyses won't have data.user_id yet locally, so they are not read-only
        if (data.user_id && session?.user?.id && data.user_id !== session.user.id) {
          setIsReadOnly(true);
        } else {
          setIsReadOnly(false);
        }

        // [NEW] Load ALL chats for this analysis (allowing multiple sidebar entries)
        // [FIX] Shifted from supabase-js to backend API to bypass RLS for Admins viewing User chats
        try {
          // Since callBackend defaults to POST and we only have a GET endpoint, 
          // let's fetch it manually with auth token or adjust callBackend params.
          const { data: { session: freshSession } } = await auth.getSession();
          const token = freshSession?.access_token;

          const chatRes = await fetch(`${API_BASE}/chats/${id}`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });

          if (!chatRes.ok) throw new Error("Failed to fetch chats");
          const chatListData = await chatRes.json();

          if (chatListData && chatListData.length > 0) {
            // The most recent chat becomes the 'Main' view
            const primaryChat = chatListData[0];
            setChatMessages(primaryChat.chat_history || [defaultWelcome]);
            setActiveChatId('historic');

            // Populate the sidebar with all analysis-linked chats
            const formattedHistoric = chatListData.map((c, idx) => ({
              id: idx === 0 ? 'historic' : c.id,
              db_id: c.id,
              title: c.title || "Analysis Conversation",
              messages: c.chat_history || [defaultWelcome]
            }));

            setSavedChats(prev => {
              const existingIds = prev.map(p => p.db_id);
              const newOnes = formattedHistoric.filter(f => !existingIds.includes(f.db_id));
              return [...prev, ...newOnes];
            });
          }
        } catch (chatErr) {
          console.error("Failed to load chats for analysis:", chatErr);
        }
        // Generic chats are no longer loaded here, they are loaded in a separate top-level hook.

      }
    } catch (err) {
      console.error("Failed to load history:", err);
      toast.error("Failed to load policy analysis.");
    } finally {
      setLoading({ extracting: false, comparing: false });
    }
  };

  // [NEW] Fetch standalone chats mapping to the user globally
  useEffect(() => {
    const fetchStandaloneChats = async () => {
      if (!session?.user?.id) return;

      try {
        const { data: standaloneData, error: standaloneErr } = await supabase
          .from('chats')
          .select('id, title, chat_history')
          .is('analysis_id', null)
          .eq('user_id', session.user.id)
          .order('created_at', { ascending: false });

        if (!standaloneErr && standaloneData) {
          const formattedChats = standaloneData.map(c => ({
            id: c.id,
            db_id: c.id,
            title: c.title || "New Conversation",
            messages: c.chat_history || [defaultWelcome]
          }));

          setSavedChats(prev => {
            // Merge historic and standalone without duplicates
            const existingIds = prev.map(p => p.db_id);
            const newChats = formattedChats.filter(f => !existingIds.includes(f.db_id));
            return [...prev, ...newChats];
          });
        }
      } catch (err) {
        console.error("Failed to load standalone chats:", err);
      }
    };

    fetchStandaloneChats();
  }, [session]);

  // [NEW] Scroll chat to bottom when it opens
  useEffect(() => {
    if (showChat) {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [showChat]);

  // Auto-scroll logic
  useEffect(() => {
    if (hasExtractedPolicy && extractedDetailsRef.current && !analysisId) {
      setTimeout(() => extractedDetailsRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    }
  }, [hasExtractedPolicy, analysisId]);

  useEffect(() => {
    if (report && reportSectionRef.current && !analysisId) {
      setTimeout(() => reportSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [report, analysisId]);

  // --- ASYNC JOB POLLER ---
  // Polls GET /api/job/{job_id} every 2.5s until the backend finishes the AI work.
  // This is needed because Cloudflare has a 100s hard timeout on proxied requests.
  const pollJob = async (jobId) => {
    const POLL_INTERVAL = 2500;
    const MAX_WAIT_MS = 3 * 60 * 1000; // 3 minute failsafe
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (Date.now() - started > MAX_WAIT_MS) {
          return reject(new Error('Analysis timed out after 3 minutes. Please try again.'));
        }
        try {
          const { data: { session: s } } = await auth.getSession();
          const res = await fetch(`${API_BASE}/job/${jobId}`, {
            headers: { 'Authorization': `Bearer ${s?.access_token}` }
          });
          if (!res.ok) throw new Error(`Job poll failed: ${res.statusText}`);
          const job = await res.json();
          setJobPhase(job.phase || '');
          if (job.status === 'completed') return resolve(job.result);
          if (job.status === 'failed') return reject(new Error(job.error || 'Analysis failed'));
          setTimeout(tick, POLL_INTERVAL);
        } catch (err) {
          reject(err);
        }
      };
      setTimeout(tick, POLL_INTERVAL); // First poll after 2.5s
    });
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check file size (10MB limit)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      toast.error(`File size exceeds ${(MAX_SIZE / (1024 * 1024)).toFixed(0)}MB limit. Please upload a smaller file.`);
      e.target.value = null;
      return;
    }

    setLoading({ ...loading, extracting: true });
    setJobPhase('Uploading document...');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { job_id } = await callBackend("/extract", fd, true, null);
      setJobPhase('Reading document...');
      const data = await pollJob(job_id);
      setPolicy(data);
    } catch (err) { toast.error(err.message); }
    finally { setLoading({ ...loading, extracting: false }); setJobPhase(''); }
  };

  const handleCompare = async () => {
    setLoading({ ...loading, comparing: true });
    setJobPhase('Starting analysis...');
    try {
      const { job_id } = await callBackend("/compare", policy, false, null);
      const data = await pollJob(job_id);

      // Flash the "Analysis Complete" step for 1.5s so users see all stages complete
      setJobPhase('Done');
      await new Promise(res => setTimeout(res, 1500));

      setReport(data);

      // Update URL with newly generated ID to enable persistent chat and shareable links
      if (data.db_analysis_id) {
        setSearchParams({ id: data.db_analysis_id });
      }

      // Initialize chat with a welcome message
      setChatMessages([{ role: 'ai', text: `Hello${fullName ? ' ' + fullName.split(' ')[0] : ''}! I've generated your report and saved it to your Dashboard. Do you have any specific questions about the analysis or recommendations?` }]);
    } catch (err) { toast.error(err.message); }
    finally { setLoading({ ...loading, comparing: false }); setJobPhase(''); }
  };

  // [NEW] Handle Chat Submit
  const handleSendChat = async (e) => {
    e?.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const userMsg = chatInput.trim();
    setChatInput('');
    const prevMsgs = [...chatMessages, { role: 'user', text: userMsg }];
    setChatMessages(prevMsgs);
    setChatLoading(true);

    try {
      const response = await callBackend("/chat", {
        message: userMsg,
        history: chatMessages.slice(1),
        analysis_id: analysisId || report?.db_analysis_id, // Fetch server-side to avoid Cloudflare WAF block
        chat_db_id: savedChats.find(c => c.id === activeChatId)?.db_id // Pass UUID if we have it
      }, false, null);

      const newMessages = [...prevMsgs, { role: 'ai', text: response.reply }];
      setChatMessages(newMessages);

      // [PHASE 17] Update Sidebar instantly for every message to ensure visibility
      setSavedChats(prev => {
        const existingIdx = prev.findIndex(c => c.id === activeChatId);

        const generatedTitle = prevMsgs.length === 1 ? (userMsg.length > 30 ? userMsg.substring(0, 30) + '...' : userMsg) : null;
        const newTitle = existingIdx >= 0 ?
          (prev[existingIdx].title && prev[existingIdx].title !== "New Conversation" ? prev[existingIdx].title : (response.title || generatedTitle || "New Conversation"))
          : (response.title || generatedTitle || "New Conversation");

        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            title: newTitle,
            messages: newMessages,
            db_id: response.chat_id || updated[existingIdx].db_id // Capture the UUID from backend
          };
          return updated;
        } else {
          return [{
            id: activeChatId,
            title: newTitle,
            messages: newMessages,
            db_id: response.chat_id
          }, ...prev];
        }
      });
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'ai', text: `Error: ${err.message}` }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const startNewChat = () => {
    setActiveChatId(Date.now()); // Instantiate an isolated local session
    setChatMessages([defaultWelcome]);
  };

  const loadSavedChat = (chat) => {
    setActiveChatId(chat.id);
    setChatMessages(chat.messages);
  };

  const deleteChat = async (e, chatId) => {
    e.stopPropagation();

    const chatToDelete = savedChats.find(c => c.id === chatId);

    // If deleting the saved historic chat, wipe it from the database completely
    if (chatId === 'historic' && (analysisId || report?.db_analysis_id)) {
      try {
        await supabase
          .from('chats')
          .delete()
          .eq('analysis_id', analysisId || report?.db_analysis_id);
      } catch (err) {
        console.error("Failed to delete historic chat:", err);
      }
    } else if (typeof chatId === 'string' && chatId !== 'historic') { // If deleting a standalone chat
      try {
        await supabase
          .from('chats')
          .delete()
          .eq('id', chatId);
      } catch (err) {
        console.error("Failed to delete standalone chat:", err);
      }
    }

    // Remove from sidebar
    setSavedChats(prev => prev.filter(c => c.id !== chatId));

    // If the deleted chat was currently open, reset the window
    if (chatToDelete && chatToDelete.messages === chatMessages) {
      setChatMessages([defaultWelcome]);
    }
  };

  // [PHASE 20] Save Edited Chat Title
  const handleSaveTitle = async (chatId, e) => {
    e?.stopPropagation();
    e?.preventDefault();

    if (!editTitleValue.trim()) {
      setEditingChatId(null);
      return;
    }

    const safeTitle = editTitleValue.trim().substring(0, 50);

    // 1. Update DB if it is the historic persistent chat
    if (chatId === 'historic' && (analysisId || report?.db_analysis_id)) {
      try {
        const { error } = await supabase
          .from('chats')
          .update({ title: safeTitle })
          .eq('analysis_id', analysisId || report?.db_analysis_id);

        if (error) throw error;
      } catch (err) {
        console.error("Failed to update chat title in DB", err);
        // Fallthrough to update UI anyway for responsiveness
      }
    }

    // 2. Update Local UI State
    setSavedChats(prev => prev.map(c => c.id === chatId ? { ...c, title: safeTitle } : c));

    // Close Edit Mode
    setEditingChatId(null);
  };

  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const handleSignOut = async () => {
    await auth.signOut();
    localStorage.clear();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 text-slate-900 font-sans">
      <header className="px-10 py-5 bg-white/80 backdrop-blur-md border-b border-indigo-100 font-bold text-xl flex items-center justify-between print:hidden sticky top-0 z-50">
        <div className="flex items-center gap-8">
          <img src="/logo3.png" alt="Share India" className="h-9 object-contain cursor-pointer" onClick={() => navigate('/dashboard')} />
          <button
            onClick={() => navigate('/dashboard')}
            className="text-sm font-black text-slate-500 hover:text-blue-600 transition flex items-center gap-2"
          >
            ← Dashboard
          </button>
        </div>

        <div className="flex items-center gap-8">
          <div className="hidden md:flex items-center gap-6 text-xs font-bold text-slate-400 uppercase tracking-widest">
            <a href="https://shareindiainsurance.com/" target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 transition">Visit Website</a>
            <div className="h-4 w-px bg-slate-200"></div>
            <div className="flex items-center gap-2 text-slate-700 normal-case tracking-normal">
              <span className="bg-emerald-100 text-emerald-600 p-1.5 rounded-lg text-[10px]">📞</span>
              <span>1800-210-2022</span>
            </div>
          </div>

          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              className="w-12 h-12 bg-white rounded-2xl border border-blue-50 shadow-sm flex items-center justify-center hover:bg-slate-50 transition active:scale-95 group"
            >
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center text-white font-black text-sm shadow-md group-hover:shadow-lg transition">
                {getInitials()}
              </div>
            </button>

            {showProfileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)}></div>
                <div className="absolute right-0 mt-4 w-64 bg-white rounded-3xl shadow-2xl border border-slate-100 p-3 z-50 animate-in fade-in zoom-in duration-200 origin-top-right">
                  <div className="px-4 py-3 mb-2 border-b border-slate-50">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Signed in as</p>
                    <p className="text-sm font-bold text-slate-700 truncate">{dispName}</p>
                  </div>

                  <button
                    onClick={() => navigate('/settings')}
                    className="w-full text-left px-4 py-2.5 rounded-xl text-slate-600 font-semibold hover:bg-slate-50 hover:text-blue-600 transition flex items-center gap-3 text-xs"
                  >
                    <span className="text-base">⚙️</span> Settings
                  </button>

                  <button
                    onClick={handleSignOut}
                    className="w-full text-left px-4 py-2.5 rounded-xl text-rose-600 font-semibold hover:bg-rose-50 transition flex items-center gap-3 text-xs"
                  >
                    <span className="text-base">🚪</span> Sign Out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className={`max-w-6xl mx-auto py-12 px-6 ${comparingItem ? 'print:hidden' : ''}`}>

        {/* [NEW] Print-Only Header */}
        <div className="hidden print:grid grid-cols-3 items-center border-b-2 border-slate-200 pb-6 mb-8">
          <div className="flex justify-start">
            <img src="/logo3.png" alt="Share India" className="h-12 object-contain" />
          </div>
          <div className="text-center">
            <h1 className="text-3xl font-black text-slate-800 mb-1">PolicyWise</h1>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Smart AI Insurance Analysis</p>
          </div>
          <div className="flex justify-end">
            <div className="text-right bg-slate-50 px-4 py-2 rounded-xl border border-slate-100 inline-block">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Support Contact</p>
              <div className="flex items-center gap-2 text-slate-800 font-black justify-end">
                <span className="text-sm">📞</span>
                <span>1800-210-2022</span>
              </div>
            </div>
          </div>
        </div>

        {/* [NEW] Centered Heading */}
        <div className="text-center mb-10 print:hidden">
          <h1 className="text-4xl font-black bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-indigo-500 mb-2 pb-1 leading-normal">PolicyWise</h1>
          <p className="text-slate-500 font-medium">Smart AI Insurance Analysis</p>
        </div>

        {/* 2. Upload Box - Only show if not loading historic */}
        {!analysisId && (!hasExtractedPolicy || loading.extracting) && (
          <div className="bg-white rounded-3xl p-10 shadow-xl border border-slate-100 max-w-3xl mx-auto print:hidden transition-all hover:shadow-2xl">

            <div className="text-center mb-8">
              <h2 className="text-3xl font-black text-slate-800 mb-2">Upload Your Policy</h2>
              <p className="text-slate-500 text-lg">AI-powered analysis & comparison in seconds.</p>
            </div>

            <div
              onClick={() => fileRef.current.click()}
              className="border-2 border-dashed border-blue-200 bg-blue-50/30 rounded-2xl p-16 text-center cursor-pointer hover:bg-blue-50 hover:border-blue-400 transition group"
            >
              <input type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" onChange={handleUpload} className="hidden" />
              <div className="text-6xl mb-6 group-hover:scale-110 transition transform duration-300">{loading.extracting ? "⏳" : "📄"}</div>

              <h3 className="text-xl font-bold text-slate-700 mb-2">
                {loading.extracting ? (jobPhase || 'Reading Document...') : 'Click to Upload Policy PDF/Image'}
              </h3>
              <p className="text-sm text-slate-400 mb-8">Supports: PDF, JPG, PNG (Max: 10MB)</p>

              <span className="bg-blue-600 text-white px-8 py-3 rounded-full font-bold shadow-lg shadow-blue-200 group-hover:shadow-blue-300 group-hover:-translate-y-1 transition inline-block">
                Browse Files
              </span>
            </div>
          </div>
        )}

        {/* 3. Extracted Data Display (Visible in Print) */}
        {hasExtractedPolicy && (
          <div id="extracted-policy-card" ref={extractedDetailsRef} className="relative bg-white rounded-3xl p-8 shadow-2xl border border-slate-100 max-w-3xl mx-auto mt-6 overflow-hidden break-inside-avoid print:shadow-none print:border-none">
            {/* Decorative top accent */}


            <div className="flex items-center gap-3 mb-6 pb-2 border-b border-slate-100">
              <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
              </div>
              <h2 className="text-lg font-black text-slate-800 uppercase tracking-wide">Extracted Policy Details</h2>
            </div>

            <div className="space-y-4 text-slate-700">
              <div className="flex justify-between items-center group hover:bg-slate-50 p-2 rounded-lg transition-colors">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Name of the Company:</span>
                <span className="text-base font-bold text-slate-900 text-right">{policy.company || "---"}</span>
              </div>

              <div className="flex justify-between items-center group hover:bg-slate-50 p-2 rounded-lg transition-colors">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Name of the Product:</span>
                <span className="text-base font-bold text-slate-900 text-right">{policy.plan || "---"}</span>
              </div>

              {policy.policy_holders && policy.policy_holders.length > 0 && (
                <div className="flex justify-between items-start group hover:bg-slate-50 p-2 rounded-lg transition-colors">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wide mt-1">Policy Holder(s):</span>
                  <div className="flex flex-col text-right">
                    {policy.policy_holders.map((person, idx) => (
                      <span key={idx} className="text-sm font-semibold text-slate-700">
                        {person.name} {person.age ? `(${person.age}yrs)` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center group hover:bg-slate-50 p-2 rounded-lg transition-colors">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Premium: </span>
                <span className="text-base font-bold text-slate-900 text-right">{policy.premium || "---"}</span>
              </div>

              <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                <div className="flex justify-between items-center mb-2 pb-2 border-b border-slate-200">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Sum Insured Details</span>
                  {/* Optional: Add info icon or badge here */}
                </div>

                <div className="flex flex-col space-y-2 w-full">
                  {/* Components List */}
                  {policy.sum_insured?.components && policy.sum_insured.components.length > 0 ? (
                    policy.sum_insured.components.map((comp, idx) => (
                      <div key={idx} className="flex justify-between items-center text-sm">
                        <span className="text-slate-600 font-medium">{comp.label}:</span>
                        <span className="font-bold text-slate-900">{comp.value}</span>
                      </div>
                    ))
                  ) : (
                    /* Fallback for old/missing data */
                    policy.sum_insured?.breakdown && (
                      <div className="text-sm text-slate-500 font-medium italic mb-2 text-right">{policy.sum_insured.breakdown}</div>
                    )
                  )}

                  {/* Total */}
                  <div className="border-t border-slate-300 pt-2 mt-2 flex justify-between items-center">
                    <span className="text-sm font-bold text-slate-700">Total Sum Insured:</span>
                    <span className="text-xl font-black text-slate-900">
                      {(() => {
                        const effective = getEffectiveSITotal(policy);
                        if (effective > 0) return effective.toLocaleString('en-IN');
                        return policy.sum_insured?.total || "---";
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* [NEW] Senior Citizen Medical History Interactivity */}
            {hasSeniorCitizen(policy) && (
              <div className="mt-8 mb-4 bg-amber-50/80 p-6 rounded-2xl border border-amber-200 shadow-sm transition-all break-inside-avoid print:hidden">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-amber-100 rounded-xl text-2xl shadow-inner">
                    👵👴
                  </div>
                  <div className="flex-1">
                    <h4 className="font-black text-amber-900 text-lg mb-1">Senior Member Detected (Age 55+)</h4>
                    <p className="text-sm font-medium text-amber-800 leading-relaxed max-w-xl">
                      Do any of the senior policyholders have a pre-existing medical history (e.g., Diabetes, Hypertension, Cardiac issues)?
                    </p>

                    <div className="flex flex-wrap gap-3 mt-5">
                      <button
                        onClick={() => setPolicy({ ...policy, has_medical_history: true })}
                        className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all shadow-sm flex items-center gap-2 ${policy.has_medical_history === true ? 'bg-amber-600 text-white shadow-amber-300 ring-2 ring-amber-400 ring-offset-1' : 'bg-white text-amber-700 border border-amber-300 hover:bg-amber-100/50'}`}
                      >
                        {policy.has_medical_history === true ? '✓' : ''} Yes, they have medical history
                      </button>
                      <button
                        onClick={() => setPolicy({ ...policy, has_medical_history: false })}
                        className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all shadow-sm flex items-center gap-2 ${policy.has_medical_history === false ? 'bg-amber-600 text-white shadow-amber-300 ring-2 ring-amber-400 ring-offset-1' : 'bg-white text-amber-700 border border-amber-300 hover:bg-amber-100/50'}`}
                      >
                        {policy.has_medical_history === false ? '✓' : ''} No medical history
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!analysisId && (
              <div className="mt-8 mb-6 print:hidden">
                {hasSeniorCitizen(policy) && policy.has_medical_history === undefined && (
                  <div className="flex items-center gap-2 mb-3 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm font-semibold animate-pulse">
                    <span>⬆️</span>
                    <span>Please answer the medical history question above to continue.</span>
                  </div>
                )}
                <button
                  onClick={handleCompare}
                  disabled={!hasExtractedPolicy || loading.comparing || (hasSeniorCitizen(policy) && policy.has_medical_history === undefined)}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-bold uppercase text-sm tracking-widest hover:from-blue-700 hover:to-indigo-700 hover:shadow-lg hover:shadow-indigo-200 transition transform hover:-translate-y-0.5 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {loading.comparing
                    ? <span className="flex items-center justify-center gap-3"><span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>GENERATING ANALYSIS REPORT...</span>
                    : 'Generate Analysis Report'
                  }
                </button>

                {/* ── ANIMATED PROGRESS PANEL ── */}
                {loading.comparing && (() => {
                  const compareStages = ANALYSIS_STAGES.filter(s => ['analyse', 'report', 'done'].includes(s.id));
                  const activeIdx = getActiveStageIndex(jobPhase, false, true);
                  // Map the global idx back to the compare-only list
                  const compareGlobalIds = ['analyse', 'report', 'done'];
                  const localActive = compareGlobalIds.findIndex(id =>
                    id === (ANALYSIS_STAGES[activeIdx]?.id)
                  );
                  return (
                    <div className="mt-5 bg-white rounded-2xl border border-indigo-100 shadow-lg overflow-hidden">
                      {/* Top shimmer bar */}
                      <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 animate-pulse" />

                      <div className="px-6 py-5">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Analysis Progress</p>

                        <div className="space-y-4">
                          {compareStages.map((stage, i) => {
                            const isDone = i < localActive;
                            const isActive = i === localActive || (localActive === -1 && i === 0);
                            const isPending = !isDone && !isActive;
                            return (
                              <div key={stage.id} className="flex items-center gap-4">
                                {/* Step icon circle */}
                                <div className={`relative flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all duration-500
                                  ${isDone ? 'bg-emerald-100 ring-2 ring-emerald-400' : ''}
                                  ${isActive ? 'bg-indigo-100 ring-2 ring-indigo-400 shadow-lg shadow-indigo-100' : ''}
                                  ${isPending ? 'bg-slate-100 opacity-40' : ''}
                                `}>
                                  {isDone ? '✅' : stage.icon}
                                  {isActive && (
                                    <span className="absolute inset-0 rounded-full ring-2 ring-indigo-400 animate-ping opacity-30" />
                                  )}
                                </div>

                                {/* Text */}
                                <div className="flex-1 min-w-0">
                                  <p className={`text-sm font-bold truncate transition-colors duration-300
                                    ${isDone ? 'text-emerald-600' : ''}
                                    ${isActive ? 'text-indigo-700' : ''}
                                    ${isPending ? 'text-slate-400' : ''}
                                  `}>{stage.label}</p>
                                  <p className={`text-xs truncate transition-opacity duration-300
                                    ${isActive ? 'text-slate-500 opacity-100' : 'opacity-0'}
                                  `}>{stage.sublabel}</p>
                                </div>

                                {/* Status badge */}
                                <div className="flex-shrink-0">
                                  {isDone && <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">Done</span>}
                                  {isActive && <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200 animate-pulse">Working…</span>}
                                  {isPending && <span className="text-xs font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full border border-slate-200">Pending</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Current action text */}
                        {jobPhase && jobPhase !== 'Done' && (
                          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center gap-2">
                            <span className="inline-block w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                            <p className="text-xs text-slate-500 font-medium italic">{jobPhase}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* SUM INSURED ANALYSIS CARD */}
        {
          policy.sum_insured?.total && report && (() => {
            // Use the EFFECTIVE total (Base - Deductibles) so the badge matches the display
            const effectiveTotal = getEffectiveSITotal(policy);
            const analysis = getSumInsuredAnalysis(effectiveTotal > 0 ? String(effectiveTotal) : policy.sum_insured.total);
            if (!analysis) return null;

            // [MODIFIED] Dynamic Color Theme
            const colorMap = {
              rose: { bg: "bg-rose-50", border: "border-rose-100", text: "text-rose-900", title: "text-rose-700", dot: "bg-rose-500", badge: "bg-rose-100 text-rose-700", icon: "🔴" },
              amber: { bg: "bg-amber-50", border: "border-amber-100", text: "text-amber-900", title: "text-amber-700", dot: "bg-amber-500", badge: "bg-amber-100 text-amber-700", icon: "⚠️" },
              emerald: { bg: "bg-emerald-50", border: "border-emerald-100", text: "text-emerald-900", title: "text-emerald-700", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700", icon: "✅" },
              purple: { bg: "bg-purple-50", border: "border-purple-100", text: "text-purple-900", title: "text-purple-700", dot: "bg-purple-500", badge: "bg-purple-100 text-purple-700", icon: "⭐" }
            };
            const theme = colorMap[analysis.color] || colorMap.blue;

            return (
              <div ref={reportSectionRef} className={`mt-8 print:mt-4 rounded-3xl border ${theme.border} bg-white shadow-xl overflow-hidden break-inside-avoid ring-1 ring-slate-900/5`}>

                {/* Header Section */}
                <div className={`${theme.bg} px-8 py-6 border-b ${theme.border}`}>
                  <div className="flex flex-col md:flex-row md:items-center print:flex-row print:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-2xl">{theme.icon}</span>
                        <h4 className={`font-black text-2xl ${theme.title} tracking-tight`}>{analysis.status.replace(/^[^\s]+ /, "")}</h4>
                      </div>
                      <p className={`text-sm font-bold uppercase tracking-wider opacity-70 ${theme.text}`}>Current Coverage Status</p>
                    </div>
                    <div className={`px-4 py-2 rounded-xl font-bold text-sm ${theme.badge} self-start md:self-center shadow-sm`}>
                      {typeof analysis.range_desc === 'function' ? analysis.range_desc(policy) : analysis.range_desc}
                    </div>
                  </div>
                </div>

                <div className="p-8">
                  {/* Reality Check */}
                  <div className="mb-8">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-lg">👁️</span>
                      <h5 className="text-sm font-black text-slate-400 uppercase tracking-widest">Coverage Insights</h5>
                    </div>

                    <ul className="space-y-4">
                      {analysis.reality(policy).map((r, i) => (
                        <li key={i} className="flex gap-4 items-start text-slate-700 font-medium leading-relaxed group">
                          <div className={`mt-2 min-w-[8px] h-[8px] rounded-full ${theme.dot} ring-2 ring-white shadow-sm group-hover:scale-125 transition-transform`}></div>
                          <span className="flex-1">{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* [NEW] FAMILY ANALYSIS SECTION */}
                  {report.family_analysis && (
                    <div className="mb-8 bg-indigo-50/50 rounded-2xl p-6 border border-indigo-100">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-xl">👨‍👩‍👧‍👦</span>
                        <h5 className="font-bold text-indigo-800 text-sm uppercase tracking-wider">Family Coverage Analysis</h5>
                      </div>

                      <div className="flex flex-col md:flex-row print:flex-row gap-6 items-start">
                        <div className="flex-1">
                          <p className="text-sm text-slate-700 font-medium leading-relaxed mb-3 print:text-xs">
                            {report.family_analysis.insight}
                          </p>
                          <div className="flex flex-wrap gap-2 mt-4 print:mt-2">
                            <span className="text-xs print:text-[10px] font-bold text-slate-500 uppercase tracking-wide mt-0.5">Composition:</span>
                            <span className="text-xs print:text-[10px] font-bold bg-white px-2 py-1 rounded border border-indigo-100 text-indigo-600 shadow-sm">
                              {report.family_analysis.status}
                            </span>
                          </div>
                        </div>

                        <div className="w-full md:w-1/3 print:w-1/3 bg-white rounded-xl p-4 border border-indigo-100 shadow-sm md:-mt-12 print:-mt-12 relative z-10 shrink-0">
                          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Key Priorities</p>
                          <ul className="space-y-2">
                            {report.family_analysis.key_priorities?.map((p, k) => (
                              <li key={k} className="flex items-center gap-2 text-sm font-bold text-slate-700">
                                <span className="text-indigo-500">★</span> {p}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Market Insight Footer - Premium Look */}
                  <div className="bg-slate-900 rounded-2xl p-6 text-white shadow-2xl relative overflow-hidden group print:break-inside-avoid print:mt-6">
                    {/* Gradient Overlay */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-600 to-purple-600 rounded-full blur-3xl opacity-20 -translate-y-1/2 translate-x-1/3 group-hover:opacity-30 transition duration-700"></div>

                    <div className="relative z-10">
                      <div className="flex items-center gap-2 mb-4 pb-4 border-b border-slate-700">
                        <span className="text-xl">💡</span>
                        <span className="font-bold text-blue-200 uppercase tracking-wider text-xs">
                          {getTargetPossessive(policy)} Local Insight: {report.location_analysis?.city || "Your City"}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-4 md:gap-6 text-sm text-slate-300 mb-6 print:grid-cols-2">
                        {report.location_analysis?.major_illnesses?.map((illness, idx) => (
                          <div key={idx}>
                            <p className="mb-0.5 text-slate-400 text-[10px] md:text-xs print:text-[10px] uppercase font-bold">{illness.illness}</p>
                            <p className="font-bold text-white text-base md:text-lg print:text-base">{illness.estimated_cost}</p>
                          </div>
                        ))}
                        {(!report.location_analysis?.major_illnesses || report.location_analysis?.major_illnesses.length === 0) && (
                          <div className="col-span-2 text-center text-slate-500 italic">
                            Local illness cost data not available.
                          </div>
                        )}
                      </div>

                      <div className="mb-4">
                        <p className="text-base text-slate-300 leading-relaxed font-medium">
                          {report.location_analysis?.insight}
                        </p>
                      </div>

                      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-emerald-400">✅</span>
                          <h5 className="font-bold text-emerald-400 text-sm uppercase tracking-wider">Analysis Verdict</h5>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed">
                          {report.location_analysis?.verdict}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()
        }


        {/* 4. Comparison Report (Only shows if result exists) */}
        {
          report && (
            <div className="mt-10 print:mt-4 animate-fade-in space-y-10 print:space-y-4" id="report-content">
              {/* Policy Analysis Section */}
              {/* Policy Analysis Section - Comprehensive Checklist */}
              <div className="max-w-4xl mx-auto print:break-before-page">

                {/* Product Score Card */}
                {report.product_score && (
                  <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-3xl p-8 text-white shadow-2xl mb-10 flex flex-col md:flex-row print:flex-row items-center justify-between gap-6 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
                    <div>
                      <h3 className="text-2xl font-black mb-1">Policy Health Score</h3>
                      <p className="text-slate-400 text-sm">Based on 30+ parameters</p>
                    </div>
                    <div className="flex items-center gap-4 relative z-10">
                      <div className="relative w-32 h-32 flex items-center justify-center">
                        <svg className="w-full h-full transform -rotate-90">
                          <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-slate-700" />
                          <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="transparent" strokeDasharray={351.86} strokeDashoffset={351.86 - (351.86 * (report.product_score / 10))} className={`${report.product_score >= 7 ? 'text-emerald-500' : report.product_score >= 5 ? 'text-amber-500' : 'text-rose-500'} transition-all duration-1000`} strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-4xl font-black">{report.product_score}</span>
                          <span className="text-xs font-bold text-slate-400 uppercase">/ 10</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <h3 className="text-2xl font-black text-slate-800 mb-6 text-center">Comprehensive Feature Analysis</h3>

                <div className="space-y-4">
                  {(() => {
                    const order = ["Non-Negotiable Benefits", "Must Have", "Good to Have", "Special Features"];
                    const groups = report.feature_analysis?.reduce((acc, item) => {
                      if (!acc[item.category]) acc[item.category] = [];
                      acc[item.category].push(item);
                      return acc;
                    }, {}) || {};

                    return order.map((cat) => {
                      if (!groups[cat]) return null;

                      const theme = {
                        "Non-Negotiable Benefits": { bg: "bg-rose-50/40", bar: "bg-rose-500", chevron: "text-rose-400", count: "bg-rose-100 text-rose-600" },
                        "Must Have": { bg: "bg-blue-50/40", bar: "bg-blue-500", chevron: "text-blue-400", count: "bg-blue-100 text-blue-600" },
                        "Good to Have": { bg: "bg-emerald-50/40", bar: "bg-emerald-500", chevron: "text-emerald-400", count: "bg-emerald-100 text-emerald-600" },
                        "Special Features": { bg: "bg-purple-50/40", bar: "bg-purple-500", chevron: "text-purple-400", count: "bg-purple-100 text-purple-600" }
                      }[cat] || { bg: "bg-slate-50", bar: "bg-slate-300", chevron: "text-slate-400", count: "bg-slate-100 text-slate-500" };

                      const isOpen = !!expandedCategories[cat];
                      const positiveCount = groups[cat].filter(i => i.status === "Positive").length;

                      return (
                        <div key={cat} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden transition-all duration-200">
                          {/* Print-only static category header */}
                          <div className={`hidden print:flex items-center gap-3 px-6 py-4 border-b border-slate-100 ${theme.bg}`}>
                            <div className={`w-1.5 h-6 rounded-full ${theme.bar} shrink-0`}></div>
                            <h4 className="font-bold text-lg text-slate-800 flex-1">{cat}</h4>
                            <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${theme.count}`}>
                              {positiveCount}/{groups[cat].length} covered
                            </span>
                          </div>

                          {/* Clickable Header — screen only */}
                          <button
                            onClick={() => setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }))}
                            className={`w-full px-6 py-4 flex items-center gap-3 ${theme.bg} hover:brightness-95 transition-all duration-200 text-left print:hidden`}
                          >
                            <div className={`w-1.5 h-6 rounded-full ${theme.bar} shrink-0`}></div>
                            <h4 className="font-bold text-lg text-slate-800 flex-1">{cat}</h4>
                            {/* Feature count badge */}
                            <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${theme.count}`}>
                              {positiveCount}/{groups[cat].length} covered
                            </span>
                            {/* Chevron */}
                            <svg
                              className={`w-5 h-5 ${theme.chevron} transition-transform duration-300 ${isOpen ? 'rotate-180' : 'rotate-0'}`}
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>

                          {/* Collapsible Feature List — always rendered so print always shows all features */}
                          <div className={`divide-y divide-slate-50 border-t border-slate-100 ${isOpen ? 'block' : 'hidden'} print:!block`}>
                            {groups[cat].map((item, idx) => (
                              <div key={idx} className="px-6 py-4 flex flex-col hover:bg-slate-50 transition-colors">
                                <div className="flex items-center justify-between">
                                  <div className="pr-4">
                                    <p className="font-bold text-slate-700 text-sm">
                                      {item.feature}
                                    </p>
                                    {item.explanation && (
                                      <p className="text-xs text-slate-400 mt-1 mb-1.5 leading-relaxed pr-2">
                                        {item.explanation}
                                      </p>
                                    )}
                                    <p className="text-xs text-slate-800 font-medium">{item.value}</p>
                                  </div>
                                  <div className="shrink-0 ml-4">
                                    {item.status === "Positive" ? (
                                      <span className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 shadow-sm text-lg" title={`Score Weight: ${item.score_weight || 'N/A'}`}>✓</span>
                                    ) : (
                                      <span className="w-8 h-8 rounded-full bg-rose-100 flex items-center justify-center text-rose-600 shadow-sm text-sm" title={`Score Weight: ${item.score_weight || 'N/A'}`}>✕</span>
                                    )}
                                  </div>
                                </div>
                                {(item.policy_text && item.policy_text !== "N/A" && item.policy_text !== "Not Explicitly Mentioned") && (
                                  <div className={`mt-3 p-3 rounded-lg border text-xs italic border-l-2 ${item.status === "Positive"
                                    ? "bg-amber-50/80 border-amber-200 text-amber-800 border-l-amber-400"
                                    : "bg-slate-100/50 border-slate-100/50 text-slate-600 border-l-slate-300"
                                    }`}>
                                    <span className={`font-bold not-italic mr-1 ${item.status === "Positive" ? "text-amber-700" : "text-slate-500"}`}>Policy Extract:</span>
                                    "{item.policy_text}"
                                  </div>
                                )}

                                {/* [NEW] Restore Benefit Specific Educational Card */}
                                {item.feature === 'Restoration Benefit' && (
                                  <RestoreBenefitDetailsCard value={item.value} policyText={item.policy_text} />
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* CURRENT POLICY STATS SECTION */}
              {report.current_policy_stats && (
                <div className="max-w-4xl mx-auto break-inside-avoid print:break-before-page print:mb-16">
                  <div className="text-center mb-6">
                    <h5 className="font-bold text-slate-500 uppercase tracking-widest text-xs">Current Insurer Performance</h5>
                    <h3 className="font-black text-2xl text-slate-800">{report.current_policy_stats.company || `${getTargetPossessive(policy)} Insurer`} Analysis</h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 print:grid-cols-3 print:gap-4">
                    {/* CSR Card */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-lg flex flex-col items-center text-center">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Claim Settlement</span>
                      <span className="text-3xl font-black text-slate-800 mb-2">{report.current_policy_stats.csr || "N/A"}</span>
                      <span className="text-xs font-bold bg-blue-50 text-blue-600 px-3 py-1 rounded-full uppercase tracking-wide">
                        Rank: {report.current_policy_stats.csr_rank || "--"}
                      </span>
                    </div>

                    {/* Solvency Card */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-lg flex flex-col items-center text-center">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Solvency Ratio</span>
                      <span className="text-3xl font-black text-slate-800 mb-2">{report.current_policy_stats.solvency !== "N/A" ? `${report.current_policy_stats.solvency}x` : "N/A"}</span>
                      <span className="text-xs font-bold bg-purple-50 text-purple-600 px-3 py-1 rounded-full uppercase tracking-wide">
                        Rank: {report.current_policy_stats.solvency_rank || "--"}
                      </span>
                    </div>

                    {/* Complaints Card */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-lg flex flex-col items-center text-center">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Complaints Resolved</span>
                      <span className="text-3xl font-black text-slate-800 mb-2">{report.current_policy_stats.complaints || "N/A"}</span>
                      <span className="text-xs font-bold bg-emerald-50 text-emerald-600 px-3 py-1 rounded-full uppercase tracking-wide">
                        Rank: {report.current_policy_stats.complaints_rank || "--"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="hidden print:block w-full h-16"></div>
              <div className="space-y-10">

                {/* --- GOOD COVERAGE VERDICT BANNER --- */}
                {report.coverage_verdict === 'good' ? (
                  <div className="relative bg-gradient-to-br from-emerald-50 via-green-50 to-teal-50 border-2 border-emerald-200 rounded-3xl p-10 text-center overflow-hidden shadow-xl">
                    {/* Decorative background circles */}
                    <div className="absolute -top-8 -right-8 w-40 h-40 bg-emerald-100 rounded-full opacity-40 pointer-events-none" />
                    <div className="absolute -bottom-6 -left-6 w-28 h-28 bg-teal-100 rounded-full opacity-40 pointer-events-none" />

                    <div className="relative z-10">
                      <div className="text-5xl mb-4 animate-bounce">🏆</div>
                      <h4 className="font-black text-2xl text-emerald-800 mb-2">
                        {getTargetPossessive(policy)} Plan Is Well-Covered!
                      </h4>
                      <p className="text-emerald-700 font-semibold text-base max-w-xl mx-auto leading-relaxed mb-6">
                        Based on our comprehensive analysis, {getTargetName(policy) === 'You' ? 'your' : `${getTargetName(policy)}'s`} current policy scores <strong>{report.product_score}/10</strong> — indicating strong, comprehensive coverage. There are no significant gaps that would warrant switching or upgrading at this time.
                      </p>

                      <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto mb-6">
                        <div className="bg-white/70 rounded-2xl p-4 border border-emerald-100 shadow-sm">
                          <div className="text-2xl font-black text-emerald-600">{report.product_score}/10</div>
                          <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Coverage Score</div>
                        </div>
                        <div className="bg-white/70 rounded-2xl p-4 border border-emerald-100 shadow-sm">
                          <div className="text-2xl font-black text-emerald-600">
                            {report.feature_analysis?.filter(f => f.status === 'Positive').length || '—'}
                          </div>
                          <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Features Covered</div>
                        </div>
                        <div className="bg-white/70 rounded-2xl p-4 border border-emerald-100 shadow-sm">
                          <div className="text-2xl font-black text-emerald-600">✓</div>
                          <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">No Action Needed</div>
                        </div>
                      </div>

                      <p className="text-sm text-emerald-600 font-medium">
                        💡 If you ever have questions about your policy benefits, use the <strong>AI Chat</strong> below.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <h4 className="font-bold text-2xl text-slate-800 ml-1 border-l-8 border-blue-600 pl-4">
                      Top Recommendations for {getTargetName(policy) === 'You' ? 'You' : getTargetName(policy)}
                    </h4>

                    {/* Flatten all recommendations into a single list to guarantee horizontal layout */}
                    {(() => {
                      const allItems = report.recommendations?.flatMap(cat => cat.items || []) || [];
                      return (
                        <div className="space-y-6 print:space-y-3">
                          {/* Use the first category name as a sub-header if available, or generic */}
                          <h5 className="font-bold text-sm uppercase tracking-wider text-slate-500 bg-slate-100 inline-block px-3 py-1 rounded-lg">
                            {report.recommendations?.[0]?.category || "Recommended Plans"}
                          </h5>

                          <div className="grid grid-cols-3 gap-6 print:gap-3">
                            {allItems.map((item, j) => (
                              <div key={j} className="bg-white p-6 rounded-2xl border border-slate-100 shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 relative overflow-hidden group flex flex-col h-full break-inside-avoid print:p-3 print:rounded-lg">
                                <div className="absolute top-0 right-0 bg-gradient-to-l from-blue-600 to-blue-500 text-white text-[10px] font-bold px-3 py-1.5 rounded-bl-xl shadow-md opacity-90 group-hover:opacity-100 transition">
                                  SHARE INDIA PARTNER
                                </div>
                                <div className="mb-4 mt-2">
                                  <h6 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{item.company}</h6>
                                  <h5 className="font-bold text-lg text-slate-900 leading-tight mb-2">{item.name}</h5>
                                  <span className="text-[10px] font-bold bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-100 uppercase tracking-wide">{item.type}</span>
                                </div>

                                {item.description && item.description.includes(';') ? (
                                  <ul className="text-sm text-slate-600 leading-relaxed mb-4 border-b border-slate-50 pb-4 print:text-xs print:mb-2 print:pb-2 list-disc pl-4 space-y-1">
                                    {item.description.replace(/^USP:\s*/i, '').split(';').map((point, k) => (
                                      point.trim() && <li key={k}>{point.trim()}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-sm text-slate-600 leading-relaxed mb-4 border-b border-slate-50 pb-4 print:text-xs print:mb-2 print:pb-2">{item.description}</p>
                                )}

                                {/* Product Score Display */}
                                {item.product_score && (
                                  <div className="flex items-center gap-2 mb-4 bg-slate-50 p-2 rounded-lg border border-slate-100 w-fit">
                                    <div className="relative w-8 h-8 flex items-center justify-center">
                                      <svg className="w-full h-full transform -rotate-90">
                                        <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="3" fill="transparent" className="text-slate-200" />
                                        <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="3" fill="transparent" strokeDasharray={87.96} strokeDashoffset={87.96 - (87.96 * (item.product_score / 10))} className={`${item.product_score >= 8 ? 'text-emerald-500' : 'text-blue-500'}`} strokeLinecap="round" />
                                      </svg>
                                      <span className="absolute text-[9px] font-bold text-slate-700">{item.product_score}</span>
                                    </div>
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">Product Score</span>
                                  </div>
                                )}

                                <div className="mt-4 mb-4 grid grid-cols-3 gap-2">
                                  <div className="bg-slate-50 p-2 rounded-xl border border-slate-100 text-center print:p-1">
                                    <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-widest text-nowrap">Claims Paid</span>
                                    <span className="block text-sm font-black text-slate-700 print:text-xs">{item.stats?.csr || "N/A"}</span>
                                    <span className="block text-[9px] font-bold text-blue-600 mt-1 uppercase tracking-wide">Rank: {item.stats?.csr_rank || "-"}</span>
                                  </div>
                                  <div className="bg-slate-50 p-2 rounded-xl border border-slate-100 text-center print:p-1">
                                    <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-widest text-nowrap">Solvency</span>
                                    <span className="block text-sm font-black text-slate-700 print:text-xs">{item.stats?.solvency || "N/A"}</span>
                                    <span className="block text-[9px] font-bold text-purple-600 mt-1 uppercase tracking-wide">Rank: {item.stats?.solvency_rank || "-"}</span>
                                  </div>
                                  <div className="bg-slate-50 p-2 rounded-xl border border-slate-100 text-center print:p-1">
                                    <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-widest text-nowrap">Complaints</span>
                                    <span className="block text-sm font-black text-slate-700 print:text-xs">{item.stats?.complaints || "N/A"}</span>
                                    <span className="block text-[9px] font-bold text-emerald-600 mt-1 uppercase tracking-wide">Rank: {item.stats?.complaints_rank || "-"}</span>
                                  </div>
                                </div>

                                <div className="mt-4 mb-6 print:mt-2 print:mb-2">
                                  <span className="text-xs font-bold text-emerald-600 block mb-2 uppercase tracking-wide">✅ BENEFITS</span>
                                  <ul className="text-sm space-y-2 text-slate-600 print:text-xs print:space-y-1">
                                    {item.benefits?.map((b, k) => <li key={k} className="leading-snug flex gap-1.5"><span className="text-emerald-500">•</span> {b}</li>)}
                                  </ul>
                                </div>

                                {/* [NEW] Compare Button */}
                                <button
                                  onClick={() => setComparingItem(item)}
                                  className="w-full mt-auto bg-white border-2 border-slate-900 text-slate-900 py-2 rounded-xl font-bold uppercase text-xs tracking-widest hover:bg-slate-900 hover:text-white transition print:py-1 print:text-[10px]"
                                >
                                  Compare
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>

              {/* Action Buttons - Bottom */}
              <div className="flex justify-center items-center gap-6 print:hidden pb-10 mt-6">
                <button
                  onClick={() => window.print()}
                  className="bg-white text-indigo-600 border-2 border-indigo-600 px-8 py-4 rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-indigo-50 transition flex items-center gap-2 shadow-lg hover:-translate-y-1 transform"
                >
                  <span className="text-xl">🖨️</span> Save as PDF / Print
                </button>
                <button
                  onClick={() => setShowChat(true)}
                  className="bg-slate-900 text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 transition flex items-center gap-3 shadow-2xl hover:-translate-y-1 transform border-2 border-slate-900"
                >
                  <span className="text-2xl">🤖</span> Ask PolicyWise AI
                </button>
              </div>

            </div>
          )
        }
      </main >

      {/* [NEW] Full Screen Chat View */}
      {showChat && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-slate-50 animate-fade-in print:hidden">
          {/* Chat Minimal Header */}
          <div className="bg-white px-8 py-4 border-b border-slate-200 flex items-center justify-between shadow-sm shrink-0">
            <div className="flex items-center gap-4">
              <img src="/logo3.png" alt="Share India" className="h-9 object-contain" />
              <span className="text-2xl font-black text-[#546afb]">| AI Advisor</span>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 hidden md:flex">
                <span className="bg-slate-100 p-2 rounded-full text-sm">📞</span>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wider font-bold">Support</p>
                  <p className="text-slate-800 font-bold text-sm">1800-210-2022</p>
                </div>
              </div>
              <div className="h-8 w-px bg-slate-200 hidden md:block"></div>
              <button
                onClick={() => setShowChat(false)}
                className="text-slate-500 hover:text-slate-800 font-bold text-sm flex items-center gap-2 transition bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg"
              >
                <span>←</span> Back to Report
              </button>
            </div>
          </div>

          {/* Chat Container */}
          <div className="flex-1 overflow-hidden p-4 md:p-8 flex justify-center items-center bg-gradient-to-br from-slate-50 to-indigo-50/50">
            <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden flex w-full max-w-6xl h-full max-h-[85vh]">

              {/* Sidebar for Chat History */}
              <div className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col hidden md:flex shrink-0">
                {!isReadOnly && (
                  <div className="p-5 border-b border-slate-200">
                    <button onClick={startNewChat} className="w-full bg-indigo-600 text-white rounded-xl py-3 font-bold text-sm hover:bg-indigo-700 transition shadow-sm flex items-center justify-center gap-2">
                      <span>+</span> New Chat
                    </button>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-widest pl-1 mb-2">Recent Chats</div>
                  {savedChats.length === 0 && <p className="text-xs text-slate-400 italic pl-1">No previous chats</p>}
                  {savedChats.map(chat => (
                    <div key={chat.id} className="relative group">
                      {editingChatId === chat.id ? (
                        <div className="flex items-center bg-white border border-indigo-400 rounded-xl p-2 pr-1 shadow-md">
                          <input
                            type="text"
                            value={editTitleValue}
                            onChange={(e) => setEditTitleValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveTitle(chat.id, e)}
                            className="flex-1 bg-transparent border-none text-sm text-slate-700 outline-none px-2"
                            autoFocus
                            placeholder="Chat Title..."
                          />
                          <button
                            onClick={(e) => handleSaveTitle(chat.id, e)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-emerald-600 hover:bg-emerald-50 transition font-bold"
                            title="Save Title"
                          >
                            ✓
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => loadSavedChat(chat)} className="w-full text-left p-3 pr-16 rounded-xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition text-sm text-slate-700 truncate">
                          <span className="text-slate-400 mr-2">💬</span> {chat.title}
                        </button>
                      )}

                      {/* Action Buttons (Only show if not editing AND not read only) */}
                      {editingChatId !== chat.id && !isReadOnly && (
                        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingChatId(chat.id);
                              setEditTitleValue(chat.title);
                            }}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition"
                            title="Edit Title"
                          >
                            ✏️
                          </button>
                          <button
                            onClick={(e) => deleteChat(e, chat.id)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition font-bold"
                            title="Delete Chat"
                          >
                            🗑️
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Main Chat Area */}
              <div className="flex-1 flex flex-col h-full bg-white relative">
                {/* Inner Header */}
                <div className="bg-slate-900 px-6 py-5 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center text-white text-2xl shadow-inner">
                      🤖
                    </div>
                    <div>
                      <h4 className="font-bold text-white text-lg leading-tight">Ask PolicyWise</h4>
                      <p className="text-slate-400 text-sm font-medium">Your AI Health Insurance Advisor</p>
                    </div>
                  </div>
                </div>

                {/* Chat Messages Area */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
                  {chatMessages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-2xl px-6 py-4 shadow-sm ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-none'}`}>
                        {msg.role === 'ai' && <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">PolicyWise AI</div>}
                        <div className="text-sm md:text-base">
                          {msg.role === 'user' ? (
                            <p>{msg.text}</p>
                          ) : (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                h1: ({ node, ...props }) => <h1 className="font-black text-2xl text-slate-900 mt-6 mb-3" {...props} />,
                                h2: ({ node, ...props }) => <h2 className="font-bold text-xl text-slate-800 mt-5 mb-2" {...props} />,
                                h3: ({ node, ...props }) => <h3 className="font-bold text-lg text-slate-800 mt-4 mb-2" {...props} />,
                                h4: ({ node, ...props }) => <h4 className="font-bold text-base text-slate-800 mt-2 mb-1" {...props} />,
                                h5: ({ node, ...props }) => <h5 className="font-bold text-sm text-slate-800 mt-1 mb-1 uppercase tracking-wide" {...props} />,
                                ul: ({ node, ...props }) => <ul className="ml-5 list-disc space-y-0.5 my-1" {...props} />,
                                ol: ({ node, ...props }) => <ol className="ml-5 list-decimal space-y-0.5 my-1" {...props} />,
                                li: ({ node, ...props }) => <li className="pl-1 mb-0.5" {...props} />,
                                p: ({ node, ...props }) => <p className="mb-1 last:mb-0 leading-normal" {...props} />,
                                a: ({ node, ...props }) => <a className="text-indigo-600 hover:text-indigo-800 underline" target="_blank" rel="noopener noreferrer" {...props} />,
                                strong: ({ node, ...props }) => <strong className="font-bold text-slate-900" {...props} />,
                                table: ({ node, ...props }) => (
                                  <div className="overflow-x-auto my-3 w-full">
                                    <table className="w-full text-sm text-left text-slate-600 border border-slate-200 rounded-lg overflow-hidden shadow-sm table-auto" {...props} />
                                  </div>
                                ),
                                thead: ({ node, ...props }) => <thead className="text-xs text-slate-500 uppercase bg-slate-100 border-b border-slate-200" {...props} />,
                                tbody: ({ node, ...props }) => <tbody className="divide-y divide-slate-100 bg-white" {...props} />,
                                th: ({ node, ...props }) => <th className="px-3 py-2 font-bold break-words whitespace-normal align-top bg-slate-50 border-r border-slate-200 last:border-r-0" {...props} />,
                                td: ({ node, ...props }) => <td className="px-3 py-2 break-words whitespace-normal border-r border-slate-100 last:border-r-0 align-top" {...props} />,
                                blockquote: ({ node, ...props }) => <blockquote className="border-l-4 border-indigo-500 bg-indigo-50/50 pl-4 py-2 my-1 italic text-slate-700 rounded-r-lg" {...props} />
                              }}
                            >
                              {msg.text}
                            </ReactMarkdown>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex justify-start">
                      <div className="bg-white border border-slate-200 text-slate-500 rounded-2xl rounded-bl-none px-6 py-5 shadow-sm flex items-center gap-2">
                        <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce"></div>
                        <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input Box */}
                <div className="p-5 bg-white border-t border-slate-100 shrink-0">
                  {isReadOnly ? (
                    <div className="w-full bg-slate-100 border border-slate-200 rounded-xl px-5 py-4 text-center text-slate-500 font-bold uppercase tracking-wider text-sm flex items-center justify-center gap-2">
                      <span>🔒</span> Viewing in Read-Only Mode
                    </div>
                  ) : (
                    <form onSubmit={handleSendChat} className="flex gap-3">
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Ask a question about your policy or these recommendations..."
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all shadow-inner"
                        disabled={chatLoading}
                        autoFocus
                      />
                      <button
                        type="submit"
                        disabled={chatLoading || !chatInput.trim()}
                        className="bg-indigo-600 text-white rounded-xl px-8 py-4 font-bold text-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shadow-md hover:shadow-lg min-w-[120px]"
                      >
                        Send
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* [NEW] Comparison Modal */}
      {
        comparingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/90 backdrop-blur-md animate-fade-in print:absolute print:bg-white print:p-0 print:block">
            <div className="bg-white rounded-3xl w-full max-w-7xl h-[90vh] flex flex-col shadow-2xl relative overflow-hidden print:h-auto print:max-h-none print:w-full print:rounded-none print:shadow-none print:border-none print:overflow-visible">
              {/* Modal Header - Compact */}
              <div className="px-6 py-3 border-b flex justify-between items-center bg-slate-50 shrink-0">
                <h3 className="text-lg font-black text-slate-900">Policy Comparison</h3>
                <button
                  onClick={() => setComparingItem(null)}
                  className="w-8 h-8 rounded-full bg-slate-200 hover:bg-slate-300 flex items-center justify-center transition text-sm text-slate-600"
                >
                  ✕
                </button>
              </div>

              {/* Combined Scrollable Content */}
              <div className="flex-1 overflow-auto print:overflow-visible print:h-auto print:block">
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-8 divide-y md:divide-y-0 md:divide-x divide-slate-100">
                  {/* Left Column: Your Policy */}
                  <div className="space-y-4 pl-4">
                    <div className="bg-gray-100 text-gray-600 text-[10px] font-extrabold px-3 py-1 rounded inline-block uppercase tracking-wider mb-2">
                      Existing Policy
                    </div>

                    <div className="flex flex-col gap-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-slate-400 uppercase tracking-wide min-w-[80px]">Company:</span>
                        <span className="text-lg font-black text-slate-800 break-words line-clamp-2 leading-tight">
                          {policy.company ? policy.company.replace(/((?:Co\.|Corp\.|Ltd\.|Limited)\.?)(.*)/i, '$1').trim() : "Unknown"}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-slate-400 uppercase tracking-wide min-w-[80px]">Plan:</span>
                        <span className="text-lg font-bold text-slate-700">{policy.plan || "N/A"}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-slate-400 uppercase tracking-wide min-w-[80px]">Premium:</span>
                        <span className="text-lg font-bold text-slate-700">{policy.premium || "N/A"}</span>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Recommended Policy */}
                  <div className="space-y-4 md:pl-8 pt-6 md:pt-0">
                    <div className="bg-blue-100 text-blue-700 text-[10px] font-extrabold px-3 py-1 rounded inline-block uppercase tracking-wider mb-2">
                      Recommended Upgrade
                    </div>

                    <div className="flex flex-col gap-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-blue-300 uppercase tracking-wide min-w-[80px]">Company:</span>
                        <span className="text-lg font-black text-blue-800">{comparingItem.company || "Unknown"}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-blue-300 uppercase tracking-wide min-w-[80px]">Plan:</span>
                        <div className="flex-1">
                          <span className="text-xl font-black text-blue-700 leading-tight">{comparingItem.name}</span>
                          <span className="text-xl font-bold text-blue-600 ml-2">({comparingItem.type})</span>
                        </div>
                      </div>

                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-bold text-blue-300 uppercase tracking-wide min-w-[80px]">Est. Cost:</span>
                        <span className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-indigo-600 print:text-blue-700 print:bg-none">
                          {comparingItem.premium}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Detailed Comparison Table - Full Width Centered */}
                <div className="px-6 pb-6">
                  <div className="max-w-5xl mx-auto">
                    <div className="text-center mb-6">
                      <div className="inline-flex items-center gap-2 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-100">
                        <span className="text-lg">📊</span>
                        <span className="text-xs text-blue-800 font-black uppercase tracking-widest">Detailed Gap Analysis</span>
                      </div>
                    </div>

                    <div className="space-y-8">
                      {/* Helper to render a category section */}
                      {['non_negotiable', 'must_have', 'good_to_have', 'special_features'].map((key) => {
                        const items = comparingItem[key];
                        if (!items || items.length === 0) return null;

                        const filteredItems = items.filter(row => {
                          const p = (row.proposed || "").trim().toLowerCase();

                          // Only hide if the recommended data is genuinely missing from DB for a required upgrade
                          if (p === "n/a" || p.includes("no data") || p.includes("ref 3") || p.includes("unavailable") || p.includes("not listed")) {
                            return false;
                          }

                          return true;
                        });

                        if (filteredItems.length === 0) return null;

                        const titles = {
                          non_negotiable: "Non-Negotiable Benefits",
                          must_have: "Must Have Features",
                          good_to_have: "Good To Have Features",
                          special_features: "Special Features"
                        };

                        const colors = {
                          non_negotiable: "indigo",
                          must_have: "blue",
                          good_to_have: "purple",
                          special_features: "amber"
                        };

                        const color = colors[key];

                        return (
                          <div key={key} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                            <div className={`bg-${color}-50 px-6 py-3 border-b border-${color}-100 flex items-center gap-2`}>
                              {key === 'non_negotiable' && <span className="text-lg">💎</span>}
                              <h5 className={`font-black text-${color}-800 text-sm uppercase tracking-wider`}>{titles[key]}</h5>
                            </div>

                            {/* Table Header */}
                            <div className="grid grid-cols-12 bg-slate-50 border-b border-slate-200 text-[10px] font-black text-slate-400 uppercase tracking-wider text-center">
                              <div className="col-span-4 p-2">Feature</div>
                              <div className="col-span-4 p-2 border-l border-slate-200">Your Current Policy</div>
                              <div className="col-span-4 p-2 border-l border-slate-200 bg-blue-50/30 text-blue-600">Recommended Upgrade</div>
                            </div>

                            <div className="divide-y divide-slate-100 bg-white">
                              {filteredItems.map((row, i) => (
                                <div key={i} className="grid grid-cols-12 items-stretch text-xs">
                                  <div className="col-span-4 p-3 bg-slate-50/30 flex items-center justify-center text-center font-bold text-slate-700 break-words">
                                    {row.feature}
                                  </div>
                                  <div className="col-span-4 p-3 border-l border-slate-100 flex items-center justify-center text-center text-slate-500 font-medium break-words">
                                    {(row.existing && row.existing.toLowerCase() === "not found") ? "Not Available" : (row.existing || <span className="italic text-slate-300">--</span>)}
                                  </div>
                                  <div className="col-span-4 p-3 border-l border-blue-50 bg-blue-50/10 flex items-center justify-center text-center font-bold text-blue-800 relative break-words">
                                    {row.proposed}
                                    {row.status === "Upgrade" && (
                                      <span className="absolute top-1 right-1 text-[8px] bg-emerald-100 text-emerald-700 px-1 rounded font-bold uppercase tracking-wide">UPGRADE</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}

                      {/* RED FLAGS SECTION */}
                      {comparingItem.red_flags && comparingItem.red_flags.length > 0 && (
                        <div className="bg-rose-50 border border-rose-100 rounded-xl p-6">
                          <h5 className="font-bold text-rose-800 text-sm uppercase tracking-wider mb-4 flex items-center gap-2">
                            <span>🚩</span> Red Flags / Things to Avoid
                          </h5>
                          <ul className="space-y-2">
                            {comparingItem.red_flags.map((flag, i) => (
                              <li key={i} className="flex gap-2 text-rose-900 text-sm font-medium">
                                <span className="text-rose-500 font-bold">•</span> {flag}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Fallback if nothing exists */}
                      {(!comparingItem.must_have && !comparingItem.good_to_have && !comparingItem.special_features && !comparingItem.comparison_table) && (
                        <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300">
                          <p className="text-slate-400 text-sm">Detailed comparison data unavailable for this item.</p>
                        </div>
                      )}
                    </div>

                    <div className="pt-6">
                      <p className="text-xs text-slate-500 italic bg-slate-50 p-3 rounded-xl border border-slate-100 text-center">
                        "{comparingItem.description}"
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modal Footer - Compact */}
              <div className="px-6 py-3 border-t bg-slate-50 flex justify-between items-center shrink-0">
                <button
                  onClick={() => window.print()}
                  className="text-slate-500 hover:text-slate-800 text-sm font-bold uppercase tracking-wide flex items-center gap-2"
                >
                  🖨️ Print / Save PDF
                </button>
                <button
                  onClick={() => setComparingItem(null)}
                  className="bg-slate-900 hover:bg-slate-800 text-white px-6 py-2 rounded-lg font-bold text-sm transition"
                >
                  Close Comparison
                </button>
              </div>
            </div>
          </div>
        )
      }


    </div >
  );
}
