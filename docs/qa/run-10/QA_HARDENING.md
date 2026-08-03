# QA Run 10 — Recorder Hardening Review

Candidate: `81827a1`

## Verified safeguards

- Permanent delete authorizes ownership before storage mutation.
- Completed storage objects are deleted before the video/database records.
- Successful hard delete is idempotent.
- Soft-delete Trash behavior remains separate.
- Tab-only start fails closed on missing/unusable client audio.
- Capture contexts acknowledge Pause/Resume only when they acted.
- Old async discard completion is identity-guarded against newer recorder state.
- Production build and route-export guard accept the new route.

## High hardening gaps

### Discard transaction boundary

The invariant spans two HTTP calls and local destructive cleanup:

1. local bytes and retry evidence are deleted;
2. multipart abort is attempted;
3. abort failure is caught;
4. permanent video deletion is still attempted;
5. no durable cleanup job remains.

This is neither atomic nor recoverable. A safe design needs one authenticated server discard operation, or an equivalent durable state machine, that retains the ownership row until multipart and object cleanup finish. The extension must persist exactly one idempotent discard retry before deleting its upload retry evidence.

### Capture-surface guarantee

Picker constraints cannot be treated as proof of the chosen surface. Meeting-required capture must inspect the returned track and reject known non-monitor values before `RECORDER_STARTED`/upload initialization. Plain instruction capture must remain unchanged.

## Medium hardening gaps

- Visible control state is not coupled to acknowledgement.
- Destructive action result is not shown.
- The persistent recording surface lacks Pause/Resume.
- Required inline `aria-live` failure feedback cannot be verified because it is not implemented for these controls.

## Unverified operational boundaries

- Real R2 multipart/object cleanup and database absence.
- Actual Chrome tab-mute to MediaStreamTrack event mapping.
- MV3 restart while cleanup/finalization is pending.
- Final media duration and remote audio after pause/offline recovery.
- Exact packaged candidate loaded in the user's Chrome profile.

## Owner decision

No new product decision is needed. The 2026-07-15 binding decisions remain sufficient: keep both capture modes, keep the explicit full-screen no-audio waiver plus persistent warning, and fail tab-only closed.

## Required next verification

After the open code gaps are fixed, rebuild the exact unpacked extension and run the two-person Meet, Pause interval, wrong-surface, offline restart/finalize, tab-only remote voice, and offline permanent-discard cleanup checks. Any surviving data or false UI state blocks release.
