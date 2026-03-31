/**
 * Qwen3-TTS CustomVoice (1.7B / 0.6B) — languages and preset speakers per model card:
 * https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
 *
 * API expects language as full words (e.g. "English"), not ISO codes.
 * Speakers must match generate_custom_voice() exactly.
 */
(function (global) {
  /** @type {{ value: string, label: string }[]} */
  const LANGUAGES = [
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
  const SPEAKERS = [
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
      const ok =
        known.has(cur) || Array.from(selectEl.options).some((o) => o.value === cur);
      selectEl.value = ok ? cur : items.length ? items[0].value : "";
    } else if (items.length) {
      selectEl.value = items[0].value;
    }
  }

  /**
   * @param {HTMLSelectElement | null} selectEl
   * @param {string} [selectedValue]
   */
  function fillSpeakerSelect(selectEl, selectedValue) {
    fillSelect(selectEl, SPEAKERS, selectedValue, "custom");
  }

  /**
   * @param {HTMLSelectElement | null} selectEl
   * @param {string} [selectedValue]
   */
  function fillLanguageSelect(selectEl, selectedValue) {
    fillSelect(selectEl, LANGUAGES, selectedValue, "custom");
  }

  /**
   * Toggle between plain text inputs (other TTS modes) and Qwen3 dropdowns.
   * @param {{ voiceInput: string, speakerSelect: string, langInput: string, langSelect: string }} ids element ids
   * @param {boolean} isQwen3
   */
  function setVoiceLangUiMode(ids, isQwen3) {
    const vIn = document.getElementById(ids.voiceInput);
    const vSel = document.getElementById(ids.speakerSelect);
    const lIn = document.getElementById(ids.langInput);
    const lSel = document.getElementById(ids.langSelect);
    if (!vIn || !vSel || !lIn || !lSel) return;

    if (isQwen3) {
      fillSpeakerSelect(vSel, vIn.value || "Ryan");
      fillLanguageSelect(lSel, lIn.value || "English");
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
    LANGUAGES,
    SPEAKERS,
    fillSpeakerSelect,
    fillLanguageSelect,
    setVoiceLangUiMode,
  };
})(typeof window !== "undefined" ? window : globalThis);
