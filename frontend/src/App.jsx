import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { auth, apiFetch, clearTokens } from './authClient';
import { Toaster, toast } from 'react-hot-toast';

// Components
import Auth from './components/Auth';
import ClientDashboard from './components/ClientDashboard';
import AdminDashboard from './components/AdminDashboard';
import Analyzer from './components/Analyzer';
import Settings from './components/Settings';
import UpdatePassword from './components/UpdatePassword';
import PhoneVerificationGate from './components/PhoneVerificationGate';

export default function App() {
    const [session, setSession] = useState(null);
    const [role, setRole] = useState(null);
    const [fullName, setFullName] = useState(null);
    const [username, setUsername] = useState(null);
    const [phoneVerified, setPhoneVerified] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        const initializeSession = async () => {
            console.log("DEBUG: initializeSession started");

            try {
                const { data: { session: currentSession } } = await auth.getSession();
                console.log("DEBUG: getSession returned", currentSession);

                if (!mounted) return;

                if (currentSession) {
                    // Check if they are halfway through a phone verification signup
                    if (sessionStorage.getItem('signup_in_progress') === 'true') {
                        console.log("DEBUG: Abandoned mid-signup detected during refresh. Cleaning up.");
                        await auth.signOut();
                        sessionStorage.removeItem('signup_in_progress');
                        if (mounted) setLoading(false);
                        return;
                    }

                    await fetchUserData();
                    if (mounted) {
                        setSession(currentSession);
                        setLoading(false);
                    }
                } else {
                    if (mounted) setLoading(false);
                }
            } catch (err) {
                console.error("DEBUG: initial session check failed", err);
                if (mounted) setLoading(false);
            }
        };

        initializeSession();

        const { data: { subscription } } = auth.onAuthStateChange(async (event, sessionData) => {
            if (event === 'SIGNED_IN' && sessionData) {
                if (sessionStorage.getItem('signup_in_progress') === 'true') {
                    console.log("DEBUG: Signup in progress, holding router at /login.");
                    return;
                }
                await fetchUserData();
                const { data: { session: freshSession } } = await auth.getSession();
                if (mounted) setSession(freshSession);
            } else if (event === 'SIGNED_OUT') {
                if (mounted) {
                    setSession(null);
                    setRole(null);
                    setFullName(null);
                    setUsername(null);
                    setPhoneVerified(null);
                    setLoading(false);
                }
            }
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, []);

    const fetchUserData = async (userIdUnused) => {
        console.log("DEBUG: fetchUserData started");
        try {
            // Fetch the user from the Cognito auth service
            const userData = await auth.getUser();
            console.log("DEBUG: getUser returned", userData);

            if (userData) {
                // Map Cognito user fields to the existing role/profile structure.
                // Cognito doesn't have roles by default — use custom attribute or default to 'client'.
                const userRole = userData.role || userData['custom:role'] || 'client';
                const userFullName = userData.name || userData.full_name || userData.username || userData.email || '';
                const userUsername = userData.username || userData.email || '';
                const userPhone = userData.phone || userData.phone_number || null;

                setRole(userRole);
                setFullName(userFullName);
                setUsername(userUsername);
                setPhoneVerified(!!userPhone);
            } else {
                console.warn("DEBUG: No user data returned. Signing out.");
                toast.error("Could not load user profile. Please sign in again.", { duration: 6000 });
                await auth.signOut();
                setSession(null);
                setRole(null);
                setFullName(null);
                setUsername(null);
                setPhoneVerified(null);
                setLoading(false);
            }
        } catch (err) {
            console.error("DEBUG: Error fetching user profile data", err);
            // Try /users/profile as fallback
            try {
                const profile = await apiFetch('/users/profile');
                if (profile) {
                    setRole(profile.role || 'client');
                    setFullName(profile.full_name || profile.name || '');
                    setUsername(profile.username || '');
                    setPhoneVerified(!!profile.phone);
                }
            } catch (profileErr) {
                console.error("DEBUG: /users/profile fallback also failed", profileErr);
            }
        }
    };

    // Auto-Logout if idle for 15 minutes
    useEffect(() => {
        let timeoutId;
        const resetTimer = () => {
            clearTimeout(timeoutId);
            if (session) {
                const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
                timeoutId = setTimeout(async () => {
                    console.log("DEBUG: User idle for too long. Forcing sign out.");
                    await auth.signOut();
                    toast.error("You have been signed out securely due to inactivity.", { duration: 6000 });
                }, IDLE_TIMEOUT_MS);
            }
        };

        if (session) {
            window.addEventListener('mousemove', resetTimer);
            window.addEventListener('mousedown', resetTimer);
            window.addEventListener('keydown', resetTimer);
            window.addEventListener('scroll', resetTimer);
            window.addEventListener('touchstart', resetTimer);
            resetTimer();
        }

        return () => {
            clearTimeout(timeoutId);
            window.removeEventListener('mousemove', resetTimer);
            window.removeEventListener('mousedown', resetTimer);
            window.removeEventListener('keydown', resetTimer);
            window.removeEventListener('scroll', resetTimer);
            window.removeEventListener('touchstart', resetTimer);
        };
    }, [session]);

    if (loading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center font-sans bg-slate-50">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                <div className="text-slate-500 font-bold animate-pulse text-sm uppercase tracking-widest">Verifying Session...</div>
            </div>
        );
    }

    if (session && phoneVerified === false) {
        return (
            <>
                <Toaster position="top-right" />
                <PhoneVerificationGate session={session} onVerified={(newPhone) => setPhoneVerified(true)} />
            </>
        );
    }

    return (
        <BrowserRouter>
            <Toaster position="top-right" />
            <Routes>
                {/* Public / Auth Route */}
                <Route
                    path="/login"
                    element={!session ? <Auth onAuthSuccess={() => window.location.reload()} /> : <Navigate to={role === 'admin' ? '/admin' : '/dashboard'} replace />}
                />

                <Route
                    path="/update-password"
                    element={<UpdatePassword />}
                />

                {/* Client Routes */}
                <Route
                    path="/dashboard"
                    element={session && role === 'client' ? <ClientDashboard session={session} fullName={fullName} username={username} /> : <Navigate to="/login" replace />}
                />

                <Route
                    path="/analyze"
                    element={session ? <Analyzer session={session} fullName={fullName} username={username} /> : <Navigate to="/login" replace />}
                />

                <Route
                    path="/settings"
                    element={session ? <Settings session={session} fullName={fullName} username={username} onProfileUpdate={() => fetchUserData()} /> : <Navigate to="/login" replace />}
                />

                {/* Admin Routes */}
                <Route
                    path="/admin"
                    element={session && role === 'admin' ? <AdminDashboard session={session} fullName={fullName} /> : <Navigate to="/dashboard" replace />}
                />

                {/* Default Catch-all */}
                <Route
                    path="*"
                    element={session ? (role ? <Navigate to={role === 'admin' ? '/admin' : '/dashboard'} replace /> : <div className="text-center p-20 font-bold opacity-50 uppercase tracking-widest text-xs">Redirecting...</div>) : <Navigate to="/login" replace />}
                />
            </Routes>
        </BrowserRouter>
    );
}
