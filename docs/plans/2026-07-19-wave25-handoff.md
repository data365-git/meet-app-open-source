# Wave 2.5 handoff — patch required in `ShareVideo.tsx` (file ownership excluded)

Written by the Wave 2.5 (AI chat + panels dark-mode) executor. `ShareVideo.tsx`
was on the do-not-edit list (another agent owns it concurrently), so the one
change Wave 2.5 needed there is written out here instead of applied directly.

## Why this is needed

Wave 2.5 deleted the `?variant=inline` chat implementation from
`SharePanel.tsx` (state, handlers, JSX — see that file's top comment). The
owner-delivered "modal" design (`AIFab` + `AIChatPopup`, dropped in this wave)
is now the only chat surface. `SharePanel` still accepts `chatVariant` /
`processing` / `videoId` / `onVideoJump` props for backward-compat (so this
file keeps typechecking untouched), but no longer branches on them.

`ShareVideo.tsx` is the one file that still computes `chatVariant` from
`?variant=` and conditionally renders `AIFab`/`AIChatPopup` only when it
equals `"modal"`. Functionally nothing is broken right now — the query
param defaults to `"modal"` — but `?variant=inline` is a live URL that now
silently shows a bare tab panel with **no chat at all** (SharePanel dropped
its inline chat, and ShareVideo hides the modal chat for that variant). This
is the exact dangling half-migrated state the spec warned about.

## Exact patch

In `apps/web/app/s/[videoId]/_components/ShareVideo.tsx`:

1. **Remove the variant switch** (around line 120-123):

```diff
-		// Chat UI: the blue-FAB → dialog chat is the DEFAULT (owner choice
-		// 2026-07-13). `?variant=inline` still opts into the in-panel inline chat.
-		const chatVariant: "modal" | "inline" =
-			searchParams.get("variant") === "inline" ? "inline" : "modal";
+		// Wave 2.5: the inline chat variant was deleted (SharePanel.tsx). The
+		// modal (AIFab + AIChatPopup) is now the only chat surface — no more
+		// `?variant=` branching.
```

   (`searchParams` itself must stay — it's also used for the `t` deep-link
   param at line ~364/436.)

2. **Stop passing the now-dead prop** to `SharePanel` (around line 885):

```diff
-								chatVariant={chatVariant}
```

   (Harmless to leave in — `SharePanel`'s prop type still accepts it — but
   it's dead weight once the switch above is gone.)

3. **Always render the modal chat**, dropping the `chatVariant === "modal"`
   guard (around line 1015-1033):

```diff
-				{/* T9 prototype: ?variant=modal — restored blue-FAB → dialog chat,
-			    hidden by default in favor of the current inline chat above. */}
-				{chatVariant === "modal" && (
-					<>
-						<div className={`ai-aura${aiChatOpen ? " show" : ""}`} />
-						<AIChatPopup
-							videoId={data.id}
-							onVideoJump={handleSeekAndPlay}
-							onClose={() => setAiChatOpen(false)}
-							isOpen={aiChatOpen}
-							processing={aiProcessing}
-							transcriptReady={transcriptReady}
-						/>
-						<AIFab
-							onClick={() => setAiChatOpen((v) => !v)}
-							isOpen={aiChatOpen}
-						/>
-					</>
-				)}
+				{/* Wave 2.5: modal (AIFab + AIChatPopup) is the only chat surface now. */}
+				<AIChatPopup
+					videoId={data.id}
+					onVideoJump={handleSeekAndPlay}
+					onClose={() => setAiChatOpen(false)}
+					isOpen={aiChatOpen}
+					processing={aiProcessing}
+					transcriptReady={transcriptReady}
+				/>
+				<AIFab
+					onClick={() => setAiChatOpen((v) => !v)}
+					isOpen={aiChatOpen}
+				/>
```

   The `<div className="ai-aura" />` is dropped along with the guard — the
   new `ai-chat.css` (Wave 2.5 drop-in) intentionally has no `.ai-aura`
   styles (the owner's redesign explicitly removes the glow/aura effect for
   a calmer ADHD-friendly surface), so that div was already a no-op; this
   just removes the dead markup along with its dead guard.

## Verified safe in the meantime

Until the above lands, nothing crashes: `?variant=inline` isn't linked from
anywhere in the app (grepped — no internal link sets it), so this is a
latent gap, not a live regression. `tsc --noEmit` passes with `SharePanel`
still accepting the unused props.
