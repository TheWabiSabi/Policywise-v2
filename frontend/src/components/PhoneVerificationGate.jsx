import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { toast } from 'react-hot-toast';
import { Phone, ShieldAlert, LogOut, ShieldCheck, Zap, FileSearch } from 'lucide-react';

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

export default function PhoneVerificationGate({ session, onVerified }) {
    const [countryCode, setCountryCode] = useState('+91');
    const [isCountryDropdownOpen, setIsCountryDropdownOpen] = useState(false);
    const [phone, setPhone] = useState('');
    const [otp, setOtp] = useState('');
    const [otpSent, setOtpSent] = useState(false);
    const [resendCount, setResendCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [timer, setTimer] = useState(0);
    const dropdownRef = useRef(null);

    useEffect(() => {
        let interval;
        if (timer > 0) {
            interval = setInterval(() => setTimer(prev => prev - 1), 1000);
        }
        return () => clearInterval(interval);
    }, [timer]);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsCountryDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleSendOtp = async () => {
        if (phone.trim().length !== 10) {
            toast.error('Please enter a valid 10-digit phone number.');
            return;
        }

        setLoading(true);
        const fullPhone = `${countryCode}${phone.trim()}`;
        
        try {
            // Tells Supabase to send an OTP to attach this phone to the currently logged in user
            const { error } = await supabase.auth.updateUser({ phone: fullPhone });
            if (error) throw error;
            
            if (otpSent) {
                setResendCount(prev => prev + 1);
            }
            
            setOtpSent(true);
            setOtp('');
            setTimer(60);
            toast.success(`OTP sent via SMS to ${fullPhone}!`, { duration: 4000 });
        } catch (err) {
            toast.error(err.message || 'Failed to send OTP. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyOtp = async () => {
        if (otp.trim().length !== 6) {
            toast.error('Please enter the 6-digit OTP.');
            return;
        }

        setLoading(true);
        const fullPhone = `${countryCode}${phone.trim()}`;
        
        try {
            // Verify the OTP specifically for a phone change/addition event
            const { error } = await supabase.auth.verifyOtp({
                phone: fullPhone,
                token: otp.trim(),
                type: 'phone_change'
            });
            if (error) throw error;
            
            // Once Supabase internal auth acknowledges the phone, sync it to our public profile table
            await supabase.from('profiles').update({ phone: fullPhone }).eq('id', session.user.id);
            
            toast.success('Secure setup complete! Welcome to the Dashboard.', { duration: 3000 });
            
            // Trigger parent to re-render without the gate
            onVerified(fullPhone);
        } catch (err) {
            toast.error('Invalid OTP. Please check the code and try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleSignOut = async () => {
        await supabase.auth.signOut();
    };

    return (
        <div className="min-h-screen flex text-slate-900" style={{ fontFamily: "'Inter', sans-serif" }}>
            {/* LEFT PANEL - BRANDING (Hidden on Mobile) */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-gradient-to-br from-blue-900 via-indigo-900 to-slate-900 overflow-hidden items-center justify-center p-12">
                <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, white 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
                <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-blue-500 opacity-20 blur-3xl"></div>
                <div className="absolute top-1/4 -right-20 w-80 h-80 rounded-full bg-indigo-500 opacity-20 blur-3xl"></div>

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
                        <div className="flex items-center gap-4 text-blue-50">
                            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-800/50 flex items-center justify-center border border-blue-400/30">
                                <Zap className="w-5 h-5 text-blue-300" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-lg">Instant Precision Parsing</h3>
                                <p className="text-sm text-blue-200">Extract exact coverage limits, sum insured, and Super Credit bonuses instantly.</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4 text-blue-50">
                            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-800/50 flex items-center justify-center border border-blue-400/30">
                                <FileSearch className="w-5 h-5 text-blue-300" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-lg">Smart Policy Comparison</h3>
                                <p className="text-sm text-blue-200">Effortlessly compare features and exclusions across multiple health documents.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* RIGHT PANEL - VERIFICATION FORM */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-6 sm:p-12 bg-white relative">
                
                {/* Mobile Header (Shows only on small screens) */}
                <div className="lg:hidden w-full max-w-md mb-8 flex items-center gap-3 justify-center">
                    <ShieldCheck className="w-8 h-8 text-blue-600" />
                    <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">PolicyWise</h1>
                </div>

                <div className="w-full max-w-md" style={{ animation: 'slideUp 0.5s ease-out forwards' }}>
                    <div className="mb-8">
                        <h2 className="text-2xl font-bold mb-2 text-slate-900">Verify your phone number</h2>
                        <p className="text-sm text-slate-500 leading-relaxed">
                            Please link a verified phone number to your account to continue to the PolicyWise dashboard.
                        </p>
                    </div>

                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-semibold text-slate-700 mb-2">
                                Phone Number
                            </label>
                            
                            <div className="flex gap-2">
                                {/* Country code dropdown */}
                                <div className="relative w-32" ref={dropdownRef}>
                                    <button
                                        type="button" disabled={otpSent}
                                        onClick={() => setIsCountryDropdownOpen(!isCountryDropdownOpen)}
                                        className={`flex items-center justify-between w-full pl-3 pr-2 py-3 border rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 transition-all sm:text-sm ${otpSent ? 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-75' : 'border-slate-200 bg-white hover:bg-slate-50 shadow-sm'}`}
                                    >
                                        <span className="flex items-center gap-1.5 font-medium">
                                            {countryList.find(c => c.code === countryCode)?.flag} {countryCode}
                                        </span>
                                        {!otpSent && (
                                            <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                        )}
                                    </button>
                                    
                                    {isCountryDropdownOpen && !otpSent && (
                                        <div className="absolute z-50 bottom-full mb-2 left-0 w-64 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg shadow-slate-200/50 py-1">
                                            {countryList.map((country) => (
                                                <button key={country.name} type="button"
                                                    onClick={() => { setCountryCode(country.code); setIsCountryDropdownOpen(false); }}
                                                    className={`flex items-center w-full px-4 py-2.5 text-sm hover:bg-slate-50 transition-colors ${countryCode === country.code ? 'bg-rose-50/50 text-rose-700 font-medium' : 'text-slate-700'}`}>
                                                    <span className="mr-3 text-base">{country.flag}</span>
                                                    <span className="flex-1 text-left truncate">{country.name}</span>
                                                    <span className="text-slate-400 font-mono ml-3 text-xs">{country.code}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="relative flex-1 group shadow-sm rounded-xl">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400 group-focus-within:text-rose-500 transition-colors">
                                        <Phone className="w-5 h-5" />
                                    </div>
                                    <input
                                        type="tel" required disabled={otpSent} value={phone} maxLength={10}
                                        onChange={(e) => {
                                            const val = e.target.value.replace(/\D/g, '');
                                            if (val.length <= 10) setPhone(val);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && phone.trim().length === 10 && !loading) {
                                                handleSendOtp();
                                            }
                                        }}
                                        placeholder="10-digit number"
                                        className={`appearance-none block w-full pl-10 pr-3 py-3 border rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 transition-all sm:text-sm ${
                                            otpSent ? 'bg-slate-50 border-slate-200 cursor-not-allowed' : 'border-slate-200 bg-white focus:border-rose-300 focus:ring-rose-500'
                                        }`}
                                    />
                                </div>
                            </div>

                            {!otpSent && (
                                <button type="button" onClick={handleSendOtp} disabled={phone.trim().length !== 10 || loading}
                                    className="w-full mt-4 flex justify-center py-3 px-4 shadow-sm rounded-xl text-sm font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                                    {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" /> Sending...</> : 'Send Verification OTP'}
                                </button>
                            )}
                        </div>

                        {otpSent && (
                            <div className="pt-2 border-t border-slate-100" style={{ animation: 'slideUp 0.3s ease-out forwards' }}>
                                <label className="block text-sm font-semibold text-slate-700 mb-2">
                                    Enter 6-Digit Code
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text" value={otp} maxLength={6}
                                        onChange={(e) => {
                                            const val = e.target.value.replace(/\D/g, '');
                                            if (val.length <= 6) setOtp(val);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && otp.trim().length === 6 && !loading) {
                                                handleVerifyOtp();
                                            }
                                        }}
                                        placeholder="000000"
                                        className="flex-1 px-4 py-3 border shadow-sm border-emerald-200 rounded-xl bg-emerald-50 text-slate-900 placeholder-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-center text-lg font-mono tracking-widest"
                                    />
                                    <button type="button" onClick={handleVerifyOtp} disabled={otp.trim().length !== 6 || loading}
                                        className="shrink-0 px-6 py-3 rounded-xl shadow-sm text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center">
                                        {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Verify'}
                                    </button>
                                </div>
                                <div className="text-xs text-center text-slate-500 mt-5 flex items-center justify-center gap-3">
                                    <span>Didn't get the code?</span>
                                    {resendCount < 3 ? (
                                        <button type="button" onClick={handleSendOtp} disabled={loading || timer > 0} className={`font-bold transition-colors disabled:opacity-50 ${timer > 0 ? 'text-slate-400 cursor-not-allowed' : 'text-emerald-600 hover:text-emerald-700'}`}>
                                            {timer > 0 ? `Resend in ${timer}s` : `Resend OTP (${3 - resendCount} left)`}
                                        </button>
                                    ) : (
                                        <span className="text-slate-400 font-medium">Max resends reached</span>
                                    )}
                                    <span className="text-slate-300">|</span>
                                    <button type="button" onClick={() => { setOtpSent(false); setResendCount(0); setTimer(0); }} className="text-rose-600 font-semibold hover:underline">Change number</button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="mt-8 pt-6 flex justify-center">
                        <button onClick={handleSignOut} className="text-sm font-medium text-slate-500 hover:text-slate-700 flex items-center gap-1.5 transition-colors">
                            <LogOut className="w-4 h-4" /> Sign out for now
                        </button>
                    </div>
                </div>
            </div>

            <style>{`
                @keyframes slideUp {
                    0% { opacity: 0; transform: translateY(10px); }
                    100% { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
}
