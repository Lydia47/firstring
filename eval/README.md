# FirstRing eval

Synthetic calls, pre-event prepared public data. Utterances are synthetic caller descriptions; labels (complaint type, descriptor, agency) come from public NYC Open Data 311 records. Audio is macOS TTS, 16 kHz PCM16 mono.

## Method

`eval/run.mjs` starts its own server on port 8081 (ticket log `data/tickets.jsonl`, records tagged `source=eval-dev|eval-test`), then places one call per dataset item over `ws://localhost:8081/call`, strictly sequential with a 2 s gap:

1. Wait for the agent's opening turn to complete, then 0.5 s.
2. Stream the utterance WAV in real time (3200-byte / 100 ms chunks), then 1.5 s of silence.
3. If the agent finishes a turn without filing or transferring, wait a 1.5 s grace period for a tool call. Then:
   - The turn is a read-back (contains "right?" / "correct?" or repeats the street number) → stream the confirmation WAV for that voice once, plus 1.5 s of silence, and keep waiting.
   - Otherwise → the agent asked for clarification; record the question and end the call.
4. 60 s timeout per call. Hang up and close after each call.

## Buckets

| bucket | meaning |
|---|---|
| filed_correct | `create_service_request` succeeded with the expected complaint type |
| filed_wrong | filed, but with a different complaint type |
| asked_clarification | agent asked a follow-up question instead of filing |
| handed_off | agent called `transfer_to_human` |
| network_error | socket error, upstream close, server error, or 60 s timeout |

Agency and descriptor matches are recorded per filed call; `agency_correct` counts agency matches.

## Run

```
node eval/run.mjs --set dev                    # 30 dev calls  -> eval/results-dev.json
node eval/run.mjs --set test                   # 20 test calls -> eval/results-test.json
node eval/run.mjs --set dev --ids nyc-01,nyc-02
node eval/run.mjs --set dev --limit 2 --out eval/results-smoke.json
```

Requires `GEMINI_API_KEY` in the environment and port 8081 free. Results are rewritten after every call, so an interrupted run keeps its progress. Server output goes to `eval/server.log`.
