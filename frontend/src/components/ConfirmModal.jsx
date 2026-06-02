import React from 'react';

export default function ConfirmModal({ 
    isOpen, 
    title, 
    message, 
    onConfirm, 
    onCancel, 
    confirmText = "Confirm", 
    cancelText = "Cancel", 
    isDestructive = true 
}) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm px-4">
            <div 
                className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full animate-in fade-in zoom-in-95 duration-200"
            >
                <div className="flex items-center gap-3 mb-4">
                    {isDestructive ? (
                        <div className="w-10 h-10 bg-rose-100 rounded-full flex items-center justify-center text-rose-600 text-xl flex-shrink-0">
                            ⚠️
                        </div>
                    ) : (
                        <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xl flex-shrink-0">
                            ℹ️
                        </div>
                    )}
                    <h3 className="text-xl font-bold text-slate-800">{title}</h3>
                </div>
                
                <p className="text-slate-600 font-medium text-sm mb-6 whitespace-pre-line">
                    {message}
                </p>

                <div className="flex gap-3 justify-end">
                    <button
                        onClick={onCancel}
                        className="px-5 py-2.5 rounded-xl text-slate-600 font-bold hover:bg-slate-100 transition"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={onConfirm}
                        className={`px-5 py-2.5 rounded-xl font-bold text-white transition shadow-sm ${
                            isDestructive 
                            ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-200' 
                            : 'bg-blue-600 hover:bg-blue-700 shadow-blue-200'
                        }`}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
