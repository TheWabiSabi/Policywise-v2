import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth } from '../authClient';

export default function GoogleCallbackHandler() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [message, setMessage] = useState('Signing you in...');

    useEffect(() => {
        const code = searchParams.get('code');
        const error = searchParams.get('error');

        if (error || !code) {
            navigate('/login?auth_error=google_cancelled', { replace: true });
            return;
        }

        // Mirrors the InsurAI callback flow: exchange Google's OAuth code with
        // the NestJS auth service, store the returned token, then enter the app.
        auth.loginWithGoogleCode(code, `${window.location.origin}/auth/google/callback`)
            .then(() => navigate('/dashboard', { replace: true }))
            .catch((err) => {
                console.error('Google callback failed', err);
                setMessage(err.message || 'Google sign in failed.');
                navigate('/login?auth_error=google_failed', { replace: true });
            });
    }, [navigate, searchParams]);

    return (
        <div className="min-h-screen flex flex-col items-center justify-center font-sans bg-slate-50">
            <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
            <div className="text-slate-500 font-bold animate-pulse text-sm uppercase tracking-widest">{message}</div>
        </div>
    );
}
