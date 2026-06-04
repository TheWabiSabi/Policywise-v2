import React, { useState, useEffect, useRef } from 'react';
import { auth } from '../authClient';
import { toast } from 'react-hot-toast';
import { Eye, EyeOff, Mail, Lock, ShieldCheck, Zap, FileSearch, KeyRound } from 'lucide-react';

// ── helpers ────────────────────────────────────────────────────────────────
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InputIcon({ icon: Icon }) {
    return (
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-500 transition-colors">
            <Icon className="w-5 h-5" />
        </div>
    );
}

function SubmitButton({ loading, label, loadingLabel, disabled }) {
    return (
        <button
            type="submit"
            disabled={disabled || loading}
            className="w-full flex justify-center py-3 px-4 rounded-xl shadow-md text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5"
        >
            {loading ? (
                <span className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {loadingLabel}
                </span>
            ) : label}
        </button>
    );
}

// ── main component ─────────────────────────────────────────────────────────
/**
 * view states: 'signin' | 'signup' | 'confirm' | 'forgot' | 'forgot-confirm'
 */
export default function Auth({ onAuthSuccess }) {
    const [view, setView] = useState('signin');
    const [loading, setLoading] = useState(false);
    const googleButtonRef = useRef(null);
    const [googleReady, setGoogleReady] = useState(false);

    // shared fields
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    // signup fields
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [emailError, setEmailError] = useState('');

    // confirm OTP
    const [otpCode, setOtpCode] = useState('');
    const [pendingEmail, setPendingEmail] = useState(''); // email locked after signup

    // forgot password
    const [forgotEmail, setForgotEmail] = useState('');
    const [resetCode, setResetCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [showNewPassword, setShowNewPassword] = useState(false);

    // ── real-time email validation on signup ───────────────────────────────
    useEffect(() => {
        if (view !== 'signup') { setEmailError(''); return; }
        if (!email) { setEmailError(''); return; }
        setEmailError(emailRegex.test(email.trim()) ? '' : 'Please enter a valid email address.');
    }, [email, view]);

    useEffect(() => {
        let cancelled = false;

        // Initialize Google Identity Services for the NestJS /auth/google exchange.
        auth.initializeGoogle(
            () => {
                toast.success('Signed in with Google.', { duration: 2000 });
                if (onAuthSuccess) onAuthSuccess();
                else window.location.reload();
            },
            (err) => toast.error(err.message || 'Google sign in failed.')
        ).then(() => {
            if (cancelled) return;
            setGoogleReady(true);
            if (googleButtonRef.current && window.google?.accounts?.id) {
                googleButtonRef.current.innerHTML = '';
                window.google.accounts.id.renderButton(googleButtonRef.current, {
                    theme: 'outline',
                    size: 'large',
                    type: 'standard',
                    shape: 'rectangular',
                    text: 'continue_with',
                    logo_alignment: 'left',
                    width: googleButtonRef.current.offsetWidth || 384,
                });
            }
        }).catch((err) => {
            console.warn('Google sign-in unavailable:', err);
        });

        return () => { cancelled = true; };
    }, [onAuthSuccess, view]);

    // ── Enter-key progression ──────────────────────────────────────────────
    const handleKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        const form = e.currentTarget;
        const inputs = Array.from(form.elements).filter(
            (el) => el.tagName === 'INPUT' && !el.disabled
        );
        const idx = inputs.indexOf(e.target);
        if (idx > -1 && idx < inputs.length - 1) {
            e.preventDefault();
            inputs[idx + 1].focus();
        }
    };

    // reset when switching views
    const switchView = (next) => {
        setPassword('');
        setShowPassword(false);
        setEmailError('');
        setView(next);
    };

    // ── SIGN IN ────────────────────────────────────────────────────────────
    const handleSignIn = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await auth.signIn({ email: email.trim(), password });
            toast.success('Welcome back! 👋', { duration: 2000 });
            if (onAuthSuccess) onAuthSuccess();
            else window.location.reload();
        } catch (err) {
            const msg = err.message?.toLowerCase() || '';
            if (msg.includes('invalid') || msg.includes('credentials') || msg.includes('incorrect') || msg.includes('not found')) {
                toast.error('Invalid email or password.');
            } else {
                toast.error(err.message || 'Sign in failed.');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleSignIn = async () => {
        try {
            // Fallback initialization path for browsers that load GSI late.
            if (!googleReady) {
                await auth.initializeGoogle(
                    () => {
                        if (onAuthSuccess) onAuthSuccess();
                        else window.location.reload();
                    },
                    (err) => toast.error(err.message || 'Google sign in failed.')
                );
                setGoogleReady(true);
            }
            auth.promptGoogle();
        } catch (err) {
            toast.error(err.message || 'Google sign in is not available.');
        }
    };

    // ── SIGN UP ────────────────────────────────────────────────────────────
    const handleSignUp = async (e) => {
        e.preventDefault();
        if (emailError) { toast.error('Please fix the email error first.'); return; }
        setLoading(true);
        try {
            await auth.signUp({
                email: email.trim(),
                password,
                first_name: firstName.trim(),
                last_name: lastName.trim(),
            });
            setPendingEmail(email.trim());
            toast.success('Account created! Check your email for the OTP code. 📬', { duration: 5000 });
            switchView('confirm');
        } catch (err) {
            const msg = err.message?.toLowerCase() || '';
            if (msg.includes('already') && msg.includes('email')) {
                toast.error('This email is already registered.');
            } else if (msg.includes('rate limit') || msg.includes('too many')) {
                toast.error('Too many attempts. Please wait a few minutes.');
            } else {
                toast.error(err.message || 'Sign up failed.');
            }
        } finally {
            setLoading(false);
        }
    };

    // ── CONFIRM OTP ────────────────────────────────────────────────────────
    const handleConfirm = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await auth.confirmSignUp({ email: pendingEmail, code: otpCode.trim() });
            toast.success('Email confirmed! You can now sign in. ✅', { duration: 4000 });
            setEmail(pendingEmail);
            setPassword('');
            setOtpCode('');
            switchView('signin');
        } catch (err) {
            toast.error(err.message || 'Invalid or expired code.');
        } finally {
            setLoading(false);
        }
    };

    // ── FORGOT PASSWORD step 1 ─────────────────────────────────────────────
    const handleForgotPassword = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await auth.forgotPassword(forgotEmail.trim());
            toast.success('If that account exists, a reset code has been sent. 📩', { duration: 5000 });
            switchView('forgot-confirm');
        } catch (_) {
            // Neutral message to prevent enumeration
            toast.success('If that account exists, a reset code has been sent. 📩', { duration: 5000 });
            switchView('forgot-confirm');
        } finally {
            setLoading(false);
        }
    };

    // ── FORGOT PASSWORD step 2 ─────────────────────────────────────────────
    const handleForgotConfirm = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await auth.confirmForgotPassword({
                email: forgotEmail.trim(),
                code: resetCode.trim(),
                new_password: newPassword,
            });
            toast.success('Password reset successfully! Please sign in. 🎉', { duration: 4000 });
            setForgotEmail('');
            setResetCode('');
            setNewPassword('');
            switchView('signin');
        } catch (err) {
            toast.error(err.message || 'Code invalid or expired.');
        } finally {
            setLoading(false);
        }
    };

    // ── INPUT class helpers ────────────────────────────────────────────────
    const inputCls = (hasError) =>
        `appearance-none block w-full pl-10 pr-3 py-3 border rounded-xl focus:outline-none focus:ring-2 transition-all sm:text-sm ${hasError
            ? 'border-rose-300 bg-rose-50 focus:ring-rose-500'
            : 'border-slate-200 bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:ring-blue-500'
        }`;

    const plainInputCls =
        'appearance-none block w-full pl-10 pr-3 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm';

    // ── RENDER ─────────────────────────────────────────────────────────────
    return (
        <div className="min-h-screen flex text-slate-900" style={{ fontFamily: "'Inter', sans-serif" }}>

            {/* LEFT PANEL — Branding (hidden on mobile) */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-gradient-to-br from-blue-900 via-indigo-900 to-slate-900 overflow-hidden items-center justify-center p-12">
                <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, white 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
                <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-blue-500 opacity-20 blur-3xl" />
                <div className="absolute top-1/4 -right-20 w-80 h-80 rounded-full bg-indigo-500 opacity-20 blur-3xl" />

                <div className="relative z-10 max-w-lg text-white">
                    <div className="flex items-center gap-3 mb-8">
                        <div className="p-3 bg-white/10 rounded-xl backdrop-blur-sm border border-white/20 shadow-xl">
                            <ShieldCheck className="w-10 h-10 text-blue-300" />
                        </div>
                        <h1 className="text-4xl font-extrabold tracking-tight">PolicyWise</h1>
                    </div>

                    <h2 className="text-3xl font-bold leading-tight mb-6">
                        Smart AI Insurance Analysis <br />
                        <span className="text-blue-300">for modern advisors.</span>
                    </h2>

                    <p className="text-lg text-blue-100/80 mb-10 leading-relaxed">
                        Instantly analyze, compare, and extract critical coverage details from dense health insurance policy documents using cutting-edge AI.
                    </p>

                    <div className="space-y-5">
                        {[
                            { Icon: Zap, title: 'Instant Precision Parsing', desc: 'Extract exact coverage limits, sum insured, and Super Credit bonuses instantly.' },
                            { Icon: FileSearch, title: 'Smart Policy Comparison', desc: 'Effortlessly compare features and exclusions across multiple health documents.' },
                            { Icon: ShieldCheck, title: 'Regulatory Context', desc: 'Automatically identifies standard IRDAI-approved features and rights.' },
                        ].map(({ Icon, title, desc }) => (
                            <div key={title} className="flex items-center gap-4 text-blue-50">
                                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-800/50 flex items-center justify-center border border-blue-400/30">
                                    <Icon className="w-5 h-5 text-blue-300" />
                                </div>
                                <div>
                                    <h3 className="font-semibold text-lg">{title}</h3>
                                    <p className="text-sm text-blue-200">{desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* RIGHT PANEL — Auth form */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-6 sm:p-12 bg-white relative">

                {/* Mobile logo */}
                <div className="lg:hidden w-full max-w-md mb-8 flex items-center gap-3 justify-center">
                    <ShieldCheck className="w-8 h-8 text-blue-600" />
                    <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">PolicyWise</h1>
                </div>

                <div className="w-full max-w-md" style={{ animation: 'slideUp 0.5s ease-out forwards' }}>

                    {/* ── SIGN IN ── */}
                    {view === 'signin' && (
                        <>
                            <div className="mb-8">
                                <h2 className="text-2xl font-bold mb-2">Welcome back</h2>
                                <p className="text-slate-500 text-sm">Enter your details to access your workspace.</p>
                                <div className="mt-6 flex p-1 bg-slate-100 rounded-lg">
                                    <button onClick={() => switchView('signin')} type="button" className="flex-1 py-2 text-sm font-semibold rounded-md bg-white shadow text-blue-700 transition-all duration-200">Login</button>
                                    <button onClick={() => switchView('signup')} type="button" className="flex-1 py-2 text-sm font-semibold rounded-md text-slate-500 hover:text-slate-700 transition-all duration-200">Sign Up</button>
                                </div>
                            </div>

                            <form className="space-y-5" onSubmit={handleSignIn} onKeyDown={handleKeyDown}>
                                <div ref={googleButtonRef} className="w-full min-h-[44px]" />
                                {!googleReady && (
                                    <button
                                        type="button"
                                        onClick={handleGoogleSignIn}
                                        disabled={loading}
                                        className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                    >
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-base font-black text-blue-600">G</span>
                                        Continue with Google
                                    </button>
                                )}

                                <div className="flex items-center gap-3">
                                    <div className="h-px flex-1 bg-slate-200" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">or</span>
                                    <div className="h-px flex-1 bg-slate-200" />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                                    <div className="relative group">
                                        <InputIcon icon={Mail} />
                                        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={plainInputCls} />
                                    </div>
                                </div>

                                <div>
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="block text-sm font-medium text-slate-700">Password</label>
                                        <button type="button" onClick={() => switchView('forgot')} className="text-sm font-semibold text-blue-600 hover:text-blue-500 transition-colors">Forgot password?</button>
                                    </div>
                                    <div className="relative group">
                                        <InputIcon icon={Lock} />
                                        <input
                                            type={showPassword ? 'text' : 'password'} required value={password}
                                            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
                                            className="appearance-none block w-full pl-10 pr-10 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm"
                                        />
                                        <button type="button" className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600" onClick={() => setShowPassword(!showPassword)}>
                                            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="pt-2">
                                    <SubmitButton loading={loading} label="Sign In" loadingLabel="Authenticating..." disabled={!email.trim() || !password.trim()} />
                                </div>
                            </form>
                        </>
                    )}

                    {/* ── SIGN UP ── */}
                    {view === 'signup' && (
                        <>
                            <div className="mb-8">
                                <h2 className="text-2xl font-bold mb-2">Create your account</h2>
                                <p className="text-slate-500 text-sm">Join PolicyWise to start analyzing policies.</p>
                                <div className="mt-6 flex p-1 bg-slate-100 rounded-lg">
                                    <button onClick={() => switchView('signin')} type="button" className="flex-1 py-2 text-sm font-semibold rounded-md text-slate-500 hover:text-slate-700 transition-all duration-200">Login</button>
                                    <button onClick={() => switchView('signup')} type="button" className="flex-1 py-2 text-sm font-semibold rounded-md bg-white shadow text-blue-700 transition-all duration-200">Sign Up</button>
                                </div>
                            </div>

                            <form className="space-y-5" onSubmit={handleSignUp} onKeyDown={handleKeyDown}>
                                <div ref={googleButtonRef} className="w-full min-h-[44px]" />
                                {!googleReady && (
                                    <button
                                        type="button"
                                        onClick={handleGoogleSignIn}
                                        disabled={loading}
                                        className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                    >
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-base font-black text-blue-600">G</span>
                                        Continue with Google
                                    </button>
                                )}

                                <div className="flex items-center gap-3">
                                    <div className="h-px flex-1 bg-slate-200" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">or</span>
                                    <div className="h-px flex-1 bg-slate-200" />
                                </div>

                                {/* First + Last name */}
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                                        <input
                                            type="text" required value={firstName}
                                            onChange={(e) => setFirstName(e.target.value.replace(/[^a-zA-Z\s-]/g, ''))}
                                            placeholder="John"
                                            className="appearance-none block w-full px-3 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                                        <input
                                            type="text" required value={lastName}
                                            onChange={(e) => setLastName(e.target.value.replace(/[^a-zA-Z\s-]/g, ''))}
                                            placeholder="Doe"
                                            className="appearance-none block w-full px-3 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm"
                                        />
                                    </div>
                                </div>

                                {/* Email */}
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Email address</label>
                                    <div className="relative group">
                                        <InputIcon icon={Mail} />
                                        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputCls(!!emailError)} />
                                    </div>
                                    {emailError && <p className="text-xs text-rose-600 mt-1.5 font-medium">{emailError}</p>}
                                </div>

                                {/* Password */}
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                                    <div className="relative group">
                                        <InputIcon icon={Lock} />
                                        <input
                                            type={showPassword ? 'text' : 'password'} required value={password}
                                            onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 characters"
                                            className="appearance-none block w-full pl-10 pr-10 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm"
                                        />
                                        <button type="button" className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600" onClick={() => setShowPassword(!showPassword)}>
                                            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="pt-2">
                                    <SubmitButton
                                        loading={loading} label="Create Account" loadingLabel="Creating Account..."
                                        disabled={!email.trim() || !!emailError || !firstName.trim() || !lastName.trim() || password.length < 8}
                                    />
                                </div>
                            </form>
                        </>
                    )}

                    {/* ── CONFIRM OTP ── */}
                    {view === 'confirm' && (
                        <>
                            <div className="mb-8">
                                <h2 className="text-2xl font-bold mb-2">Verify your email</h2>
                                <p className="text-slate-500 text-sm">
                                    We sent a 6-digit code to <span className="font-semibold text-slate-700">{pendingEmail}</span>. Enter it below to activate your account.
                                </p>
                            </div>

                            <form className="space-y-5" onSubmit={handleConfirm} onKeyDown={handleKeyDown}>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Verification Code</label>
                                    <div className="relative group">
                                        <InputIcon icon={KeyRound} />
                                        <input
                                            type="text" required value={otpCode}
                                            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            placeholder="123456" maxLength={6}
                                            className={plainInputCls}
                                        />
                                    </div>
                                </div>

                                <div className="pt-2">
                                    <SubmitButton loading={loading} label="Confirm Email" loadingLabel="Verifying..." disabled={otpCode.length !== 6} />
                                </div>

                                <div className="text-center">
                                    <button type="button" onClick={() => switchView('signup')} className="text-sm text-slate-500 hover:text-blue-600 transition-colors">
                                        &larr; Back to sign up
                                    </button>
                                </div>
                            </form>
                        </>
                    )}

                    {/* ── FORGOT PASSWORD step 1 ── */}
                    {view === 'forgot' && (
                        <>
                            <div className="mb-8">
                                <h2 className="text-2xl font-bold mb-2">Reset Password</h2>
                                <p className="text-slate-500 text-sm">Enter your email and we'll send you a reset code.</p>
                            </div>

                            <form className="space-y-5" onSubmit={handleForgotPassword} onKeyDown={handleKeyDown}>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Email Address</label>
                                    <div className="relative group">
                                        <InputIcon icon={Mail} />
                                        <input type="email" required value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} placeholder="you@example.com" className={plainInputCls} />
                                    </div>
                                </div>

                                <SubmitButton loading={loading} label="Send Reset Code" loadingLabel="Sending..." disabled={!forgotEmail.trim()} />

                                <div className="text-center">
                                    <button type="button" onClick={() => switchView('signin')} className="text-sm text-slate-500 hover:text-blue-600 transition-colors">
                                        &larr; Back to sign in
                                    </button>
                                </div>
                            </form>
                        </>
                    )}

                    {/* ── FORGOT PASSWORD step 2 ── */}
                    {view === 'forgot-confirm' && (
                        <>
                            <div className="mb-8">
                                <h2 className="text-2xl font-bold mb-2">Set New Password</h2>
                                <p className="text-slate-500 text-sm">
                                    Enter the code sent to <span className="font-semibold text-slate-700">{forgotEmail || 'your email'}</span> and choose a new password.
                                </p>
                            </div>

                            <form className="space-y-5" onSubmit={handleForgotConfirm} onKeyDown={handleKeyDown}>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Reset Code</label>
                                    <div className="relative group">
                                        <InputIcon icon={KeyRound} />
                                        <input
                                            type="text" required value={resetCode}
                                            onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            placeholder="123456" maxLength={6}
                                            className={plainInputCls}
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                                    <div className="relative group">
                                        <InputIcon icon={Lock} />
                                        <input
                                            type={showNewPassword ? 'text' : 'password'} required value={newPassword}
                                            onChange={(e) => setNewPassword(e.target.value)} placeholder="Min. 8 characters"
                                            className="appearance-none block w-full pl-10 pr-10 py-3 border border-slate-200 rounded-xl bg-slate-50 focus:bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all sm:text-sm"
                                        />
                                        <button type="button" className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600" onClick={() => setShowNewPassword(!showNewPassword)}>
                                            {showNewPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="pt-2">
                                    <SubmitButton loading={loading} label="Reset Password" loadingLabel="Resetting..." disabled={resetCode.length !== 6 || newPassword.length < 8} />
                                </div>

                                <div className="text-center">
                                    <button type="button" onClick={() => switchView('forgot')} className="text-sm text-slate-500 hover:text-blue-600 transition-colors">
                                        &larr; Re-send code
                                    </button>
                                </div>
                            </form>
                        </>
                    )}

                </div>
            </div>
        </div>
    );
}
