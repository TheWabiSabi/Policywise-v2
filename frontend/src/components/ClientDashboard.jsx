import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import ConfirmModal from './ConfirmModal';

import { API_BASE } from '../config';

export default function ClientDashboard({ session, fullName }) {
    const [policies, setPolicies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState(null);
    const navigate = useNavigate();

    // avatar logic
    const getInitials = () => {
        if (fullName) return fullName[0].toUpperCase();
        return session?.user?.email?.[0].toUpperCase() || '?';
    };

    const dispName = fullName || session?.user?.email;

    useEffect(() => {
        fetchPolicies();
    }, []);

    const fetchPolicies = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('policy_analyses')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setPolicies(data || []);
        } catch (error) {
            console.error('Error fetching policies:', error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSignOut = async () => {
        await supabase.auth.signOut();
        localStorage.clear();
        sessionStorage.clear();
        // React Router via App.jsx will automatically redirect to /login
        navigate('/login', { replace: true });
    };

    const handleDeleteAnalysis = (id, e) => {
        e.stopPropagation(); // prevent card click
        setDeleteConfirmId(id);
    };

    const confirmDeleteAnalysis = () => {
        if (!deleteConfirmId) return;

        const id = deleteConfirmId;

        // --- Optimistic UI: remove instantly & close modal ---
        const previousPolicies = policies;
        setPolicies(prev => prev.filter(p => p.id !== id));
        setDeleteConfirmId(null);
        toast.success("Analysis deleted.");

        // Fire-and-forget API call in background
        (async () => {
            try {
                const { data: { session: freshSession } } = await supabase.auth.getSession();
                const token = freshSession?.access_token;

                const res = await fetch(`${API_BASE}/analysis/${id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (!res.ok) {
                    const errorText = await res.text();
                    let detail = "Delete failed";
                    try {
                        const json = JSON.parse(errorText);
                        if (json.detail) detail = json.detail;
                    } catch { detail = errorText || detail; }
                    throw new Error(detail);
                }
            } catch (error) {
                console.error('Error deleting policy:', error.message);
                // Roll back the optimistic removal
                setPolicies(previousPolicies);
                toast.error("Failed to delete analysis: " + error.message);
            }
        })();
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 font-sans">
            <header className="px-10 py-5 bg-white/80 backdrop-blur-md border-b border-indigo-100 flex items-center justify-between sticky top-0 z-50">
                <div className="flex items-center gap-4">
                    <div className="bg-blue-600 p-2.5 rounded-2xl shadow-lg shadow-blue-100">
                        <img src="/logo3.png" alt="Logo" className="h-6 w-6 object-contain invert brightness-0" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-black text-slate-800 tracking-tight">My Dashboard</h1>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Manage your insurance policy analyses</p>
                    </div>
                </div>

                <div className="flex items-center gap-6">
                    <button
                        onClick={() => navigate('/analyze')}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl font-black text-sm transition shadow-lg shadow-blue-200 active:scale-95 flex items-center gap-2"
                    >
                        <span>+</span> Analyze New Policy
                    </button>

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

            <main className="max-w-7xl mx-auto p-10">
                {loading ? (
                    <div className="text-center py-40 text-slate-400 font-medium">Loading your policies...</div>
                ) : policies.length === 0 ? (
                    <div className="bg-white rounded-[40px] shadow-2xl shadow-slate-200/50 border border-slate-100 p-32 text-center min-h-[500px] flex flex-col items-center justify-center">
                        <h3 className="text-xl font-bold text-slate-700 mb-2">No policies yet</h3>
                        <p className="text-slate-500 mb-6">Upload an insurance policy to get an AI-powered smart analysis.</p>
                        <button
                            onClick={() => navigate('/analyze')}
                            className="bg-slate-100 hover:bg-blue-600 hover:text-white text-blue-600 px-8 py-3 rounded-2xl font-black text-sm transition"
                        >
                            Upload First Policy
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {policies.map((p) => (
                            <div
                                key={p.id}
                                onClick={() => navigate(`/analyze?id=${p.id}`)}
                                className="group bg-white rounded-[32px] p-6 border border-slate-100 shadow-xl shadow-slate-200/40 hover:shadow-2xl hover:shadow-blue-200/40 transition-all duration-300 cursor-pointer relative overflow-hidden flex flex-col justify-between"
                            >
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-6">
                                        <div className="w-12 h-12 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl flex items-center justify-center text-xl shadow-inner">
                                            📄
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full uppercase tracking-widest border border-blue-100">
                                                Analysis Completed
                                            </span>
                                            <button 
                                                onClick={(e) => handleDeleteAnalysis(p.id, e)}
                                                className="p-1.5 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition"
                                                title="Delete Analysis"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>

                                    <div className="mb-6">
                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block truncate mb-1">{p.company_name}</span>
                                        <h3 className="text-lg font-black text-slate-800 leading-tight group-hover:text-blue-600 transition truncate">{p.plan_name}</h3>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between mt-4 relative z-10 pt-4 border-t border-slate-50">
                                    <span className="text-xs font-bold text-slate-500">{new Date(p.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                                    <button className="text-blue-600 font-black text-xs uppercase tracking-widest flex items-center gap-1 group-hover:translate-x-1 transition-transform">
                                        View Report →
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </main>
            <ConfirmModal 
                isOpen={!!deleteConfirmId}
                title="Delete Analysis"
                message="Are you sure you want to delete this analysis? This action cannot be undone."
                onConfirm={confirmDeleteAnalysis}
                onCancel={() => setDeleteConfirmId(null)}
                confirmText="Delete"
            />
        </div>
    );
}
