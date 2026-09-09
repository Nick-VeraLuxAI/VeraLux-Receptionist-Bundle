import React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, Save, Upload, Square, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, InlineNote } from "@/components/vl/Cards";
import { Pill } from "@/components/vl/Pills";
import { QueryBoundary, CardSkeleton } from "@/components/vl/States";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { normalizeTtsPreviewJob, ttsPreviewAudioSrc, fromTtsConfigSave } from "@/lib/controlPlaneAdapters";
import { voicesForMode, languagesForMode, defaultVoiceLang, qwen3InstructForTuning, coerceQwen3Language, coerceMagpieLanguage, coerceMeloLanguage, magpieTuningForPreset, meloTuningForPreset, meloLanguageForSpeaker, kokoroLanguageForVoice, kokoroVoiceForLanguage, coerceKokoroVoice, PRESET_ONLY_TTS } from "@/lib/voiceCatalog";

const PRESETS = [
  { id: "neutral", label: "Neutral", hint: "Balanced and clear" },
  { id: "warm", label: "Warm", hint: "Friendly and welcoming" },
  { id: "energetic", label: "Energetic", hint: "Upbeat and quick" },
  { id: "calm", label: "Calm", hint: "Measured and reassuring" },
];
const ENGINES = { kokoro_http: "Kokoro (on-prem)" };
const URL_FIELDS = ["kokoroUrl", "coquiXttsUrl", "chatterboxUrl", "qwen3TtsUrl", "misoTtsUrl", "magpieTtsUrl", "meloTtsUrl"];
const isPresetOnly = (mode) => PRESET_ONLY_TTS.has(mode);

function sliderNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Async preview: POST /api/tts/preview/async -> poll GET until ready -> play. */
function previewWavUrl(job) {
  const src = ttsPreviewAudioSrc(job);
  if (!src) return null;
  if (!job?.audioWavBase64) return src;
  const bin = atob(job.audioWavBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: job.contentType || "audio/wav" }));
}

export function useVoicePreview(api) {
  const [state, setState] = React.useState("idle"); // idle | pending | playing | error
  const audioRef = React.useRef(null);
  const objectUrlRef = React.useRef(null);
  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setState("idle");
  };
  const play = async (text, overrides = {}) => {
    stop();
    setState("pending");
    try {
      const start = await api.post("/api/tts/preview/async", {
        ...(text ? { text } : {}),
        ...overrides,
      });
      let job = normalizeTtsPreviewJob(start);
      for (let i = 0; i < 40 && job.status !== "ready" && job.status !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        job = normalizeTtsPreviewJob(
          await api.get(`/api/tts/preview/async/${start.id}`, { headers: { Accept: "application/json" } }),
        );
      }
      if (job.status !== "ready") throw new Error(job.error || "Preview is taking too long. Try again.");
      const src = previewWavUrl(job);
      if (!src) throw new Error("Preview finished but no audio was returned.");
      if (src.startsWith("blob:")) objectUrlRef.current = src;
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => setState("idle");
      audio.onerror = () => setState("error");
      await audio.play();
      setState("playing");
    } catch (e) {
      setState("error");
      toast.error("Couldn't play preview", { description: errorMessage(e) });
    }
  };
  React.useEffect(() => () => stop(), []);
  return { state, play, stop };
}

export const VoiceEditor = ({ api, mode, tenantId, onSaved, greeting }) => {
  const q = useQuery({ queryKey: [mode, "tts", tenantId], queryFn: () => api.get("/api/tts/config"), enabled: !!tenantId });
  return (
    <QueryBoundary query={q} skeleton={<CardSkeleton lines={8} />}>
      {(data) => <VoiceForm key={data.updatedAt || "init"} data={data} api={api} mode={mode} onSaved={onSaved} greeting={greeting} />}
    </QueryBoundary>
  );
};

const VoiceForm = ({ data, api, mode, onSaved, greeting }) => {
  const initialMagpie = magpieTuningForPreset(data.preset || "neutral");
  const initialMelo = meloTuningForPreset(data.preset || "neutral");
  const [form, setForm] = React.useState({
    ttsMode: "kokoro_http",
    preset: data.preset || "neutral",
    defaultVoiceMode: "preset",
    voiceId: coerceKokoroVoice(data.voiceId),
    language: kokoroLanguageForVoice(coerceKokoroVoice(data.voiceId)) || "en-US",
    rate: Number(data.rate || 1),
    clonedVoice: data.clonedVoice || null,
    magpieTemperature: Number(data.magpieTemperature ?? initialMagpie.temperature),
    magpieCfgScale: Number(data.magpieCfgScale ?? initialMagpie.cfgScale),
    magpieTopK: Number(data.magpieTopK ?? initialMagpie.topK),
    magpieUseCfg: data.magpieUseCfg === true,
    magpieApplyTn: data.magpieApplyTn === true,
    meloSdpRatio: Number(data.meloSdpRatio ?? initialMelo.sdpRatio),
    meloNoiseScale: Number(data.meloNoiseScale ?? initialMelo.noiseScale),
    meloNoiseScaleW: Number(data.meloNoiseScaleW ?? initialMelo.noiseScaleW),
  });
  const [urls, setUrls] = React.useState(() => Object.fromEntries(URL_FIELDS.filter((f) => data[f] !== undefined && data[f] !== "[redacted]").map((f) => [f, data[f] || ""])));
  const [saving, setSaving] = React.useState(false);
  const [liveState, setLiveState] = React.useState("live");
  const [lastSave, setLastSave] = React.useState(null);
  const [uploading, setUploading] = React.useState(false);
  const [previewText, setPreviewText] = React.useState(greeting || "");
  const preview = useVoicePreview(api);
  const formRef = React.useRef(form);
  const urlsRef = React.useRef(urls);
  const savedSig = React.useRef("");
  const persistPromise = React.useRef(null);
  const applyTimer = React.useRef(null);
  formRef.current = form;
  urlsRef.current = urls;
  const voices = voicesForMode(form.ttsMode, data.availableVoices && data.availableVoices[form.ttsMode]);
  const langs = languagesForMode(form.ttsMode);
  const canEditUrls = mode === "admin" && URL_FIELDS.some((f) => data[f] !== "[redacted]" && f in data);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("audio", file);
      const res = await api.upload("/api/admin/voice-recordings", fd);
      setForm((f) => ({ ...f, defaultVoiceMode: "cloned", clonedVoice: { speakerWavUrl: res.url, label: file.name.replace(/\.wav$/i, "") } }));
      toast.success("Recording uploaded", { description: `${res.filename} (${Math.round(res.size / 1024)} KB)` });
    } catch (e) {
      toast.error("Upload failed", { description: errorMessage(e) });
    } finally {
      setUploading(false);
    }
  };

  const tuningSignature = (f) => JSON.stringify({
    ttsMode: f.ttsMode,
    preset: f.preset,
    defaultVoiceMode: f.defaultVoiceMode,
    voiceId: f.voiceId,
    language: f.language,
    rate: f.rate,
    cloned: f.clonedVoice?.speakerWavUrl || "",
    magpieTemperature: f.magpieTemperature,
    magpieCfgScale: f.magpieCfgScale,
    magpieTopK: f.magpieTopK,
    magpieUseCfg: f.magpieUseCfg,
    magpieApplyTn: f.magpieApplyTn,
    meloSdpRatio: f.meloSdpRatio,
    meloNoiseScale: f.meloNoiseScale,
    meloNoiseScaleW: f.meloNoiseScaleW,
  });

  const persist = React.useCallback(async ({ silent } = {}) => {
    const current = formRef.current;
    const currentUrls = urlsRef.current;
    const sig = tuningSignature(current);
    if (current.defaultVoiceMode === "cloned" && !isPresetOnly(current.ttsMode) && !current.clonedVoice) {
      if (!silent) toast.error("Upload a recording first", { description: "Cloned voice needs a WAV sample." });
      return false;
    }
    setSaving(true);
    setLiveState("applying");
    try {
      const body = { ...current };
      if (isPresetOnly(current.ttsMode)) body.defaultVoiceMode = "preset";
      if (current.ttsMode === "qwen3_tts_http") {
        body.voiceId = current.voiceId || "Serena";
        body.language = coerceQwen3Language(current.language);
        body.qwen3Instruct = qwen3InstructForTuning(current.preset, current.rate);
        body.qwen3Streaming = true;
        const qwenUrl = String(currentUrls.qwen3TtsUrl || data.qwen3TtsUrl || "");
        if (canEditUrls && /qwen3/i.test(qwenUrl)) body.qwen3TtsUrl = qwenUrl;
      }
      if (current.ttsMode === "magpie_tts_http") {
        body.voiceId = current.voiceId || "Sofia";
        body.language = coerceMagpieLanguage(current.language);
        const magpieUrl = String(currentUrls.magpieTtsUrl || data.magpieTtsUrl || "");
        if (canEditUrls && /magpie/i.test(magpieUrl)) body.magpieTtsUrl = magpieUrl;
      }
      if (current.ttsMode === "kokoro_http") {
        body.voiceId = kokoroVoiceForLanguage(current.voiceId || "af_heart", current.language);
        body.language = kokoroLanguageForVoice(body.voiceId);
      }
      if (current.ttsMode === "melo_tts_http") {
        body.voiceId = current.voiceId || "EN-US";
        body.language = coerceMeloLanguage(current.language, body.voiceId);
        const meloUrl = String(currentUrls.meloTtsUrl || data.meloTtsUrl || "");
        if (canEditUrls && /melo/i.test(meloUrl)) body.meloTtsUrl = meloUrl;
      }
      if (canEditUrls && !isPresetOnly(current.ttsMode)) Object.assign(body, currentUrls);
      if (body.qwen3TtsUrl === "[redacted]") delete body.qwen3TtsUrl;
      if (body.magpieTtsUrl === "[redacted]") delete body.magpieTtsUrl;
      if (body.meloTtsUrl === "[redacted]") delete body.meloTtsUrl;
      const res = await api.post("/api/tts/config", body);
      const saved = fromTtsConfigSave(res);
      savedSig.current = sig;
      setLastSave(saved);
      setLiveState(saved.published ? "live" : "failed");
      if (!silent) {
        toast.success("Voice saved", {
          description: saved.published
            ? "Live on the next reply."
            : "Saved. Publish to make it live.",
        });
      }
      onSaved && onSaved({ ...res, published: saved.published, lastRuntimePublishedAt: saved.lastRuntimePublishedAt });
      return true;
    } catch (e) {
      setLiveState("failed");
      toast.error("Couldn't apply voice", { description: errorMessage(e) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, canEditUrls, data.qwen3TtsUrl, data.magpieTtsUrl, data.meloTtsUrl, onSaved]);

  const flushPersist = React.useCallback(() => {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }
    if (persistPromise.current) return persistPromise.current;
    const sig = tuningSignature(formRef.current);
    if (sig === savedSig.current) return Promise.resolve(true);
    persistPromise.current = persist({ silent: true }).finally(() => {
      persistPromise.current = null;
    });
    return persistPromise.current;
  }, [persist]);

  React.useEffect(() => {
    const sig = tuningSignature(form);
    if (!savedSig.current) {
      savedSig.current = sig;
      return undefined;
    }
    if (sig === savedSig.current) return undefined;
    setLiveState("applying");
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => {
      applyTimer.current = null;
      persistPromise.current = persist({ silent: true }).finally(() => {
        persistPromise.current = null;
      });
    }, 350);
    return () => {
      if (applyTimer.current) {
        clearTimeout(applyTimer.current);
        applyTimer.current = null;
      }
    };
  }, [form, persist]);

  return (
    <div className="space-y-5" data-testid="voice-editor">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="vl-card-soft p-4 space-y-4">
          <Field label="Voice type">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Voice type">
              {[
                ["preset", "Preset voice", "Choose from the voice library"],
                ...(isPresetOnly(form.ttsMode) ? [] : [["cloned", "Cloned voice", "Use your own recording"]]),
              ].map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={form.defaultVoiceMode === id}
                  onClick={() => setForm((f) => ({ ...f, defaultVoiceMode: id }))}
                  className={cn("rounded-[4px] border px-3 py-2.5 text-left transition-colors", form.defaultVoiceMode === id ? "border-vl-gold bg-white" : "border-vl-border bg-white/60 hover:bg-white")}
                  data-testid={`voice-mode-${id}`}
                >
                  <div className="text-[13px] font-medium">{label}</div>
                  <div className="vl-meta">{hint}</div>
                </button>
              ))}
            </div>
          </Field>

          {form.defaultVoiceMode === "preset" ? (
            <>
              <Field label="Voice engine" htmlFor="engine">
                <Select value={form.ttsMode} onValueChange={(v) => {
                  const d = defaultVoiceLang(v, "", form.language);
                  const magpie = magpieTuningForPreset(form.preset);
                  const melo = meloTuningForPreset(form.preset);
                  setForm((f) => ({
                    ...f,
                    ttsMode: v,
                    voiceId: d.voice,
                    language: d.lang || f.language,
                    defaultVoiceMode: isPresetOnly(v) ? "preset" : f.defaultVoiceMode,
                    magpieTemperature: magpie.temperature,
                    magpieCfgScale: magpie.cfgScale,
                    magpieTopK: magpie.topK,
                    magpieUseCfg: false,
                    magpieApplyTn: false,
                    meloSdpRatio: melo.sdpRatio,
                    meloNoiseScale: melo.noiseScale,
                    meloNoiseScaleW: melo.noiseScaleW,
                  }));
                }}>
                  <SelectTrigger id="engine" data-testid="voice-engine">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ENGINES).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {form.ttsMode === "qwen3_tts_http" ? (
                <InlineNote>Nine CustomVoice speakers. Serena is the default receptionist. Every speaker can talk English; native-language lines sound strongest.</InlineNote>
              ) : null}
              {form.ttsMode === "magpie_tts_http" ? (
                <InlineNote>NVIDIA Magpie 357M on this GPU. Five baked speakers, no cloning. CFG is off by default so first audio arrives sooner; enable it only if you want a richer (slower) take. Rate is applied after synthesis.</InlineNote>
              ) : null}
              {form.ttsMode === "melo_tts_http" ? (
                <InlineNote>MeloTTS is a fast VITS engine. Voice/accent is the big change. Speaking rate is native speed. SDP and noise only nudge timing and randomness — they will not make a new character.</InlineNote>
              ) : null}
              {form.ttsMode === "kokoro_http" ? (
                <InlineNote>Kokoro voice id is the accent. en-US keeps an American speaker; en-GB switches to the British match. Tone changes pace on top of the speaking-rate slider.</InlineNote>
              ) : null}
              {form.ttsMode === "openai_tts" ? (
                <InlineNote>Cloud engine. Needs a real OPENAI_API_KEY on the platform (the current install has a placeholder). On-prem Kokoro stays the default for live calls.</InlineNote>
              ) : null}
              {form.ttsMode === "elevenlabs" ? (
                <InlineNote>Cloud engine. Set ELEVENLABS_API_KEY on the control plane and runtime. On-prem engines do not need a key.</InlineNote>
              ) : null}
              <Field label="Voice" htmlFor="voice">
                {voices.length ? (
                  <Select value={form.voiceId} onValueChange={(v) => setForm((f) => ({
                    ...f,
                    voiceId: v,
                    language: f.ttsMode === "melo_tts_http"
                      ? meloLanguageForSpeaker(v)
                      : f.ttsMode === "kokoro_http"
                        ? kokoroLanguageForVoice(v)
                        : f.language,
                  }))}>
                    <SelectTrigger id="voice" data-testid="voice-select">
                      <SelectValue placeholder="Choose a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {voices.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}
                          {v.gender ? ` · ${v.gender}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="voice" value={form.voiceId} onChange={(e) => setForm((f) => ({ ...f, voiceId: e.target.value }))} placeholder="Voice ID" data-testid="voice-id-input" />
                )}
              </Field>
            </>
          ) : (
            <div className="space-y-3">
              <Field label="Voice recording (WAV)" hint="A clean 10-30 second sample works best.">
                <div className="flex items-center gap-3">
                  <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-input border border-vl-border-strong bg-white px-3 text-[13px] font-medium hover:bg-vl-soft">
                    <Upload className="h-4 w-4" aria-hidden="true" /> {uploading ? "Uploading…" : "Upload WAV"}
                    <input type="file" accept="audio/wav,.wav" className="sr-only" onChange={(e) => upload(e.target.files && e.target.files[0])} disabled={uploading} data-testid="voice-upload-input" />
                  </label>
                  {form.clonedVoice ? (
                    <Pill tone="success" icon={CheckCircle2} testId="cloned-voice-pill">
                      {form.clonedVoice.label || "Recording ready"}
                    </Pill>
                  ) : (
                    <span className="vl-meta">No recording yet</span>
                  )}
                </div>
              </Field>
            </div>
          )}

          <Field label="Language" htmlFor="lang">
            <Select value={form.language} onValueChange={(v) => setForm((f) => ({
              ...f,
              language: v,
              voiceId: f.ttsMode === "kokoro_http" ? kokoroVoiceForLanguage(f.voiceId, v) : f.voiceId,
            }))}>
              <SelectTrigger id="lang" data-testid="voice-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(langs.some((l) => l.id === form.language) ? langs : [{ id: form.language, label: form.language }, ...langs]).filter((l) => l.id).map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="vl-card-soft p-4 space-y-5">
          <Field label="Tone preset">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tone preset">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={form.preset === p.id}
                  onClick={() => setForm((f) => {
                    const magpie = magpieTuningForPreset(p.id);
                    const melo = meloTuningForPreset(p.id);
                    return {
                      ...f,
                      preset: p.id,
                      magpieTemperature: magpie.temperature,
                      magpieCfgScale: magpie.cfgScale,
                      magpieTopK: magpie.topK,
                      meloSdpRatio: melo.sdpRatio,
                      meloNoiseScale: melo.noiseScale,
                      meloNoiseScaleW: melo.noiseScaleW,
                    };
                  })}
                  className={cn("rounded-[4px] border px-3 py-2.5 text-left transition-colors", form.preset === p.id ? "border-vl-gold bg-white" : "border-vl-border bg-white/60 hover:bg-white")}
                  data-testid={`voice-preset-${p.id}`}
                >
                  <div className="text-[13px] font-medium">{p.label}</div>
                  <div className="vl-meta">{p.hint}</div>
                </button>
              ))}
            </div>
          </Field>
          <Field label={`Speaking rate · ${form.rate.toFixed(2)}x`} htmlFor="rate">
            <Slider id="rate" min={0.8} max={1.2} step={0.05} value={[Math.min(1.2, Math.max(0.8, form.rate))]} onValueChange={([v]) => setForm((f) => ({ ...f, rate: v }))} data-testid="voice-rate" aria-label="Speaking rate" />
            <div className="flex justify-between vl-meta">
              <span>Slower</span>
              <span>Faster</span>
            </div>
          </Field>
          {form.ttsMode === "magpie_tts_http" ? (
            <div className="space-y-4" data-testid="magpie-tuning">
              <Field label={`Temperature · ${Number(form.magpieTemperature).toFixed(2)}`} htmlFor="magpie-temp">
                <Slider id="magpie-temp" min={0.2} max={1.2} step={0.05} value={[Math.min(1.2, Math.max(0.2, Number(form.magpieTemperature) || 0.6))]} onValueChange={([v]) => setForm((f) => ({ ...f, magpieTemperature: v }))} aria-label="Magpie temperature" />
              </Field>
              <Field label={`CFG scale · ${Number(form.magpieCfgScale).toFixed(2)}`} htmlFor="magpie-cfg">
                <Slider id="magpie-cfg" min={1} max={4} step={0.1} value={[Math.min(4, Math.max(1, Number(form.magpieCfgScale) || 2.5))]} onValueChange={([v]) => setForm((f) => ({ ...f, magpieCfgScale: v }))} aria-label="Magpie CFG scale" />
              </Field>
              <Field label={`Top-k · ${Math.round(Number(form.magpieTopK) || 80)}`} htmlFor="magpie-topk">
                <Slider id="magpie-topk" min={10} max={120} step={1} value={[Math.min(120, Math.max(10, Math.round(Number(form.magpieTopK) || 80)))]} onValueChange={([v]) => setForm((f) => ({ ...f, magpieTopK: v }))} aria-label="Magpie top-k" />
              </Field>
              <label className="flex items-start gap-2 text-[13px] leading-5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.magpieUseCfg === true}
                  onChange={(e) => setForm((f) => ({ ...f, magpieUseCfg: e.target.checked }))}
                  data-testid="magpie-use-cfg"
                />
                <span>Classifier-free guidance (richer, about 2× slower)</span>
              </label>
              <label className="flex items-start gap-2 text-[13px] leading-5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.magpieApplyTn === true}
                  onChange={(e) => setForm((f) => ({ ...f, magpieApplyTn: e.target.checked }))}
                  data-testid="magpie-apply-tn"
                />
                <span>Text normalization (better for numbers/dates; extra latency)</span>
              </label>
            </div>
          ) : null}
          {form.ttsMode === "melo_tts_http" ? (
            <div className="space-y-4" data-testid="melo-tuning">
              <Field label={`SDP ratio · ${sliderNum(form.meloSdpRatio, 0.2).toFixed(2)}`} htmlFor="melo-sdp" hint="Higher = more varied timing.">
                <Slider id="melo-sdp" min={0} max={1} step={0.02} value={[Math.min(1, Math.max(0, sliderNum(form.meloSdpRatio, 0.2)))]} onValueChange={([v]) => setForm((f) => ({ ...f, meloSdpRatio: v }))} aria-label="MeloTTS SDP ratio" />
              </Field>
              <Field label={`Noise · ${sliderNum(form.meloNoiseScale, 0.6).toFixed(2)}`} htmlFor="melo-noise" hint="Higher = looser, more expressive.">
                <Slider id="melo-noise" min={0.1} max={1.5} step={0.02} value={[Math.min(1.5, Math.max(0.1, sliderNum(form.meloNoiseScale, 0.6)))]} onValueChange={([v]) => setForm((f) => ({ ...f, meloNoiseScale: v }))} aria-label="MeloTTS noise scale" />
              </Field>
              <Field label={`Duration noise · ${sliderNum(form.meloNoiseScaleW, 0.8).toFixed(2)}`} htmlFor="melo-noise-w" hint="Higher = more stretch in syllable length.">
                <Slider id="melo-noise-w" min={0.1} max={1.5} step={0.02} value={[Math.min(1.5, Math.max(0.1, sliderNum(form.meloNoiseScaleW, 0.8)))]} onValueChange={([v]) => setForm((f) => ({ ...f, meloNoiseScaleW: v }))} aria-label="MeloTTS duration noise" />
              </Field>
            </div>
          ) : null}

          <Field label="Preview text" htmlFor="ptext" hint="Leave empty to preview your saved greeting.">
            <div className="flex gap-2">
              <Input id="ptext" value={previewText} onChange={(e) => setPreviewText(e.target.value)} placeholder="Hi! Thanks for calling…" data-testid="voice-preview-text" />
              {preview.state === "playing" ? (
                <Button type="button" variant="outline" onClick={preview.stop} data-testid="voice-preview-stop">
                  <Square className="h-4 w-4" /> Stop
                </Button>
              ) : (
                <Button type="button" onClick={async () => {
                  const ok = await flushPersist();
                  const current = formRef.current;
                  if (ok !== false) {
                    preview.play(previewText, {
                      ttsMode: current.ttsMode,
                      voiceId: current.voiceId,
                      language: current.language,
                      rate: current.rate,
                      preset: current.preset,
                      meloSdpRatio: current.meloSdpRatio,
                      meloNoiseScale: current.meloNoiseScale,
                      meloNoiseScaleW: current.meloNoiseScaleW,
                      magpieTemperature: current.magpieTemperature,
                      magpieCfgScale: current.magpieCfgScale,
                      magpieTopK: current.magpieTopK,
                      magpieUseCfg: current.magpieUseCfg === true,
                      magpieApplyTn: current.magpieApplyTn === true,
                    });
                  }
                }} disabled={preview.state === "pending"} data-testid="voice-preview-button">
                  {preview.state === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {preview.state === "pending" ? "Generating…" : "Hear voice"}
                </Button>
              )}
            </div>
          </Field>
          <InlineNote>Changes apply as you edit. The next reply on a live call uses them. Hear voice plays the current speaker.</InlineNote>
          <InlineNote>
            Deep engine sliders (Qwen3 / Miso / Coqui) stay on{" "}
            <a className="underline" href="/admin-legacy">
              /admin-legacy
            </a>{" "}
            for this release. Magpie and MeloTTS knobs are on this page.
          </InlineNote>
        </div>
      </div>

      {canEditUrls ? (
        <div className="vl-card-soft p-4 space-y-3" data-testid="voice-provider-urls">
          <div className="text-[13px] font-medium">Provider endpoints (superadmin)</div>
          <div className="grid gap-3 md:grid-cols-2">
            {URL_FIELDS.filter((f) => f in urls).map((f) => (
              <Field key={f} label={f} htmlFor={`url-${f}`}>
                <Input id={`url-${f}`} value={urls[f] || ""} onChange={(e) => setUrls((u) => ({ ...u, [f]: e.target.value }))} placeholder="http://…" />
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <Pill tone={liveState === "failed" ? "warning" : "success"} testId="voice-publish-status">
          {liveState === "applying" ? "Applying…" : liveState === "failed" ? "Not live yet" : "Live on the next reply"}
        </Pill>
        <Button onClick={() => persist({ silent: false })} disabled={saving} data-testid="voice-save-button">
          <Save className="h-4 w-4" /> {saving ? "Applying…" : "Save voice"}
        </Button>
      </div>
    </div>
  );
};
