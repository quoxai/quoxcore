import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useVoiceCapture — unified push-to-talk pipeline.
 *
 * Owns: mic permission, MediaRecorder, AudioContext analyser, transcribe POST.
 * Exposes phase, live analyser data, duration, level, transcript, and control methods.
 * Callers get back a single hook, no race with half-done states.
 *
 * Phases: idle → requesting-mic → listening → transcribing → (done | cancelled | error)
 * After terminal phase, auto-returns to idle within ~1.2s so UI animates out cleanly.
 */
const API_BASE = '/webhook';
const FFT_SIZE = 512;
const MAX_DURATION_MS = 30_000;
const TERMINAL_RESET_MS = 1200;

export function useVoiceCapture({ onTranscript, onError } = {}) {
    const [phase, setPhase] = useState('idle');
    const [durationMs, setDurationMs] = useState(0);
    const [level, setLevel] = useState(0);
    const [transcript, setTranscript] = useState('');
    const [errorMessage, setErrorMessage] = useState(null);

    const streamRef = useRef(null);
    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const audioCtxRef = useRef(null);
    const analyserRef = useRef(null);
    const rafRef = useRef(null);
    const freqDataRef = useRef(null);
    const timeDataRef = useRef(null);
    const startedAtRef = useRef(0);
    const durationTimerRef = useRef(null);
    const autoStopTimerRef = useRef(null);
    const resetTimerRef = useRef(null);
    const cancelledRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const cleanup = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        if (durationTimerRef.current) clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
        if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
        try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* */ }
        streamRef.current = null;
        try { audioCtxRef.current?.close(); } catch { /* */ }
        audioCtxRef.current = null;
        analyserRef.current = null;
        recorderRef.current = null;
    }, []);

    const getAnalyserData = useCallback(() => {
        // Returns { freq: Uint8Array, time: Uint8Array } — both aliased; do not mutate.
        if (!analyserRef.current) return null;
        if (!freqDataRef.current) freqDataRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);
        if (!timeDataRef.current) timeDataRef.current = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteFrequencyData(freqDataRef.current);
        analyserRef.current.getByteTimeDomainData(timeDataRef.current);
        return { freq: freqDataRef.current, time: timeDataRef.current };
    }, []);

    const scheduleReset = useCallback(() => {
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            setPhase('idle');
            setDurationMs(0);
            setLevel(0);
            setTranscript('');
            setErrorMessage(null);
        }, TERMINAL_RESET_MS);
    }, []);

    const fail = useCallback((message) => {
        console.error('[useVoiceCapture]', message);
        setErrorMessage(message);
        setPhase('error');
        onError?.(message);
        cleanup();
        scheduleReset();
    }, [onError, cleanup, scheduleReset]);

    const start = useCallback(async () => {
        if (phase === 'listening' || phase === 'requesting-mic' || phase === 'transcribing') return;
        cancelledRef.current = false;
        setErrorMessage(null);
        setTranscript('');
        setDurationMs(0);
        setLevel(0);
        setPhase('requesting-mic');

        if (!navigator.mediaDevices?.getUserMedia) {
            fail(window.location.protocol === 'http:'
                ? `Microphone requires HTTPS or localhost (you are on ${window.location.host} over HTTP).`
                : 'Microphone requires a secure context.');
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            const name = err?.name;
            if (name === 'NotAllowedError') return fail('Microphone permission denied. Click the lock icon in the address bar → allow microphone.');
            if (name === 'NotFoundError') return fail('No microphone detected. Plug one in and try again.');
            if (name === 'NotReadableError' || name === 'AbortError') return fail('Microphone is in use by another application.');
            return fail(`Microphone error: ${err?.message || name || 'unknown'}`);
        }
        if (!mountedRef.current || cancelledRef.current) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }
        streamRef.current = stream;

        const tracks = stream.getAudioTracks();
        if (tracks.length === 0 || tracks.every(t => t.muted)) {
            return fail('Microphone returned no audio track (may be muted at the OS level).');
        }

        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            audioCtxRef.current = new Ctx();
            analyserRef.current = audioCtxRef.current.createAnalyser();
            analyserRef.current.fftSize = FFT_SIZE;
            analyserRef.current.smoothingTimeConstant = 0.75;
            const source = audioCtxRef.current.createMediaStreamSource(stream);
            source.connect(analyserRef.current);
        } catch (err) {
            return fail(`Audio analysis setup failed: ${err?.message || err}`);
        }

        // Build MediaRecorder — pick a mime the browser will honor
        let recorder;
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        const mime = candidates.find(m => {
            try { return window.MediaRecorder && MediaRecorder.isTypeSupported?.(m); } catch { return false; }
        }) || '';
        try {
            recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch (err) {
            return fail(`MediaRecorder unavailable: ${err?.message || err}`);
        }
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
        recorder.onerror = (e) => fail(`Recorder error: ${e?.error?.message || 'unknown'}`);
        recorder.onstop = async () => {
            const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
            // Stop the stream tracks before the network hop so the OS mic indicator clears immediately
            streamRef.current?.getTracks().forEach(t => t.stop());
            streamRef.current = null;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            if (durationTimerRef.current) clearInterval(durationTimerRef.current);
            durationTimerRef.current = null;

            if (cancelledRef.current) {
                setPhase('cancelled');
                scheduleReset();
                return;
            }
            if (blob.size < 400) {
                setPhase('error');
                setErrorMessage('No audio captured — microphone level may be zero.');
                onError?.('No audio captured.');
                scheduleReset();
                return;
            }
            await transcribe(blob);
        };

        try { recorder.start(250); } catch (err) {
            return fail(`Failed to start recorder: ${err?.message || err}`);
        }

        startedAtRef.current = Date.now();
        setPhase('listening');

        // duration + level ticker
        durationTimerRef.current = setInterval(() => {
            if (!mountedRef.current) return;
            setDurationMs(Date.now() - startedAtRef.current);
        }, 100);

        const tick = () => {
            const a = analyserRef.current;
            if (!a) return;
            if (!timeDataRef.current) timeDataRef.current = new Uint8Array(a.fftSize);
            a.getByteTimeDomainData(timeDataRef.current);
            // RMS over time-domain samples (centered at 128)
            let sum = 0;
            for (let i = 0; i < timeDataRef.current.length; i++) {
                const v = (timeDataRef.current[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / timeDataRef.current.length);
            setLevel(Math.min(1, rms * 2.2));
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        // auto-stop safety net
        autoStopTimerRef.current = setTimeout(() => {
            if (recorderRef.current?.state === 'recording') stop();
        }, MAX_DURATION_MS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, fail, scheduleReset, onError]);

    const stop = useCallback(() => {
        if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
        const r = recorderRef.current;
        if (r && r.state === 'recording') {
            try { r.stop(); } catch { /* */ }
        }
    }, []);

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        stop();
    }, [stop]);

    const transcribe = useCallback(async (blob) => {
        setPhase('transcribing');
        try {
            const fd = new FormData();
            fd.append('audio', blob, `recording.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
            const resp = await fetch(`${API_BASE}/transcribe`, { method: 'POST', body: fd });
            if (!resp.ok) {
                let detail = `HTTP ${resp.status}`;
                try { const j = await resp.json(); detail = j?.error || j?.message || detail; } catch { /* */ }
                if (resp.status === 503 || resp.status === 401 || resp.status === 403) {
                    return fail('Speech-to-text is not configured. Add your OpenAI key in Settings → Core Integrations.');
                }
                return fail(`Transcription failed (${detail}).`);
            }
            const data = await resp.json();
            const text = (data?.text || data?.transcript || '').trim();
            if (!text) {
                setPhase('error');
                setErrorMessage('Nothing heard — try speaking a bit louder or closer to the mic.');
                onError?.('Empty transcript.');
                scheduleReset();
                return;
            }
            setTranscript(text);
            setPhase('done');
            try { onTranscript?.(text); } catch (err) { console.error('[useVoiceCapture] onTranscript threw:', err); }
            scheduleReset();
        } catch (err) {
            fail(`Transcription network error: ${err?.message || err}`);
        }
    }, [fail, onTranscript, onError, scheduleReset]);

    return {
        phase,
        durationMs,
        level,
        transcript,
        errorMessage,
        getAnalyserData,
        start,
        stop,
        cancel,
    };
}

export default useVoiceCapture;
