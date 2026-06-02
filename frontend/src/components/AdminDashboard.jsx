import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import ConfirmModal from './ConfirmModal';

import { API_BASE } from '../config';

export default function AdminDashboard({ session, fullName }) {
    const [analyses, setAnalyses] = useState([]);
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
        fetchAnalyses();
    }, []);

    const fetchAnalyses = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('policy_analyses')
                .select(`
                    *,
                    profiles(email, full_name, phone)
                `)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setAnalyses(data || []);
        } catch (error) {
            console.error('Error fetching admin data:', error.message);
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
        e.stopPropagation(); // prevent row click if applied later
        setDeleteConfirmId(id);
    };

    const confirmDeleteAnalysis = () => {
        if (!deleteConfirmId) return;

        const id = deleteConfirmId;

        // --- Optimistic UI: remove instantly & close modal ---
        const previousAnalyses = analyses;
        setAnalyses(prev => prev.filter(a => a.id !== id));
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
                setAnalyses(previousAnalyses);
                toast.error("Failed to delete analysis: " + error.message);
            }
        })();
    };

    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            <header className="px-10 py-5 bg-white border-b border-slate-200 flex items-center justify-between sticky top-0 z-50">
                <div className="flex items-center gap-4">
                    <div className="bg-rose-600 p-2 rounded-xl shadow-lg shadow-rose-100">
                        <img src="/logo3.png" alt="Logo" className="h-7 w-7 object-contain invert brightness-0" />
                    </div>
                    <div>
                        <h1 className="text-xl font-black text-slate-800 tracking-tight">Admin Console</h1>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">System Management</p>
                    </div>
                </div>

                <div className="flex items-center gap-6">
                    <div className="relative">
                        <button
                            onClick={() => setShowProfileMenu(!showProfileMenu)}
                            className="w-12 h-12 bg-white rounded-2xl border border-slate-100 shadow-sm flex items-center justify-center hover:bg-slate-50 transition active:scale-95 group"
                        >
                            <div className="w-8 h-8 bg-gradient-to-br from-rose-500 to-rose-700 rounded-xl flex items-center justify-center text-white font-black text-sm shadow-md group-hover:shadow-lg transition text-uppercase">
                                {getInitials()}
                            </div>
                        </button>

                        {showProfileMenu && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)}></div>
                                <div className="absolute right-0 mt-4 w-64 bg-white rounded-3xl shadow-2xl border border-slate-100 p-3 z-50 animate-in fade-in zoom-in duration-200 origin-top-right">
                                    <div className="px-4 py-3 mb-2 border-b border-slate-50">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Administrator</p>
                                        <p className="text-sm font-bold text-slate-700 truncate">{dispName}</p>
                                    </div>

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

            <div className="max-w-[92%] mx-auto p-4 md:p-8">
                <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
                    <div className="p-6 border-b border-slate-50 bg-slate-50/30">
                        <h2 className="font-black text-slate-700 uppercase text-xs tracking-widest">Latest Policy Extractions</h2>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left whitespace-nowrap">
                            <thead className="bg-slate-50/50 text-slate-400 uppercase text-[10px] font-black tracking-widest">
                                <tr>
                                    <th className="px-4 py-4 w-[12%]">Date</th>
                                    <th className="px-4 py-4 w-[22%]">Client User</th>
                                    <th className="px-4 py-4 w-[14%]">Phone</th>
                                    <th className="px-4 py-4 w-[1%] whitespace-nowrap">Company</th>
                                    <th className="px-4 py-4 w-[25%]">Plan Name</th>
                                    <th className="px-4 py-4 w-[12%]">AI Score</th>
                                    <th className="px-4 py-4 w-[10%] text-center">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {loading ? (
                                    <tr><td colSpan="6" className="px-4 py-20 text-center text-slate-400 font-medium">Loading command center data...</td></tr>
                                ) : analyses.length === 0 ? (
                                    <tr><td colSpan="6" className="px-4 py-20 text-center text-slate-400 font-medium">No analyses captured yet.</td></tr>
                                ) : analyses.map(a => (
                                    <tr key={a.id} className="hover:bg-slate-50/80 transition group">
                                        <td className="px-4 py-4 text-sm text-slate-500 font-medium">{new Date(a.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                                        <td className="px-4 py-4">
                                            <div className="flex flex-col">
                                                <span className="text-sm font-bold text-slate-700">{a.profiles?.full_name || 'N/A'}</span>
                                                <span className="text-[10px] text-slate-400 font-medium uppercase tracking-tighter opacity-70">{a.profiles?.email}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4">
                                            {a.profiles?.phone ? (
                                                <a
                                                    href={`tel:${a.profiles.phone.replace(/\s/g, '')}`}
                                                    className="flex items-center gap-1.5 text-sm font-bold text-emerald-700 hover:text-emerald-500 transition group w-fit"
                                                    title="Click to call"
                                                >
                                                    <span className="bg-emerald-100 group-hover:bg-emerald-200 text-emerald-600 px-1.5 py-0.5 rounded text-[10px] transition">📞</span>
                                                    {a.profiles.phone}
                                                </a>
                                            ) : (
                                                <span className="text-slate-300 text-xs italic">Not provided</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 text-sm text-slate-500 font-medium">{a.company_name}</td>
                                        <td className="px-4 py-4 text-sm font-black text-slate-800">{a.plan_name}</td>
                                        <td className="px-4 py-4">
                                            {a.report_data?.product_score ? (
                                                <div className="flex items-center gap-2">
                                                    <div className="w-12 h-2 bg-slate-100 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-blue-500 rounded-full"
                                                            style={{ width: `${(a.report_data.product_score / 10) * 100}%` }}
                                                        ></div>
                                                    </div>
                                                    <span className="text-xs font-black text-blue-600">{a.report_data.product_score}/10</span>
                                                </div>
                                            ) : <span className="text-slate-300 text-xs italic">Pending</span>}
                                        </td>
                                        <td className="px-4 py-4 text-center">
                                            <div className="flex items-center justify-center gap-3">
                                                <button
                                                    onClick={() => navigate(`/analyze?id=${a.id}`)}
                                                    className="bg-blue-50 text-blue-600 px-4 py-2 rounded-xl text-xs font-black hover:bg-blue-600 hover:text-white transition shadow-sm"
                                                >
                                                    Details
                                                </button>
                                                <button
                                                    onClick={(e) => handleDeleteAnalysis(a.id, e)}
                                                    className="p-1.5 text-slate-300 hover:text-white hover:bg-rose-500 rounded-lg transition"
                                                    title="Permanently Delete Analysis"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            <ConfirmModal 
                isOpen={!!deleteConfirmId}
                title="Admin Delete Analysis"
                message="Admin Action: Are you sure you want to delete this analysis permanently?"
                onConfirm={confirmDeleteAnalysis}
                onCancel={() => setDeleteConfirmId(null)}
                confirmText="Permanently Delete"
            />
        </div>
    );
}
