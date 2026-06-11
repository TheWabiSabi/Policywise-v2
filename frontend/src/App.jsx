import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { auth, apiFetch } from './authClient';
import { Toaster, toast } from 'react-hot-toast';

// Components
import Auth from './components/Auth';
import ClientDashboard from './components/ClientDashboard';
import AdminDashboard from './components/AdminDashboard';
import Analyzer from './components/Analyzer';
import Settings from './components/Settings';
import UpdatePassword from './components/UpdatePassword';

export default function App() {
    const [session, setSession] = useState(null);
    const [role, setRole] = useState(null);
    const [fullName, setFullName] = useState(null);
    const [username, setUsername] = useState(null);
    const [loading, setLoading] = useState(true);
    const fetchUserDataPromiseRef = useRef(null);

    const applyUserData = useCallback((userData = {}) => {
        // Auth is owned by Cognito/NestJS now; profile data is useful for UI,
        // but missing profile fields should not block a valid login session.
        const rawRole = String(userData.role || userData['custom:role'] || 'client').toLowerCase();
        const userRole = rawRole === 'admin' ? 'admin' : 'client';
        const userFullName = userData.name || userData.full_name || userData.username || userData.email || '';
        const userUsername = userData.username || userData.email || '';
        setRole(userRole);
        setFullName(userFullName);
        setUsername(userUsername);
    }, []);

    const fetchUserData = useCallback(async () => {
        if (fetchUserDataPromiseRef.current) return fetchUserDataPromiseRef.current;

        fetchUserDataPromiseRef.current = (async () => {
            console.log("DEBUG: fetchUserData started");
            try {
                // Fetch the user from the Cognito auth service
                const userData = await auth.getUser();
                console.log("DEBUG: getUser returned", userData);

                if (userData) {
                    applyUserData(userData);
                    return;
                }

                const { data: { session: currentSession } } = await auth.getSession();
                if (currentSession) {
                    console.warn("DEBUG: Profile unavailable. Continuing with authenticated session.");
                    applyUserData(currentSession.user || {});
                    return;
                }

                console.warn("DEBUG: No auth session found after profile lookup. Signing out.");
                await auth.signOut();
                setSession(null);
                setRole(null);
                setFullName(null);
                setUsername(null);
                setLoading(false);
            } catch (err) {
                console.error("DEBUG: Error fetching user profile data", err);
                // Try /users/profile as fallback
                try {
                    const profile = await apiFetch('/users/profile');
                    if (profile) {
                        applyUserData(profile);
                        return;
                    }
                } catch (profileErr) {
                    console.error("DEBUG: /users/profile fallback also failed", profileErr);
                }

                const { data: { session: currentSession } } = await auth.getSession();
                if (currentSession) {
                    console.warn("DEBUG: Continuing with cached authenticated session after profile errors.");
                    applyUserData(currentSession.user || {});
                }
            }
        })();

        try {
            return await fetchUserDataPromiseRef.current;
        } finally {
            fetchUserDataPromiseRef.current = null;
        }
    }, [applyUserData]);

    const handleAuthSuccess = useCallback(async () => {
        setLoading(true);
        try {
            await fetchUserData();
            const { data: { session: freshSession } } = await auth.getSession();
            setSession(freshSession);
        } catch (err) {
            console.error("DEBUG: Error completing auth handoff", err);
            toast.error("Signed in, but couldn't load your workspace. Please refresh once.");
        } finally {
            setLoading(false);
        }
    }, [fetchUserData]);

    useEffect(() => {
        let mounted = true;

        const initializeSession = async () => {
            console.log("DEBUG: initializeSession started");

            try {
                const { data: { session: currentSession } } = await auth.getSession();
                console.log("DEBUG: getSession returned", currentSession);

                if (!mounted) return;

                if (currentSession) {
                    await fetchUserData();
                    if (mounted) {
                        const { data: { session: freshSession } } = await auth.getSession();
                        setSession(freshSession);
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
                await fetchUserData();
                const { data: { session: freshSession } } = await auth.getSession();
                if (mounted) {
                    setSession(freshSession);
                    setLoading(false);
                }
            } else if (event === 'SIGNED_OUT') {
                if (mounted) {
                    setSession(null);
                    setRole(null);
                    setFullName(null);
                    setUsername(null);
                    setLoading(false);
                }
            }
        });

        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, [fetchUserData]);

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

    const resolvingRole = session && !role;
    const routeLoader = (
        <div className="min-h-screen flex flex-col items-center justify-center font-sans bg-slate-50">
            <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
            <div className="text-slate-500 font-bold animate-pulse text-sm uppercase tracking-widest">Opening Workspace...</div>
        </div>
    );

    return (
        <BrowserRouter>
            <Toaster position="top-right" />
            <Routes>
                {/* Public / Auth Route */}
                <Route
                    path="/login"
                    element={!session ? <Auth onAuthSuccess={handleAuthSuccess} /> : resolvingRole ? routeLoader : <Navigate to={role === 'admin' ? '/admin' : '/dashboard'} replace />}
                />

                <Route
                    path="/update-password"
                    element={<UpdatePassword />}
                />

                {/* Client Routes */}
                <Route
                    path="/dashboard"
                    element={!session ? <Navigate to="/login" replace /> : resolvingRole ? routeLoader : role === 'client' ? <ClientDashboard session={session} fullName={fullName} username={username} /> : <Navigate to="/admin" replace />}
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
                    element={!session ? <Navigate to="/login" replace /> : resolvingRole ? routeLoader : role === 'admin' ? <AdminDashboard session={session} fullName={fullName} /> : <Navigate to="/dashboard" replace />}
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
