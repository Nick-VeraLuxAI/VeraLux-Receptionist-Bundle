# Demo Shop STREAMTTS remainder duplicate (v3:ys94d8gX)

**Call:** `v3:ys94d8gXq8nA1i3lOrs3sZ2ZIBDAO6fVVjYlKmQDr5wejfGn7b3kQQ`  
**Time:** 2026-09-07 03:26:04–03:26:32 UTC (~20:26 PT)

## What Nick heard
1. Greeting OK  
2. User: “Hi, I was looking to hire a demo.” (STT mishear — secondary)  
3. “Hi there!” then “I'm glad you're interested in a demo.”  
4. ~1.8s gap  
5. **Full reply spoken again** starting “Hi there! …” — hangup

## Forensics (runtime logs)
| t (approx) | event | note |
|---|---|---|
| 03:26:12.649 | `demo_shop_streamtts_arm` | max_segments=2 |
| 03:26:12.749 | `tts_segment_queued` turn-2-1 | seg_len=10 (“Hi there!”) |
| 03:26:12.784 | `tts_segment_queued` turn-2-2 + `segment_cap` | seg_len=37 |
| 03:26:13.005 | `demo_shop_tts_replytext_unwrap` | original_len=**284** JSON → spoken_len=**157** |
| 03:26:13.006 | `remainder_queued` | remainder_len=**157**, preview starts **“Hi there!”** |
| 03:26:19.001 | remainder play_start | after seg1+seg2 + PSTN_WAIT |
| hangup | `demo_shop_hangup_book_skip` | no name/contact/confirm — book-truth OK |

Not barge. Not empty unwrap. Chatterbox OK.

## Root cause
Stream complete replaced `bufferedText` with longer `reply.text` (JSON envelope). Unwrap then set **`speakCursor = 0`**. Remainder used `remain = longer(fromParts, fromCursor)`. `fromCursor` became the **full 157-char replyText**. That string is longer than the true suffix, so the tail replayed segs 1–2 plus the question.

## Fix
`VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906`: remap cursor after unwrap; pick **unsent suffix only**; skip + log `remainder_skipped_duplicate` if the tail equals/starts with already-spoken text. Combine tiny first clauses so “Hi there!” is not its own burst.
