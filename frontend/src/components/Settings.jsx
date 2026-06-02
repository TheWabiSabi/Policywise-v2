import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { toast } from 'react-hot-toast';
import { Phone } from 'lucide-react';
import ConfirmModal from './ConfirmModal';

import { API_BASE } from '../config';

const countryList = [
    { code: '+91', flag: '🇮🇳', name: 'India' },
    { code: '+1', flag: '🇺🇸', name: 'United States' },
    { code: '+44', flag: '🇬🇧', name: 'United Kingdom' },
    { code: '+61', flag: '🇦🇺', name: 'Australia' },
    { code: '+81', flag: '🇯🇵', name: 'Japan' },
    { code: '+86', flag: '🇨🇳', name: 'China' },
    { code: '+49', flag: '🇩🇪', name: 'Germany' },
    { code: '+33', flag: '🇫🇷', name: 'France' },
    { code: '+971', flag: '🇦🇪', name: 'United Arab Emirates' },
];

export default function Settings({ session, fullName, username, onProfileUpdate }) {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [deleteError, setDeleteError] = useState(null);
    const [success, setSuccess] = useState(null);

    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [localUsername, setLocalUsername] = useState('');
    const [countryCode, setCountryCode] = useState('+91');
    const [isCountryDropdownOpen, setIsCountryDropdownOpen] = useState(false);
    const dropdownRef = useRef(null);
    const [phone, setPhone] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsCountryDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Initialize from props
    useEffect(() => {
        if (fullName) {
            const parts = fullName.split(' ');
            setFirstName(parts[0] || '');
            setLastName(parts.slice(1).join(' ') || '');
        }
        if (username) {
            setLocalUsername(username);
        } else if (session?.user?.id) {
            // Fallback fetch if prop is not yet loaded
            fetchProfile();
        }
    }, [fullName, username, session]);

    const fetchProfile = async () => {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('full_name, username')
                .eq('id', session.user.id)
                .single();

            if (error) throw error;
            if (data) {
                const parts = data.full_name?.split(' ') || [];
                setFirstName(parts[0] || '');
                setLastName(parts.slice(1).join(' ') || '');
                setLocalUsername(data.username || '');
                
                // Pull phone directly from Auth user metadata since it's not a column in profiles
                const userPhone = session?.user?.user_metadata?.phone;
                if (userPhone) {
                    const phoneParts = userPhone.split(' ');
                    if (phoneParts.length > 1) {
                        setCountryCode(phoneParts[0]);
                        setPhone(phoneParts.slice(1).join(''));
                    } else {
                        setPhone(userPhone);
                    }
                }
            }
        } catch (err) {
            console.error("Error fetching profile:", err);
        }
    };

    const handleSaveProfile = async () => {
        setSaving(true);
        setSaveError(null);
        setSuccess(null);
        try {
            const newFullName = `${firstName} ${lastName}`.trim();
            const newUsername = localUsername.trim();
            if (!newFullName) throw new Error("Name cannot be empty");
            if (!newUsername) throw new Error("Username cannot be empty");

            // Use upsert to handle cases where the profile row might be missing
            const { data, error } = await supabase
                .from('profiles')
                .upsert({
                    id: session.user.id,
                    full_name: newFullName,
                    username: newUsername
                }, { onConflict: 'id' })
                .select();

            if (error) throw error;

            // In some RLS configurations, upsert/update might return empty data if blocked
            if (!data || data.length === 0) {
                throw new Error("Update failed. Please ensure you have applied the RLS Update policy in Supabase.");
            }

            setSuccess("Profile updated successfully!");

            if (onProfileUpdate) onProfileUpdate();

            // Also update Auth metadata for session consistency
            await supabase.auth.updateUser({
                data: {
                    full_name: newFullName,
                    username: newUsername
                }
            });

        } catch (err) {
            console.error("Save Error:", err);
            let msg = err.message;
            if (msg.toLowerCase().includes('profiles_username_key')) {
                msg = "This username is already taken. Please try another one!";
            }
            setSaveError(msg);
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteAccount = () => {
        setShowDeleteModal(true);
    };

    const confirmDeleteAccount = async () => {
        setShowDeleteModal(false);
        setLoading(true);
        setDeleteError(null);

        try {
            // Ensure we have a fresh token
            const { data: { session: freshSession } } = await supabase.auth.getSession();
            const activeToken = freshSession?.access_token || session?.access_token;

            if (!activeToken) throw new Error("No active session found. Please log in again.");

            const res = await fetch(`${API_BASE}/user/self`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${activeToken}`
                }
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.detail || "Failed to delete account");
            }

            await supabase.auth.signOut();
            localStorage.clear();
            sessionStorage.clear();

            toast.success("Your account has been deleted successfully.");
            navigate('/login', { replace: true });
        } catch (err) {
            setDeleteError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 font-sans p-10">
            <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-white">
                    <h1 className="text-3xl font-black mb-2">Account Settings</h1>
                    <p className="text-blue-100 font-medium">Manage your personal information and privacy.</p>
                </div>

                <div className="p-8 space-y-8">
                    {/* Profile Section */}
                    <div className="space-y-6">
                        <div className="flex items-center justify-between border-b pb-2">
                            <h2 className="text-xl font-bold text-slate-800">Profile Information</h2>
                            <div className="flex flex-col items-end text-right">
                                {success && <span className="text-emerald-500 text-xs font-bold animate-pulse">{success}</span>}
                                {saveError && <span className="text-rose-500 text-[10px] font-bold">Error: {saveError}</span>}
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Username</label>
                            <input
                                type="text"
                                value={localUsername}
                                onChange={(e) => setLocalUsername(e.target.value)}
                                className="w-full text-slate-700 font-bold bg-slate-50 p-3 rounded-xl border border-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
                                placeholder="Choose unique username"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">First Name</label>
                                <input
                                    type="text"
                                    value={firstName}
                                    onChange={(e) => setFirstName(e.target.value)}
                                    className="w-full text-slate-700 font-bold bg-slate-50 p-3 rounded-xl border border-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
                                    placeholder="Enter first name"
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Surname</label>
                                <input
                                    type="text"
                                    value={lastName}
                                    onChange={(e) => setLastName(e.target.value)}
                                    className="w-full text-slate-700 font-bold bg-slate-50 p-3 rounded-xl border border-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm"
                                    placeholder="Enter surname"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Email Address</label>
                            <p className="text-slate-500 font-medium bg-slate-50/50 p-3 rounded-xl border border-slate-100 opacity-70">
                                {session?.user?.email}
                            </p>
                        </div>

                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Phone Number</label>
                            <p className="text-slate-500 font-medium bg-slate-50/50 p-3 rounded-xl border border-slate-100 opacity-70">
                                {phone ? `${countryCode} ${phone}` : session?.user?.user_metadata?.phone || "Not provided"}
                            </p>
                        </div>

                        <button
                            onClick={handleSaveProfile}
                            disabled={saving}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold text-sm transition shadow-lg shadow-blue-100 active:scale-95 disabled:opacity-50"
                        >
                            {saving ? "Saving Changes..." : "Save Profile Details"}
                        </button>
                    </div>

                    {/* Security & Privacy Section */}
                    <div className="space-y-4 pt-6">
                        <h2 className="text-xl font-bold text-slate-800 border-b pb-2">Security & Privacy</h2>
                        <div className="bg-rose-50/30 p-6 rounded-2xl border border-rose-100">
                            <div className="flex items-center gap-3 mb-4">
                                <span className="text-xl">🛡️</span>
                                <h3 className="font-bold text-slate-800">Delete Account</h3>
                            </div>
                            <p className="text-sm text-slate-600 mb-6 font-medium">
                                Once you delete your account, there is no going back. All your uploaded policies, reports, and chat history will be permanently erased.
                            </p>

                            {deleteError && (
                                <div className="bg-white border border-rose-200 text-rose-600 p-3 rounded-xl text-sm mb-4 font-bold">
                                    Error: {deleteError}
                                </div>
                            )}

                            <button
                                onClick={handleDeleteAccount}
                                disabled={loading}
                                className={`w-full py-4 rounded-xl font-black transition-all shadow-lg ${loading
                                    ? 'bg-rose-300 cursor-not-allowed'
                                    : 'bg-rose-600 text-white hover:bg-rose-700 hover:shadow-rose-200 active:scale-95'
                                    }`}
                            >
                                {loading ? "Processing..." : "Permanently Delete My Account"}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="bg-slate-50 p-6 flex justify-between items-center border-t border-slate-100">
                    <button
                        onClick={() => navigate('/dashboard')}
                        className="text-slate-500 hover:text-blue-600 font-black transition flex items-center gap-2 text-sm uppercase tracking-widest"
                    >
                        ← Dashboard
                    </button>
                    <button
                        onClick={async () => {
                            await supabase.auth.signOut();
                            localStorage.clear();
                            sessionStorage.clear();
                            navigate('/login');
                        }}
                        className="text-rose-600 hover:text-rose-800 font-black transition text-sm uppercase tracking-widest"
                    >
                        Sign Out
                    </button>
                </div>
            </div>
            <ConfirmModal 
                isOpen={showDeleteModal}
                title="Delete Account"
                message={`Are you absolutely sure you want to delete your account?\n\nThis action is permanent and will delete all your policy analyses and chat history.`}
                onConfirm={confirmDeleteAccount}
                onCancel={() => setShowDeleteModal(false)}
                confirmText="Yes, delete my account"
            />
        </div>
    );
}
