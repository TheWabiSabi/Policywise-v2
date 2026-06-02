import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function UpdatePassword() {
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        // When clicking a reset link, Supabase appends #access_token=... to the URL.
        // We verify that a session exists (the user is implicitly logged in by clicking the link)
        const checkSession = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                // If there's no session, the link might be expired or invalid
                setErrorMsg('Invalid or expired password reset link. Please try requesting a new one.');
            }
        };
        checkSession();
    }, []);

    const handleUpdatePassword = async (e) => {
        e.preventDefault();
        setLoading(true);
        setErrorMsg('');
        setSuccessMsg('');

        if (password !== confirmPassword) {
            setErrorMsg('Passwords do not match.');
            setLoading(false);
            return;
        }

        if (password.length < 6) {
            setErrorMsg('Password must be at least 6 characters long.');
            setLoading(false);
            return;
        }

        try {
            // [PHASE 25] Update the user's password securely
            const { error } = await supabase.auth.updateUser({
                password: password
            });

            if (error) throw error;

            setSuccessMsg('Your password has been updated successfully!');
            
            // Redirect to login after 3 seconds
            setTimeout(async () => {
                // Ensure they are fully logged out so they can log back in with the new password
                await supabase.auth.signOut();
                
                // Use a hard redirect instead of react-router navigate to forcefully clear ALL App.jsx 
                // Context / State and prevent any race conditions with the 'session' routing.
                window.location.href = '/login';
            }, 3000);

        } catch (error) {
            setErrorMsg(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans">
            <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
                <h2 className="mt-6 text-center text-3xl font-extrabold text-slate-900 pr-2">
                    PolicyWise
                </h2>
                <p className="mt-2 text-center text-sm text-slate-600">
                    Update Your Password
                </p>
            </div>

            <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
                <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 border border-slate-100">
                    {successMsg ? (
                        <div className="text-center">
                            <div className="text-emerald-600 text-sm font-medium p-4 bg-emerald-50 rounded-md border border-emerald-100 mb-4">
                                {successMsg}
                            </div>
                            <p className="text-sm text-slate-500">Redirecting to login...</p>
                        </div>
                    ) : (
                        <form className="space-y-6" onSubmit={handleUpdatePassword}>
                            <div>
                                <label className="block text-sm font-medium text-slate-700">New Password <span className="text-rose-500">*</span></label>
                                <div className="mt-1">
                                    <input
                                        type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                                        className="appearance-none block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm placeholder-slate-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                                    />
                                </div>
                            </div>
                            
                            <div>
                                <label className="block text-sm font-medium text-slate-700">Confirm New Password <span className="text-rose-500">*</span></label>
                                <div className="mt-1">
                                    <input
                                        type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="appearance-none block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm placeholder-slate-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                                    />
                                </div>
                            </div>

                            {errorMsg && <div className="text-rose-600 text-sm font-medium">{errorMsg}</div>}

                            <div>
                                <button
                                    type="submit" disabled={loading || !password || !confirmPassword}
                                    className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                    {loading ? 'Updating...' : 'Update Password'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
