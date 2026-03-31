/**
 * TTS voice & language dropdown data + helpers (Qwen3 CustomVoice, Kokoro, XTTS, ISO languages).
 * Qwen3: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
 * Kokoro voices: VOICES.md (Kokoro v1.0 style IDs)
 */
(function (global) {
  /** @type {{ value: string, label: string }[]} */
  const QWEN3_LANGUAGES = [
    { value: "Auto", label: "Auto — infer from text" },
    { value: "Chinese", label: "Chinese" },
    { value: "English", label: "English" },
    { value: "Japanese", label: "Japanese" },
    { value: "Korean", label: "Korean" },
    { value: "German", label: "German" },
    { value: "French", label: "French" },
    { value: "Russian", label: "Russian" },
    { value: "Portuguese", label: "Portuguese" },
    { value: "Spanish", label: "Spanish" },
    { value: "Italian", label: "Italian" },
  ];

  /** @type {{ value: string, label: string }[]} */
  const QWEN3_SPEAKERS = [
    { value: "Vivian", label: "Vivian — bright young female (Chinese)" },
    { value: "Serena", label: "Serena — warm gentle female (Chinese)" },
    { value: "Uncle_Fu", label: "Uncle Fu — seasoned low male (Chinese)" },
    { value: "Dylan", label: "Dylan — Beijing male, clear (Chinese)" },
    { value: "Eric", label: "Eric — Chengdu male, lively (Sichuan)" },
    { value: "Ryan", label: "Ryan — dynamic English male" },
    { value: "Aiden", label: "Aiden — sunny US English male" },
    { value: "Ono_Anna", label: "Ono Anna — playful Japanese female" },
    { value: "Sohee", label: "Sohee — warm Korean female" },
  ];

  /** Kokoro v1.0 preset voice IDs (hexgrad/misaki voice packs). */
  const KOKORO_VOICES = [
    { value: "af_heart", label: "af_heart — American English female" },
    { value: "af_alloy", label: "af_alloy — American English female" },
    { value: "af_aoede", label: "af_aoede — American English female" },
    { value: "af_bella", label: "af_bella — American English female" },
    { value: "af_jessica", label: "af_jessica — American English female" },
    { value: "af_kore", label: "af_kore — American English female" },
    { value: "af_nicole", label: "af_nicole — American English female" },
    { value: "af_nova", label: "af_nova — American English female" },
    { value: "af_river", label: "af_river — American English female" },
    { value: "af_sarah", label: "af_sarah — American English female" },
    { value: "af_sky", label: "af_sky — American English female" },
    { value: "am_adam", label: "am_adam — American English male" },
    { value: "am_echo", label: "am_echo — American English male" },
    { value: "am_eric", label: "am_eric — American English male" },
    { value: "am_fenrir", label: "am_fenrir — American English male" },
    { value: "am_liam", label: "am_liam — American English male" },
    { value: "am_michael", label: "am_michael — American English male" },
    { value: "am_onyx", label: "am_onyx — American English male" },
    { value: "am_puck", label: "am_puck — American English male" },
    { value: "am_santa", label: "am_santa — American English male" },
    { value: "bf_alice", label: "bf_alice — British English female" },
    { value: "bf_emma", label: "bf_emma — British English female" },
    { value: "bf_isabella", label: "bf_isabella — British English female" },
    { value: "bf_lily", label: "bf_lily — British English female" },
    { value: "bm_daniel", label: "bm_daniel — British English male" },
    { value: "bm_fable", label: "bm_fable — British English male" },
    { value: "bm_george", label: "bm_george — British English male" },
    { value: "bm_lewis", label: "bm_lewis — British English male" },
    { value: "jf_alpha", label: "jf_alpha — Japanese female" },
    { value: "jf_gongitsune", label: "jf_gongitsune — Japanese female" },
    { value: "jf_nezumi", label: "jf_nezumi — Japanese female" },
    { value: "jf_tebukuro", label: "jf_tebukuro — Japanese female" },
    { value: "jm_kumo", label: "jm_kumo — Japanese male" },
    { value: "zf_xiaobei", label: "zf_xiaobei — Mandarin female" },
    { value: "zf_xiaoni", label: "zf_xiaoni — Mandarin female" },
    { value: "zf_xiaoxiao", label: "zf_xiaoxiao — Mandarin female" },
    { value: "zf_xiaoyi", label: "zf_xiaoyi — Mandarin female" },
    { value: "zm_yunjian", label: "zm_yunjian — Mandarin male" },
    { value: "zm_yunxi", label: "zm_yunxi — Mandarin male" },
    { value: "zm_yunxia", label: "zm_yunxia — Mandarin male" },
    { value: "zm_yunyang", label: "zm_yunyang — Mandarin male" },
    { value: "ef_dora", label: "ef_dora — Spanish female" },
    { value: "em_alex", label: "em_alex — Spanish male" },
    { value: "em_santa", label: "em_santa — Spanish male" },
    { value: "ff_siwis", label: "ff_siwis — French female" },
    { value: "hf_alpha", label: "hf_alpha — Hindi female" },
    { value: "hf_beta", label: "hf_beta — Hindi female" },
    { value: "hm_omega", label: "hm_omega — Hindi male" },
    { value: "hm_psi", label: "hm_psi — Hindi male" },
    { value: "if_sara", label: "if_sara — Italian female" },
    { value: "im_nicola", label: "im_nicola — Italian male" },
    { value: "pf_dora", label: "pf_dora — Brazilian Portuguese female" },
    { value: "pm_alex", label: "pm_alex — Brazilian Portuguese male" },
    { value: "pm_santa", label: "pm_santa — Brazilian Portuguese male" },
  ];

  /** Common Coqui XTTS / xtts-api built-in speaker IDs */
  const XTTS_SAMPLE_VOICES = [
    { value: "en_sample", label: "en_sample — English" },
    { value: "es_sample", label: "es_sample — Spanish" },
    { value: "fr_sample", label: "fr_sample — French" },
    { value: "de_sample", label: "de_sample — German" },
    { value: "it_sample", label: "it_sample — Italian" },
    { value: "pt_sample", label: "pt_sample — Portuguese" },
    { value: "pl_sample", label: "pl_sample — Polish" },
    { value: "tr_sample", label: "tr_sample — Turkish" },
    { value: "ru_sample", label: "ru_sample — Russian" },
    { value: "nl_sample", label: "nl_sample — Dutch" },
    { value: "cs_sample", label: "cs_sample — Czech" },
    { value: "ar_sample", label: "ar_sample — Arabic" },
    { value: "zh-cn_sample", label: "zh-cn_sample — Chinese" },
    { value: "ja_sample", label: "ja_sample — Japanese" },
    { value: "ko_sample", label: "ko_sample — Korean" },
    { value: "hi_sample", label: "hi_sample — Hindi" },
    { value: "hu_sample", label: "hu_sample — Hungarian" },
    { value: "el_sample", label: "el_sample — Greek" },
    { value: "fi_sample", label: "fi_sample — Finnish" },
    { value: "sv_sample", label: "sv_sample — Swedish" },
    { value: "uk_sample", label: "uk_sample — Ukrainian" },
    { value: "ro_sample", label: "ro_sample — Romanian" },
    { value: "sk_sample", label: "sk_sample — Slovak" },
    { value: "hr_sample", label: "hr_sample — Croatian" },
    { value: "bg_sample", label: "bg_sample — Bulgarian" },
    { value: "da_sample", label: "da_sample — Danish" },
    { value: "no_sample", label: "no_sample — Norwegian" },
    { value: "vi_sample", label: "vi_sample — Vietnamese" },
    { value: "ms_sample", label: "ms_sample — Malay" },
    { value: "id_sample", label: "id_sample — Indonesian" },
    { value: "fil_sample", label: "fil_sample — Filipino" },
  ];

  /** ISO 639-1 language codes for XTTS / Chatterbox (short codes). */
  const ISO_LANGUAGES = [
    { value: "en", label: "English (en)" },
    { value: "es", label: "Spanish (es)" },
    { value: "fr", label: "French (fr)" },
    { value: "de", label: "German (de)" },
    { value: "it", label: "Italian (it)" },
    { value: "pt", label: "Portuguese (pt)" },
    { value: "pl", label: "Polish (pl)" },
    { value: "tr", label: "Turkish (tr)" },
    { value: "ru", label: "Russian (ru)" },
    { value: "nl", label: "Dutch (nl)" },
    { value: "cs", label: "Czech (cs)" },
    { value: "ar", label: "Arabic (ar)" },
    { value: "zh", label: "Chinese (zh)" },
    { value: "ja", label: "Japanese (ja)" },
    { value: "ko", label: "Korean (ko)" },
    { value: "hi", label: "Hindi (hi)" },
    { value: "hu", label: "Hungarian (hu)" },
    { value: "el", label: "Greek (el)" },
    { value: "fi", label: "Finnish (fi)" },
    { value: "sv", label: "Swedish (sv)" },
    { value: "uk", label: "Ukrainian (uk)" },
    { value: "ro", label: "Romanian (ro)" },
    { value: "sk", label: "Slovak (sk)" },
    { value: "hr", label: "Croatian (hr)" },
    { value: "bg", label: "Bulgarian (bg)" },
    { value: "da", label: "Danish (da)" },
    { value: "no", label: "Norwegian (no)" },
    { value: "vi", label: "Vietnamese (vi)" },
    { value: "ms", label: "Malay (ms)" },
    { value: "id", label: "Indonesian (id)" },
    { value: "fil", label: "Filipino (fil)" },
    { value: "fa", label: "Persian (fa)" },
    { value: "he", label: "Hebrew (he)" },
    { value: "bn", label: "Bengali (bn)" },
    { value: "ta", label: "Tamil (ta)" },
    { value: "ur", label: "Urdu (ur)" },
  ];

  function fillSelect(selectEl, items, selectedValue, legacyLabel) {
    if (!selectEl) return;
    const cur = selectedValue != null && String(selectedValue).trim() !== "" ? String(selectedValue).trim() : "";
    const known = new Set(items.map((x) => x.value));
    selectEl.innerHTML = "";
    items.forEach((it) => {
      const o = document.createElement("option");
      o.value = it.value;
      o.textContent = it.label;
      selectEl.appendChild(o);
    });
    if (cur && !known.has(cur)) {
      const o = document.createElement("option");
      o.value = cur;
      o.textContent = legacyLabel ? `${cur} (${legacyLabel})` : `${cur} (saved)`;
      selectEl.appendChild(o);
    }
    if (cur) {
      const ok = known.has(cur) || Array.from(selectEl.options).some((o) => o.value === cur);
      selectEl.value = ok ? cur : items.length ? items[0].value : "";
    } else if (items.length) {
      selectEl.value = items[0].value;
    }
  }

  /**
   * @param {HTMLSelectElement | null} selectEl
   * @param {string} mode
   * @param {string} [selectedValue]
   */
  function fillVoiceSelect(selectEl, mode, selectedValue) {
    if (!selectEl) return;
    if (mode === "qwen3_tts_http") {
      fillSelect(selectEl, QWEN3_SPEAKERS, selectedValue, "saved");
      return;
    }
    if (mode === "kokoro_http") {
      fillSelect(selectEl, KOKORO_VOICES, selectedValue, "custom");
      return;
    }
    if (mode === "coqui_xtts") {
      fillSelect(selectEl, XTTS_SAMPLE_VOICES, selectedValue, "custom");
      return;
    }
    selectEl.innerHTML = "";
  }

  /**
   * @param {HTMLSelectElement | null} selectEl
   * @param {string} mode
   * @param {string} [selectedValue]
   */
  function fillLanguageSelect(selectEl, mode, selectedValue) {
    if (!selectEl) return;
    if (mode === "qwen3_tts_http") {
      fillSelect(selectEl, QWEN3_LANGUAGES, selectedValue, "saved");
      return;
    }
    if (mode === "coqui_xtts" || mode === "chatterbox_http") {
      fillSelect(selectEl, ISO_LANGUAGES, selectedValue, "saved");
      return;
    }
    selectEl.innerHTML = "";
  }

  const KOKORO_VOICE_PATTERN = /^[ab][fm]_/;

  /**
   * Apply the same defaults as the admin/portal/owner apply*Defaults helpers (string in → string out).
   * @param {string} mode
   * @param {string} voice
   * @param {string} lang
   * @returns {{ voice: string, lang: string }}
   */
  function resolveVoiceLangDefaults(mode, voice, lang) {
    let v = (voice || "").trim();
    let l = (lang || "").trim();
    const KOKORO_LANG_SINGLE = ["a", "b"];
    if (mode === "coqui_xtts") {
      if (!v || KOKORO_VOICE_PATTERN.test(v)) v = "en_sample";
      if (!l || KOKORO_LANG_SINGLE.includes(l)) l = "en";
    } else if (mode === "kokoro_http") {
      if (!v || !KOKORO_VOICE_PATTERN.test(v)) v = "af_bella";
    } else if (mode === "qwen3_tts_http") {
      if (!v) v = "Ryan";
      if (!l) l = "English";
    } else if (mode === "chatterbox_http") {
      if (!l || KOKORO_LANG_SINGLE.includes(l)) l = "en";
    }
    return { voice: v, lang: l };
  }

  /** @deprecated Use fillVoiceSelect / fillLanguageSelect */
  function setVoiceLangUiMode(ids, isQwen3) {
    const vIn = document.getElementById(ids.voiceInput);
    const vSel = document.getElementById(ids.speakerSelect);
    const lIn = document.getElementById(ids.langInput);
    const lSel = document.getElementById(ids.langSelect);
    if (!vIn || !vSel || !lIn || !lSel) return;
    if (isQwen3) {
      fillSelect(vSel, QWEN3_SPEAKERS, vIn.value || "Ryan", "saved");
      fillSelect(lSel, QWEN3_LANGUAGES, lIn.value || "English", "saved");
      vIn.style.display = "none";
      vSel.style.display = "block";
      lIn.style.display = "none";
      lSel.style.display = "block";
    } else {
      vIn.value = (vSel.value || vIn.value).trim();
      lIn.value = (lSel.value || lIn.value).trim();
      vIn.style.display = "block";
      vSel.style.display = "none";
      lIn.style.display = "block";
      lSel.style.display = "none";
    }
  }

  global.QWEN3_CUSTOMVOICE = {
    LANGUAGES: QWEN3_LANGUAGES,
    SPEAKERS: QWEN3_SPEAKERS,
    fillSpeakerSelect: function (selectEl, selectedValue) {
      fillSelect(selectEl, QWEN3_SPEAKERS, selectedValue, "custom");
    },
    fillLanguageSelect: function (selectEl, selectedValue) {
      fillSelect(selectEl, QWEN3_LANGUAGES, selectedValue, "saved");
    },
    setVoiceLangUiMode: setVoiceLangUiMode,
  };

  global.TTS_VOICE_LANG_UI = {
    fillVoiceSelect: fillVoiceSelect,
    fillLanguageSelect: fillLanguageSelect,
    resolveVoiceLangDefaults: resolveVoiceLangDefaults,
    KOKORO_VOICES: KOKORO_VOICES,
    XTTS_SAMPLE_VOICES: XTTS_SAMPLE_VOICES,
    ISO_LANGUAGES: ISO_LANGUAGES,
    QWEN3_LANGUAGES: QWEN3_LANGUAGES,
    QWEN3_SPEAKERS: QWEN3_SPEAKERS,
  };
})(typeof window !== "undefined" ? window : globalThis);
