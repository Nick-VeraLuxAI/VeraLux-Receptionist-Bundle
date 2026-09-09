DEBT (Forge 2026-09-04): Rebuild/publish BOTH images after Nick proof dial (or if Nick says rebuild now). Do NOT bounce stack mid-dial.

1) veralux-voice-runtime image — bake callSession/brainClient fixes (queueTtsSegment, !playbackDone speak, serializeCaughtError, ensureCallEndedWorkflowFires, openai_direct_stream).
2) veralux-control-plane image — bake hangup always handleCallEnded from body history/transcript.

Until both ship: docker-compose.demo-tts.yml bind mounts (patches/callSession.js, brainClient.js, control-server.js) are interim.

Preflight: scripts/assert-demo-runtime-patches.sh
