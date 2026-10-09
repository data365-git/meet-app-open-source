# ADR 2026-10-08 - Meeting recordings -> Hermes CRM folder

## Context
Owner (Abror) wants: after a meeting is recorded in data365, data365 asks "Bu meetingmi? Hermesga joylaymi?";
on "Ha" it transcribes the recording (if needed) and the transcript lands in Hermes' CRM folder on Bunyod's Mac Mini.

## Decisions (owner, 2026-10-08, one-tap interview)
- Where the question appears: in data365 (the video page), not Telegram.
- Which recordings: only those in the Meetings library (`libraryKindMeetingFilter`).
- Target folder: `~/.hermes/crm-agent/data/meetings/` on the Mac (existing files: `YYYY-MM-DD_<Ism>_<Kompaniya>_meet.txt`).
- File name: the admin TYPES client name + company in the dialog each time.
- Content: transcript only (.txt, same text as the existing per-video download). Hermes summarises itself.
- Who may press it: admins only.
- Feedback: a "Hermesga joylandi ✓" mark in data365 is enough; no Telegram message.

## Delivery design (commander, HOW)
PULL, not push: data365 (public HTTPS) keeps a small queue; a launchd job on the Mac polls it every 5 min with a
shared secret token, writes the .txt into the folder, then ACKs. Reason: the Mac is behind NAT and the server has no
proven route to it; a pull survives Mac sleep/offline (it catches up), and the server never holds a Mac credential.
State lives in `videos.metadata.hermes` (JSON: status asked|declined|queued|delivered, clientName, company, queuedAt,
deliveredAt, fileName) - no DB migration (this repo's migrator stops at a benign error, see STATE).

## Parts
A. data365 (GLM): admin dialog on Meetings videos, metadata state, start transcript if missing, token-protected
   `GET /api/hermes/meetings/queue` + `POST .../ack`, "joylandi ✓" mark.
B. Mac (Hermes, Opus): puller script + launchd plist, writes atomically (tmp + rename), never overwrites (dedupe " (2)").
