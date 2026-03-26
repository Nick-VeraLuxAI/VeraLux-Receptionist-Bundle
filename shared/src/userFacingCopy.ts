/**
 * Canonical user-facing phrases shared by control-plane and voice runtime
 * so LLM failure paths stay consistent across surfaces.
 */

/** Short copy for real-time voice when the brain/LLM path fails. */
export const ASSISTANT_VOICE_LLM_ERROR_FALLBACK =
  "Sorry - I had a problem responding. Can you repeat that?";

/** Fuller copy for text-oriented receptionist / dev flows when the LLM fails or returns no reply. */
export const RECEPTIONIST_TEXT_LLM_ERROR_FALLBACK =
  "I'm sorry, I had a little trouble on my end. Could you please repeat that or tell me a bit more about what you need help with?";
