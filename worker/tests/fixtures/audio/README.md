Synthetic 1-second 440 Hz tones generated locally with FFmpeg, no human audio or PII.
- tone.ogg: 48 kHz Opus (WhatsApp voice-note container path)
- tone.wav: 16 kHz PCM s16le
- tone.mp3: 44.1 kHz MP3

These validate media parsing/remuxing, not speech recognition. Runtime tests inject
prescribed transcripts from ../whatsapp-multilingual.json; they do not establish
accuracy, dialect coverage, latency or availability of the real transcription API.
